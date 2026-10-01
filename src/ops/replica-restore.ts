/**
 * The bulk copy that gets a replica from empty to `VERIFIED`, and what it must refuse.
 *
 * The log carries changes, not a beginning (`planApply()` needs each record to build on the last).
 * The primary keeps serving during a multi-invocation copy, so tables could land at different
 * generations; every chunk states its read generation and a disagreeing chunk is refused.
 * @module
 */
import { classifyState, type StateStatus } from './state-inventory';

/** sqlite's own bookkeeping; absent from a replica by construction */
const SQLITE_INTERNAL = /^sqlite_/;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The bound-parameter ceiling on Durable Object SQLite; rows insert singly, so it binds the column
 * count (the driver's own error names no table).
 */
export const MAX_BOUND_PARAMS = 100;

/** whether a table is copied to a replica, and why */
export type TableVerdict = {
	table: string;
	status: StateStatus;
	copy: boolean;
	reason: string;
};

/**
 * Locally-owned tables seeded anyway so a lane starts warm. Enumerated, since each needs an
 * argument that a stale copy meets an invalidation the lane receives (`purgeAfterApply()`).
 * Unseeded, anon-cached went from 2 ms at c=1 to 405 ms at c=4: every lane request met an empty
 * page store (82% of traffic weight).
 */
const SEED_ON_RESTORE: ReadonlySet<string> = new Set(['cfw_page']);

/**
 * Which of the primary's tables belong on a replica.
 * `UNKNOWN` is copied, the opposite of the request-time rule: a table missing from a restore fails
 * silently on first read. Every copied unknown is named in the plan.
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
			const seeded = SEED_ON_RESTORE.has(table);
			out.push({
				table,
				status,
				copy: seeded,
				reason: seeded
					? "the replica owns its own, but starts from the primary's"
					: 'the replica owns its own'
			});
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
	 * The table's DDL and indexes, applied only when the replica lacks the table (the installer
	 * makes tables the pack lacks, so a pack-only lane fails with `no such table`).
	 */
	ddl?: readonly string[];
	/** on the first chunk: every table the copy delivers (`done` alone passes a copy cut short) */
	expect?: readonly string[];
	/**
	 * On the first chunk: the origin the primary renders against.
	 * Drupal derives the session cookie name from the host, and `cfw_meta` is lane-local, so a lane
	 * pinned its first caller's host (`https://arm.invalid` on a deployed 32-lane pool) and
	 * rendered every session anonymous. Authoritative site state: a lane inherits it, never mints.
	 */
	origin?: string;
	/**
	 * On the first chunk: the primary's hash salt (signs form tokens, login links and
	 * `Crypt::hmacBase64` keys); lanes each minted their own and the primary refused their forms.
	 */
	hashSalt?: string;
	/** the last chunk of the whole copy */
	done?: boolean;
};

/**
 * Why this chunk cannot land, or null.
 *
 * @param begunAt the generation the restore began at, or null; a mismatch is a torn copy
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

/** where a bounded copy got to, handed back rather than stored; `generation` is where it began */
export type ProvisionCursor = { generation: number; index: number; offset: number };

/** the result of one bounded provisioning step */
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
