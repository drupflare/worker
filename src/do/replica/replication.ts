import { type SqlBindings, toPositional } from '@drupflare/durabledb/do-sqlite';
import { writeTargetTable } from '../../db/write-tally';
import { type LogRecord } from '../../ops/replica/replication-log';
import { planRestore } from '../../ops/replica/restore';
import { fingerprintState, readStateRows } from '../../ops/replica/state-fingerprint';
import { classifyState } from '../../ops/replica/state-inventory';
import type { SitePhpDurableObject } from '../../site-do';
import { firstRow } from '../../util/sql';
import type { ReplicationLogHost } from '../host';
import { COMMIT_SEQ_KEY } from '../keys';
import { REPLICATION_RECORD_MAX_STATEMENTS } from '../limits';

/**
 * Collects the statements a replica would have to apply to reach this generation.
 *
 * Synchronous because it runs inside `execSql()`, which is PHP-facing and cannot await. The
 * record's fingerprint is an async SHA-256, so the record is buffered here and sealed at the end
 * of the invocation by {@link sealGeneration}.
 *
 * A replica buffers nothing: its writes are replica-local cache fills, and replicating them back
 * would loop.
 */
export function bufferForReplication(
	site: SitePhpDurableObject,
	sql: string,
	params?: SqlBindings
): void {
	if (site.isReplica()) return;
	const buffer = (site.pendingReplication ??= {
		// the last sealed record, never `commitSeq() - 1` (a seal can land past it, leaving two
		// records with one parent and withdrawing every lane); a caught-up replica sits here
		parent: site.copyableGeneration(),
		statements: [],
		overflowed: false
	});
	// past the cap (a migration writes thousands) the record is overflowed and empty: a replica
	// must restore, never apply a truncated record that would leave it silently wrong
	if (buffer.statements.length >= REPLICATION_RECORD_MAX_STATEMENTS) {
		buffer.overflowed = true;
		buffer.statements = [];
		return;
	}
	if (buffer.overflowed) return;
	// positional at capture: Drupal binds by name, the applier replays with `exec(sql, ...params)`
	const { text, values } = toPositional(sql, params);
	buffer.statements.push({ sql: text, params: values });
}

/**
 * Turns the buffered statements into one durable {@link LogRecord}.
 *
 * Called at the end of an invocation, where awaiting is legal. One record per invocation, not per
 * statement, so a replica never stops in a state the primary was never observably in.
 */
export async function sealGeneration(
	site: SitePhpDurableObject
): Promise<{ generation: number; statements: number } | undefined> {
	// before the buffer check: the sequence must persist even when no record is sealed
	site.flushCommitSeq();
	const buffer = site.pendingReplication;
	site.pendingReplication = undefined;
	if (!buffer) return undefined;
	let generation = site.commitSeq();
	if (generation <= buffer.parent) {
		// a buffered write must get a generation (the buffer is already cleared); reachable when an
		// authoritative write invalidated nothing, since the sequence only advances on invalidation
		generation = site.advanceCommit();
		site.flushCommitSeq();
	}
	if (generation <= buffer.parent) return undefined;

	const read = readStateRows((sql) => site.sql.exec(sql).toArray());
	const fingerprint = await fingerprintState(read.rows);
	site.ensureReplicationLog();
	site.sql.exec(
		`INSERT INTO cfw_repl_log (generation, parent, schema_version, fingerprint, overflowed,
				statements, sealed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(generation) DO UPDATE SET
				parent = excluded.parent, fingerprint = excluded.fingerprint,
				overflowed = excluded.overflowed, statements = excluded.statements`,
		generation,
		buffer.parent,
		site.packGeneration() ?? '',
		fingerprint,
		buffer.overflowed ? 1 : 0,
		JSON.stringify(buffer.statements),
		site.nowMs()
	);
	return { generation, statements: buffer.statements.length };
}

/** the records a replica at `since` needs, oldest first; the shape `applyRecord()` consumes */
export function replicationRecords(
	site: SitePhpDurableObject,
	since: number,
	limit = 50
): LogRecord[] {
	site.ensureReplicationLog();
	const rows = site.sql
		.exec(
			`SELECT generation, parent, schema_version, fingerprint, overflowed, statements
				 FROM cfw_repl_log WHERE generation > ? ORDER BY generation LIMIT ?`,
			since,
			limit
		)
		.toArray() as unknown as {
		generation: number;
		parent: number;
		schema_version: string;
		fingerprint: string;
		overflowed: number;
		statements: string;
	}[];
	return rows.map((r) => ({
		generation: Number(r.generation),
		parent: Number(r.parent),
		schemaVersion: String(r.schema_version),
		fingerprint: String(r.fingerprint),
		overflowed: Number(r.overflowed) === 1,
		statements: JSON.parse(r.statements) as LogRecord['statements']
	}));
}

/** creates the replication log table if absent */
export function ensureReplicationLog(host: ReplicationLogHost): void {
	host.sql.exec(
		`CREATE TABLE IF NOT EXISTS cfw_repl_log (
        generation INTEGER PRIMARY KEY,
        parent INTEGER NOT NULL,
        schema_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        overflowed INTEGER NOT NULL DEFAULT 0,
        statements TEXT NOT NULL,
        sealed_at INTEGER NOT NULL
      ) WITHOUT ROWID`
	);
}

/**
 * The generation a copy may hand a replica: the last sealed record, not `commitSeq()`.
 *
 * The sequence can sit ahead of the last record (a lane copied at 86 meets a record from 85
 * and is withdrawn). The gap holds no statements, so resuming at the last record skips no
 * change.
 */
export function copyableGeneration(host: ReplicationLogHost): number {
	ensureReplicationLog(host);
	const row = firstRow(host.sql.exec(`SELECT MAX(generation) AS head FROM cfw_repl_log`)) as
		{ head: number | null } | undefined;
	const head = Number(row?.head ?? 0);
	return Number.isFinite(head) && head > 0 ? head : commitSeq(host);
}

/**
 * Advances the monotonic count of authoritative invalidations that a replica fences on.
 *
 * Separate from `generation`, a coalesced page-purge counter that stops moving once
 * `cfw_page` is empty (a permission grant invalidated two tags and left it still).
 */
export function advanceCommit(host: ReplicationLogHost): number {
	host.pendingCommits = (host.pendingCommits ?? 0) + 1;
	return commitSeq(host);
}

/** the stored commit sequence plus advances not yet persisted */
export function commitSeq(host: ReplicationLogHost): number {
	return Number(host.metaGet(COMMIT_SEQ_KEY, '0') ?? 0) + (host.pendingCommits ?? 0);
}

/**
 * Persists the invocation's commit advances as one row (a write per statement was 15% of a node
 * save's row cost). An invocation's writes commit together, so the counter cannot fall behind
 * the data it fences; the seal flushes unconditionally, since under-advancing serves stale
 * authorization.
 */
export function flushCommitSeq(host: ReplicationLogHost): void {
	if (!host.pendingCommits) return;
	const next = commitSeq(host);
	host.pendingCommits = 0;
	host.metaSet(COMMIT_SEQ_KEY, next);
}

/** whether this object holds a table at all; the restore's own precondition */
export function hasTable(host: ReplicationLogHost, table: string): boolean {
	return (
		host.sql
			.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
			.toArray().length > 0
	);
}

/**
 * The DDL that recreates one table, its own statement first and its indexes after.
 *
 * `sql IS NOT NULL` drops sqlite's auto-indexes, which have no statement and are recreated with
 * the table anyway.
 */
export function tableDdl(host: ReplicationLogHost, table: string): string[] {
	return host.sql
		.exec(
			`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL
				 ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`,
			table
		)
		.toArray()
		.map((r) => String((r as { sql: unknown }).sql));
}

/** every table this object holds, in `sqlite_master` order */
export function tableNames(host: ReplicationLogHost): string[] {
	return host.sql
		.exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
		.toArray()
		.map((r) => String((r as { name: unknown }).name));
}

/**
 * One page of one table, as columns plus flat rows.
 *
 * Uses `OFFSET` (a `WITHOUT ROWID` table has no rowid); unstable under a concurrent write,
 * which the receiving generation check refuses.
 * ponytail: O(n^2) over a whole table; a keyset cursor if a restore ever spans a large one
 */
export function snapshotRows(
	host: ReplicationLogHost,
	table: string,
	offset: number,
	limit: number
): { columns: string[]; rows: unknown[][] } {
	const verdict = planRestore([table])[0]!;
	if (!verdict.copy) throw new Error(`${table} is not copyable: ${verdict.reason}`);
	const raw = host.sql
		.exec(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, limit, offset)
		.toArray() as Record<string, unknown>[];
	if (raw.length === 0) return { columns: [], rows: [] };
	const columns = Object.keys(raw[0]!);
	return { columns, rows: raw.map((r) => columns.map((c) => r[c])) };
}

/**
 * Advances the commit sequence when a statement writes authoritative state.
 *
 * Keyed on the target table, not cache tags (a user create and a `system.private_key` rotation
 * write no tag). Every `key_value` write counts, which over-advances safely: too often costs a
 * refresh, too rarely serves stale authorization.
 */
export function noteAuthoritativeWrite(
	host: ReplicationLogHost,
	sql: string,
	params?: SqlBindings
): void {
	const table = writeTargetTable(sql);
	if (table === undefined) return;
	if (table === 'key_value' || table === 'key_value_expire') {
		advanceCommit(host);
		host.bufferForReplication(sql, params);
		return;
	}
	if (classifyState(table) === 'AUTHORITATIVE') {
		advanceCommit(host);
		host.bufferForReplication(sql, params);
	}
}
