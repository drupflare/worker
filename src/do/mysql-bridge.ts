import { withMask } from '@drupflare/cartridge/mask';
import { decode, encode } from '@drupflare/durabledb/codec';
import { bindable } from '@drupflare/durabledb/do-sqlite';
import { executeMysql, type MysqlReply, type SqlRun } from '../db/sql/exec';
import { createDatabaseState, createState, type MysqlState } from '../db/sql/translate';
import type { SitePhpDurableObject } from '../site-do';
import type { SiteBinary } from './types';

/**
 * What `SELECT VERSION()` answers. WordPress's schema upgrader stops comparing integer display
 * widths at 8.0.17, and the stored definitions answer DESCRIBE the way MySQL 8 does.
 */
export const MYSQL_SERVER_VERSION = '8.0.17-drupflare';

/**
 * The mode a session starts in. It is the mode wpdb leaves its connection in after removing the
 * strict modes, so a session the host begins fresh (after a heap restore keeps the PHP side) agrees
 * with what PHP believes it already sent.
 */
export const BRIDGE_SQL_MODE = 'NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

/** the part of the bridge the object reaches into: one request's worth of state to clear */
export interface MysqlBridge {
	/** forgets what one PHP run must not hand to the next; called as each run starts */
	beginRun(): void;
	/** the session the bridge's statements run in, created on first use */
	session(): MysqlState;
}

/**
 * One bound value as the platform takes it, or a refusal. The platform binds an object as the
 * string "[object Object]" without an error, so anything that is not a primitive or an
 * ArrayBuffer stops here.
 */
export function bindingOf(value: unknown): string | number | null | ArrayBuffer {
	if (value === null || typeof value === 'string' || typeof value === 'number') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'bigint') return bindable(value) as number;
	if (value instanceof ArrayBuffer) return value;
	throw new TypeError(
		`refused a bound ${value === undefined ? 'undefined' : typeof value} value`
	);
}

const failure = (error: string): MysqlReply => ({
	ok: false,
	errno: 1105,
	sqlstate: 'HY000',
	error
});

/**
 * Installs `cfwMysqlExec`, which takes one MySQL statement and answers in the bridge contract.
 *
 * The statement is translated and every SQLite statement it becomes runs on the object's counted
 * handle, the one `execSql()` ends in, so the daily rows meter, the write tally and the schema
 * marks see ordinary statements. `execSql()` itself is not used: it returns row objects, which
 * collapse a join's two columns of one name and lose the columns of an empty result, and it reads
 * the insert id and change count after every statement.
 *
 * The database state (stored table definitions and the translation cache) belongs to this
 * interpreter, and so to this site. The session (sql mode, character set, FOUND_ROWS memory) is
 * created on first use; only the FOUND_ROWS memory is request scoped, so it is the one thing
 * `beginRun()` clears.
 */
export function installMysqlBridge(site: SitePhpDurableObject, binary: SiteBinary): MysqlBridge {
	const db = createDatabaseState();
	let current: MysqlState | undefined;
	const session = (): MysqlState =>
		(current ??= createState({
			db,
			serverVersion: MYSQL_SERVER_VERSION,
			sqlMode: BRIDGE_SQL_MODE
		}));

	let refusedBinding: string | undefined;
	const run: SqlRun = (sql, ...params) => {
		let bound: unknown[];
		try {
			bound = params.map(bindingOf);
		} catch (e) {
			refusedBinding = (e as Error).message;
			throw e;
		}
		const cursor = site.sql.exec(sql, ...bound);
		return {
			columnNames: cursor.columnNames,
			raw: () => ({ toArray: () => Array.from(cursor.raw()) }),
			get rowsRead() {
				return cursor.rowsRead;
			},
			get rowsWritten() {
				return cursor.rowsWritten;
			}
		};
	};
	const atomic = <T>(fn: () => T): T => site.ctx.storage.transactionSync(fn);

	binary.cfwMysqlExec = (json: string) =>
		withMask(() => {
			let reply: MysqlReply;
			refusedBinding = undefined;
			try {
				const request = decode(JSON.parse(json)) as { sql?: unknown } | null;
				reply =
					typeof request?.sql === 'string'
						? executeMysql(request.sql, run, session(), { atomic })
						: failure('cfwMysqlExec needs a sql string');
				if (!reply.ok && refusedBinding !== undefined) {
					reply = {
						ok: false,
						errno: 1235,
						sqlstate: '42000',
						error: refusedBinding,
						refused: 'binding-type'
					};
				}
			} catch (e) {
				reply = failure(String((e as Error)?.message ?? e));
			}
			return JSON.stringify(encode(reply));
		});

	return {
		beginRun() {
			if (current !== undefined) current.foundRows = undefined;
		},
		session
	};
}
