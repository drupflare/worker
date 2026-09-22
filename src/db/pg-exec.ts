/**
 * One statement against a PostgreSQL database, through Hyperdrive's pooled connection string.
 *
 * `pg` is the client Cloudflare's own Hyperdrive documentation uses, and Hyperdrive itself supplies
 * no client at all -- only the pooled endpoint and the string. The pooling is the reason a
 * connection is made per call here rather than held: Cloudflare's guidance is a client per request
 * because the underlying connection is pooled on their side, and a Durable Object holding an open
 * socket is on the no-hibernation list, which bills duration for the whole time it is held.
 *
 * ## The shape it answers in is `ctx.storage.sql`'s, not `pg`'s
 *
 * The caller is the same host seam that answers `cfwSqlExec`, so the reply has to be the shape
 * `rom`'s driver already parses. Translating here rather than in PHP keeps the driver ignorant of
 * which backend it is on, which is the whole point of putting the selection behind one contract.
 */

import type { BackendDialect, BackendSelection } from './backend.js';

/** what one statement answers, in the shape the host's own SQL seam uses */
export type BackendResult = {
	rows: Record<string, unknown>[];
	rowsWritten: number;
	rowsRead: number;
	lastInsertId: string;
};

/** the client, as a seam: the gate drives this over a stub rather than opening a socket */
export type PgClient = {
	connect(): Promise<void>;
	query(
		text: string,
		values?: unknown[]
	): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
	end(): Promise<void>;
};

export type PgDeps = {
	client(connectionString: string, dialect: BackendDialect): PgClient | Promise<PgClient>;
};

/**
 * Rewrites `?` placeholders to `$1..$n` for PostgreSQL.
 *
 * The driver emits `?`, which is SQLite's form and MySQL's, and PostgreSQL takes neither. Doing it
 * here rather than in the driver keeps `rom` ignorant of which backend it is on, which is the whole
 * point of putting the selection behind one contract.
 *
 * A `?` INSIDE A LITERAL IS NOT A PLACEHOLDER, and rewriting one would corrupt the statement --
 * `WHERE note = 'why?'` has to survive. Single quotes, double quotes and the `??` escape are all
 * tracked, because the alternative is a regex that is wrong on the first row of real content.
 */
export function toDollarPlaceholders(sql: string): string {
	let out = '';
	let n = 0;
	let quote: string | null = null;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i] as string;
		if (quote !== null) {
			out += c;
			// a doubled quote inside a literal is an escaped quote, not the end of one
			if (c === quote) {
				if (sql[i + 1] === quote) {
					out += sql[++i] as string;
				} else {
					quote = null;
				}
			}
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			out += c;
			continue;
		}
		if (c === '?') {
			out += `$${++n}`;
			continue;
		}
		out += c;
	}
	return out;
}

/**
 * The real client, reached by a DYNAMIC import, and the reason is the lane split rather than size.
 *
 * A static `import { Client } from 'pg'` bundles correctly -- measured, esbuild produces a Worker
 * that uploads, and `pg` costs 90 KiB of the 65,536 KiB ceiling. It also makes every vitest spec
 * whose graph reaches this module fail to load at all: vite answers
 * `SyntaxError: Cannot use import statement outside a module` for `pg`'s CommonJS entry. That is
 * the gate-and-bundler disagreement this repository already has a rule about, arriving from the
 * other side -- and `park-drive.ts` imports this file, so a static import would have taken every
 * spec that reaches the park with it.
 *
 * Dynamic, the import is not evaluated until a deployment actually selects this backend, so the
 * gate never resolves it and the bundler still does.
 */
export const DEFAULT_PG_DEPS: PgDeps = {
	async client(connectionString: string, dialect: BackendDialect): Promise<PgClient> {
		if (dialect === 'mysql') {
			const mysql = (await import('mysql2/promise')) as unknown as {
				createConnection(o: object): Promise<MysqlConnection>;
			};
			return mysqlClient(mysql, connectionString);
		}
		const { Client } = (await import('pg')) as unknown as {
			Client: new (o: object) => PgClient;
		};
		return new Client({ connectionString });
	}
};

/** the slice of `mysql2/promise` this uses, named so the adapter below reads as a contract */
type MysqlConnection = {
	query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
	end(): Promise<void>;
};

/**
 * `mysql2` behind the same three methods `pg` offers.
 *
 * **`query()` RATHER THAN `execute()`, and this is a Hyperdrive constraint rather than a
 * preference.** `execute()` sends `COM_STMT_PREPARE`, which Hyperdrive does not support for MySQL --
 * it is one of the blockers `docs/external-database.md` already lists. `query()` interpolates the
 * values client-side and sends one text statement, which is what survives the pool.
 *
 * `createConnection` is deferred to `connect()` so the adapter matches `pg`'s lifecycle: the caller
 * connects, queries, and ends, and a failure to connect surfaces where the caller expects it.
 */
function mysqlClient(
	mysql: { createConnection(o: object): Promise<MysqlConnection> },
	connectionString: string
): PgClient {
	let conn: MysqlConnection | null = null;
	return {
		async connect() {
			conn = await mysql.createConnection({ uri: connectionString });
		},
		async query(text: string, values?: unknown[]) {
			if (conn === null) throw new Error('the mysql connection was not opened');
			const [result] = await conn.query(text, values ? [...values] : []);
			// a SELECT answers an array of rows; a write answers a header object carrying
			// `affectedRows`, which is the same split `pg` expresses through an empty row list
			if (Array.isArray(result)) {
				return { rows: result as Record<string, unknown>[], rowCount: result.length };
			}
			const affected = Number((result as { affectedRows?: number })?.affectedRows ?? 0);
			return { rows: [], rowCount: affected };
		},
		async end() {
			await conn?.end();
			conn = null;
		}
	};
}

/**
 * Runs one statement and answers in the host's own result shape.
 *
 * `rowsWritten` comes from `rowCount` on a statement that returned no rows, which is what a write
 * is; a SELECT reports its rows read instead. MEASURED against the rig's PostgreSQL 17.6 rather
 * than assumed, because `pg` uses one field for both: `SELECT $1::int` answers
 * `{rows: [{n: 7}], rowCount: 1}` and `INSERT INTO probe (id) VALUES ($1)` answers
 * `{rows: [], rowCount: 1}`, so the row LIST is the only thing that separates them.
 *
 * Neither is the Durable Object meter -- an external database is not metered per row by Cloudflare
 * at all -- so these are for the driver's own bookkeeping rather than for the quota ladder, and a
 * caller that treats them as billed rows would be counting a meter that does not exist here.
 */
export async function backendExec(
	selection: BackendSelection,
	sql: string,
	params: readonly unknown[] = [],
	deps: PgDeps = DEFAULT_PG_DEPS
): Promise<BackendResult> {
	if (!selection.available || !selection.connectionString) {
		throw new Error(selection.why || 'no external database backend is configured');
	}
	const dialect = selection.dialect ?? 'postgres';
	const client = await deps.client(selection.connectionString, dialect);
	await client.connect();
	try {
		// PostgreSQL takes `$1..$n` and the driver emits `?`, which is what MySQL takes as-is
		const text = dialect === 'postgres' ? toDollarPlaceholders(sql) : sql;
		const out = await client.query(text, [...params]);
		const rows = Array.isArray(out.rows) ? out.rows : [];
		const count = typeof out.rowCount === 'number' ? out.rowCount : 0;
		return {
			rows,
			// a statement that returned rows READ them; one that returned none and reports a count
			// wrote them. `pg` uses one field for both and only the row list tells them apart
			rowsWritten: rows.length === 0 ? count : 0,
			rowsRead: rows.length,
			lastInsertId: '0'
		};
	} finally {
		// ALWAYS, including on a throw: Hyperdrive pools the underlying connection and a client left
		// open holds one of the configuration's limited origin connections for the object's life
		await client.end().catch(() => {});
	}
}
