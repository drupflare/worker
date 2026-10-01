import { type SqlBindings, toPositional } from '@drupflare/durabledb/do-sqlite';
import { writeTargetTable } from '../db/write-tally';
import { statementAllowedOnReplica } from '../ops/replica';
import { admissionVerdict, type ReplicaStage } from '../ops/replica-admission';
import { chunkRefusal, type RestoreChunk, restoreStatements } from '../ops/replica-restore';
import { replicaOf } from '../ops/replica-routing';
import {
	applyRecord,
	landPosition,
	type LogRecord,
	markInflight,
	positionTrust,
	readPosition
} from '../ops/replication-log';
import { ORIGIN_KEY, pinnable } from '../ops/site-origin';
import { assertSalt, HASH_SALT_KEY } from '../ops/site-secrets';
import { fingerprintState, readStateRows } from '../ops/state-fingerprint';
import { partitionedTables } from '../ops/write-forwarding';
import type { SitePhpDurableObject } from '../site-do';
import {
	COMMIT_SEQ_KEY,
	READMIT_ASKS_KEY,
	RESTORE_EXPECT_KEY,
	RESTORE_GENERATION_KEY,
	RESTORE_SEEN_KEY
} from './keys';
import { REPLICATION_RECORD_MAX_STATEMENTS } from './limits';
import type { ForwardOutcome } from './types';

/**
 * Keeps a forwarded statement, with the table the tally attributes it to.
 *
 * The parent generation is pinned on the first statement of an invocation (the generation this
 * lane read at); the primary refuses a batch built on one it has moved past.
 */
export function collectForward(
	site: SitePhpDurableObject,
	statements: readonly string[],
	payload: unknown
): void {
	const body = (() => {
		try {
			return JSON.parse(String(payload)) as {
				statements?: { sql?: string; params?: unknown[]; minted?: string }[];
			};
		} catch (e) {
			site.noteError('collectForward', e);
			return undefined;
		}
	})();
	if (site.forwardParent === undefined) site.forwardParent = site.commitSeq();
	site.forwardBuffer ??= [];
	for (const statement of body?.statements ?? []) {
		if (typeof statement?.sql !== 'string') continue;
		if (statementAllowedOnReplica(statement.sql)) continue;
		site.forwardBuffer.push({
			sql: statement.sql,
			params: (statement.params ?? []) as unknown[],
			table: writeTargetTable(statement.sql) ?? '',
			// the driver's own report of an id minted from this lane's residue class (see
			// `partitionedTables()`)
			...(typeof statement.minted === 'string' && statement.minted !== ''
				? { minted: statement.minted }
				: {})
		});
	}
	void statements;
}

/**
 * Sends this invocation's collected writes to the primary, once.
 *
 * A conflict is retried once after re-reading the generation (usually another lane committed in
 * between); a second conflict is a contended row, and retrying again would spin.
 */
export async function flushForward(
	site: SitePhpDurableObject
): Promise<ForwardOutcome | undefined> {
	const batch = site.forwardBuffer;
	const parent = site.forwardParent;
	site.forwardBuffer = undefined;
	site.forwardParent = undefined;
	if (batch === undefined || batch.length === 0 || parent === undefined) return undefined;

	const lane = replicaOf(site.ctx.id.name ?? '');
	const ns = site.env?.SITE;
	if (lane === undefined || !ns) {
		return { action: 'refuse', reason: 'no primary to forward to' };
	}
	const primary = ns.get(ns.idFromName(lane.site));

	type Answer = {
		action: string;
		reason: string;
		generation?: number;
		primaryGeneration?: number;
	};
	// what the driver minted, not what the statements look like (`laneHighWater()` would admit a
	// table this lane never originated an id for)
	const partitioned = partitionedTables(batch);
	const send = async (at: number): Promise<Answer> => {
		const res = await primary.fetch(
			new Request('https://do.local/__replica?action=forward', {
				method: 'POST',
				body: JSON.stringify({ statements: batch, parent: at, partitioned }),
				headers: { 'content-type': 'application/json' }
			})
		);
		return (await res.json()) as Answer;
	};

	const first = await send(parent);
	// the retry re-sends the same statements, rowids included; safe because every writer mints
	// from its own residue class (`idPartition()`), so no concurrent commit took one of these ids
	const answer =
		first.action === 'conflict' && Number.isFinite(first.primaryGeneration)
			? await send(first.primaryGeneration!)
			: first;
	if (answer.action === 'commit') site.markLaneHigh(batch);
	return answer;
}

/**
 * Lands one chunk of a bulk copy on this replica.
 *
 * The first chunk marks the position in-flight; it clears only when the whole copy and the
 * mandatory set have landed, so an interrupted restore reads as untrusted, not as a low generation.
 * `VERIFIED` is reached only from {@link missingMandatory} being empty.
 */
export function applyRestoreChunk(
	site: SitePhpDurableObject,
	chunk: RestoreChunk
): {
	ok: boolean;
	reason: string;
	stage: ReplicaStage;
	statements: number;
	missing: string[];
} {
	const stage = site.replicaStage();
	const begunRaw = site.metaGet(RESTORE_GENERATION_KEY);
	const begunAt = begunRaw === null || begunRaw === '' ? null : Number(begunRaw);
	const refusal = chunkRefusal(chunk, site.packGeneration() ?? null, begunAt);
	if (refusal !== null) {
		return { ok: false, reason: refusal, stage, statements: 0, missing: [] };
	}

	if (begunAt === null) {
		site.metaSet(RESTORE_GENERATION_KEY, chunk.generation);
		site.metaSet(RESTORE_EXPECT_KEY, (chunk.expect ?? []).join(','));
		// inherited, never observed (see `RestoreChunk.origin`); else the session cookie name
		// differs from the primary's and every visitor is uid 0
		if (pinnable(chunk.origin)) site.metaSet(ORIGIN_KEY, chunk.origin!);
		// inherited likewise; the running interpreter baked the old salt into settings.php
		if (typeof chunk.hashSalt === 'string' && chunk.hashSalt !== '') {
			assertSalt(chunk.hashSalt);
			if (site.metaGet(HASH_SALT_KEY) !== chunk.hashSalt) {
				site.metaSet(HASH_SALT_KEY, chunk.hashSalt);
				site.php = undefined;
			}
		}
		site.metaSet(RESTORE_SEEN_KEY, '');
		markInflight(site.logStore(), site.commitSeq(), chunk.generation);
		if (stage === 'CREATED') site.setReplicaStage('RESTORING');
		// the ask was answered; clear its backoff so a second withdrawal asks promptly
		site.metaSet(READMIT_ASKS_KEY, '');
	}

	// before the statements: the first is a DELETE and a missing table fails it
	if (chunk.first === true && !site.hasTable(chunk.table)) {
		for (const sql of chunk.ddl ?? []) site.sql.exec(sql);
	}

	const statements = restoreStatements(chunk);
	site.storage.transactionSync(() => {
		for (const s of statements) site.sql.exec(s.sql, ...s.params);
	});
	const seen = site.restoreList(RESTORE_SEEN_KEY);
	if (!seen.includes(chunk.table)) {
		site.metaSet(RESTORE_SEEN_KEY, [...seen, chunk.table].join(','));
	}

	if (chunk.done !== true) {
		return {
			ok: true,
			reason: '',
			stage: site.replicaStage(),
			statements: statements.length,
			missing: []
		};
	}

	// a `done` on the wrong chunk must not verify a partial copy (the mandatory set only catches a
	// missing identity, so a copy that stopped after `config` would read as a working site)
	const landed = site.restoreList(RESTORE_SEEN_KEY);
	const uncopied = site.restoreList(RESTORE_EXPECT_KEY).filter((t) => !landed.includes(t));
	const missing = [...site.mandatoryGap(), ...uncopied.map((t) => `table:${t}`)];
	if (missing.length > 0) {
		// the marker stays; a copy missing values a replica cannot mint is not finished
		return {
			ok: false,
			reason: `restore incomplete: ${missing.join(', ')}`,
			stage: site.replicaStage(),
			statements: statements.length,
			missing
		};
	}

	landPosition(site.logStore(), chunk.generation);
	site.metaSet(COMMIT_SEQ_KEY, chunk.generation);
	site.clearRestore();
	site.setReplicaStage('VERIFIED');
	return {
		ok: true,
		reason: '',
		stage: site.replicaStage(),
		statements: statements.length,
		missing: []
	};
}

/**
 * Pulls one batch of the primary's log and applies it, then re-decides admission.
 *
 * The replica pulls because a push would make the primary own delivery state for every lane and
 * spend invocations on lanes that are down. Two hops per round: `/__replica` for what the primary
 * advertises, then `action=log`. Promotion goes through {@link admissionVerdict}, which resolves
 * every unknown toward the primary, so a null fingerprint on either side refuses.
 */
export async function catchUpOnce(
	site: SitePhpDurableObject,
	limit = 25
): Promise<{
	ran: boolean;
	reason: string;
	applied: number;
	advertised: number;
	records: number;
	stage: ReplicaStage;
	admitted: boolean;
}> {
	const stage = site.replicaStage();
	const idle = {
		ran: false,
		applied: site.commitSeq(),
		advertised: 0,
		records: 0,
		stage,
		admitted: false
	};

	const lane = replicaOf(site.ctx.id.name ?? '');
	if (lane === undefined) return { ...idle, reason: 'not a pool lane' };
	const ns = site.env?.SITE;
	if (!ns) return { ...idle, reason: 'the namespace is not bound' };
	// a log cannot repair CREATED, RESTORING or WITHDRAWN
	if (stage === 'CREATED' || stage === 'RESTORING' || stage === 'WITHDRAWN') {
		return { ...idle, reason: `stage ${stage} needs a restore, not a log` };
	}

	const position = readPosition(site.logStore());
	const trust = positionTrust(position);
	if (!trust.trusted) {
		// an untrusted position is not resumable (the marker names the generation, not which chunks
		// committed), so withdraw and wait for a restore
		site.setReplicaStage('WITHDRAWN');
		return { ...idle, reason: trust.reason, stage: site.replicaStage() };
	}

	const primary = ns.get(ns.idFromName(lane.site));
	const head = (await (
		await primary.fetch(new Request('https://do.local/__replica'))
	).json()) as {
		generation: number;
		fingerprint: string | null;
		schemaVersion: string | null;
	};

	let applied = position.applied;
	let records = 0;
	if (applied < head.generation) {
		if (site.replicaStage() === 'VERIFIED') site.setReplicaStage('CATCHING_UP');
		const batch = (await (
			await primary.fetch(
				new Request(`https://do.local/__replica?action=log&since=${applied}&limit=${limit}`)
			)
		).json()) as { records: LogRecord[] };
		for (const record of batch.records) {
			const outcome = applyRecord(site.logStore(), record, {
				localSchema: site.packGeneration()
			});
			if (outcome.action === 'refuse') {
				// a refusal ends the batch but does not undo the records ahead of it, which still
				// owe the loop's normal bookkeeping
				if (applied > position.applied) {
					site.metaSet(COMMIT_SEQ_KEY, applied);
					site.purgeAfterApply();
				}
				// separate from `lastCatchUp`, which readmission overwrites on the next firing
				site.lastWithdrawal = {
					reason: outcome.reason,
					generation: record.generation,
					applied,
					at: site.nowMs()
				};
				site.setReplicaStage('WITHDRAWN');
				return {
					ran: true,
					reason: `refused generation ${record.generation}: ${outcome.reason}`,
					applied,
					advertised: head.generation,
					records,
					stage: site.replicaStage(),
					admitted: false
				};
			}
			if (outcome.action === 'apply') records++;
			applied = outcome.applied;
		}
		site.metaSet(COMMIT_SEQ_KEY, applied);
		// the lane holds its own copies of the derived caches the primary purged on write
		if (applied > position.applied) site.purgeAfterApply();
	}

	const read = readStateRows((sql) => site.sql.exec(sql).toArray());
	const verdict = admissionVerdict({
		stage: site.replicaStage(),
		presentState: read.rows.map((r) => ({ collection: r.collection, name: r.name })),
		presentCollections: [...new Set(read.rows.map((r) => r.collection))],
		appliedGeneration: applied,
		advertisedGeneration: head.generation,
		fingerprint: await fingerprintState(read.rows),
		primaryFingerprint: head.fingerprint,
		schemaVersion: site.packGeneration() ?? null,
		primarySchemaVersion: head.schemaVersion
	});

	if (verdict.admitted) {
		// each move is one legal step; a lane that arrives here from VERIFIED walks all three
		for (const to of ['CATCHING_UP', 'ELIGIBLE', 'SERVING'] as const) {
			site.setReplicaStage(to);
		}
	}

	return {
		ran: true,
		reason: verdict.admitted ? '' : verdict.refusals.join('; '),
		applied,
		advertised: head.generation,
		records,
		stage: site.replicaStage(),
		admitted: verdict.admitted
	};
}

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
