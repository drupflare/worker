/**
 * The deferred TCP tier: PHP declares a whole exchange, JS runs it between invocations, and the
 * answer is read on a later one. A refused park (`park.ts`) degrades to this.
 *
 * The endpoint and credentials come only from `REDIS_URL` / `SYSLOG_URL`, never from PHP, which
 * would otherwise get arbitrary TCP. Import `edgeport/core`, not the root, which esbuild cannot
 * bundle.
 *
 * @module
 */
import {
	AuthError,
	connect as coreConnect,
	ProtocolError,
	type ConnectOptions,
	type CoreSocket
} from 'edgeport/core';
import { _connectOverSocket, type RedisArg } from 'edgeport/redis';
import { _sessionFromSocket as syslogSessionFromSocket } from 'edgeport/syslog';

// #region endpoints

/** `redis` has a reply and is cached or deferred; `syslog` is fire-and-forget */
export type TcpProtocol = 'redis' | 'syslog';

/** every {@link TcpProtocol} */
export const TCP_PROTOCOLS: readonly TcpProtocol[] = ['redis', 'syslog'];

/** the pseudo-scheme a queued TCP exchange is stored under, so the drain can dispatch on it */
export const TCP_SCHEME_PREFIX = 'tcp+';

/** the vars an endpoint is resolved from; a subset of `SiteEnv`, so the resolver is drivable */
export type TcpEnv = {
	REDIS_URL?: string;
	SYSLOG_URL?: string;
	SYSLOG_APP_NAME?: string;
};

/** a resolved operator endpoint */
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

/** blocked outbound on Workers, so refused at resolve time rather than dialled */
export const BLOCKED_TCP_PORT = 25;

// default port and implicit TLS per scheme; a field, since `'redis:'.endsWith('s:')` is true
const SCHEMES: Record<string, { protocol: TcpProtocol; port: number; tls: boolean }> = {
	'redis:': { protocol: 'redis', port: 6379, tls: false },
	'rediss:': { protocol: 'redis', port: 6380, tls: true },
	'syslog:': { protocol: 'syslog', port: 514, tls: false },
	'syslogs:': { protocol: 'syslog', port: 6514, tls: true }
};

/**
 * Resolves one protocol's endpoint from the operator's configuration, or a refusal PHP can show
 * (an unconfigured site is told so rather than dialling a default host).
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
		// never starttls: redis has no in-band upgrade and syslog TLS (RFC 5425) is implicit
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
 * Commands whose answer can be cached and whose retry is harmless, so they take the GET budget and
 * TTL from `deferred-post.ts`.
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
 * Commands a module may not run against the operator's shared server: each destroys data outside
 * this site's keyspace, reconfigures the server, executes code, or blocks.
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
 * The HTTP method a TCP operation borrows, so the deferred tier's budget applies; a write gets one
 * attempt, since a replayed `INCR` may have landed the first time.
 */
export function tcpMethod(protocol: TcpProtocol, command: string): 'GET' | 'POST' {
	if (protocol !== 'redis') return 'POST';
	return REDIS_READ_COMMANDS.has(command.toUpperCase()) ? 'GET' : 'POST';
}

// #endregion

// #region the queue url

/**
 * The url a TCP exchange is queued under: the endpoint without credentials (read from env at
 * drain time). The operation rides in the body, which `deferredKey()` also keys on.
 */
export function tcpQueueUrl(endpoint: TcpEndpoint): string {
	return `${TCP_SCHEME_PREFIX}${endpoint.protocol}://${endpoint.hostname}:${endpoint.port}/`;
}

/** whether a queued row belongs to this tier rather than to `fetch()` */
export function isTcpUrl(url: string): boolean {
	return url.startsWith(TCP_SCHEME_PREFIX);
}

/** the protocol a queued row runs, or undefined when the url is not this tier's */
export function tcpProtocolOf(url: string): TcpProtocol | undefined {
	if (!isTcpUrl(url)) return undefined;
	const name = url.slice(TCP_SCHEME_PREFIX.length).split(':')[0];
	return (TCP_PROTOCOLS as readonly string[]).includes(name ?? '')
		? (name as TcpProtocol)
		: undefined;
}

// #endregion

// #region running one exchange

/**
 * The transport, injected so a spec runs edgeport's real RESP codec over a scripted socket.
 */
export type TcpDeps = { connect: (opts: ConnectOptions) => Promise<CoreSocket> };

/** the real socket connect */
export const DEFAULT_TCP_DEPS: TcpDeps = { connect: coreConnect };

/** what one exchange produces, shaped like an HTTP result for the existing cache table */
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
 * Turns a cached exchange row into the reply PHP reads; a non-200 body also goes in `error`,
 * where `CfwTcp::redis()` looks.
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
	// the handshake stays inside the try: it raises `AuthError`, which must not reach the drain's
	// retry
	let session: Awaited<ReturnType<typeof _connectOverSocket>> | undefined;
	try {
		session = await _connectOverSocket(socket, {
			hostname: endpoint.hostname,
			port: endpoint.port,
			tls: endpoint.tls === 'implicit' ? 'implicit' : 'off',
			...(endpoint.username ? { username: endpoint.username } : {}),
			...(endpoint.password ? { password: endpoint.password } : {}),
			...(endpoint.db !== undefined ? { db: endpoint.db } : {})
		});
		const reply = await session.send(...args);
		return {
			status: 200,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(nativeToJson(reply.value))
		};
	} catch (e) {
		// a RESP or auth error is the server's answer: a 502, not a retryable transport fault
		if (e instanceof ProtocolError || e instanceof AuthError) {
			return { status: 502, headers: {}, body: String(e.message) };
		}
		throw e;
	} finally {
		// undefined when the handshake threw
		if (session) await session.close();
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
		// syslog over TCP never replies
		return { status: 204, headers: {}, body: '' };
	} finally {
		await session.close();
	}
}

/**
 * Runs one queued exchange between PHP invocations. `body` is a JSON array of Redis arguments or a
 * syslog record, parsed here so a row queued by an older build still runs.
 */
export async function runTcpExchange(
	url: string,
	body: string,
	env: TcpEnv,
	deps: TcpDeps = DEFAULT_TCP_DEPS
): Promise<TcpResult> {
	const protocol = tcpProtocolOf(url);
	if (protocol === undefined) return { status: 400, headers: {}, body: `not a TCP url: ${url}` };

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
