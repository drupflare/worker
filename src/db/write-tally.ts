import { firstRow } from '../util/sql';
/**
 * The table a write statement targets, or `undefined` when the statement writes nothing.
 *
 * Narrow on purpose: an unrecognised write tallies as `?unattributed`, where a wrong guess would
 * silently move rows onto the wrong table.
 */
export function writeTargetTable(sql: string): string | undefined {
	const text = String(sql ?? '').trim();
	// `INSERT OR REPLACE INTO`, `INSERT OR IGNORE INTO`, `INSERT INTO`
	const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`[]?([A-Za-z0-9_.]+)/i.exec(text);
	if (insert) return insert[1] as string;
	const update = /^UPDATE\s+(?:OR\s+\w+\s+)?["'`[]?([A-Za-z0-9_.]+)/i.exec(text);
	if (update) return update[1] as string;
	const del = /^DELETE\s+FROM\s+["'`[]?([A-Za-z0-9_.]+)/i.exec(text);
	if (del) return del[1] as string;
	const replace = /^REPLACE\s+INTO\s+["'`[]?([A-Za-z0-9_.]+)/i.exec(text);
	if (replace) return replace[1] as string;
	// DDL writes rows too (sqlite_master), and a migration is mostly DDL
	const create =
		/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z0-9_.]+)/i.exec(
			text
		);
	if (create) return create[1] as string;
	return undefined;
}

/**
 * The tables a read statement draws from, or `undefined` when that cannot be answered confidently.
 *
 * A missed table would mean a read answered against a stale database, so `undefined` ("replay
 * anyway") covers a CTE, a subquery or any unrecognised shape.
 */
export function readSourceTables(sql: string): string[] | undefined {
	const text = String(sql ?? '').trim();
	if (!/^SELECT\b/i.test(text)) return undefined;
	// a CTE, a subquery or a table-valued function all put a source where this scan does not look
	if (/\bWITH\b/i.test(text) || /\(\s*SELECT\b/i.test(text)) return undefined;
	const tables = [...text.matchAll(/\b(?:FROM|JOIN)\s+["'`[]?([A-Za-z0-9_.]+)/gi)].map(
		(m) => m[1] as string
	);
	return tables.length > 0 ? tables : undefined;
}

/** write counts for one armed window; rows say how expensive, statements say how many times */
export type WriteTally = {
	/** rows written per table, and `?unattributed` for a write whose target could not be parsed */
	byTable: Record<string, number>;
	/** distinct statement shapes and their counts, capped at {@link TALLY_SHAPE_LIMIT} */
	shapes?: Record<string, number>;
	/**
	 * write statements per table, no-ops included (unlike `byTable`); a router rebuild is a fixed
	 * statement shape, so this reads the number of rebuilds directly where rows cannot.
	 */
	statementsByTable: Record<string, number>;
	statements: number;
	rowsWritten: number;
};

/** a tally with every counter at zero */
export function emptyTally(): WriteTally {
	return { byTable: {}, statementsByTable: {}, statements: 0, rowsWritten: 0, shapes: {} };
}

/** how many distinct statement shapes a tally remembers, across the whole tally */
export const TALLY_SHAPE_LIMIT = 40;

/** a statement with whitespace normalised and cut to 120 chars, to answer "which statement" */
export function statementShape(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function countRows(tally: WriteTally, table: string, rowsWritten: number): WriteTally {
	tally.statementsByTable[table] = (tally.statementsByTable[table] ?? 0) + 1;
	const rows = Number.isFinite(rowsWritten) ? Math.max(0, rowsWritten) : 0;
	if (rows === 0) return tally;
	tally.rowsWritten += rows;
	tally.byTable[table] = (tally.byTable[table] ?? 0) + rows;
	return tally;
}

/**
 * Folds one statement's result in. A zero-row write counts in `statements` only; an unparsed
 * target lands under `?unattributed`, and a large share there means the parser misses a form.
 */
export function tallyWrite(tally: WriteTally, sql: string, rowsWritten: number): WriteTally {
	tally.statements += 1;
	const table = writeTargetTable(sql) ?? '?unattributed';
	// bounded: the tally lives in the isolate and the key is statement text
	if (tally.shapes) {
		const shape = statementShape(sql);
		if (
			tally.shapes[shape] !== undefined ||
			Object.keys(tally.shapes).length < TALLY_SHAPE_LIMIT
		) {
			tally.shapes[shape] = (tally.shapes[shape] ?? 0) + 1;
		}
	}
	return countRows(tally, table, rowsWritten);
}

/** the shape of `ctx.storage.sql` this wrapper needs, narrowed so the module stays testable */
export type SqlLike = {
	exec(sql: string, ...bindings: unknown[]): { rowsWritten: number };
};

/**
 * Wraps `ctx.storage.sql` so the host's own writes (the `cfw_page` insert, queue deletes, DDL) are
 * tallied beside Drupal's; rows written binds the regeneration ceiling. Reads pass through
 * uncounted: `rowsWritten` on a live cursor is not settled, and only a write returns no rows.
 */
export function countingSql<T extends SqlLike>(
	sql: T,
	getTally: () => WriteTally | undefined,
	onWrite?: (rows: number) => void
): T {
	const wrapped: SqlLike = {
		exec(text: string, ...bindings: unknown[]) {
			const cursor = sql.exec(text, ...bindings);
			// a `SELECT` cursor is a live iterator; reading rowsWritten would consume its rows
			const isWrite = writeTargetTable(text) !== undefined;
			if (!isWrite) return cursor;
			const rows = cursor.rowsWritten;
			// always on, unlike the route-armed tally: one addition per write, no allocation
			onWrite?.(rows);
			const tally = getTally();
			if (tally) tallyWrite(tally, text, rows);
			return cursor;
		}
	};
	// `Reflect.get` takes no receiver: workerd host accessors reject a proxy as `this` and throw
	// "Illegal invocation" (first seen on `databaseSize`)
	return new Proxy(sql, {
		get(target, prop) {
			if (prop === 'exec') return wrapped.exec;
			const value = Reflect.get(target, prop);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

/** folds a KV-API write in; it has no statement text, so it carries a pseudo-table instead */
export function tallyStorage(tally: WriteTally, op: string, rowsWritten: number): WriteTally {
	const table = `${STORAGE_TABLE_PREFIX}${op}`;
	tally.statements += 1;
	return countRows(tally, table, rowsWritten);
}

/** `?` so it sorts beside `?unattributed` and cannot collide with a real table name */
export const STORAGE_TABLE_PREFIX = '?storage.';

/** the `ctx.storage` write methods {@link countingStorage} intercepts */
export type StorageLike = {
	put(keyOrEntries: unknown, value?: unknown, options?: unknown): Promise<void>;
	delete(keyOrKeys: unknown, options?: unknown): Promise<boolean | number>;
	deleteAll(options?: unknown): Promise<void>;
	setAlarm(when: unknown, options?: unknown): Promise<void>;
	deleteAlarm(options?: unknown): Promise<void>;
};

/**
 * Wraps `ctx.storage` so KV-API writes reach the rows meter (`degradation()` gates read-only mode
 * on it). `delete` is charged from its resolved result; `deleteAll` is charged 0 because its count
 * is unknown and a guess is worse than a visible zero.
 */
export function countingStorage<T extends object>(
	storage: T,
	getTally: () => WriteTally | undefined,
	onWrite?: (rows: number) => void
): T {
	// the real handle's overloads do not match StorageLike
	const s = storage as unknown as StorageLike;
	const charge = (op: string, rows: number): void => {
		onWrite?.(rows);
		const tally = getTally();
		if (tally) tallyStorage(tally, op, rows);
	};
	const wrapped: Record<string, (...args: never[]) => unknown> = {
		put(keyOrEntries: unknown, ...rest: unknown[]) {
			const rows =
				typeof keyOrEntries === 'object' && keyOrEntries !== null
					? Object.keys(keyOrEntries).length
					: 1;
			charge('put', rows);
			return (s.put as (...a: unknown[]) => Promise<void>)(keyOrEntries, ...rest);
		},
		delete(keyOrKeys: unknown, ...rest: unknown[]) {
			const done = (s.delete as (...a: unknown[]) => Promise<boolean | number>)(
				keyOrKeys,
				...rest
			);
			return done.then((result) => {
				charge('delete', typeof result === 'number' ? result : result ? 1 : 0);
				return result;
			});
		},
		deleteAll(...rest: unknown[]) {
			charge('deleteAll', 0);
			return (s.deleteAll as (...a: unknown[]) => Promise<void>)(...rest);
		},
		setAlarm(when: unknown, ...rest: unknown[]) {
			charge('setAlarm', 1);
			return (s.setAlarm as (...a: unknown[]) => Promise<void>)(when, ...rest);
		},
		deleteAlarm(...rest: unknown[]) {
			charge('deleteAlarm', 1);
			return (s.deleteAlarm as (...a: unknown[]) => Promise<void>)(...rest);
		}
	};
	// same receiver rule as countingSql(): workerd host accessors reject a proxy as `this`
	return new Proxy(storage, {
		get(target, prop) {
			const override = typeof prop === 'string' ? wrapped[prop] : undefined;
			if (override) return override;
			const value = Reflect.get(target, prop);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

/** the tally sorted heaviest-first, which is the only order worth reading it in */
export function rankTally(
	tally: WriteTally
): Array<{ table: string; rows: number; statements: number; share: number }> {
	const total = tally.rowsWritten;
	// union of both keys: a table with statements and zero rows is a no-op write path, not a blank
	const tables = new Set([
		...Object.keys(tally.byTable),
		...Object.keys(tally.statementsByTable)
	]);
	return [...tables]
		.map((table) => ({
			table,
			rows: tally.byTable[table] ?? 0,
			statements: tally.statementsByTable[table] ?? 0,
			share: total > 0 ? (tally.byTable[table] ?? 0) / total : 0
		}))
		.sort((a, b) => b.rows - a.rows || b.statements - a.statements);
}

/**
 * Full router rebuilds in a tally: a `DELETE FROM router` plus `ceil(routes / routesPerStatement)`
 * inserts per pass; see {@link routerRebuilds} for the residual.
 *
 * @param routesPerStatement - rows the driver puts in one `INSERT`; the driver writes 1
 */
export function routerRebuildPasses(
	tally: WriteTally,
	routes: number,
	routesPerStatement = 1
): number | undefined {
	return routerRebuilds(tally, routes, routesPerStatement)?.passes;
}

/** a rebuild count with the statements it could not attribute, so neither half is guessed */
export interface RouterRebuilds {
	passes: number;
	/** statements left after the whole passes; a large one means the shape is not understood */
	residual: number;
	/** statements one full dump costs at the given chunk size */
	perPass: number;
}

/**
 * The full reading behind {@link routerRebuildPasses}; undefined when there is nothing to divide.
 * A residual above one pass means the chunk size is wrong.
 */
export function routerRebuilds(
	tally: WriteTally,
	routes: number,
	routesPerStatement = 1
): RouterRebuilds | undefined {
	const statements = tally.statementsByTable['router'] ?? 0;
	if (statements === 0 || routes <= 0 || routesPerStatement <= 0) return undefined;
	const perPass = 1 + Math.ceil(routes / routesPerStatement);
	return { passes: Math.floor(statements / perPass), residual: statements % perPass, perPass };
}

/** One table's charged rows against the statements that caused them. */
export type Amplification = {
	table: string;
	/** write statements aimed at this table, including no-ops */
	statements: number;
	/** rows the host charged for those statements */
	rowsWritten: number;
	/** charged rows per statement; above 1 the extra is index maintenance (one row per index) */
	factor: number;
};

/**
 * Charged rows per write statement, per table, largest factor first. It does not say which index;
 * a table with statements and no charged rows reports 0 rather than being dropped.
 */
export function amplification(tally: WriteTally): Amplification[] {
	const tables = new Set([
		...Object.keys(tally.statementsByTable),
		...Object.keys(tally.byTable)
	]);
	return [...tables]
		.map((table) => {
			const statements = tally.statementsByTable[table] ?? 0;
			const rowsWritten = tally.byTable[table] ?? 0;
			return {
				table,
				statements,
				rowsWritten,
				factor: statements > 0 ? rowsWritten / statements : 0
			};
		})
		.sort((a, b) => b.factor - a.factor || b.rowsWritten - a.rowsWritten);
}

/**
 * The share of charged rows not explained by one row per statement; a burst detector, not an
 * index share. A cold fill (63 statements, 12 rows) reads 0 here while `index-audit.ts` finds 9 of
 * 12 rows are indexes, so price indexes with `splitChargedRows()`.
 */
export function overheadShare(tally: WriteTally): number {
	if (tally.rowsWritten <= 0) return 0;
	const explained = Math.min(tally.statements, tally.rowsWritten);
	return (tally.rowsWritten - explained) / tally.rowsWritten;
}

/** one table's charged rows divided into what was stored and what was overhead */
export type ChargeSplit = {
	table: string;
	chargedRows: number;
	/** charged rows one stored row costs, from the schema */
	chargePerRow: number;
	dataRows: number;
	/** every charged row that is not the table row (`AUTOINCREMENT` adds `sqlite_sequence`) */
	indexRows: number;
	/** false when the total is not a whole multiple of the factor, or the factor is unknown */
	exact: boolean;
};

/** the reads a live charge-factor lookup needs; narrower than `SqlLike`, which only writes */
export type SchemaReader = {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

/** a table name safe to interpolate (a `PRAGMA` takes no binding) */
const SAFE_TABLE = /^[A-Za-z0-9_]+$/;

/**
 * Charge factors read off the live database (a module enable creates tables no pack contains).
 * Indexes come from `PRAGMA index_list` (partial excluded), `AUTOINCREMENT` and `WITHOUT ROWID`
 * from the DDL text; a missing table is omitted, not 0, so `splitChargedRows()` reports it inexact.
 */
export function chargeFactorsFromSchema(
	sql: SchemaReader,
	tables: readonly string[]
): Record<string, number> {
	const factors: Record<string, number> = {};
	for (const table of tables) {
		if (!SAFE_TABLE.test(table)) continue;
		const ddl = firstRow(
			sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)
		);
		if (!ddl) continue;
		const indexes = sql
			.exec(`PRAGMA index_list("${table}")`)
			.toArray()
			.filter((row) => Number(row['partial'] ?? 0) === 0).length;
		const text = String(ddl['sql'] ?? '');
		// a `WITHOUT ROWID` table is its primary-key B-tree; its autoindex must not count
		const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(text);
		factors[table] =
			(withoutRowid ? Math.max(1, indexes) : 1 + indexes) +
			(/\bAUTOINCREMENT\b/i.test(text) ? 1 : 0);
	}
	return factors;
}

/**
 * Divides charged rows into data and index maintenance by per-table charge factor. A total that is
 * not a whole multiple (not all fresh single-row inserts) reports `exact: false`, not a rounding.
 */
export function splitChargedRows(
	charged: Record<string, number>,
	chargePerRow: Record<string, number>
): { rows: ChargeSplit[]; dataRows: number; indexRows: number; indexShare: number } {
	const rows: ChargeSplit[] = [];
	for (const [table, chargedRows] of Object.entries(charged)) {
		const factor = chargePerRow[table] ?? 0;
		const exactRows = factor > 0 ? chargedRows / factor : 0;
		const dataRows = Math.floor(exactRows);
		rows.push({
			table,
			chargedRows,
			chargePerRow: factor,
			dataRows,
			indexRows: chargedRows - dataRows,
			exact: factor > 0 && Number.isInteger(exactRows)
		});
	}
	const dataRows = rows.reduce((n, r) => n + r.dataRows, 0);
	const total = rows.reduce((n, r) => n + r.chargedRows, 0);
	return {
		rows,
		dataRows,
		indexRows: total - dataRows,
		indexShare: total > 0 ? (total - dataRows) / total : 0
	};
}
