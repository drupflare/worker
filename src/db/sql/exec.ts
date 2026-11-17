import { parseCreateTable } from './ddl';
import { translate, type MysqlState, type Plan, type Step, type Translation } from './translate';

/**
 * What one statement returns, in the shape of `ctx.storage.sql.exec`'s cursor.
 *
 * `raw()` yields positional rows, so a join with two columns of one name keeps both. The counters
 * are final once the rows are read. A Durable Object's `SqlStorageCursor` satisfies this as is.
 */
export interface SqlCursor {
	readonly columnNames: string[];
	raw(): { toArray(): unknown[][] };
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

/** runs one SQLite statement with positional (or numbered) bindings, like `ctx.storage.sql.exec` */
export type SqlRun = (sql: string, ...params: unknown[]) => SqlCursor;

/** the reply the bridge contract names, plus the row meters of the statements that ran */
export type MysqlReply =
	| {
			ok: true;
			kind: 'rows';
			columns: string[];
			rows: unknown[][];
			rowsRead?: number;
			rowsWritten?: number;
	  }
	| {
			ok: true;
			kind: 'write';
			affected: number;
			insertId: number;
			rowsRead?: number;
			rowsWritten?: number;
	  }
	| { ok: true; kind: 'none'; rowsRead?: number; rowsWritten?: number }
	| { ok: false; errno: number; sqlstate: string; error: string; refused?: string };

/** how a host runs several statements as one unit; a Durable Object passes `transactionSync` */
export interface ExecOptions {
	atomic?: <T>(fn: () => T) => T;
}

/** statements longer than this are never cached, because their literals are user data */
export const CACHE_MAX_SQL = 512;

/** the most translations one database state keeps */
export const CACHE_MAX_ENTRIES = 256;

const META_TABLE = 'cfw_mysql_schema';

/** loads the stored MySQL definitions into the catalog once per database state */
export function ensureCatalog(run: SqlRun, state: MysqlState): void {
	const db = state.db;
	if (db.loaded) return;
	try {
		const cursor = run(`SELECT name, ddl FROM ${META_TABLE}`);
		for (const [, ddl] of cursor.raw().toArray()) {
			try {
				const { schema } = parseCreateTable(String(ddl));
				db.catalog.set(schema.name.toLowerCase(), schema);
			} catch {
				/* a stored definition that no longer parses is skipped, not fatal */
			}
		}
	} catch {
		/* no table yet means no MySQL table has been created */
	}
	db.loaded = true;
	db.epoch++;
}

function lookup(sql: string, state: MysqlState): Translation {
	const db = state.db;
	const hit = db.cache.get(sql);
	if (hit !== undefined && hit.epoch === db.epoch && hit.mode === state.sqlMode) {
		db.cache.delete(sql);
		db.cache.set(sql, hit);
		db.stats.hits++;
		return hit.translation;
	}
	db.stats.misses++;
	const translation = translate(sql, state);
	if (sql.length <= CACHE_MAX_SQL && translation.plan.kind !== 'local') {
		db.cache.delete(sql);
		db.cache.set(sql, { epoch: db.epoch, mode: state.sqlMode, translation });
		if (db.cache.size > CACHE_MAX_ENTRIES) {
			const oldest = db.cache.keys().next().value;
			if (oldest !== undefined) db.cache.delete(oldest);
		}
	}
	return translation;
}

type ErrorReply = Extract<MysqlReply, { ok: false }>;

/** the MySQL error WordPress would see for a SQLite failure */
export function mapSqliteError(message: string, state: MysqlState, sql = ''): ErrorReply {
	const db = state.database;
	const fail = (errno: number, sqlstate: string, error: string, refused?: string): ErrorReply =>
		refused === undefined
			? { ok: false, errno, sqlstate, error }
			: { ok: false, errno, sqlstate, error, refused };
	let m = /no such table: (?:main\.)?(\S+)/.exec(message);
	if (m !== null && /^\s*DROP\s+TABLE/i.test(sql)) {
		return fail(1051, '42S02', `Unknown table '${db}.${m[1]}'`);
	}
	if (m !== null) return fail(1146, '42S02', `Table '${db}.${m[1]}' doesn't exist`);
	m = /no such column: (\S+)/.exec(message) ?? /has no column named (\S+)/.exec(message);
	if (m !== null) return fail(1054, '42S22', `Unknown column '${m[1]}' in 'field list'`);
	m = /ambiguous column name: (\S+)/.exec(message);
	if (m !== null) return fail(1052, '23000', `Column '${m[1]}' in field list is ambiguous`);
	m = /UNIQUE constraint failed: (\S+)/.exec(message);
	if (m !== null) return fail(1062, '23000', `Duplicate entry for key '${m[1]}'`);
	m = /NOT NULL constraint failed: (?:\S+\.)?(\S+)/.exec(message);
	if (m !== null) return fail(1048, '23000', `Column '${m[1]}' cannot be null`);
	m = /table (\S+) already exists/.exec(message);
	if (m !== null) return fail(1050, '42S01', `Table '${m[1]}' already exists`);
	m = /no such function: (\S+)/.exec(message);
	if (m !== null) return fail(1305, '42000', `FUNCTION ${db}.${m[1]} does not exist`);
	if (/values were supplied|columns but|\d+ values for \d+ columns/.test(message)) {
		return fail(1136, '21S01', "Column count doesn't match value count at row 1");
	}
	if (/LIKE or GLOB pattern too complex/.test(message)) {
		return fail(1235, '42000', 'a LIKE pattern over 50 bytes', 'like-pattern-too-long');
	}
	if (/too many SQL variables/.test(message)) {
		return fail(1235, '42000', 'too many bound values', 'statement-too-large');
	}
	if (/too long|TOOBIG/i.test(message)) {
		return fail(1153, '08S01', 'statement over the byte limit', 'statement-too-large');
	}
	if (/syntax error|incomplete input|unrecognized token/.test(message)) {
		return fail(1064, '42000', `You have an error in your SQL syntax; ${message}`);
	}
	return fail(1105, 'HY000', `Unknown error: ${message}`);
}

interface Meters {
	read: number;
	written: number;
}

function runStep(run: SqlRun, step: Step, meters: Meters): unknown[][] {
	const cursor = run(step.sql, ...step.params);
	const rows = cursor.raw().toArray();
	meters.read += cursor.rowsRead;
	meters.written += cursor.rowsWritten;
	return rows;
}

function tail(meters: Meters): { rowsRead: number; rowsWritten: number } {
	return { rowsRead: meters.read, rowsWritten: meters.written };
}

function perform(plan: Plan, run: SqlRun, state: MysqlState, options: ExecOptions): MysqlReply {
	const meters: Meters = { read: 0, written: 0 };
	switch (plan.kind) {
		case 'error':
			return plan.refused === undefined
				? { ok: false, errno: plan.errno, sqlstate: plan.sqlstate, error: plan.message }
				: {
						ok: false,
						errno: plan.errno,
						sqlstate: plan.sqlstate,
						error: plan.message,
						refused: plan.refused
					};
		case 'local': {
			const e = plan.effect;
			if (e !== undefined) {
				if (e.sqlMode !== undefined) state.sqlMode = e.sqlMode;
				if (e.charset !== undefined) state.charset = e.charset;
				if (e.collation !== undefined) state.collation = e.collation;
				if (e.resetFoundRows === true) state.foundRows = undefined;
			}
			if (plan.result === undefined) return { ok: true, kind: 'none' };
			return { ok: true, kind: 'rows', columns: plan.result.columns, rows: plan.result.rows };
		}
		case 'found-rows': {
			const found = state.foundRows;
			let n = 0;
			if (found !== undefined && 'count' in found) n = found.count;
			else if (found !== undefined) {
				const rows = runStep(run, found.countStep, meters);
				n = Number((rows[0] as unknown[] | undefined)?.[0] ?? 0);
			}
			state.foundRows = { count: 1 };
			return {
				ok: true,
				kind: 'rows',
				columns: ['FOUND_ROWS()'],
				rows: [[n]],
				...tail(meters)
			};
		}
		case 'read': {
			const cursor = run(plan.step.sql, ...plan.step.params);
			const columns = [...cursor.columnNames];
			const rows = cursor.raw().toArray();
			meters.read += cursor.rowsRead;
			meters.written += cursor.rowsWritten;
			if (plan.calc !== undefined && 'countStep' in plan.calc) {
				state.foundRows = { countStep: plan.calc.countStep };
			} else if (plan.countStep !== undefined && rows.length === 0) {
				state.foundRows = { countStep: plan.countStep };
			} else {
				// without SQL_CALC_FOUND_ROWS MySQL counts the rows skipped by the offset too
				state.foundRows = { count: (plan.offset ?? 0) + rows.length };
			}
			return { ok: true, kind: 'rows', columns, rows, ...tail(meters) };
		}
		case 'write': {
			let existing: unknown[] = [];
			if (plan.odku !== undefined) {
				existing = runStep(run, plan.odku.probe, meters).map((r) => r[0]);
			}
			for (const step of plan.steps) runStep(run, step, meters);
			const meta = runStep(
				run,
				{ sql: 'SELECT last_insert_rowid(), changes()', params: [] },
				meters
			);
			const lastId = Number(meta[0]?.[0] ?? 0);
			const changes = Number(meta[0]?.[1] ?? 0);
			if (plan.odku !== undefined) {
				const inserted = Math.max(plan.rows - existing.length, 0);
				const updated = Math.max(changes - inserted, 0);
				let insertId = 0;
				if (plan.insertId !== 'none') {
					if (inserted > 0)
						insertId = plan.insertId === 'generated' ? lastId - (inserted - 1) : lastId;
					else if (updated > 0) insertId = Number(existing[existing.length - 1] ?? 0);
				}
				return {
					ok: true,
					kind: 'write',
					affected: inserted + 2 * updated,
					insertId,
					...tail(meters)
				};
			}
			let insertId = 0;
			if (changes > 0 && plan.insertId === 'generated') insertId = lastId - (changes - 1);
			else if (changes > 0 && plan.insertId === 'explicit') insertId = lastId;
			return { ok: true, kind: 'write', affected: changes, insertId, ...tail(meters) };
		}
		case 'ddl': {
			const body = () => {
				for (const step of plan.steps) runStep(run, step, meters);
			};
			if (options.atomic !== undefined) options.atomic(body);
			else body();
			const db = state.db;
			const e = plan.effect;
			if (e.catalogSet !== undefined) {
				const key = e.catalogSet.name.toLowerCase();
				// a table that already existed only got here through IF NOT EXISTS and keeps its definition
				if (!db.catalog.has(key)) db.catalog.set(key, e.catalogSet);
			}
			for (const name of e.catalogDrop ?? []) db.catalog.delete(name);
			db.epoch++;
			return { ok: true, kind: 'none', ...tail(meters) };
		}
	}
}

/**
 * Runs one MySQL statement over SQLite and answers in the bridge contract's shape.
 *
 * It translates (through a bounded per-database cache), runs the SQLite statements in order,
 * and maps a SQLite failure to the MySQL number WordPress tests for. A statement the translator
 * refuses comes back as `{ ok: false, refused }`, never as an empty success.
 */
export function executeMysql(
	mysqlSql: string,
	run: SqlRun,
	state: MysqlState,
	options: ExecOptions = {}
): MysqlReply {
	try {
		ensureCatalog(run, state);
		const { plan } = lookup(mysqlSql, state);
		return perform(plan, run, state, options);
	} catch (e) {
		return mapSqliteError(String((e as Error)?.message ?? e), state, mysqlSql);
	}
}

/** the translation of a statement, for callers that want the class rows and not the result */
export function translationOf(mysqlSql: string, state: MysqlState): Translation {
	return lookup(mysqlSql, state);
}
