import { createConnection } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { e2eGate, ENDPOINT, SITE } from './helpers/endpoint';

/**
 * The TCP tier against a real Redis and a real syslog collector. Every other test of it stops at a
 * mock, and a socket dialled against a mock is not evidence about a socket.
 *
 * The assertion is the ROUND TRIP: `/tcp` asks, drains, asks again, because the first ask can only
 * refuse and queue. Rig and env in `tests/e2e/README.md`. Skip locally, fail in CI.
 */

const SYSLOG_READBACK = Number(process.env.CFW_E2E_SYSLOG_READBACK ?? 5515);
const SYSLOG_HOST = process.env.CFW_E2E_SYSLOG_HOST ?? '127.0.0.1';

/** the collector cats its ingest file down a second port; this reads it */
function readSyslog(timeoutMs = 5000): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: SYSLOG_HOST, port: SYSLOG_READBACK });
		let buffer = '';
		const done = (fn: () => void) => {
			socket.destroy();
			fn();
		};
		socket.setTimeout(timeoutMs, () =>
			done(() => reject(new Error('syslog readback timed out')))
		);
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
		});
		socket.on('end', () => done(() => resolve(buffer)));
		socket.on('error', (e) => done(() => reject(e)));
	});
}

async function rigReachable(): Promise<boolean> {
	try {
		await readSyslog(2000);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether the WORKER is wired to the rig, which is a different question from whether the rig is up.
 *
 * `bun run dev` sets no `REDIS_URL`/`SYSLOG_URL`, so with `js/edgeport`'s compose project already
 * holding the ports the collector answered, the gate opened, and four tests then failed on
 * `redis is not configured; set REDIS_URL`. A gate that probes one end of the path passes while the
 * path is broken.
 */
async function workerWired(): Promise<string | null> {
	try {
		const reply = await tcp({ protocol: 'redis', args: 'PING' });
		const error = String(reply.first?.error ?? '');
		return /not configured/i.test(error) ? error : null;
	} catch (e) {
		return `the worker did not answer /tcp: ${String((e as Error)?.message ?? e)}`;
	}
}

type TcpReply = {
	first?: { available?: boolean; ok?: boolean; queued?: boolean; error?: string; throw?: string };
	drained?: unknown;
	second?: { ok?: boolean; value?: unknown; error?: string } | null;
};

function tcp(params: Record<string, string>): Promise<TcpReply> {
	const url = new URL(`${ENDPOINT}/tcp`);
	url.searchParams.set('site', SITE);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return fetch(url, { signal: AbortSignal.timeout(60_000) }).then(
		(r) => r.json() as Promise<TcpReply>
	);
}

describe('the TCP tier over a real socket', () => {
	let skip = false;
	let noRig = false;

	beforeAll(async () => {
		skip = await e2eGate();
		if (skip) return;
		noRig = !(await rigReachable());
		if (noRig && process.env.CI) {
			throw new Error(
				`e2e: no syslog collector at ${SYSLOG_HOST}:${SYSLOG_READBACK} (required in CI). ` +
					'Start it with `docker compose -f docker/compose.yml up -d redis syslog`.'
			);
		}
		if (noRig) return;
		const unwired = await workerWired();
		if (unwired !== null) {
			if (process.env.CI) {
				throw new Error(
					`e2e: the rig is up but the worker is not wired to it (${unwired}). ` +
						'Set REDIS_URL and SYSLOG_URL on the worker under test.'
				);
			}
			noRig = true;
		}
	});

	it('refuses the first redis ask and answers the second, off one drain', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const key = `cfw:e2e:${Date.now().toString(36)}`;
		const value = `v${Math.random().toString(36).slice(2, 10)}`;

		const write = await tcp({ protocol: 'redis', args: `SET,${key},${value}` });
		expect(write.first?.throw, 'PHP threw reaching the tier').toBeUndefined();
		expect(write.first?.available, 'the host did not install cfwTcp').toBe(true);
		// the refusal IS the contract: PHP cannot await, so the first ask can only queue
		expect(write.first?.ok).toBe(false);
		expect(write.first?.queued).toBe(true);
		expect(write.second?.ok, write.second?.error).toBe(true);

		const read = await tcp({ protocol: 'redis', args: `GET,${key}` });
		expect(read.second?.ok, read.second?.error).toBe(true);
		// the value came back out of a server this process never wrote to directly
		expect(read.second?.value).toBe(value);
	});

	it('carries a RESP error back as the server own sentence, not as a transport fault', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		// INCR on a string key is a decision the server made; retrying it would not change it
		const key = `cfw:e2e:str:${Date.now().toString(36)}`;
		await tcp({ protocol: 'redis', args: `SET,${key},notanumber` });
		const bad = await tcp({ protocol: 'redis', args: `INCR,${key}` });
		expect(String(bad.second?.error ?? '')).toMatch(/not an integer|WRONGTYPE|value is not/i);
	});

	it('refuses a command that would reach outside this site', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const refused = await tcp({ protocol: 'redis', args: 'FLUSHALL' });
		expect(refused.first?.ok).toBe(false);
		expect(String(refused.first?.error ?? '')).toContain('FLUSHALL');
		// refused BEFORE the queue, so a drain never sees it
		expect(refused.first?.queued).toBe(false);
	});

	it('delivers a syslog record the collector can read back', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const marker = `cfw-e2e-${Math.random().toString(36).slice(2, 10)}`;
		const sent = await tcp({ protocol: 'syslog', message: marker });
		expect(sent.first?.throw, 'PHP threw reaching the tier').toBeUndefined();
		// syslog never replies, so acceptance is all PHP can be told
		expect(sent.first?.ok).toBe(true);

		const deadline = Date.now() + 20_000;
		let seen = '';
		while (Date.now() < deadline) {
			seen = await readSyslog();
			if (seen.includes(marker)) break;
			await new Promise((r) => setTimeout(r, 750));
		}
		expect(seen, 'the collector never received the record').toContain(marker);
		// RFC 5424 structure, not just the text: a bare string would match the line above
		expect(seen).toMatch(new RegExp(`<\\d+>1 \\S+ \\S+ \\S+ \\S+ cfwtcp .*${marker}`));
	});
});
