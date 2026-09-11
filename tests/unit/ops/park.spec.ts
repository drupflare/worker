import { describe, expect, it } from 'vitest';
import {
	PARK_PROBE,
	PARK_TRAPS,
	type ParkBinary,
	installPark,
	parkEnabled,
	parkTrapInstall
} from '../../../src/ops/park';
import {
	PARK_IO_TIMEOUT_MS,
	PARK_MARK,
	PARK_MAX_TRIPS,
	PARK_PENDING,
	PARK_RESUME_PASSTHROUGH,
	PARK_SOCKET_TRAPS,
	type ParkPending,
	ParkSockets,
	classifyParkOp,
	drivePark,
	parkResumeBytes,
	parkResumeValue,
	parkRun,
	parseSocketTarget,
	stripPhpTag
} from '../../../src/ops/park-drive';

/**
 * The host half of the park, over a mock interpreter and a mock socket.
 *
 * What this lane can establish is the LOOP: that a parked call is classified, answered and resumed in
 * the right order, and that an op the host cannot answer ends the run instead of hanging. What it
 * cannot establish is that the interpreter parks at all -- that needs the real binary and lives in
 * `tests/integration/park-interpreter.spec.ts`.
 */

const res = (id: number) => ({ res: id });
const b64 = (s: string) => ({ b64: btoa(s) });
const pending = (fn: string, ...args: ParkPending['args']): ParkPending => ({ fn, args });
const REDIS = { REDIS_URL: 'redis://cache.test:6379' };

/** a binary that answers each fragment with whatever the test says the interpreter would print */
function binaryOf(answers: Record<string, string>, thrown?: string): ParkBinary {
	return {
		async runText(code: string) {
			if (thrown) throw new Error(thrown);
			for (const [needle, out] of Object.entries(answers)) {
				if (code.includes(needle)) return out;
			}
			return '';
		}
	};
}

describe('reporting whether this interpreter can park', () => {
	it('probes for the extension rather than assuming it', async () => {
		expect(PARK_PROBE).toContain("function_exists('cfw_park_run')");
	});

	it('answers absent, with no traps armed, when the extension is missing', async () => {
		const out = await installPark(binaryOf({ cfw_park_run: '{"park":false}' }));
		expect(out.state).toBe('absent');
		expect(out.armed).toEqual([]);
	});

	it('answers absent when the interpreter prints nothing parseable', async () => {
		expect((await installPark(binaryOf({}))).state).toBe('absent');
	});

	it('reports a throwing interpreter as failed rather than absent', async () => {
		const out = await installPark(binaryOf({}, 'wasm trap'));
		expect(out.state).toBe('failed');
		expect(out.why).toContain('wasm trap');
	});

	/**
	 * ARMS NOTHING UNLESS ASKED, which is a safety property rather than an unfinished default.
	 *
	 * An armed trap diverts every call to that name for the duration of a parked run, so arming
	 * ahead of the loop would hang the first socket write on the site. `ready` is the state for
	 * "the interpreter can park and no call site is diverted".
	 */
	it('arms NOTHING by default, so a trap cannot outrun its drive loop', async () => {
		const out = await installPark(binaryOf({ cfw_park_run: '{"park":true}' }));
		expect(out.state).toBe('ready');
		expect(out.armed).toEqual([]);
	});

	it('distinguishes ready from absent, so a missing extension is not read as an idle one', async () => {
		const ready = await installPark(binaryOf({ cfw_park_run: '{"park":true}' }));
		const absent = await installPark(binaryOf({ cfw_park_run: '{"park":false}' }));
		expect(ready.state).toBe('ready');
		expect(absent.state).toBe('absent');
	});

	it('arms the socket class when asked, and reports the names that took', async () => {
		const out = await installPark(
			binaryOf({
				cfw_park_run: '{"park":true}',
				cfw_park_trap: '{"armed":["stream_socket_client","fwrite"]}'
			}),
			['socket']
		);
		expect(out.state).toBe('installed');
		expect(out.armed).toEqual(['stream_socket_client', 'fwrite']);
	});

	it('reports a rename in php-src as failed rather than as an armed class', async () => {
		const out = await installPark(
			binaryOf({ cfw_park_run: '{"park":true}', cfw_park_trap: '{"armed":[]}' }),
			['socket']
		);
		expect(out.state).toBe('failed');
		expect(out.why).toContain('no trap took');
	});

	/**
	 * THE DRIFT GUARD, and it is the one assertion here that could not be recovered by reading the
	 * code. A trap the loop cannot answer is worse than no trap: it parks the chain, `drivePark`
	 * refuses, and the render fails where it would otherwise have worked. The two lists are the same
	 * object today; this fails if anyone splits them again.
	 */
	it('arms only names the drive loop answers', async () => {
		expect(PARK_TRAPS.socket).toBe(PARK_SOCKET_TRAPS);
		expect(parkTrapInstall(['socket'])).toContain('stream_socket_client');
	});

	it('does not trap fclose, which has no untrapped equivalent to fall through to', async () => {
		expect(PARK_SOCKET_TRAPS).not.toContain('fclose');
	});
});

describe('classifying what a parked call needs', () => {
	it('routes a trapped open to the endpoint the OPERATOR configured', async () => {
		const op = classifyParkOp(
			pending('stream_socket_client', b64('tcp://cache.test:6379')),
			new Set(),
			REDIS
		);
		expect(op.kind).toBe('open');
		expect(op.kind === 'open' && op.endpoint.hostname).toBe('cache.test');
	});

	/**
	 * The endpoint is never the caller's, and this is the assertion that keeps it that way.
	 * `src/ops/tcp.ts` gives the reason: honouring the host PHP asked for would put arbitrary
	 * `host:port` TCP behind any module that can reach `stream_socket_client`.
	 */
	it('refuses an open whose port disagrees with the configured endpoint', async () => {
		const op = classifyParkOp(
			pending('stream_socket_client', b64('tcp://evil.test:22')),
			new Set(),
			REDIS
		);
		expect(op.kind).toBe('refused');
		expect(op.kind === 'refused' && op.why).toContain('configured endpoint');
	});

	it('refuses an open when nothing is configured, naming the var', async () => {
		const op = classifyParkOp(
			pending('stream_socket_client', b64('tcp://cache.test:6379')),
			new Set(),
			{}
		);
		expect(op.kind === 'refused' && op.why).toContain('REDIS_URL');
	});

	it('reads a write as bytes, so a reply that is not text survives', async () => {
		const op = classifyParkOp(pending('fwrite', res(2), b64('PING\r\n')), new Set([2]), REDIS);
		expect(op.kind).toBe('write');
		expect(op.kind === 'write' && new TextDecoder().decode(op.bytes)).toBe('PING\r\n');
	});

	it('reads a sized read and an unsized line as different ops', async () => {
		expect(classifyParkOp(pending('fread', res(2), 4096), new Set([2]), REDIS).kind).toBe(
			'read'
		);
		expect(classifyParkOp(pending('fgets', res(2)), new Set([2]), REDIS).kind).toBe('line');
	});

	/**
	 * THE CASE THAT MAKES ARMING SURVIVABLE. Traps are global for the duration of a parked run, so a
	 * render that writes a file arrives here on a handle the host never minted. It has to be
	 * performed rather than refused, or arming the class would break every file write on the site.
	 */
	it('hands a handle it never minted back to PHP rather than answering it', async () => {
		const op = classifyParkOp(pending('fwrite', res(9), b64('x')), new Set([2]), REDIS);
		expect(op.kind).toBe('passthrough');
		expect(PARK_RESUME_PASSTHROUGH).toContain('fputs');
	});

	it('refuses a trapped call with no stream handle at all', async () => {
		const op = classifyParkOp(pending('fwrite', null), new Set([2]), REDIS);
		expect(op.kind === 'refused' && op.why).toContain('no stream handle');
	});

	it('refuses a read with no length rather than reading an unbounded amount', async () => {
		expect(classifyParkOp(pending('fread', res(2), 0), new Set([2]), REDIS).kind).toBe(
			'refused'
		);
	});
});

describe('the socket target parser', () => {
	it('takes a scheme or no scheme', async () => {
		expect(parseSocketTarget('tcp://h:1')).toEqual({ host: 'h', port: 1 });
		expect(parseSocketTarget('h:1')).toEqual({ host: 'h', port: 1 });
	});

	it('takes the LAST colon, so an ipv6 host does not eat its own port', async () => {
		expect(parseSocketTarget('tcp://[::1]:6379')).toEqual({ host: '[::1]', port: 6379 });
	});

	it('REFUSES port 25, which Cloudflare blocks for ordinary Workers', async () => {
		expect(parseSocketTarget('tcp://mail.example:25')).toBeNull();
		expect(parseSocketTarget('tcp://mail.example:587')).toEqual({
			host: 'mail.example',
			port: 587
		});
	});

	it('rejects a missing, non-numeric or out-of-range port, and an empty host', async () => {
		for (const bad of ['host', 'host:', 'host:abc', 'host:0', 'host:70000', ':6379']) {
			expect(parseSocketTarget(bad), bad).toBeNull();
		}
	});
});

describe('the fragments the loop composes', () => {
	/** `cfw_park_run` evaluates its argument, and an eval may not open with a `<?php` tag */
	it('strips the php tag, because the body is eval-ed rather than run', async () => {
		expect(stripPhpTag('<?php echo 1;')).toBe('echo 1;');
		expect(parkRun('<?php echo 1;')).not.toContain('<?php echo 1;');
		expect(parkRun('<?php echo 1;')).toContain('cfw_park_run(base64_decode(');
	});

	it('carries the body as base64, so no PHP quoting can break it', async () => {
		const nasty = `<?php $x = 'it\\'s' . "\`" . <<<'EOT'\nEOT;`;
		expect(parkRun(nasty)).toContain(btoa(stripPhpTag(nasty)));
	});

	it('resumes bytes through base64 and scalars as literals', async () => {
		expect(parkResumeBytes(new Uint8Array([0, 255]))).toContain(btoa('\x00\xff'));
		expect(parkResumeValue(7)).toContain('cfw_park_resume(7)');
		expect(parkResumeValue(false)).toContain('cfw_park_resume(false)');
	});

	/** the id is read before the resume, because the resume may park again on the next trip */
	it('reads the pending call with resources as ids and strings as base64', async () => {
		expect(PARK_PENDING).toContain('get_resource_id');
		expect(PARK_PENDING).toContain('base64_encode');
	});
});

// #region the sockets and the loop

type FakeSocket = { written: Uint8Array[]; closed: boolean };

/** a CoreSocket-shaped fake whose reader answers a scripted redis conversation */
function socketOf(replies: string[]): { socket: any; state: FakeSocket } {
	const state: FakeSocket = { written: [], closed: false };
	let at = 0;
	const socket = {
		reader: {
			async readN(n: number) {
				const next = replies[at++] ?? '';
				return new TextEncoder().encode(next.slice(0, n));
			},
			async readUntil() {
				return new TextEncoder().encode(replies[at++] ?? '');
			}
		},
		writer: {
			async write(chunk: Uint8Array) {
				state.written.push(chunk);
			}
		},
		async close() {
			state.closed = true;
		}
	};
	return { socket, state };
}

describe('the sockets one interpreter holds', () => {
	it('writes what it was given and reads what the peer sent', async () => {
		const { socket, state } = socketOf(['+PONG\r\n']);
		const sockets = new ParkSockets(async () => socket);
		await sockets.open(2, {
			protocol: 'redis',
			hostname: 'cache.test',
			port: 6379,
			tls: 'off'
		});
		expect(sockets.minted.has(2)).toBe(true);
		expect(await sockets.write(2, new TextEncoder().encode('PING\r\n'))).toBe(6);
		expect(new TextDecoder().decode(state.written[0] as Uint8Array)).toBe('PING\r\n');
		const line = await sockets.line(2);
		expect(new TextDecoder().decode(line as Uint8Array)).toBe('+PONG\r\n');
	});

	/** a failed dial leaves a token with no socket; every call on it has to answer rather than throw */
	it('answers 0 and null for a handle it does not hold', async () => {
		const sockets = new ParkSockets(async () => socketOf([]).socket);
		expect(await sockets.write(9, new Uint8Array([1]))).toBe(0);
		expect(await sockets.read(9, 10)).toBeNull();
		expect(await sockets.line(9)).toBeNull();
	});

	/** the interpreter drop takes the PHP token with it, leaving the socket with no owner */
	it('closes every socket it holds when the interpreter is dropped', async () => {
		const first = socketOf([]);
		const sockets = new ParkSockets(async () => first.socket);
		await sockets.open(2, { protocol: 'redis', hostname: 'c', port: 6379, tls: 'off' });
		expect(sockets.size).toBe(1);
		await sockets.closeAll();
		expect(first.state.closed).toBe(true);
		expect(sockets.size).toBe(0);
	});

	it('bounds a read, so a hung peer cannot hold the object forever', async () => {
		expect(PARK_IO_TIMEOUT_MS).toBeGreaterThan(0);
		expect(PARK_IO_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
	});
});

/**
 * An interpreter that parks its way through one redis exchange.
 *
 * Scripted rather than stateful-fake, so the ORDER is the assertion: the loop has to read the
 * pending call between every resume, and a loop that resumed twice without re-reading would run off
 * the end of this script.
 */
function parkingBinary(script: Array<[string, string]>): ParkBinary & { seen: string[] } {
	const seen: string[] = [];
	let at = 0;
	let parked = false;
	const mark = (json: string) => `${PARK_MARK}${json}${PARK_MARK}`;
	return {
		seen,
		async runText(code: string) {
			// the held probe and the unwind are plumbing rather than the ordering under test, so
			// they are answered from the parked flag instead of costing every script two entries
			if (code.includes('cfw_park_pending() !== null')) return mark(String(parked));
			if (at >= script.length && code.includes('cfw_park_resume')) {
				parked = false;
				return mark('{"state":"DONE"}');
			}
			const step = script[at];
			if (!step)
				throw new Error(`the loop ran past the script at step ${at}: ${code.slice(0, 90)}`);
			const [needle, out] = step;
			if (!code.includes(needle)) {
				throw new Error(`step ${at} wanted ${needle}, got: ${code.slice(0, 90)}`);
			}
			seen.push(needle);
			at++;
			parked = out.includes('"PARKED"');
			return mark(out);
		}
	};
}

describe('the drive loop', () => {
	const PING = '*1\r\n$4\r\nPING\r\n';

	it('drives open, write and read to DONE, in that order', async () => {
		const binary = parkingBinary([
			['cfw_park_run', '{"state":"PARKED"}'],
			[
				'cfw_park_pending',
				`{"fn":"stream_socket_client","args":[{"b64":"${btoa('tcp://cache.test:6379')}"}]}`
			],
			['fopen("php://memory", "r")', '{"id":2}'],
			['cfw_park_resume($GLOBALS["CFW_PARK_TOKENS"][2])', '{"state":"PARKED"}'],
			['cfw_park_pending', `{"fn":"fwrite","args":[{"res":2},{"b64":"${btoa(PING)}"}]}`],
			['cfw_park_resume(14)', '{"state":"PARKED"}'],
			['cfw_park_pending', '{"fn":"fgets","args":[{"res":2}]}'],
			['cfw_park_resume(base64_decode(', '{"state":"DONE"}']
		]);
		const { socket, state } = socketOf(['+PONG\r\n']);
		const out = await drivePark(
			binary,
			new ParkSockets(async () => socket),
			REDIS,
			'<?php ping();'
		);

		expect(out.state).toBe('done');
		expect(out.trips.map((t) => t.op)).toEqual(['open', 'write', 'line']);
		// the mint and the resume are separate calls, and the dial sits between them: the socket
		// carries the command, so it was connected before PHP was handed the token
		expect(new TextDecoder().decode(state.written[0] as Uint8Array)).toBe(PING);
		// the token is minted read-only, so a REFUSED park fails at the first write instead of
		// corrupting the conversation
		expect(binary.seen[2]).toContain('"r"');
	});

	/** the render prints into the same buffer as the loop, so the two have to come apart */
	it('separates what the program printed from its own control JSON', async () => {
		const binary: ParkBinary = {
			async runText(code: string) {
				if (code.includes('cfw_park_pending() !== null'))
					return `${PARK_MARK}false${PARK_MARK}`;
				return `{"html":"a page"}${PARK_MARK}{"state":"DONE"}${PARK_MARK}`;
			}
		};
		const out = await drivePark(
			binary,
			new ParkSockets(async () => socketOf([]).socket),
			REDIS,
			'<?php render();'
		);
		expect(out.state).toBe('done');
		expect(out.output).toBe('{"html":"a page"}');
	});

	/**
	 * THE ONE THAT WOULD HAVE BRICKED THE OBJECT. `cfw_park_run` throws when a chain is already
	 * parked, so a refusal that walked away would make every later render on this interpreter fail
	 * with `cfw: a chain is already parked` -- a permanent fault out of a transient one.
	 */
	it('unwinds a chain it gave up on, so the next run can start', async () => {
		const seen: string[] = [];
		let parked = true;
		const binary: ParkBinary = {
			async runText(code: string) {
				if (code.includes('cfw_park_pending() !== null')) {
					return `${PARK_MARK}${String(parked)}${PARK_MARK}`;
				}
				if (code.includes('cfw_park_resume(false)')) {
					seen.push('resume-false');
					parked = false;
					return `${PARK_MARK}{"state":"DONE"}${PARK_MARK}`;
				}
				if (code.includes('cfw_park_run'))
					return `${PARK_MARK}{"state":"DONE"}${PARK_MARK}`;
				return '';
			}
		};
		const out = await drivePark(
			binary,
			new ParkSockets(async () => socketOf([]).socket),
			REDIS,
			'<?php x();'
		);
		expect(out.state).toBe('done');
		// resumed with `false` before the run started, which is what clears the earlier chain
		expect(seen).toEqual(['resume-false']);
	});

	it('ends the run on an op it cannot answer, rather than retrying it', async () => {
		const binary = parkingBinary([
			['cfw_park_run', '{"state":"PARKED"}'],
			[
				'cfw_park_pending',
				`{"fn":"stream_socket_client","args":[{"b64":"${btoa('tcp://evil.test:22')}"}]}`
			]
		]);
		const out = await drivePark(
			binary,
			new ParkSockets(async () => socketOf([]).socket),
			REDIS,
			'<?php ping();'
		);
		expect(out.state).toBe('refused');
		expect(out.why).toContain('configured endpoint');
		expect(out.trips.at(-1)?.op).toBe('refused');
	});

	it('answers DONE without a single trip when nothing parks', async () => {
		const binary = parkingBinary([['cfw_park_run', '{"state":"DONE"}']]);
		const out = await drivePark(
			binary,
			new ParkSockets(async () => socketOf([]).socket),
			REDIS,
			'<?php nothing();'
		);
		expect(out.state).toBe('done');
		expect(out.trips).toEqual([]);
	});

	it('reports absent when the interpreter cannot park at all', async () => {
		const out = await drivePark(
			binaryOf({}),
			new ParkSockets(async () => socketOf([]).socket),
			REDIS,
			'<?php x();'
		);
		expect(out.state).toBe('absent');
	});

	/** a chain that parks forever needs a backstop, and it is high because a bootstrap is hundreds */
	it('caps the trips a single run may take', async () => {
		expect(PARK_MAX_TRIPS).toBeGreaterThan(100);
		// `cfw_park_resume` is matched FIRST because the passthrough fragment reads the pending call
		// as well as resuming it, so a fake that tests for `cfw_park_pending` first answers a
		// descriptor where the loop is reading a state
		const mark = (json: string) => `${PARK_MARK}${json}${PARK_MARK}`;
		let unwinding = false;
		const forever: ParkBinary = {
			async runText(code: string) {
				if (code.includes('cfw_park_pending() !== null')) return mark(String(unwinding));
				if (code.includes('cfw_park_resume(false)')) {
					unwinding = false;
					return mark('{"state":"DONE"}');
				}
				if (code.includes('cfw_park_resume')) return mark('{"state":"PARKED","id":2}');
				if (code.includes('cfw_park_pending'))
					return mark('{"fn":"fgets","args":[{"res":2}]}');
				unwinding = true;
				return mark('{"state":"PARKED","id":2}');
			}
		};
		const out = await drivePark(
			forever,
			new ParkSockets(async () => socketOf([]).socket),
			REDIS,
			'<?php x();'
		);
		expect(out.state).toBe('capped');
		expect(out.trips.length).toBe(PARK_MAX_TRIPS);
	});

	/** a parked chain that reports no pending call is a broken extension, not an empty answer */
	it('refuses when the chain is parked and nothing is pending', async () => {
		const binary = parkingBinary([
			['cfw_park_run', '{"state":"PARKED"}'],
			['cfw_park_pending', 'null']
		]);
		const out = await drivePark(
			binary,
			new ParkSockets(async () => socketOf([]).socket),
			REDIS,
			'<?php x();'
		);
		expect(out.state).toBe('refused');
		expect(out.why).toContain('no pending call');
	});
});

// #endregion

// #region the operator switch

describe('parkEnabled', () => {
	// EVERY render pays `cfw_park_run` once a class is armed, including the ones that yield
	// nothing: two ordinary renders on the gate interpreter report `runs=2 trips=0`. The switch is
	// what a site running no module that needs a blocking call uses to stop paying for it
	it('is on when the var is absent, which is the shipping default', () => {
		expect(parkEnabled(undefined)).toBe(true);
		expect(parkEnabled(null)).toBe(true);
		expect(parkEnabled({})).toBe(true);
	});

	it('is on at "1" and off at anything else that was deliberately set', () => {
		expect(parkEnabled({ PARK: '1' })).toBe(true);
		expect(parkEnabled({ PARK: '0' })).toBe(false);
		expect(parkEnabled({ PARK: 'off' })).toBe(false);
	});

	it('treats an empty string as unset rather than as off', () => {
		// wrangler passes an undeclared `--var` through as '', and a deploy that meant nothing by it
		// must not silently disarm a capability
		expect(parkEnabled({ PARK: '' })).toBe(true);
	});
});

// #endregion
