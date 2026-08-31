/**
 * The bulk copy that gets a replica from empty to `VERIFIED`, and what it must refuse.
 *
 * The log carries changes and cannot carry a beginning: `planApply()` needs each record to build on
 * the one before it, so an empty object can never reach a primary at generation 900.
 *
 * The primary keeps serving while its rows are read, so a copy spanning several invocations can hold
 * table A at generation 12 and table B at 13 -- a state the primary was never in, which no
 * generation number describes. Every chunk states the generation it was read at, a chunk that
 * disagrees is refused, and the position stays in-flight until a whole consistent copy lands.
 */

import { classifyState, type StateStatus } from './state-inventory.js';

/** sqlite's own bookkeeping; absent from a replica by construction rather than by omission */
const SQLITE_INTERNAL = /^sqlite_/;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The bound-parameter ceiling on Durable Object SQLite.
 *
 * A row is inserted on its own rather than batched, so this binds the COLUMN count. No Drupal table
 * comes close; the guard exists because exceeding it fails at the driver with a message that says
 * nothing about which table was being copied.
 */
export const MAX_BOUND_PARAMS = 100;

export type TableVerdict = {
	table: string;
	status: StateStatus;
	copy: boolean;
	reason: string;
};

/**
 * Which of the primary's tables belong on a replica.
 *
 * `UNKNOWN` is copied, the opposite of the request-time rule. An unclassified table that routes a
 * request to the primary costs capacity; one missing from a restore costs the replica whatever it
 * held, with no error until something reads it. Every copied unknown is named in the plan.
 */
export function planRestore(tables: readonly string[]): TableVerdict[] {
	const out: TableVerdict[] = [];
	for (const table of tables) {
		if (SQLITE_INTERNAL.test(table)) {
			out.push({ table, status: 'UNKNOWN', copy: false, reason: "sqlite's own bookkeeping" });
			continue;
		}
		if (!IDENTIFIER.test(table)) {
			out.push({ table, status: 'UNKNOWN', copy: false, reason: 'not a plain identifier' });
			continue;
		}
		const status = classifyState(table);
		if (status === 'LOCAL_EPHEMERAL') {
			out.push({ table, status, copy: false, reason: 'the replica owns its own' });
			continue;
		}
		if (status === 'PRIMARY_ONLY_SIDE_EFFECT') {
			out.push({
				table,
				status,
				copy: false,
				reason: 'an effect a replica must never perform'
			});
			continue;
		}
		out.push({
			table,
			status,
			copy: true,
			reason: status === 'UNKNOWN' ? 'unclassified, so copied and reported' : ''
		});
	}
	return out;
}

/** one table's rows as read from the primary at one generation */
export type RestoreChunk = {
	/** the primary's commit generation when these rows were read */
	generation: number;
	/** the pack generation both sides must agree on */
	schemaVersion: string;
	table: string;
	columns: readonly string[];
	rows: readonly (readonly unknown[])[];
	/** the first chunk for this table; existing rows are cleared before it lands */
	first?: boolean;
	/**
	 * The table's own DDL and its indexes, applied only when the replica lacks the table.
	 *
	 * Drupal's installer creates tables the packed migration does not (`batch` found this), so a lane
	 * built from the pack alone fails every insert with `no such table`. Carrying the DDL lets a lane
	 * exist without a second Drupal install on it.
	 */
	ddl?: readonly string[];
	/**
	 * On the first chunk: every table the copy will deliver.
	 *
	 * `done` is a claim the driver makes, and the mandatory set catches only a missing identity. A
	 * copy that stopped after `config` has a valid private key and no content.
	 */
	expect?: readonly string[];
	/** the last chunk of the whole copy */
	done?: boolean;
};

/**
 * Why this chunk cannot land, or null.
 *
 * @param begunAt
 *   The generation the restore in progress started at, or null when none has started. A mismatch is
 *   a torn copy and is the refusal this exists for.
 */
export function chunkRefusal(
	chunk: RestoreChunk,
	localSchema: string | null,
	begunAt: number | null
): string | null {
	if (!IDENTIFIER.test(chunk.table ?? '')) return 'the chunk names no copyable table';
	const verdict = planRestore([chunk.table])[0]!;
	if (!verdict.copy) return `${chunk.table} is not copyable: ${verdict.reason}`;

	if (!Array.isArray(chunk.columns) || chunk.columns.length === 0) {
		return 'the chunk carries no columns';
	}
	if (chunk.columns.length > MAX_BOUND_PARAMS) {
		return `${chunk.table} has ${chunk.columns.length} columns, past the ${MAX_BOUND_PARAMS} bound-parameter limit`;
	}
	for (const column of chunk.columns) {
		if (!IDENTIFIER.test(column ?? ''))
			return `${chunk.table} names a column that is not an identifier`;
	}
	if (!Array.isArray(chunk.rows)) return 'the chunk carries no row list';
	for (const row of chunk.rows) {
		if (!Array.isArray(row) || row.length !== chunk.columns.length) {
			return `${chunk.table} carries a row of the wrong width`;
		}
	}

	if (localSchema === null || chunk.schemaVersion !== localSchema) {
		return `schema mismatch: chunk ${chunk.schemaVersion}, replica ${localSchema ?? 'unknown'}`;
	}
	if (!Number.isFinite(chunk.generation) || chunk.generation < 0) {
		return 'the chunk carries a generation that is not a number';
	}
	if (begunAt !== null && chunk.generation !== begunAt) {
		return `torn copy: the restore began at generation ${begunAt} and this chunk was read at ${chunk.generation}`;
	}
	return null;
}

/**
 * Where a bounded copy got to, handed back rather than stored on the primary.
 *
 * `generation` is the one the copy began at, so a commit part-way through is reported here rather
 * than surfacing as a refusal from the far end.
 */
export type ProvisionCursor = { generation: number; index: number; offset: number };

export type ProvisionOutcome = {
	ok: boolean;
	reason: string;
	/** whether the whole copy has landed; a lane reaches `VERIFIED` on the chunk that sets this */
	done: boolean;
	/** absent when done, so a caller cannot resume a finished copy by accident */
	cursor?: ProvisionCursor;
	copied?: number;
	stage?: string;
	/** the primary committed mid-copy; restart rather than resume */
	torn?: boolean;
};

/** the statements that land one chunk, in order; the caller runs them in one transaction */
export function restoreStatements(
	chunk: RestoreChunk
): { sql: string; params: readonly unknown[] }[] {
	const table = `"${chunk.table}"`;
	const out: { sql: string; params: readonly unknown[] }[] = [];
	if (chunk.first === true) out.push({ sql: `DELETE FROM ${table}`, params: [] });
	const columns = chunk.columns.map((c) => `"${c}"`).join(', ');
	const holes = chunk.columns.map(() => '?').join(', ');
	const sql = `INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${holes})`;
	for (const row of chunk.rows) out.push({ sql, params: row });
	return out;
}
