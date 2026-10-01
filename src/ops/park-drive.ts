/**
 * Answers parked PHP calls (run, classify, perform, resume until `DONE`) inside one Worker
 * invocation; the host awaits between `_run()` calls, PHP never does.
 * @module
 */
import {
	ConnectionError,
	connect as coreConnect,
	type ConnectOptions,
	type CoreSocket
} from 'edgeport/core';
import {
	backendNeedsPark,
	selectBackend,
	type BackendEnv,
	type BackendSelection
} from '../db/backend';
import { bytesToBase64 } from '../db/file-store';
import { backendExec } from '../db/pg-exec';
import { binaryToBytes } from '../util/base64';
import { errorMessage } from '../util/errors';
import { runParkImage, type ParkImageRequest } from './image-runtime';
import { outboundGuardEnabled, refuseOutbound } from './outbound-guard';
import { resolveTcpEndpoint, type TcpEndpoint, type TcpEnv } from './tcp';

/** what the loop needs of the environment: the socket endpoint plus the SSRF lever fetches read */
export type ParkEnv = TcpEnv & { OUTBOUND_GUARD?: string };

/** how a park stopped, once the fn and its args are classified */
export type ParkOp =
	| { kind: 'open'; endpoint: TcpEndpoint }
	| { kind: 'fetch'; request: ParkFetch }
	| { kind: 'sql'; statement: ParkSql; selection: BackendSelection }
	| { kind: 'sleep'; ms: number }
	| { kind: 'image'; request: ParkImageRequest }
	| { kind: 'write'; id: number; bytes: Uint8Array }
	| { kind: 'read'; id: number; max: number }
	| { kind: 'line'; id: number }
	/** the handle is not one the host minted, so PHP performs the call itself */
	| { kind: 'passthrough'; fn: string }
	| { kind: 'refused'; why: string };

/** one argument of a parked call, as the pending reader encodes it */
export type ParkArg =
	{ res: number } | { b64: string } | { arr: number } | { obj: string } | number | boolean | null;

/** the parked call as read from PHP: the function name and its encoded arguments */
export type ParkPending = { fn: string; args: ParkArg[] };

/**
 * The functions the socket class traps. `fclose` is absent (no alias; {@link ParkSockets.closeAll}
 * closes sockets), and `fputs` keeps its own handler pointer so a fall-through write works.
 */
export const PARK_SOCKET_TRAPS: readonly string[] = [
	'stream_socket_client',
	'fwrite',
	'fread',
	'fgets'
];

/**
 * The fetch class traps `stream_socket_client` alone, as a yield point; the read/write family
 * would divert every file write in a render for nothing.
 */
export const PARK_FETCH_TRAPS: readonly string[] = ['stream_socket_client'];

/** what a `cfwpark+fetch://` target carries, once decoded */
export type ParkFetch = {
	method: string;
	url: string;
	headers: Record<string, string>;
	/** base64, because a request body is not text */
	body?: string;
	redirect?: 'follow' | 'manual';
	/** the caller's whole-request timeout (Guzzle `timeout`, `CURLOPT_TIMEOUT`) */
	timeoutMs?: number;
};

/**
 * The scheme that turns the socket trap into a general yield: under it a trapped
 * `stream_socket_client` returns a JSON string, not a stream token (only `ParkFetchHandler`).
 */
export const PARK_FETCH_SCHEME = 'cfwpark+fetch://';

/**
 * The scheme a parked SQL statement arrives under; must match `CfwSqlClient`'s copy in `rom`.
 * A second scheme, not a second trap, so an external database needs no phasm rebuild.
 */
export const PARK_SQL_SCHEME = 'cfwpark+sql://';

/**
 * The scheme a parked wait arrives under, `cfwpark+sleep://<ms>`; must match `Park::SLEEP_SCHEME`.
 * The clock is frozen across a synchronous `_run()`, so the host waits on a timer (wall, no CPU).
 */
export const PARK_SLEEP_SCHEME = 'cfwpark+sleep://';

/**
 * The scheme a queued gd operation set arrives under; must match `Gd::SCHEME` in `drupflare`.
 * The target is base64 of the request JSON; the reply is `{bytes, width, height}` or `{error}`.
 */
export const PARK_IMAGE_SCHEME = 'cfwpark+image://';

/** what is left of an invocation's waiting allowance, shared by every parked wait inside it */
export type SleepBudget = { remainingMs: number };

/** a read that has not arrived in this long is a hung peer holding the object; give up on it */
export const PARK_IO_TIMEOUT_MS = 10_000;

/**
 * How many trips one parked run may take before the host stops answering it: a backstop above
 * the measured 189 (a 9-bin render against the rig's Redis), not a budget.
 */
export const PARK_MAX_TRIPS = 400;

const LF = new Uint8Array([10]);

/**
 * Fences the loop's own JSON off from program output (a resume prints both to one buffer).
 * `` cannot occur in program output: `json_encode` escapes every control character.
 */
export const PARK_MARK = '';

// #region the PHP side of one iteration

/** reads the parked call, with resources as ids and strings as base64 so bytes survive JSON */
export const PARK_PENDING = [
	'<?php $p = cfw_park_pending();',
	'if ($p === null) { echo "\\x01null\\x01"; return; }',
	'$args = [];',
	'foreach ($p["args"] as $v) {',
	'  if (is_resource($v)) { $args[] = ["res" => get_resource_id($v)]; }',
	'  elseif (is_string($v)) { $args[] = ["b64" => base64_encode($v)]; }',
	'  elseif (is_array($v)) { $args[] = ["arr" => count($v)]; }',
	'  elseif (is_object($v)) { $args[] = ["obj" => get_class($v)]; }',
	'  else { $args[] = $v; }',
	'}',
	'echo "\\x01", json_encode(["fn" => $p["fn"], "args" => $args]), "\\x01";'
].join('\n');

/** whether anything is parked at all, so a chain left behind can be found and unwound */
export const PARK_HELD = '<?php echo "\\x01", json_encode(cfw_park_pending() !== null), "\\x01";';

/** the fragment that starts a parked run; the body is base64 so nothing needs PHP escaping */
export function parkRun(code: string): string {
	return (
		'<?php $s = cfw_park_run(base64_decode("' +
		b64(stripPhpTag(code)) +
		'")); echo "\\x01", json_encode(["state" => $s]), "\\x01";'
	);
}

/**
 * Mints the token a trapped open returns, in PHP: JS cannot build a resource and Predis calls
 * `is_resource()` on it. Separate from the resume so the host can dial before PHP's next write.
 */
export const PARK_MINT = [
	'<?php $r = fopen("php://memory", "r");',
	'$id = get_resource_id($r);',
	'$GLOBALS["CFW_PARK_TOKENS"][$id] = $r;',
	'echo "\\x01", json_encode(["id" => $id]), "\\x01";'
].join('\n');

/**
 * Resumes the open with the token minted earlier. The token is read-only (`r`), so a refused park's
 * fall-through write fails at once instead of corrupting the protocol conversation.
 */
export function parkResumeToken(id: number): string {
	return (
		`<?php $s = cfw_park_resume($GLOBALS["CFW_PARK_TOKENS"][${id}]);` +
		' echo "\\x01", json_encode(["state" => $s]), "\\x01";'
	);
}

/** resumes with a scalar the host computed */
export function parkResumeValue(value: number | boolean): string {
	const literal = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
	return `<?php $s = cfw_park_resume(${literal}); echo "\\x01", json_encode(["state" => $s]), "\\x01";`;
}

/** resumes with bytes; base64 rather than a PHP string literal, because a reply is not text */
export function parkResumeBytes(bytes: Uint8Array): string {
	return (
		'<?php $s = cfw_park_resume(base64_decode("' +
		b64Bytes(bytes) +
		'")); echo "\\x01", json_encode(["state" => $s]), "\\x01";'
	);
}

/**
 * Performs the trapped call in PHP for a handle the host did not mint (traps are global during
 * a parked run). `fgets` is `stream_get_contents` plus a seek: `stream_get_line` strips the LF.
 */
export const PARK_RESUME_PASSTHROUGH = [
	'<?php $p = cfw_park_pending();',
	'$h = $p["args"][0] ?? null;',
	'$fn = $p["fn"];',
	'$out = false;',
	'if (is_resource($h)) {',
	'  if ($fn === "fwrite") { $out = fputs($h, (string) ($p["args"][1] ?? "")); }',
	'  elseif ($fn === "fread") { $out = stream_get_contents($h, (int) ($p["args"][1] ?? 0)); }',
	'  elseif ($fn === "fgets") {',
	'    $chunk = stream_get_contents($h, 8192);',
	'    if ($chunk === "" || $chunk === false) { $out = false; }',
	'    else {',
	'      $at = strpos($chunk, "\\n");',
	'      if ($at === false) { $out = $chunk; }',
	'      else {',
	'        fseek($h, $at + 1 - strlen($chunk), SEEK_CUR);',
	'        $out = substr($chunk, 0, $at + 1);',
	'      }',
	'    }',
	'  }',
	'}',
	'$s = cfw_park_resume($out);',
	'echo "\\x01", json_encode(["state" => $s, "fn" => $fn]), "\\x01";'
].join('\n');

// #endregion

// #region classifying what parked

/**
 * Where a parked call is answered: the operator's endpoint (`REDIS_URL`), never the requested
 * target, which would put arbitrary TCP behind any caller. The port must match the configured one.
 */
export function classifyParkOp(
	pending: ParkPending,
	minted: ReadonlySet<number>,
	env: ParkEnv
): ParkOp {
	const fn = pending.fn.toLowerCase();
	const first = pending.args[0];

	if (fn === 'stream_socket_client' || fn === 'fsockopen' || fn === 'pfsockopen') {
		const target = isB64(first) ? text(first.b64) : '';
		// schemes before the socket parse: a fetch target carries no port
		if (target.startsWith(PARK_FETCH_SCHEME)) {
			const request = parseParkFetch(target.slice(PARK_FETCH_SCHEME.length));
			if (!request) return { kind: 'refused', why: 'unreadable fetch descriptor' };
			// same lever as the rest of outbound, or `OUTBOUND_GUARD=0` (the rig) would miss here
			const refusal = outboundGuardEnabled(env) ? refuseOutbound(request.url) : undefined;
			if (refusal) return { kind: 'refused', why: `${refusal.reason}: ${refusal.url}` };
			return { kind: 'fetch', request };
		}
		if (target.startsWith(PARK_SLEEP_SCHEME)) {
			const ms = Number(target.slice(PARK_SLEEP_SCHEME.length));
			if (!Number.isFinite(ms) || ms < 0) return { kind: 'refused', why: 'unreadable sleep' };
			return { kind: 'sleep', ms: Math.ceil(ms) };
		}
		if (target.startsWith(PARK_IMAGE_SCHEME)) {
			const request = parseParkImage(target.slice(PARK_IMAGE_SCHEME.length));
			return request
				? { kind: 'image', request }
				: { kind: 'refused', why: 'unreadable image request' };
		}
		if (target.startsWith(PARK_SQL_SCHEME)) {
			const statement = parseParkSql(target.slice(PARK_SQL_SCHEME.length));
			if (!statement) return { kind: 'refused', why: 'unreadable sql descriptor' };
			const selection = selectBackend(env as BackendEnv);
			// a refused sql park cannot degrade (no local copy), so it is a named error
			if (!backendNeedsPark(selection)) {
				return {
					kind: 'refused',
					why: selection.why || 'no external database backend is selected'
				};
			}
			return { kind: 'sql', statement, selection };
		}
		const parsed = parseSocketTarget(target);
		if (!parsed) return { kind: 'refused', why: `unparseable socket target: ${target}` };
		const resolved = resolveTcpEndpoint(env, 'redis');
		if ('refusal' in resolved) return { kind: 'refused', why: resolved.refusal };
		if (parsed.port !== resolved.endpoint.port) {
			return {
				kind: 'refused',
				why:
					`a park may only reach the configured endpoint: asked for port ${parsed.port}, ` +
					`REDIS_URL is port ${resolved.endpoint.port}`
			};
		}
		return { kind: 'open', endpoint: resolved.endpoint };
	}

	if (!isRes(first))
		return { kind: 'refused', why: `${pending.fn} parked with no stream handle` };
	if (!minted.has(first.res)) return { kind: 'passthrough', fn };

	if (fn === 'fwrite' || fn === 'fputs') {
		const arg = pending.args[1];
		if (!isB64(arg)) return { kind: 'refused', why: 'fwrite parked with no payload' };
		return { kind: 'write', id: first.res, bytes: bytes(arg.b64) };
	}
	if (fn === 'fread') {
		const max = typeof pending.args[1] === 'number' ? pending.args[1] : 0;
		if (max <= 0) return { kind: 'refused', why: 'fread parked with no length' };
		return { kind: 'read', id: first.res, max };
	}
	if (fn === 'fgets') return { kind: 'line', id: first.res };

	return { kind: 'refused', why: `${pending.fn} is not a trapped socket call` };
}

/**
 * Parses `tcp://host:port` or `host:port`, as `stream_socket_client` and `fsockopen` take.
 * Port 25 is refused: Workers block it, so a park there would wait forever.
 */
export function parseSocketTarget(target: string): { host: string; port: number } | undefined {
	const withoutScheme = target.replace(/^[a-z0-9+.-]+:\/\//i, '');
	const at = withoutScheme.lastIndexOf(':');
	if (at <= 0) return undefined;
	const host = withoutScheme.slice(0, at);
	const port = Number(withoutScheme.slice(at + 1));
	if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	if (port === 25) return undefined;
	return { host, port };
}

// #endregion

// #region the sockets a parked chain holds

/** opens a socket to an endpoint; edgeport's `connect` by default */
export type ParkConnect = (opts: ConnectOptions) => Promise<CoreSocket>;

type Held = { socket: CoreSocket; eof: boolean };

/**
 * The sockets one interpreter holds, by token resource id; per object, as `pib_run` has no
 * request shutdown. The interpreter drop must call {@link closeAll}.
 */
export class ParkSockets {
	/** the held sockets by token resource id */
	private held = new Map<number, Held>();

	constructor(private connect: ParkConnect = coreConnect) {}

	/** the resource ids of the tokens whose sockets this object holds */
	get minted(): ReadonlySet<number> {
		return new Set(this.held.keys());
	}

	/** how many sockets are held */
	get size(): number {
		return this.held.size;
	}

	/** dials the endpoint and keys the socket by the token's resource id */
	async open(id: number, endpoint: TcpEndpoint): Promise<void> {
		const socket = await this.connect({
			hostname: endpoint.hostname,
			port: endpoint.port,
			tls: endpoint.tls === 'implicit' ? 'on' : 'off'
		});
		this.held.set(id, { socket, eof: false });
	}

	/** writes the chunk and returns its length; 0 for an unknown id */
	async write(id: number, chunk: Uint8Array): Promise<number> {
		const one = this.held.get(id);
		if (!one) return 0;
		await one.socket.writer.write(chunk);
		return chunk.length;
	}

	/** exactly `max` bytes via `readN`, as a self-describing reply needs; null at EOF */
	async read(id: number, max: number): Promise<Uint8Array | null> {
		const one = this.held.get(id);
		if (!one || one.eof) return null;
		try {
			return await one.socket.reader.readN(max, PARK_IO_TIMEOUT_MS);
		} catch (e) {
			if (e instanceof ConnectionError) {
				one.eof = true;
				return null;
			}
			throw e;
		}
	}

	/** through the LF, terminator included (`readLine` strips it); null at EOF */
	async line(id: number): Promise<Uint8Array | null> {
		const one = this.held.get(id);
		if (!one || one.eof) return null;
		try {
			return await one.socket.reader.readUntil(LF, 65_536, PARK_IO_TIMEOUT_MS);
		} catch (e) {
			if (e instanceof ConnectionError) {
				one.eof = true;
				return null;
			}
			throw e;
		}
	}

	/** closes every held socket and forgets them */
	async closeAll(): Promise<void> {
		const all = [...this.held.values()];
		this.held.clear();
		for (const one of all) {
			try {
				await one.socket.close();
			} catch {
				// a socket the peer already dropped throws on close; there is nothing left to do
			}
		}
	}
}

// #endregion

// #region the loop

/** the seam the loop needs of an interpreter, so it can be driven from a test */
export type ParkBinary = { runText: (code: string) => Promise<string> };

/** one answered park: the call, how it was classified and why it was refused, if so */
export type ParkTrip = { fn: string; op: ParkOp['kind']; why?: string };

/** the result of one parked run */
export type ParkRun = {
	/** `done` finished; `refused` an op could not be answered; `capped` too many trips */
	state: 'done' | 'refused' | 'capped' | 'absent';
	trips: ParkTrip[];
	/** everything the parked program printed, with the loop's own control JSON removed */
	output: string;
	why?: string;
};

/**
 * Runs `code` with the traps armed, answering every park until the chain finishes. A refusal
 * ends the run, and a chain left parked is unwound (`cfw_park_run` would throw on later renders).
 */
export async function drivePark(
	binary: ParkBinary,
	sockets: ParkSockets,
	env: ParkEnv,
	code: string,
	doFetch: typeof fetch = fetch,
	budget: SleepBudget = { remainingMs: 0 }
): Promise<ParkRun> {
	const trips: ParkTrip[] = [];
	const printed: string[] = [];

	const collect = async (fragment: string): Promise<unknown> => {
		const split = splitControl(await binary.runText(fragment));
		if (split.program !== '') printed.push(split.program);
		return split.control;
	};
	const stateOf = (control: unknown): string | null => {
		if (typeof control !== 'object' || control === null) return null;
		const state = (control as Record<string, unknown>)['state'];
		return typeof state === 'string' ? state : null;
	};
	const give = (state: ParkRun['state'], why?: string): ParkRun => ({
		state,
		trips,
		output: printed.join(''),
		...(why ? { why } : {})
	});

	// a chain left parked by an earlier refusal has to go before this one can start
	await unwind(binary);

	let state = stateOf(await collect(parkRun(code)));
	if (state === null) return give('absent', 'cfw_park_run answered nothing');

	while (state === 'PARKED') {
		if (trips.length >= PARK_MAX_TRIPS) {
			const out = give('capped', `stopped after ${PARK_MAX_TRIPS} trips`);
			await unwind(binary);
			return out;
		}
		const pending = parsePending(await binary.runText(PARK_PENDING));
		if (pending === undefined) {
			const out = give('refused', 'the chain is parked and reports no pending call');
			await unwind(binary);
			return out;
		}
		const op = classifyParkOp(pending, sockets.minted, env);
		trips.push({
			fn: pending.fn,
			op: op.kind,
			...(op.kind === 'refused' ? { why: op.why } : {})
		});
		if (op.kind === 'refused') {
			const out = give('refused', op.why);
			await unwind(binary);
			return out;
		}

		state = stateOf(await perform(collect, sockets, op, doFetch, budget));
		if (state === null) {
			const out = give('refused', 'a resume answered nothing');
			await unwind(binary);
			return out;
		}
	}

	return give('done');
}

type Collect = (fragment: string) => Promise<unknown>;

/** performs one classified op and resumes the chain with its answer; null when unanswerable */
async function perform(
	collect: Collect,
	sockets: ParkSockets,
	op: ParkOp,
	doFetch: typeof fetch,
	budget: SleepBudget
): Promise<unknown> {
	if (op.kind === 'sleep') {
		// past the allowance the wait is cut short, not refused (a refusal unwinds the whole chain)
		const slept = Math.max(0, Math.min(op.ms, budget.remainingMs));
		if (slept > 0) await new Promise((resolve) => setTimeout(resolve, slept));
		budget.remainingMs -= slept;
		const reply = { slept, requested: op.ms, remaining: budget.remainingMs };
		return await collect(parkResumeBytes(new TextEncoder().encode(JSON.stringify(reply))));
	}
	if (op.kind === 'open') {
		const minted = (await collect(PARK_MINT)) as Record<string, unknown> | null;
		const id = Number(minted?.['id'] ?? 0);
		if (!Number.isInteger(id) || id <= 0) return null;
		// dial between the mint and the resume: PHP writes to the token on its next trip
		await sockets.open(id, op.endpoint);
		return await collect(parkResumeToken(id));
	}
	if (op.kind === 'fetch') {
		return await collect(parkResumeBytes(await performFetch(op.request, doFetch)));
	}
	if (op.kind === 'image') {
		return await collect(parkResumeBytes(await performImage(op.request)));
	}
	if (op.kind === 'sql') {
		return await collect(parkResumeBytes(await performSql(op.statement, op.selection)));
	}
	if (op.kind === 'passthrough') return await collect(PARK_RESUME_PASSTHROUGH);
	if (op.kind === 'write') {
		return await collect(parkResumeValue(await sockets.write(op.id, op.bytes)));
	}
	if (op.kind === 'refused') return null;
	const got = op.kind === 'read' ? await sockets.read(op.id, op.max) : await sockets.line(op.id);
	return await collect(got === null ? parkResumeValue(false) : parkResumeBytes(got));
}

/**
 * Resumes a chain nobody will answer with `false` (the failure value of every trapped call) until
 * nothing is parked, so it unwinds through its own error handling; the extension has no abort.
 */
async function unwind(binary: ParkBinary): Promise<number> {
	let resumed = 0;
	while (resumed < PARK_MAX_TRIPS) {
		const held = splitControl(await binary.runText(PARK_HELD)).control;
		if (held !== true) return resumed;
		resumed++;
		const state = splitControl(await binary.runText(parkResumeValue(false))).control;
		if (typeof state !== 'object' || state === null) return resumed;
		if ((state as Record<string, unknown>)['state'] !== 'PARKED') return resumed;
	}
	return resumed;
}

// #endregion

/**
 * One statement against the external database, answered in one JSON shape on both outcomes:
 * a failure becomes a database error in Drupal, where a throw would freeze the chain.
 */
export async function performSql(
	statement: ParkSql,
	selection: BackendSelection,
	exec: typeof backendExec = backendExec
): Promise<Uint8Array> {
	const reply = await exec(selection, statement.sql, statement.params).then(
		(result) => ({ error: '', result }),
		(e: unknown) => ({
			error: errorMessage(e).slice(0, 400),
			result: null
		})
	);
	return new TextEncoder().encode(JSON.stringify(reply));
}

/**
 * One HTTP exchange, answered as a JSON string the module's handler decodes. A rejection is a
 * reply (`error` becomes a Guzzle `RejectedPromise`); a throw would lose the whole render.
 */
export async function performFetch(
	request: ParkFetch,
	doFetch: typeof fetch = fetch
): Promise<Uint8Array> {
	const reply = async (value: Record<string, unknown>) =>
		new TextEncoder().encode(JSON.stringify(value));
	try {
		const res = await doFetch(request.url, {
			method: request.method,
			headers: request.headers,
			...(request.body ? { body: bytes(request.body) } : {}),
			redirect: request.redirect === 'manual' ? 'manual' : 'follow',
			...(request.timeoutMs ? { signal: AbortSignal.timeout(request.timeoutMs) } : {})
		});
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			headers[k] = v;
		});
		return await reply({
			status: res.status,
			headers,
			body: b64Bytes(new Uint8Array(await res.arrayBuffer()))
		});
	} catch (e: unknown) {
		return await reply({ error: e instanceof Error ? e.message : String(e) });
	}
}

/** applies a queued gd operation set, answered as a JSON string (a failure is a reply) */
export async function performImage(
	request: ParkImageRequest,
	run: typeof runParkImage = runParkImage
): Promise<Uint8Array> {
	const reply = (value: Record<string, unknown>) =>
		new TextEncoder().encode(JSON.stringify(value));
	try {
		const out = await run(request);
		return reply({ bytes: b64Bytes(out.bytes), width: out.width, height: out.height });
	} catch (e: unknown) {
		return reply({ error: e instanceof Error ? e.message : String(e) });
	}
}

/** the JSON object a packed descriptor carries, or undefined when unreadable or not an object */
function unpackObject(packed: string): object | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes(packed)));
	} catch {
		return undefined;
	}
	return raw !== null && typeof raw === 'object' ? raw : undefined;
}

/** decodes a `cfwpark+image://` descriptor, or undefined when it is not a well-formed request */
export function parseParkImage(packed: string): ParkImageRequest | undefined {
	const raw = unpackObject(packed);
	if (raw === undefined) return undefined;
	const r = raw as Record<string, unknown>;
	if (!['jpeg', 'png', 'webp', 'gif'].includes(String(r['format']))) return undefined;
	if (!Array.isArray(r['ops']) || r['ops'].length > 32) return undefined;
	if (typeof r['source'] !== 'string' && r['source'] !== null) return undefined;
	return {
		source: r['source'] as string | null,
		canvas: (r['canvas'] as ParkImageRequest['canvas']) ?? null,
		ops: r['ops'] as ParkImageRequest['ops'],
		format: r['format'] as ParkImageRequest['format'],
		quality: typeof r['quality'] === 'number' ? r['quality'] : -1
	};
}

/** one statement a parked render asked the host to run against an external database */
export type ParkSql = { sql: string; params: unknown[] };

/** decodes a `cfwpark+sql://` descriptor; undefined, never a partial statement, when unreadable */
export function parseParkSql(packed: string): ParkSql | undefined {
	const raw = unpackObject(packed);
	if (raw === undefined) return undefined;
	const sql = (raw as { sql?: unknown }).sql;
	if (typeof sql !== 'string' || sql === '') return undefined;
	const params = (raw as { params?: unknown }).params;
	return { sql, params: Array.isArray(params) ? params : [] };
}

/** the descriptor a `cfwpark+fetch://` target carries, base64 of JSON */
export function parseParkFetch(packed: string): ParkFetch | undefined {
	const raw = unpackObject(packed);
	if (raw === undefined) return undefined;
	const one = raw as Record<string, unknown>;
	if (typeof one['url'] !== 'string' || one['url'] === '') return undefined;
	const headers: Record<string, string> = {};
	const given = one['headers'];
	if (typeof given === 'object' && given !== null) {
		for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
			if (typeof v === 'string') headers[k] = v;
		}
	}
	return {
		method: typeof one['method'] === 'string' ? one['method'] : 'GET',
		url: one['url'],
		headers,
		...(typeof one['body'] === 'string' && one['body'] !== '' ? { body: one['body'] } : {}),
		...(one['redirect'] === 'manual' ? { redirect: 'manual' as const } : {}),
		...(typeof one['timeoutMs'] === 'number' && one['timeoutMs'] > 0
			? { timeoutMs: one['timeoutMs'] }
			: {})
	};
}

// #region reading what PHP printed

/**
 * Splits one `_run`'s output into the program's text and the loop's control value, the last
 * marked span (a resume prints the render's remaining output after re-entering the chain).
 */
export function splitControl(out: string): { program: string; control: unknown } {
	const parts = out.split(PARK_MARK);
	// even indexes are outside the markers, odd indexes are the loop's own spans
	if (parts.length < 3) return { program: out, control: null };
	let control: unknown = null;
	const program: string[] = [];
	for (const [i, part] of parts.entries()) {
		if (i % 2 === 0) {
			program.push(part);
			continue;
		}
		try {
			control = JSON.parse(part);
		} catch {
			// a truncated span is not a control value; the run reports it as answering nothing
		}
	}
	return { program: program.join(''), control };
}

/** reads the pending call out of `PARK_PENDING`'s output, or undefined when nothing is parked */
export function parsePending(out: string): ParkPending | undefined {
	const obj = splitControl(out).control;
	if (typeof obj !== 'object' || obj === null) return undefined;
	const one = obj as Record<string, unknown>;
	if (typeof one['fn'] !== 'string' || !Array.isArray(one['args'])) return undefined;
	return { fn: one['fn'], args: one['args'] as ParkArg[] };
}

const isRes = (a: ParkArg | undefined): a is { res: number } =>
	typeof a === 'object' && a !== null && typeof (a as { res?: unknown }).res === 'number';

const isB64 = (a: ParkArg | undefined): a is { b64: string } =>
	typeof a === 'object' && a !== null && typeof (a as { b64?: unknown }).b64 === 'string';

function bytes(b64text: string): Uint8Array {
	return binaryToBytes(atob(b64text));
}

const text = (b64text: string): string => new TextDecoder().decode(bytes(b64text));

// chunked: a per-byte string left ~44 MB of garbage per MB of body, twice per parked fetch reply,
// and an update check over 30 projects reset a farmOS object at 84 MB of linear memory
const b64Bytes = bytesToBase64;

const b64 = (input: string): string => b64Bytes(new TextEncoder().encode(input));

/** `cfw_park_run` evaluates its argument, and an eval may not open with a `<?php` tag */
export function stripPhpTag(code: string): string {
	return code.replace(/^\s*<\?php\s*/, '').replace(/\?>\s*$/, '');
}

// #endregion
