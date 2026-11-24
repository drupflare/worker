/** the one-row table holding the last abort; created by the first abort, by nothing else */
export const FRESH_FIRST_TABLE = 'cfw_fresh_first';

/**
 * The isolate as `/serve-stats` `isolateBytes` reads it at one moment: the whole-isolate estimate,
 * the current interpreter's linear memory, how many interpreters the isolate still references and
 * the bytes of a dropped memory held for reuse.
 */
export interface IsolateReading {
	totalBytes: number;
	linearBytes: number;
	interpreters: number;
	spareBytes: number;
}

/** how the repeat that followed an abort ended: a response, a governor refusal or another error */
export type FreshFirstEnd = 'ok' | 'refused' | 'error';

/** the stored record of the last abort and the count of all of them */
export interface FreshFirstRecord {
	count: number;
	last: {
		at: number;
		route: string;
		heapBeforeBytes: number;
		/** when the repeat on the new isolate finished; null while the abort has not been repeated */
		completedAt: number | null;
		before: IsolateReading;
		done: IsolateReading | null;
		/** how the repeat ended once it completed; null before */
		end: FreshFirstEnd | null;
	} | null;
}

function tableExists(sql: SqlStorage): boolean {
	return (
		sql
			.exec(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
				FRESH_FIRST_TABLE
			)
			.toArray().length > 0
	);
}

/**
 * Stores that the object is about to abort for a route, and bumps the count.
 *
 * Written and synced before the abort, so it survives it. An abort writes this row and the repeat
 * updates it once: two rows written.
 */
export function recordFreshFirst(
	sql: SqlStorage,
	abort: { at: number; route: string; heapBeforeBytes: number; before: IsolateReading }
): void {
	if (!tableExists(sql)) {
		sql.exec(
			`CREATE TABLE ${FRESH_FIRST_TABLE} (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				count INTEGER NOT NULL,
				at INTEGER NOT NULL,
				route TEXT NOT NULL,
				heap_before INTEGER NOT NULL,
				completed_at INTEGER,
				before_total INTEGER NOT NULL,
				before_linear INTEGER NOT NULL,
				before_interpreters INTEGER NOT NULL,
				before_spare INTEGER NOT NULL,
				done_total INTEGER,
				done_linear INTEGER,
				done_interpreters INTEGER,
				done_spare INTEGER,
				end TEXT
			)`
		);
	}
	sql.exec(
		`INSERT INTO ${FRESH_FIRST_TABLE}
			(id, count, at, route, heap_before, completed_at, before_total, before_linear,
			 before_interpreters, before_spare)
		 VALUES (1, 1, ?, ?, ?, NULL, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET count = count + 1, at = excluded.at, route = excluded.route,
			heap_before = excluded.heap_before, completed_at = NULL,
			before_total = excluded.before_total, before_linear = excluded.before_linear,
			before_interpreters = excluded.before_interpreters,
			before_spare = excluded.before_spare, done_total = NULL, done_linear = NULL,
			done_interpreters = NULL, done_spare = NULL, end = NULL`,
		abort.at,
		abort.route.slice(0, 160),
		abort.heapBeforeBytes,
		abort.before.totalBytes,
		abort.before.linearBytes,
		abort.before.interpreters,
		abort.before.spareBytes
	);
}

/**
 * Marks the last abort finished with the isolate at that moment, whether the repeat answered or
 * ended in a refusal or an error: `completedAt` says the new isolate got that far, `end` how.
 */
export function completeFreshFirst(
	sql: SqlStorage,
	done: IsolateReading,
	at: number,
	end: FreshFirstEnd = 'ok'
): void {
	if (!tableExists(sql)) return;
	sql.exec(
		`UPDATE ${FRESH_FIRST_TABLE} SET completed_at = ?, done_total = ?, done_linear = ?,
			done_interpreters = ?, done_spare = ?, end = ? WHERE id = 1`,
		at,
		done.totalBytes,
		done.linearBytes,
		done.interpreters,
		done.spareBytes,
		end
	);
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** the stored record, or a zero count with no last abort; it creates nothing */
export function readFreshFirst(sql: SqlStorage): FreshFirstRecord {
	if (!tableExists(sql)) return { count: 0, last: null };
	const row = sql
		.exec<Record<string, number | string | null>>(
			`SELECT * FROM ${FRESH_FIRST_TABLE} WHERE id = 1`
		)
		.toArray()[0];
	if (!row) return { count: 0, last: null };
	return {
		count: Number(row.count),
		last: {
			at: Number(row.at),
			route: String(row.route),
			heapBeforeBytes: Number(row.heap_before),
			completedAt: num(row.completed_at),
			before: {
				totalBytes: Number(row.before_total),
				linearBytes: Number(row.before_linear),
				interpreters: Number(row.before_interpreters),
				spareBytes: Number(row.before_spare)
			},
			done:
				row.done_total === null
					? null
					: {
							totalBytes: Number(row.done_total),
							linearBytes: Number(row.done_linear),
							interpreters: Number(row.done_interpreters),
							spareBytes: Number(row.done_spare)
						},
			end:
				row.end === null || row.end === undefined
					? null
					: (String(row.end) as FreshFirstEnd)
		}
	};
}
