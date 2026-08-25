// not the root barrel: edgeport 1.0.6 re-exports 20 namespaces it never imports, which esbuild
// refuses and vite tolerates (so the gate stayed green while wrangler could not bundle)
import {
	AuthError,
	connect as coreConnect,
	ProtocolError,
	type ConnectOptions,
	type CoreSocket
} from 'edgeport/core';
import { _connectOverSocket, type RedisArg } from 'edgeport/redis';
import { _sessionFromSocket as syslogSessionFromSocket } from 'edgeport/syslog';

/**
 * The TCP tier of the CFW network capability: deferred, scripted, operator-scoped.
 *
 * **`cfw_tcp_connect()` / `read()` / `write()` / `close()` CANNOT EXIST, and that is a property of
 * the interpreter rather than a gap in this file.** `Host::call()` is `$reply = $invoke($json)`: the
 * wasm stack cannot suspend without JSPI or Asyncify, so any host function that awaits hands PHP a
 * Promise it can only stringify. A session API needs a `read()` that blocks for bytes that have not
 * arrived, so the mechanism is closed. The OBJECTIVE -- PHP-reachable TCP -- is not, and this is what
 * survives it: PHP declares a whole exchange, the exchange runs in JS between invocations, and the
 * answer is readable on a later one. That is the same cached -> deferred -> sync layering
 * `cfwFetch` lives under, with the sync tier absent for the same reason.
 *
 * **The ENDPOINT is the operator's, never the caller's.** A queued row names a host, so letting PHP
 * choose one would put arbitrary `host:port` TCP behind any module that can call a host function --
 * a port scanner and a protocol-smuggling surface, which is a strictly larger hole than the HTTP
 * tier's SSRF because it is not confined to HTTP semantics. `REDIS_URL` and `SYSLOG_URL` supply the
 * endpoint and the credentials; PHP supplies the operation and nothing else.
 *
 * Two protocols ship because two shapes exist, not to be a catalogue: `redis` has a reply and is
 * therefore cached-or-deferred, `syslog` has none and is fire-and-forget. A third protocol is a
 * registry entry.
 */

// #region endpoints

export type TcpProtocol = 'redis' | 'syslog';

export const TCP_PROTOCOLS: readonly TcpProtocol[] = ['redis', 'syslog'];

/** the pseudo-scheme a queued TCP exchange is stored under, so the drain can dispatch on it */
export const TCP_SCHEME_PREFIX = 'tcp+';

/** the vars an endpoint is resolved from; a subset of `SiteEnv`, so the resolver is drivable */
export type TcpEnv = {
	REDIS_URL?: string;
	SYSLOG_URL?: string;
	SYSLOG_APP_NAME?: string;
};

export interface TcpEndpoint {
	protocol: TcpProtocol;
	hostname: string;
	port: number;
	tls: 'off' | 'implicit' | 'starttls';
	username?: string;
	password?: string;
	/** redis only: the database index from the URL path */
	db?: number;
}

/** blocked outbound on Workers, so an endpoint on it is refused at resolve time rather than dialled */
export const BLOCKED_TCP_PORT = 25;

/**
 * Every scheme, with its default port and whether it is TLS from the first byte.
 *
 * The TLS flag is a FIELD rather than a suffix test, because `'redis:'.endsWith('s:')` is true --
 * which silently made every plaintext Redis endpoint dial implicit TLS until a spec caught it.
 */
const SCHEMES: Record<string, { protocol: TcpProtocol; port: number; tls: boolean }> = {
	'redis:': { protocol: 'redis', port: 6379, tls: false },
	'rediss:': { protocol: 'redis', port: 6380, tls: true },
	'syslog:': { protocol: 'syslog', port: 514, tls: false },
	'syslogs:': { protocol: 'syslog', port: 6514, tls: true }
};

/**
 * Resolves one protocol's endpoint from the operator's configuration.
 *
 * Returns a refusal rather than throwing, because every caller reports it to PHP as text: a site
 * that never configured Redis must be told that, not handed a connection error from a default host.
 */
export function resolveTcpEndpoint(
	env: TcpEnv,
	protocol: TcpProtocol
): { endpoint: TcpEndpoint } | { refusal: string } {
	const varName = protocol === 'redis' ? 'REDIS_URL' : 'SYSLOG_URL';
	const raw = String(env[varName] ?? '').trim();
	if (raw === '') return { refusal: `${protocol} is not configured; set ${varName}` };

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { refusal: `${varName} is not a URL` };
	}

	const scheme = SCHEMES[url.protocol];
	if (scheme === undefined) {
		return {
			refusal: `${varName} scheme must be one of ${Object.keys(SCHEMES).join(', ')}; got ${url.protocol}`
		};
	}
	if (scheme.protocol !== protocol) {
		return { refusal: `${varName} carries a ${url.protocol} URL, which is not ${protocol}` };
	}
	if (url.hostname === '') return { refusal: `${varName} has no host` };

	const port = url.port === '' ? scheme.port : Number(url.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { refusal: `${varName} port must be a port number; got ${url.port}` };
	}
	if (port === BLOCKED_TCP_PORT) {
		return { refusal: `port ${BLOCKED_TCP_PORT} is blocked outbound on Workers` };
	}

	const endpoint: TcpEndpoint = {
		protocol,
		hostname: url.hostname,
		port,
		// redis has no in-band upgrade, so a redis endpoint is implicit or plaintext and never
		// starttls; syslog over TLS is RFC 5425, which is also implicit
		tls: scheme.tls ? 'implicit' : 'off'
	};
	if (url.username !== '') endpoint.username = decodeURIComponent(url.username);
	if (url.password !== '') endpoint.password = decodeURIComponent(url.password);
	if (protocol === 'redis') {
		const db = Number(url.pathname.replace(/^\//, ''));
		if (Number.isInteger(db) && db >= 0) endpoint.db = db;
	}
	return { endpoint };
}

// #endregion

// #region the redis command surface PHP may reach

/**
 * Commands whose answer can be cached and whose retry is a slower success rather than a second
 * outcome, so they take the GET budget and TTL from `deferred-post.ts`.
 */
export const REDIS_READ_COMMANDS: ReadonlySet<string> = new Set([
	'GET',
	'MGET',
	'EXISTS',
	'TTL',
	'PTTL',
	'TYPE',
	'STRLEN',
	'HGET',
	'HMGET',
	'HGETALL',
	'HKEYS',
	'HVALS',
	'HLEN',
	'HEXISTS',
	'LRANGE',
	'LLEN',
	'LINDEX',
	'SMEMBERS',
	'SISMEMBER',
	'SCARD',
	'ZRANGE',
	'ZSCORE',
	'ZCARD',
	'ZCOUNT',
	'GETRANGE',
	'BITCOUNT',
	'PING',
	'DBSIZE'
]);

/**
 * Commands a module may not run against the operator's server.
 *
 * The endpoint is chosen by the operator and shared with whatever else uses it, so a contrib module
 * that can reach it must not be able to erase it, reconfigure it, or run Lua on it. This is a trust
 * boundary and not a taste judgement: everything here either destroys data outside this site's
 * keyspace, changes the server's configuration, or executes code.
 */
export const REDIS_REFUSED_COMMANDS: ReadonlySet<string> = new Set([
	'FLUSHALL',
	'FLUSHDB',
	'CONFIG',
	'SHUTDOWN',
	'DEBUG',
	'SCRIPT',
	'EVAL',
	'EVALSHA',
	'FUNCTION',
	'MODULE',
	'ACL',
	'REPLICAOF',
	'SLAVEOF',
	'MIGRATE',
	'RESET',
	'SUBSCRIBE',
	'PSUBSCRIBE',
	'MONITOR',
	'CLUSTER',
	'FAILOVER',
	'SWAPDB',
	'BLPOP',
	'BRPOP',
	'BLMOVE',
	'BZPOPMIN',
	'BZPOPMAX',
	'WAIT'
]);

/**
 * The HTTP method a TCP operation borrows, so the deferred tier's budget and TTL apply unchanged.
 *
 * Reusing them rather than inventing a second policy is the point: `attemptBudget()` already says a
 * non-idempotent operation gets one attempt, and a Redis `INCR` replayed after a timeout is the same
 * defect as a captcha token replayed -- the first attempt may have landed and only failed to return.
 */
export function tcpMethod(protocol: TcpProtocol, command: string): 'GET' | 'POST' {
	if (protocol !== 'redis') return 'POST';
	return REDIS_READ_COMMANDS.has(command.toUpperCase()) ? 'GET' : 'POST';
}

// #endregion

// #region the queue url

/**
 * The url a TCP exchange is queued and keyed under.
 *
 * It names the endpoint so `/health` and a drain report are legible, and it carries NO credentials
 * -- those live in the env and are read at drain time. The operation is in the body, which is what
 * `deferredKey()` already keys on, so two different Redis commands to one server are two rows.
 */
export function tcpQueueUrl(endpoint: TcpEndpoint): string {
	return `${TCP_SCHEME_PREFIX}${endpoint.protocol}://${endpoint.hostname}:${endpoint.port}/`;
}

/** whether a queued row belongs to this tier rather than to `fetch()` */
export function isTcpUrl(url: string): boolean {
	return url.startsWith(TCP_SCHEME_PREFIX);
}

/** the protocol a queued row runs, or null when the url is not this tier's */
export function tcpProtocolOf(url: string): TcpProtocol | null {
	if (!isTcpUrl(url)) return null;
	const name = url.slice(TCP_SCHEME_PREFIX.length).split(':')[0];
	return (TCP_PROTOCOLS as readonly string[]).includes(name ?? '') ? (name as TcpProtocol) : null;
}

// #endregion

// #region running one exchange

/**
 * The transport, injected so a spec drives the real client over a scripted socket.
 *
 * `mail.ts` does the same for SMTP and for the same reason: stubbing `runTcpExchange` itself would
 * assert against a stub, while stubbing the SOCKET runs edgeport's real RESP codec.
 */
export type TcpDeps = { connect: (opts: ConnectOptions) => Promise<CoreSocket> };

export const DEFAULT_TCP_DEPS: TcpDeps = { connect: coreConnect };

/** what one exchange produces, shaped like an HTTP result so the existing cache table is unchanged */
export interface TcpResult {
	status: number;
	headers: Record<string, string>;
	body: string;
}

/** what `cfwTcp` hands PHP when the answer is already in the exchange cache */
export interface TcpCachedReply {
	ok: boolean;
	status: number;
	body: string;
	error?: string;
}

/**
 * Turns a cached exchange row into the reply PHP reads.
 *
 * A non-200 body is the server's own sentence and has to arrive as `error`, which is where
 * `CfwTcp::redis()` looks; putting it only in `body` made every failure read the same.
 */
export function tcpCachedReply(status: number, body: string): TcpCachedReply {
	const ok = status === 200;
	return ok ? { ok, status, body } : { ok, status, body, error: body };
}

/** a redis reply, flattened to something PHP can `json_decode` */
function nativeToJson(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	if (Array.isArray(value)) return value.map(nativeToJson);
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = nativeToJson(v);
		return out;
	}
	return value;
}

async function runRedis(
	endpoint: TcpEndpoint,
	args: RedisArg[],
	deps: TcpDeps
): Promise<TcpResult> {
	const socket = await deps.connect({
		hostname: endpoint.hostname,
		port: endpoint.port,
		tls: endpoint.tls === 'implicit' ? 'on' : 'off'
	});
	const session = await _connectOverSocket(socket, {
		hostname: endpoint.hostname,
		port: endpoint.port,
		tls: endpoint.tls === 'implicit' ? 'implicit' : 'off',
		...(endpoint.username ? { username: endpoint.username } : {}),
		...(endpoint.password ? { password: endpoint.password } : {}),
		...(endpoint.db !== undefined ? { db: endpoint.db } : {})
	});
	try {
		const reply = await session.send(...args);
		return {
			status: 200,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(nativeToJson(reply.value))
		};
	} catch (e) {
		// A RESP error is the SERVER ANSWERING, and edgeport raises it as a ProtocolError rather
		// than putting it on the reply. Letting it propagate would make the drain treat a decision
		// as a transport fault and retry it against a server that has already decided -- so it is a
		// 502 carrying the server's own sentence, while a ConnectionError still escapes to the
		// drain's retry budget where it belongs.
		if (e instanceof ProtocolError || e instanceof AuthError) {
			return { status: 502, headers: {}, body: String(e.message) };
		}
		throw e;
	} finally {
		await session.close();
	}
}

async function runSyslog(
	endpoint: TcpEndpoint,
	record: Record<string, unknown>,
	appName: string,
	deps: TcpDeps
): Promise<TcpResult> {
	const socket = await deps.connect({
		hostname: endpoint.hostname,
		port: endpoint.port,
		tls: endpoint.tls === 'implicit' ? 'on' : 'off'
	});
	const session = syslogSessionFromSocket(socket, {
		hostname: endpoint.hostname,
		port: endpoint.port,
		tls: endpoint.tls,
		...(appName ? { appName } : {})
	});
	try {
		await session.log({
			severity: (record.severity as never) ?? ('info' as never),
			message: String(record.message ?? ''),
			...(record.facility !== undefined ? { facility: record.facility as never } : {}),
			...(record.msgId !== undefined ? { msgId: String(record.msgId) } : {})
		});
		// syslog over TCP never replies, so there is nothing to cache and nothing to read back
		return { status: 204, headers: {}, body: '' };
	} finally {
		await session.close();
	}
}

/**
 * Runs one queued exchange, in JS, between PHP invocations.
 *
 * `body` is what PHP declared: a JSON array of Redis arguments, or a syslog record. It is parsed
 * here rather than at queue time so a row queued by an older build still runs.
 */
export async function runTcpExchange(
	url: string,
	body: string,
	env: TcpEnv,
	deps: TcpDeps = DEFAULT_TCP_DEPS
): Promise<TcpResult> {
	const protocol = tcpProtocolOf(url);
	if (protocol === null) return { status: 400, headers: {}, body: `not a TCP url: ${url}` };

	const resolved = resolveTcpEndpoint(env, protocol);
	if ('refusal' in resolved) return { status: 503, headers: {}, body: resolved.refusal };

	let payload: unknown;
	try {
		payload = JSON.parse(body || 'null');
	} catch {
		return { status: 400, headers: {}, body: 'queued body is not JSON' };
	}

	if (protocol === 'redis') {
		if (!Array.isArray(payload) || payload.length === 0) {
			return {
				status: 400,
				headers: {},
				body: 'a redis exchange needs a non-empty argument array'
			};
		}
		const args = payload.map((a) => (typeof a === 'number' ? a : String(a))) as RedisArg[];
		const command = String(args[0]).toUpperCase();
		if (REDIS_REFUSED_COMMANDS.has(command)) {
			return {
				status: 403,
				headers: {},
				body: `${command} is not reachable from module code`
			};
		}
		return runRedis(resolved.endpoint, args, deps);
	}

	const record = payload !== null && typeof payload === 'object' ? payload : {};
	return runSyslog(
		resolved.endpoint,
		record as Record<string, unknown>,
		String(env.SYSLOG_APP_NAME ?? 'drupal'),
		deps
	);
}

// #endregion
