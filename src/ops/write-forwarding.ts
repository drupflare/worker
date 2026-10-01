/**
 * How a lane accepts a write without committing it: run it locally, keep the statement list, roll
 * back, and forward the list to the primary, which sequences the commit.
 *
 * Two hazards survive that, and they are treated differently:
 *
 * - origination: the statement mints a value two objects would mint differently (an id from
 *   `sequences`, `system.private_key`); no ordering rule repairs it
 * - ordering: the statement updates something with a prior state, a lost update the log's parent
 *   generation already detects
 *
 * @module
 */

import { positionalBindings } from './replication-log';
import { classifyState } from './state-inventory';

/** what a statement's target risks when a lane runs it itself */
export type Hazard = 'origination' | 'ordering' | 'none';

/**
 * Whether a lane may execute writes and forward them, rather than refusing them.
 *
 * On unless `WRITE_FORWARD` is `0`; only reachable where a pool exists. With it off every POST pins
 * to the primary.
 */
export function writeForwardEnabled(env?: { WRITE_FORWARD?: string }): boolean {
	return String(env?.WRITE_FORWARD ?? '1') !== '0';
}

/**
 * Tables whose rows are an allocation rather than a value.
 *
 * Enumerated rather than matched: a false positive costs a needless partition, a miss costs a
 * silent id collision.
 */
const ALLOCATION_TABLES: ReadonlySet<string> = new Set(['sequences', 'sqlite_sequence']);

/**
 * What a lane risks by executing this statement's target itself.
 *
 * `UNKNOWN` from the classifier answers `origination`: an unclassified write forwarded as merely
 * ordered is the one that corrupts.
 */
export function hazardClass(table: string, collection?: string, name?: string): Hazard {
	if (table === '') return 'origination';
	if (ALLOCATION_TABLES.has(table)) return 'origination';
	const status = classifyState(table, collection, name);
	if (status === 'LOCAL_EPHEMERAL') return 'none';
	if (status === 'AUTHORITATIVE') {
		// site secrets are authoritative and minted lazily (origination, not ordering)
		return collection === 'state' ? 'origination' : 'ordering';
	}
	if (status === 'REPLICABLE_DERIVED') return 'ordering';
	return 'origination';
}

/**
 * The id stride a lane allocates on, so two lanes cannot mint the same one.
 *
 * Lane `n` of `lanes` takes every id congruent to `n` modulo `lanes + 1`; the primary is offset 0.
 * The sequence gains gaps, which Drupal tolerates.
 */
export function idStride(lane: number, lanes: number): { offset: number; stride: number } {
	const stride = Math.max(1, Math.floor(lanes) + 1);
	const offset = Math.max(0, Math.floor(lane)) % stride;
	return { offset, stride };
}

/**
 * The lane count every residue class is computed against.
 *
 * A constant rather than the pool size: a lane cannot read the primary's `lanes_provisioned`
 * (`cfw_meta` is replica-local), and a count read from env left the partition off on every deployed
 * pool. Set at {@link replicaCount}'s ceiling so every lane holds a distinct non-zero residue.
 */
export const ID_PARTITION_LANES = 256;

/** the next id this lane may mint at or above `after`, honouring its stride */
export function nextLaneId(after: number, lane: number, lanes: number): number {
	const { offset, stride } = idStride(lane, lanes);
	const floor = Math.max(0, Math.floor(after));
	const candidate = floor + 1;
	const shift = (((candidate - offset) % stride) + stride) % stride;
	return shift === 0 ? candidate : candidate + (stride - shift);
}

/** one statement of a forwarded batch */
export type ForwardStatement = {
	sql: string;
	params?: readonly unknown[];
	table?: string;
	/** the table the driver spliced a lane-minted rowid into; `Connection::supplyLaneRowid()` */
	minted?: string;
};

/**
 * The tables a batch may originate for, from what the driver says it actually minted.
 *
 * The driver reports a table only where it rewrote the insert to carry an id from this lane's
 * residue class. Nothing else qualifies: a high-water mark also matches
 * `INSERT INTO sequences (value) VALUES (7)`, which is the allocation the guard refuses. An
 * allocation table is dropped even when reported, since a rowid stride says nothing about a counter
 * whose value is the allocation.
 */
export function partitionedTables(statements: readonly ForwardStatement[]): string[] {
	const out = new Set<string>();
	for (const statement of statements) {
		const table = (statement.minted ?? '').toLowerCase();
		if (originable(table)) out.add(table);
	}
	return [...out].sort();
}

/**
 * Whether a reported table may stand on the allow-list at all; the primary re-applies this.
 *
 * A lane cannot mint for a table it does not hold: its residue class counts from the maximum in its
 * own copy, which is zero for a table the restore refuses to copy (`watchdog`), so it re-mints ids
 * the primary already used. Refusing sends the batch to the primary, which allocates.
 */
function originable(table: string): boolean {
	if (table === '' || ALLOCATION_TABLES.has(table)) return false;
	return classifyState(table) !== 'PRIMARY_ONLY_SIDE_EFFECT';
}

/** the `cfw_meta` key prefix a lane records a forwarded rowid under (mirrors the driver's) */
export const LANE_HIGH_PREFIX = 'lane_high:';

/** a plain single-row insert, as the column list and the value tuple */
const PLAIN_INSERT =
	/^\s*INSERT\s+(?:OR\s+[A-Za-z]+\s+)?INTO\s+"?[A-Za-z0-9_$]+"?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)/i;

/**
 * The highest rowid a lane minted per table in a batch the primary has just committed.
 *
 * The lane rolls its own copy back, so its table maximum does not move; the driver reads this mark
 * instead. `RowidPlan::withSuppliedRowid()` splices the minted id in as the first column and value,
 * so that position is read. Any insert with an integer first value counts too: a mark too high
 * costs an id gap, a missing one costs a duplicate id.
 */
export function laneHighWater(statements: readonly ForwardStatement[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const statement of statements) {
		// lower-cased to match the driver's `SqlAnalyzer::writtenTables()` keys
		const table = (statement.table ?? '').toLowerCase();
		if (table === '') continue;
		const tuple = PLAIN_INSERT.exec(statement.sql)?.[2];
		const first = tuple?.split(',')[0]?.trim() ?? '';
		if (!/^\d+$/.test(first)) continue;
		const id = Number(first);
		if (!Number.isSafeInteger(id) || id <= 0) continue;
		out.set(table, Math.max(out.get(table) ?? 0, id));
	}
	return out;
}

function tryBind(
	statement: ForwardStatement
): { sql: string; params: readonly unknown[] } | undefined {
	try {
		return positionalBindings(statement.sql, statement.params);
	} catch {
		return undefined;
	}
}

/** tables whose rows record a request, not its result; the primary appends them after the commit */
const DEFERRABLE_TABLES: ReadonlySet<string> = new Set(['watchdog']);

/** a whole single-row insert and nothing after it, so a trailing clause cannot ride along */
const WHOLE_INSERT =
	/^\s*INSERT\s+INTO\s+("?[A-Za-z0-9_$]+"?)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*;?\s*$/i;

/**
 * A disposable statement rewritten for the primary to run alone, or undefined to keep it.
 *
 * A dblog row made every lane login an origination refusal. A lane-minted id the driver spliced in
 * is dropped so the primary allocates its own; any other shape is refused as before.
 */
export function deferrable(statement: ForwardStatement): ForwardStatement | undefined {
	const table = (statement.table ?? '').toLowerCase();
	if (!DEFERRABLE_TABLES.has(table)) return undefined;
	// drupal binds by name; reduce to `?` first
	const bound = tryBind(statement);
	if (bound === undefined) return undefined;
	const match = WHOLE_INSERT.exec(bound.sql);
	if (!match) return undefined;
	const columns = (match[2] as string).split(',').map((c) => c.trim());
	const values = (match[3] as string).split(',').map((v) => v.trim());
	if (columns.length !== values.length) return undefined;
	if ((statement.minted ?? '').toLowerCase() === table) {
		if (!/^\d+$/.test(values[0] ?? '')) return undefined;
		columns.shift();
		values.shift();
	}
	if (values.length === 0 || !values.every((v) => v === '?')) return undefined;
	if (bound.params.length !== values.length) return undefined;
	return {
		sql: `INSERT INTO ${match[1]} (${columns.join(', ')}) VALUES (${values.join(', ')})`,
		params: bound.params,
		table
	};
}

/** a key_value upsert's column list and value tuple, with anything after the tuple allowed */
const KEY_VALUE_INSERT =
	/^\s*INSERT\s+(?:OR\s+[A-Za-z]+\s+)?INTO\s+"?key_value(?:_expire)?"?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i;

/**
 * The collection and key a `key_value` upsert writes, or undefined when the shape does not say.
 *
 * The table alone cannot be classified (one collection is a derived cache, another holds the
 * lazily minted site secrets). Only a plain upsert is read; anything else is refused.
 */
export function keyValueTarget(
	statement: ForwardStatement
): { collection: string; name: string } | undefined {
	if (!/^key_value(?:_expire)?$/i.test(statement.table ?? '')) return undefined;
	const bound = tryBind(statement);
	if (bound === undefined) return undefined;
	const match = KEY_VALUE_INSERT.exec(bound.sql);
	if (!match) return undefined;
	const columns = (match[1] as string).split(',').map((c) => c.trim().replace(/"/g, ''));
	const values = (match[2] as string).split(',').map((v) => v.trim());
	if (columns.length !== values.length || !values.every((v) => v === '?')) return undefined;
	const collection = bound.params[columns.indexOf('collection')];
	const name = bound.params[columns.indexOf('name')];
	if (typeof collection !== 'string' || typeof name !== 'string') return undefined;
	return { collection, name };
}

const TAG_INSERT =
	/^\s*INSERT\s+INTO\s+"?cachetags"?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*;?\s*$/i;
const TAG_UPDATE =
	/^\s*UPDATE\s+"?cachetags"?\s+SET\s+"?invalidations"?\s*=\s*"?invalidations"?\s*\+\s*1\s+WHERE\s+"?tag"?\s*=\s*\?\s*;?\s*$/i;

/**
 * A tag invalidation rewritten as the increment it means, or undefined when the shape is not one.
 *
 * Drupal's merge picks INSERT or UPDATE from the lane's own `cachetags`, so its branch can collide
 * with the primary's row; both branches add one invalidation.
 */
export function cacheTagIncrement(statement: ForwardStatement): ForwardStatement | undefined {
	if ((statement.table ?? '').toLowerCase() !== 'cachetags') return undefined;
	const bound = tryBind(statement);
	if (bound === undefined) return undefined;
	let tag: unknown;
	const insert = TAG_INSERT.exec(bound.sql);
	if (insert) {
		const columns = (insert[1] as string).split(',').map((c) => c.trim().replace(/"/g, ''));
		const values = (insert[2] as string).split(',').map((v) => v.trim());
		if (columns.length !== values.length || !values.every((v) => v === '?')) return undefined;
		tag = bound.params[columns.indexOf('tag')];
	} else if (TAG_UPDATE.test(bound.sql) && bound.params.length === 1) {
		tag = bound.params[0];
	}
	if (typeof tag !== 'string' || tag === '') return undefined;
	return {
		sql: 'INSERT INTO "cachetags" ("tag", "invalidations") VALUES (?, 1) ON CONFLICT ("tag") DO UPDATE SET "invalidations" = "invalidations" + 1',
		params: [tag],
		table: 'cachetags'
	};
}

/** a forwarded batch split into what the primary must sequence and what it may append afterwards */
export function splitForward(statements: readonly ForwardStatement[]): {
	commit: ForwardStatement[];
	deferred: ForwardStatement[];
} {
	const commit: ForwardStatement[] = [];
	const deferred: ForwardStatement[] = [];
	for (const statement of statements) {
		const later = deferrable(statement);
		if (later) deferred.push(later);
		else commit.push(cacheTagIncrement(statement) ?? statement);
	}
	return { commit, deferred };
}

/** the primary's verdict on a forwarded batch */
export type ForwardPlan =
	| { action: 'commit'; reason: '' }
	| { action: 'conflict'; reason: string }
	| { action: 'refuse'; reason: string };

/**
 * Whether the primary may commit a batch a lane executed speculatively.
 *
 * The parent check is the whole ordering guarantee: a batch built on a generation the primary has
 * moved past is a lost update. An origination hazard is refused rather than conflicted, since a
 * retry cannot fix it.
 */
export function planForward(input: {
	statements: readonly ForwardStatement[];
	parent: number;
	primaryGeneration: number;
	/**
	 * tables the lane may originate for, from what its driver reported minting
	 *
	 * Built by {@link partitionedTables} and re-filtered here because it crosses the wire.
	 */
	partitioned?: readonly string[];
}): ForwardPlan {
	if (!Number.isFinite(input.parent) || input.parent < 0) {
		return { action: 'refuse', reason: 'the batch carries no readable parent generation' };
	}
	if (!Array.isArray(input.statements) || input.statements.length === 0) {
		return { action: 'refuse', reason: 'the batch carries no statements' };
	}

	// re-filtered, not trusted: an allocation table admitted on the sender's word is a collision
	const partitioned = new Set(
		(input.partitioned ?? []).map((table) => table.toLowerCase()).filter(originable)
	);
	for (const statement of input.statements) {
		const table = statement.table ?? '';
		if (partitioned.has(table.toLowerCase())) continue;
		const key = keyValueTarget(statement);
		if (hazardClass(table, key?.collection, key?.name) === 'origination') {
			const what = key ? `${table}:${key.collection}` : table || 'an unnamed table';
			return { action: 'refuse', reason: `${what} originates a value a lane may not mint` };
		}
	}

	if (input.parent !== input.primaryGeneration) {
		return {
			action: 'conflict',
			reason: `the lane read generation ${input.parent} and the primary is at ${input.primaryGeneration}`
		};
	}

	return { action: 'commit', reason: '' };
}
