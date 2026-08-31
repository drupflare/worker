/**
 * How a lane can accept a write without being able to commit one.
 *
 * A read replica refuses every authoritative write, which makes a pool useless to a site whose
 * bottleneck is saves. The refusal is broader than the danger: the expensive part of a Drupal write
 * is form processing, validation, entity hooks and the response render, none of which is
 * authoritative. Only the commit has to be serialised.
 *
 * The driver already withholds writes and replays them in one `transactionSync`, and
 * `execTxn({commit: false})` replays a buffer, reads through it and rolls back. So a lane can run the
 * whole write locally, keep the statement list, discard its own effect, and forward the list to the
 * primary. The primary is the sequencer; the lane is the worker.
 *
 * Two hazards survive that, and they need different treatment:
 *
 * - ORIGINATION: the statement mints a value two objects would mint differently and both would look
 *   valid. An id from `sequences`, `system.private_key`. No ordering rule repairs it, because there
 *   is no prior state to compare against.
 * - ORDERING: the statement updates something with a definite prior state. A lost update, which the
 *   log's parent generation already detects.
 */

import { classifyState } from './state-inventory.js';

export type Hazard = 'origination' | 'ordering' | 'none';

/**
 * Whether a lane may execute writes and forward them, rather than refusing them.
 *
 * ON unless explicitly `0`, and reachable only where a pool already exists: every caller is behind
 * `isPoolLane()` or a non-zero `REPLICA_COUNT`, both of which are off by default. So a site with no
 * pool is not affected by this value at all, and a site that opted into a pool gets the writes
 * spread rather than a pool that only helps reads.
 *
 * The refusal it replaces was not free. With forwarding off a POST pins to the primary, so the one
 * object the pool exists to relieve keeps every form submission, and the lanes idle through exactly
 * the load that made the operator add them.
 */
export function writeForwardEnabled(env?: { WRITE_FORWARD?: string | null }): boolean {
	return String(env?.WRITE_FORWARD ?? '1') !== '0';
}

/**
 * Tables whose rows are an ALLOCATION rather than a value.
 *
 * Two objects allocating from their own copy mint the same id for different rows, and nothing errors
 * until the rows meet. Enumerated rather than matched: a pattern that wrongly calls something an
 * allocation costs a partition it did not need, and one that misses an allocation costs silent
 * collision.
 */
const ALLOCATION_TABLES: ReadonlySet<string> = new Set(['sequences', 'sqlite_sequence']);

/**
 * What a lane risks by executing this statement's target itself.
 *
 * `UNKNOWN` from the classifier answers `origination`, the strictest verdict, for the same reason the
 * restore copies an unknown table: the direction that fails safely differs by question, and here an
 * unclassified write forwarded as merely ordered is the one that corrupts.
 */
export function hazardClass(table: string, collection?: string, name?: string): Hazard {
	if (table === '') return 'origination';
	if (ALLOCATION_TABLES.has(table)) return 'origination';
	const status = classifyState(table, collection, name);
	if (status === 'LOCAL_EPHEMERAL') return 'none';
	if (status === 'AUTHORITATIVE') {
		// the installation-global secrets are authoritative AND minted lazily, so they are the
		// origination case rather than the ordering one
		return collection === 'state' ? 'origination' : 'ordering';
	}
	if (status === 'REPLICABLE_DERIVED') return 'ordering';
	return 'origination';
}

/**
 * The id stride a lane allocates on, so two lanes cannot mint the same one.
 *
 * Lane `n` of `lanes` takes every id congruent to `n` modulo `lanes + 1`; the primary is offset 0.
 * The sequence gains gaps, which Drupal tolerates because an entity id is opaque. This is the same
 * arrangement multi-primary MySQL uses for `auto_increment_offset`.
 */
export function idStride(lane: number, lanes: number): { offset: number; stride: number } {
	const stride = Math.max(1, Math.floor(lanes) + 1);
	const offset = Math.max(0, Math.floor(lane)) % stride;
	return { offset, stride };
}

/** the next id this lane may mint at or above `after`, honouring its stride */
export function nextLaneId(after: number, lane: number, lanes: number): number {
	const { offset, stride } = idStride(lane, lanes);
	const floor = Math.max(0, Math.floor(after));
	const candidate = floor + 1;
	const shift = (((candidate - offset) % stride) + stride) % stride;
	return shift === 0 ? candidate : candidate + (stride - shift);
}

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
 * residue class, so a value on this list cannot collide with another writer's. Nothing else
 * qualifies: a high-water mark reads the first value of any plain insert's tuple, which
 * `INSERT INTO sequences (value) VALUES (7)` matches, and admitting a table on that basis would
 * authorise the exact allocation the guard exists to refuse.
 *
 * An allocation table is dropped even when reported, because a rowid stride says nothing about a
 * counter whose VALUE is the allocation rather than its rowid.
 */
export function partitionedTables(statements: readonly ForwardStatement[]): string[] {
	const out = new Set<string>();
	for (const statement of statements) {
		const table = (statement.minted ?? '').toLowerCase();
		if (originable(table)) out.add(table);
	}
	return [...out].sort();
}

/** whether a reported table may stand on the allow-list at all; the primary re-applies this */
function originable(table: string): boolean {
	return table !== '' && !ALLOCATION_TABLES.has(table);
}

/** the `cfw_meta` key prefix a lane records a forwarded rowid under; `LANE_HIGH_PREFIX` in the driver */
export const LANE_HIGH_PREFIX = 'lane_high:';

/** a plain single-row insert, as the column list and the value tuple */
const PLAIN_INSERT =
	/^\s*INSERT\s+(?:OR\s+[A-Za-z]+\s+)?INTO\s+"?[A-Za-z0-9_$]+"?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)/i;

/**
 * The highest rowid a lane minted per table in a batch the primary has just committed.
 *
 * The lane rolls its own copy of the write back and the batch is never applied here, so this
 * object's table maximum does not move for a row it successfully forwarded and the next insert
 * computes the same base. This is what the driver reads instead.
 *
 * `RowidPlan::withSuppliedRowid()` splices the minted id in as the FIRST column and the first value
 * of the tuple, so that position is what is read back. Any other insert whose first value is an
 * integer literal is read as one too: a mark that is too high costs a gap in the id space, and a
 * missing one costs the same id twice.
 */
export function laneHighWater(statements: readonly ForwardStatement[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const statement of statements) {
		// lower-cased because the driver keys the mark off `SqlAnalyzer::writtenTables()`, which
		// normalises, and `writeTargetTable()` does not
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

export type ForwardPlan =
	| { action: 'commit'; reason: '' }
	| { action: 'conflict'; reason: string }
	| { action: 'refuse'; reason: string };

/**
 * Whether the primary may commit a batch a lane executed speculatively.
 *
 * The parent check is optimistic concurrency and it is the whole ordering guarantee: the lane read a
 * database at `parent`, so a batch built on anything the primary has moved past is a lost update
 * wearing a successful response.
 *
 * An origination hazard is refused rather than conflicted, because a retry cannot fix it.
 */
export function planForward(input: {
	statements: readonly ForwardStatement[];
	parent: number;
	primaryGeneration: number;
	/**
	 * tables the lane may originate for, from what its DRIVER reported minting.
	 *
	 * Built by {@link partitionedTables} on the lane and re-filtered here, because this crosses the
	 * wire. Nothing derived from the statement text belongs on it.
	 */
	partitioned?: readonly string[];
}): ForwardPlan {
	if (!Number.isFinite(input.parent) || input.parent < 0) {
		return { action: 'refuse', reason: 'the batch carries no readable parent generation' };
	}
	if (!Array.isArray(input.statements) || input.statements.length === 0) {
		return { action: 'refuse', reason: 'the batch carries no statements' };
	}

	// re-filtered rather than trusted: the list arrives over the wire from a lane, and an allocation
	// table admitted because the sender said so is the collision this refuses
	const partitioned = new Set(
		(input.partitioned ?? []).map((table) => table.toLowerCase()).filter(originable)
	);
	for (const statement of input.statements) {
		const table = statement.table ?? '';
		if (partitioned.has(table.toLowerCase())) continue;
		if (hazardClass(table) === 'origination') {
			return {
				action: 'refuse',
				reason: `${table || 'an unnamed table'} originates a value a lane may not mint`
			};
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
