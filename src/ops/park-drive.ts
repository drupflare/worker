import {
	ConnectionError,
	connect as coreConnect,
	type ConnectOptions,
	type CoreSocket
} from 'edgeport/core';
import { outboundGuardEnabled, refuseOutbound } from './outbound-guard.js';
import { resolveTcpEndpoint, type TcpEndpoint, type TcpEnv } from './tcp.js';

/** what the loop needs of the environment: the socket endpoint, plus the SSRF lever a fetch reads */
export type ParkEnv = TcpEnv & { OUTBOUND_GUARD?: string | null };

/**
 * The loop that answers a parked PHP call, so a synchronous socket read completes inside one render.
 *
 * `src/ops/park.ts` reports whether the interpreter CAN park; this performs the I/O. One iteration is
 * run -> pending -> classify -> perform -> resume, and it repeats until the chain answers `DONE`.
 * Everything happens inside ONE Worker invocation: the host awaits between `_run()` calls, which is
 * legal, while PHP never awaits at all.
 *
 * **THE TOKEN RETURNED BY A TRAPPED OPEN IS MINTED IN PHP, not in JS.** `cfw_park_resume()` copies a
 * zval, and JS cannot construct a PHP resource -- but the resume fragment is PHP the host composes,
 * so it opens a `php://memory` stream and hands THAT back. Predis calls `is_resource()` on the result
 * (`StreamConnection::write`, `::read`), so an integer handle would have failed both, and it would
 * have failed as a connection error rather than as anything naming this file.
 *
 * **A READ-ONLY TOKEN, AND THAT IS THE FAILURE MODE TALKING.** When a park is refused the trap falls
 * through to the REAL function, which would write the RESP command into the token and read nothing
 * back -- a corrupted protocol conversation rather than an error. Opening it `r` makes the
 * fall-through fail at the first write, so a refused park raises `Predis\ConnectionException` at the
 * point it happened instead of somewhere downstream.
 */

/** how a park stopped, once the fn and its args are classified */
export type ParkOp =
	| { kind: 'open'; endpoint: TcpEndpoint }
	| { kind: 'fetch'; request: ParkFetch }
	| { kind: 'write'; id: number; bytes: Uint8Array }
	| { kind: 'read'; id: number; max: number }
	| { kind: 'line'; id: number }
	/** the handle is not one the host minted, so PHP performs the call itself */
	| { kind: 'passthrough'; fn: string }
	| { kind: 'refused'; why: string };

/** one argument of a parked call, as the pending reader encodes it */
export type ParkArg =
	{ res: number } | { b64: string } | { arr: number } | { obj: string } | number | boolean | null;

export type ParkPending = { fn: string; args: ParkArg[] };

/**
 * The functions the socket class traps.
 *
 * `fclose` is deliberately absent. It has no alias and no userland equivalent, so a trapped
 * `fclose` on a handle the host did not mint could not be performed at all -- and leaving it
 * untrapped costs nothing: PHP closes the token, and the socket behind it is closed by
 * {@link ParkSockets.closeAll} when the interpreter is dropped.
 *
 * `fwrite` HAS an alias and that is what makes the fall-through possible: `fputs` is a separate
 * `zend_function` carrying its own copy of the handler pointer, so trapping `fwrite` leaves `fputs`
 * pointing at the original. `fread` and `fgets` have no alias and are rebuilt from
 * `stream_get_contents` instead.
 */
export const PARK_SOCKET_TRAPS: readonly string[] = [
	'stream_socket_client',
	'fwrite',
	'fread',
	'fgets'
];

/**
 * The functions the fetch class traps.
 *
 * `stream_socket_client` ALONE, and it is a yield point rather than a socket open here: the module's
 * Guzzle handler calls it with a `cfwpark+fetch://` target and the host answers with a whole HTTP
 * response. The read/write family is deliberately absent -- an HTTP exchange needs one round trip,
 * not a byte stream, so arming the rest would divert every file write in a render for nothing.
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
};

/**
 * The scheme that turns the socket trap into a general yield.
 *
 * A trapped `stream_socket_client` normally answers with a stream token; under this scheme it
 * answers with a JSON string instead, and only `Drupal\drupflare\Http\ParkFetchHandler` calls it
 * that way. Written down because the return type genuinely depends on the target, which is the kind
 * of thing that reads as a bug to the next person.
 */
export const PARK_FETCH_SCHEME = 'cfwpark+fetch://';

/** a read that has not arrived in this long is a hung peer holding the object; give up on it */
export const PARK_IO_TIMEOUT_MS = 10_000;

/**
 * How many trips one parked run may take before the host stops answering it.
 *
 * 400 because the measured figure is 189: a 9-bin render at one multiple-key read per bin took 189
 * parks against the rig's Redis, so a bound near it would refuse a render that was working. It is a
 * backstop for a chain that parks forever, not a budget, which is why it sits above the measurement
 * rather than at it.
 */
export const PARK_MAX_TRIPS = 400;

const LF = new Uint8Array([10]);

/**
 * Fences the loop's own JSON off from whatever the parked program printed.
 *
 * The two share one output stream: a resume re-enters the chain, so the fragment that carries the
 * host's answer prints its `{"state":...}` into the same buffer the render is writing its page into.
 * Reading the first `{` would take the render's opening brace and reading the last would take the
 * control object only by luck, so each control fragment brackets its JSON and the driver slices it
 * out. `` cannot occur in the program's own output, because a render prints JSON and json_encode
 * escapes every control character.
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

/** the fragment that starts a parked run; the body is base64 so nothing has to be escaped into PHP */
export function parkRun(code: string): string {
	return (
		'<?php $s = cfw_park_run(base64_decode("' +
		b64(stripPhpTag(code)) +
		'")); echo "\\x01", json_encode(["state" => $s]), "\\x01";'
	);
}

/**
 * Mints the token a trapped open will return, and reports the resource id the host keys on.
 *
 * Separate from the resume, and it has to be: the resume hands the token back to PHP, which writes
 * to it on the very next trip, so the socket must already be open by then. Minting and resuming in
 * one fragment would leave no point at which the host could dial.
 */
export const PARK_MINT = [
	'<?php $r = fopen("php://memory", "r");',
	'$id = get_resource_id($r);',
	'$GLOBALS["CFW_PARK_TOKENS"][$id] = $r;',
	'echo "\\x01", json_encode(["id" => $id]), "\\x01";'
].join('\n');

/** resumes the open with the token minted earlier, now that its socket is connected */
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
 * Performs the trapped call in PHP, for a handle the host did not mint.
 *
 * Armed traps are global for the duration of a parked run, so a render that writes a file inside one
 * arrives here. Each branch is the untrapped equivalent of the function that parked:
 * `fputs` is the alias, and `stream_get_contents` plus a seek rebuilds `fgets` -- `stream_get_line`
 * cannot, because it strips the delimiter Predis and every line protocol rely on.
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
 * Where a parked call has to be answered.
 *
 * **THE ENDPOINT IS THE OPERATOR'S, and the requested target is never dialled.** `src/ops/tcp.ts`
 * states the reason for the deferred tier and it holds harder here: honouring the host PHP asked for
 * would put arbitrary `host:port` TCP behind any module able to call `stream_socket_client`. The
 * target is checked for shape and the port has to agree with the configured one; the connection goes
 * to `REDIS_URL`.
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
		// the scheme is checked BEFORE the socket parse: a fetch target carries no port and would
		// otherwise be refused as unparseable
		if (target.startsWith(PARK_FETCH_SCHEME)) {
			const request = parseParkFetch(target.slice(PARK_FETCH_SCHEME.length));
			if (!request) return { kind: 'refused', why: 'unreadable fetch descriptor' };
			// THE SAME LEVER THE REST OF THE OUTBOUND PATH READS. `queueHttp()` and `cfwFetch` both
			// go through `outboundGuardEnabled()`, and this branch did not -- so `OUTBOUND_GUARD=0`,
			// which exists for the rig pointing a site at containers on the host, turned off the
			// guard everywhere except here and a parked fetch to the rig was refused as loopback.
			const refusal = outboundGuardEnabled(env) ? refuseOutbound(request.url) : null;
			if (refusal) return { kind: 'refused', why: `${refusal.reason}: ${refusal.url}` };
			return { kind: 'fetch', request };
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
 * `tcp://host:port` or `host:port`, which is what `stream_socket_client` and `fsockopen` take.
 *
 * Port 25 is refused rather than parsed: Cloudflare blocks it for ordinary Workers, so a park there
 * would wait for an answer that cannot arrive. 465 and 587 are the paths that work.
 */
export function parseSocketTarget(target: string): { host: string; port: number } | null {
	const withoutScheme = target.replace(/^[a-z0-9+.-]+:\/\//i, '');
	const at = withoutScheme.lastIndexOf(':');
	if (at <= 0) return null;
	const host = withoutScheme.slice(0, at);
	const port = Number(withoutScheme.slice(at + 1));
	if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
	if (port === 25) return null;
	return { host, port };
}

// #endregion

// #region the sockets a parked chain holds

export type ParkConnect = (opts: ConnectOptions) => Promise<CoreSocket>;

type Held = { socket: CoreSocket; eof: boolean };

/**
 * The sockets one interpreter holds, keyed by the resource id of its PHP token.
 *
 * Per OBJECT rather than per invocation, because `pib_run` performs no request shutdown: a Predis
 * connection opened on one request is still in `$GLOBALS` on the next, so its socket has to outlive
 * the invocation that opened it. {@link closeAll} is what the interpreter drop has to call, since a
 * dropped module takes the PHP token with it and leaves the socket with no owner.
 */
export class ParkSockets {
	private held = new Map<number, Held>();

	constructor(private connect: ParkConnect = coreConnect) {}

	get minted(): ReadonlySet<number> {
		return new Set(this.held.keys());
	}

	get size(): number {
		return this.held.size;
	}

	async open(id: number, endpoint: TcpEndpoint): Promise<void> {
		const socket = await this.connect({
			hostname: endpoint.hostname,
			port: endpoint.port,
			tls: endpoint.tls === 'implicit' ? 'on' : 'off'
		});
		this.held.set(id, { socket, eof: false });
	}

	async write(id: number, chunk: Uint8Array): Promise<number> {
		const one = this.held.get(id);
		if (!one) return 0;
		await one.socket.writer.write(chunk);
		return chunk.length;
	}

	/** up to `max` bytes; `readN` is exact, which is what a self-describing reply asks for */
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

	/** through the LF, terminator included: `readLine` strips it and every line protocol wants it */
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

export type ParkTrip = { fn: string; op: ParkOp['kind']; why?: string };

export type ParkRun = {
	/** `done` -- the chain finished; `refused` -- an op could not be answered; `capped` -- too many */
	state: 'done' | 'refused' | 'capped' | 'absent';
	trips: ParkTrip[];
	/** everything the parked program printed, with the loop's own control JSON removed */
	output: string;
	why?: string;
};

/**
 * Runs `code` with the socket traps armed, answering every park until the chain finishes.
 *
 * A refusal ends the run rather than retrying it, which is the `/user/password` lesson in a second
 * place: a park nothing can answer needs a terminating observation, not a bound. The bound
 * ({@link PARK_MAX_TRIPS}) is the backstop for a chain that parks forever, and it is high because one
 * Drupal bootstrap over Redis is hundreds of round trips.
 *
 * **A RUN THAT DOES NOT FINISH IS UNWOUND BEFORE RETURNING, and skipping that bricks the object for
 * the rest of its life.** `cfw_park_run` throws when a chain is already parked, so a single refusal
 * left in place would make every later render on this interpreter fail with
 * `cfw: a chain is already parked` -- a permanent fault from a transient one.
 */
export async function drivePark(
	binary: ParkBinary,
	sockets: ParkSockets,
	env: ParkEnv,
	code: string,
	doFetch: typeof fetch = fetch
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
		if (pending === null) {
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

		state = stateOf(await perform(collect, sockets, op, doFetch));
		if (state === null) {
			const out = give('refused', 'a resume answered nothing');
			await unwind(binary);
			return out;
		}
	}

	return give('done');
}

type Collect = (fragment: string) => Promise<unknown>;

async function perform(
	collect: Collect,
	sockets: ParkSockets,
	op: ParkOp,
	doFetch: typeof fetch
): Promise<unknown> {
	if (op.kind === 'open') {
		const minted = (await collect(PARK_MINT)) as Record<string, unknown> | null;
		const id = Number(minted?.['id'] ?? 0);
		if (!Number.isInteger(id) || id <= 0) return null;
		// the dial happens BETWEEN the mint and the resume: PHP writes to the token on the next
		// trip, so a socket opened after the resume would be opened too late
		await sockets.open(id, op.endpoint);
		return await collect(parkResumeToken(id));
	}
	if (op.kind === 'fetch') {
		return await collect(parkResumeBytes(await performFetch(op.request, doFetch)));
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
 * Resumes a chain nobody is going to answer, until nothing is parked.
 *
 * `false` is the value every trapped call returns on failure, so the chain unwinds through its own
 * error handling -- Predis raises a connection exception, Drupal sees a cache miss. There is no
 * abort entry point in the extension and this is why one is not needed.
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
 * One HTTP exchange, answered as a JSON string the module's handler decodes.
 *
 * A REJECTION IS A REPLY, not a throw: the handler turns a non-empty `error` into a Guzzle
 * `RejectedPromise`, which is what a module expects from a transport. Throwing here would end the
 * whole parked run and lose the render with it.
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
			redirect: request.redirect === 'manual' ? 'manual' : 'follow'
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

/** the descriptor a `cfwpark+fetch://` target carries, base64 of JSON */
export function parseParkFetch(packed: string): ParkFetch | null {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes(packed)));
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null) return null;
	const one = raw as Record<string, unknown>;
	if (typeof one['url'] !== 'string' || one['url'] === '') return null;
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
		...(one['redirect'] === 'manual' ? { redirect: 'manual' as const } : {})
	};
}

// #region reading what PHP printed

/**
 * Splits one `_run`'s output into what the program printed and the loop's own control value.
 *
 * The control value is the LAST marked span, because a resume prints the render's remaining output
 * after re-entering the chain and the mint prints a span of its own before it. Everything outside
 * the markers is the program's.
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

export function parsePending(out: string): ParkPending | null {
	const obj = splitControl(out).control;
	if (typeof obj !== 'object' || obj === null) return null;
	const one = obj as Record<string, unknown>;
	if (typeof one['fn'] !== 'string' || !Array.isArray(one['args'])) return null;
	return { fn: one['fn'], args: one['args'] as ParkArg[] };
}

const isRes = (a: ParkArg | undefined): a is { res: number } =>
	typeof a === 'object' && a !== null && typeof (a as { res?: unknown }).res === 'number';

const isB64 = (a: ParkArg | undefined): a is { b64: string } =>
	typeof a === 'object' && a !== null && typeof (a as { b64?: unknown }).b64 === 'string';

function bytes(b64text: string): Uint8Array {
	const raw = atob(b64text);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

const text = (b64text: string): string => new TextDecoder().decode(bytes(b64text));

function b64Bytes(input: Uint8Array): string {
	let raw = '';
	for (const byte of input) raw += String.fromCharCode(byte);
	return btoa(raw);
}

const b64 = (input: string): string => b64Bytes(new TextEncoder().encode(input));

/** `cfw_park_run` evaluates its argument, and an eval may not open with a `<?php` tag */
export function stripPhpTag(code: string): string {
	return code.replace(/^\s*<\?php\s*/, '').replace(/\?>\s*$/, '');
}

// #endregion
