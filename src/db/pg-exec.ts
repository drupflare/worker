/**
 * One statement against PostgreSQL or MySQL, through Hyperdrive's pooled connection string.
 *
 * A client is made per call, not held: the connection is pooled on Cloudflare's side and a
 * Durable Object holding an open socket does not hibernate. Replies take `ctx.storage.sql`'s
 * shape, the one `rom`'s driver parses, so the driver never learns which backend it is on.
 * @module
 */
import type { BackendDialect, BackendSelection } from './backend';

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

/** the injectable client factory */
export type PgDeps = {
	client(connectionString: string, dialect: BackendDialect): PgClient | Promise<PgClient>;
};

/**
 * Rewrites `?` placeholders to `$1..$n` for PostgreSQL.
 * A `?` inside a quoted literal is content (`WHERE note = 'why?'` must survive), so single and
 * double quotes are tracked.
 */
export function toDollarPlaceholders(sql: string): string {
	let out = '';
	let n = 0;
	let quote: string | undefined;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i] as string;
		if (quote !== undefined) {
			out += c;
			// a doubled quote inside a literal is an escaped quote, not the end of one
			if (c === quote) {
				if (sql[i + 1] === quote) {
					out += sql[++i] as string;
				} else {
					quote = undefined;
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
 * The real client, reached by a dynamic import: a static `import { Client } from 'pg'` bundles,
 * but vite fails every spec reaching this module (`Cannot use import statement outside a module`
 * on `pg`'s CommonJS entry), and `park-drive.ts` imports this file.
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
 * Uses `query()`, not `execute()`: `execute()` sends `COM_STMT_PREPARE`, which Hyperdrive does not
 * support for MySQL. `createConnection` waits for `connect()` to match `pg`'s lifecycle.
 */
function mysqlClient(
	mysql: { createConnection(o: object): Promise<MysqlConnection> },
	connectionString: string
): PgClient {
	let conn: MysqlConnection | undefined;
	return {
		async connect() {
			conn = await mysql.createConnection({ uri: connectionString });
		},
		async query(text: string, values?: unknown[]) {
			if (conn === undefined) throw new Error('the mysql connection was not opened');
			const [result] = await conn.query(text, values ? [...values] : []);
			// a select answers rows; a write answers a header with `affectedRows`
			if (Array.isArray(result)) {
				return { rows: result as Record<string, unknown>[], rowCount: result.length };
			}
			const affected = Number((result as { affectedRows?: number })?.affectedRows ?? 0);
			return { rows: [], rowCount: affected };
		},
		async end() {
			await conn?.end();
			conn = undefined;
		}
	};
}

/**
 * Runs one statement and answers in the host's own result shape.
 *
 * `pg` uses `rowCount` for both reads and writes (measured on PostgreSQL 17.6), so a statement
 * with no rows and a count is a write. These counts are not a Cloudflare meter: an external
 * database is not metered per row.
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
			// only the row list tells a read from a write (`rowCount` serves both)
			rowsWritten: rows.length === 0 ? count : 0,
			rowsRead: rows.length,
			lastInsertId: '0'
		};
	} finally {
		// even on a throw: an open client holds one of the limited origin connections
		await client.end().catch(() => {});
	}
}
