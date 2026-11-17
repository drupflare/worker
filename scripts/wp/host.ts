import { mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { decode, encode } from '@drupflare/durabledb/codec';
import { ensureCatalog, executeMysql, translationOf } from '../../src/db/sql/exec';
import { createDatabaseState, createState, type MysqlState } from '../../src/db/sql/translate';
import { sqliteRun } from '../measure/sql-translate-run';

/** the server version string the edge bridge answers, so dbDelta takes the same branch */
const SERVER_VERSION = '8.0.17-drupflare';

/**
 * What a host does with the first statement of a session that did not send `SET SESSION sql_mode`.
 * `strict` runs it in the translator's default strict mode, `relaxed` starts every session in the
 * mode WordPress sets on connect, `gone-away` answers 2006 until the connect statement arrives.
 */
export type Resume = 'strict' | 'relaxed' | 'gone-away';

/** options for one host */
export interface HostOptions {
	dbFile: string;
	socketPath: string;
	resume?: Resume;
	/** keep the text of every statement in the log, for a replay check */
	keepText?: boolean;
	/** keep the reply of every statement, for a trace */
	keepReply?: boolean;
}

/** one statement as the host saw it */
export interface StatementRecord {
	seq: number;
	verb: string;
	ok: boolean;
	classes: string[];
	translateMs: number;
	execMs: number;
	errno?: number;
	/** rows a write changed, as MySQL counts them; absent for a read */
	affected?: number;
	refused?: string;
	error?: string;
	sql?: string;
	reply?: unknown;
}

/** one PHP request or process, from its `begin` to its `end` */
export interface RequestRecord {
	label: string;
	statements: StatementRecord[];
	/** what the page's tag emitter sent the host: announcements, wholesale marks and the settle */
	tagCalls: Record<string, unknown>[];
	end?: Record<string, unknown>;
}

/** the request a connection is in; the install and the server it calls are two connections */
interface Connection {
	request: RequestRecord | undefined;
}

const RELAXED = 'NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

/** the leading keyword of a statement, upper case */
export function verbOf(sql: string): string {
	const m = /^\s*(?:\(\s*)*([A-Za-z]+)/.exec(sql);
	return m === null ? '?' : (m[1] as string).toUpperCase();
}

/** a running host: one SQLite file, one translator session, a unix socket PHP connects to */
export interface Host {
	requests: RequestRecord[];
	stop(): Promise<void>;
	session(): MysqlState;
	translationStats(): { hits: number; misses: number };
}

/**
 * Starts the host. It does what the object's bridge does for one request stream: translate a
 * statement, run what it becomes on SQLite, answer in the contract's shape through the real codec.
 * Each PHP process keeps one connection, and a statement belongs to the request that connection
 * began last. `b<label>` starts a request (and clears the FOUND_ROWS memory, as `beginRun()` does), `x<json>`
 * is one statement, `e<json>` is the PHP side's own tally of the request.
 */
export function startHost(options: HostOptions): Promise<Host> {
	mkdirSync(dirname(options.dbFile), { recursive: true });
	const db = new DatabaseSync(options.dbFile);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = NORMAL');
	const run = sqliteRun(db);
	const atomic = <T>(fn: () => T): T => {
		db.exec('BEGIN');
		try {
			const out = fn();
			db.exec('COMMIT');
			return out;
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
	};
	const resume = options.resume ?? 'strict';
	const database = createDatabaseState();
	let current: MysqlState | undefined;
	let established = false;
	const session = (): MysqlState =>
		(current ??= createState({
			db: database,
			serverVersion: SERVER_VERSION,
			...(resume === 'relaxed' ? { sqlMode: RELAXED } : {})
		}));
	const requests: RequestRecord[] = [];
	let seq = 0;
	const open = (conn: Connection): RequestRecord => {
		if (conn.request === undefined) {
			conn.request = { label: '(before begin)', statements: [], tagCalls: [] };
			requests.push(conn.request);
		}
		return conn.request;
	};

	const exec = (conn: Connection, json: string): string => {
		const state = session();
		const request = decode(JSON.parse(json)) as { sql?: unknown } | null;
		const record: StatementRecord = {
			seq: ++seq,
			verb: '?',
			ok: false,
			classes: [],
			translateMs: 0,
			execMs: 0
		};
		open(conn).statements.push(record);
		if (typeof request?.sql !== 'string') {
			return JSON.stringify(
				encode({ ok: false, errno: 1105, sqlstate: 'HY000', error: 'needs a sql string' })
			);
		}
		const sql = request.sql;
		record.verb = verbOf(sql);
		if (options.keepText === true) record.sql = sql;
		const isConnect = /^\s*SET\s+SESSION\s+sql_mode\b/i.test(sql);
		if (resume === 'gone-away' && !established && !isConnect) {
			record.errno = 2006;
			record.error = 'MySQL server has gone away';
			return JSON.stringify(
				encode({
					ok: false,
					errno: 2006,
					sqlstate: 'HY000',
					error: 'MySQL server has gone away'
				})
			);
		}
		if (isConnect) established = true;
		let t0 = performance.now();
		ensureCatalog(run, state);
		try {
			record.classes = [...translationOf(sql, state).classes];
		} catch {
			record.classes = ['translate-threw'];
		}
		record.translateMs = performance.now() - t0;
		t0 = performance.now();
		const reply = executeMysql(sql, run, state, { atomic });
		record.execMs = performance.now() - t0;
		if (options.keepReply === true) record.reply = reply;
		record.ok = reply.ok;
		if (reply.ok && reply.kind === 'write') record.affected = reply.affected;
		if (!reply.ok) {
			record.errno = reply.errno;
			record.error = reply.error;
			if (reply.refused !== undefined) record.refused = reply.refused;
		}
		return JSON.stringify(encode(reply));
	};

	const handle = (conn: Connection, line: string): string => {
		const op = line[0];
		const rest = line.slice(1);
		if (op === 'b') {
			if (current !== undefined) current.foundRows = undefined;
			conn.request = { label: rest, statements: [], tagCalls: [] };
			requests.push(conn.request);
			return 'ok';
		}
		if (op === 't') {
			const call = decode(JSON.parse(rest)) as Record<string, unknown>;
			open(conn).tagCalls.push(call);
			return JSON.stringify(encode({ ok: true }));
		}
		if (op === 'e') {
			open(conn).end = JSON.parse(rest) as Record<string, unknown>;
			return 'ok';
		}
		if (op === 'x') return exec(conn, rest);
		return 'bad op';
	};

	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		const conn: Connection = { request: undefined };
		socket.setEncoding('utf8');
		let buffer = '';
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			let at = buffer.indexOf('\n');
			while (at >= 0) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				socket.write(`${handle(conn, line)}\n`);
				at = buffer.indexOf('\n');
			}
		});
		socket.on('error', () => {});
		socket.on('close', () => sockets.delete(socket));
	});
	try {
		unlinkSync(options.socketPath);
	} catch {
		/* no stale socket */
	}
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.socketPath, () => {
			resolve({
				requests,
				session,
				translationStats: () => ({ ...session().db.stats }),
				stop: () =>
					new Promise<void>((done) => {
						for (const s of sockets) s.destroy();
						server.close(() => {
							db.close();
							try {
								unlinkSync(options.socketPath);
							} catch {
								/* node removed it already */
							}
							done();
						});
					})
			});
		});
	});
}
