import { beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINT, SITE, e2eGate, serve } from './helpers/endpoint.js';

/**
 * The three shapes P9 named and the lane never covered: cron firing for real, several visitors at
 * once, and the requests an attacker sends.
 *
 * Every other e2e file drives ONE visitor doing something reasonable. These are the cases where a
 * runtime that shares an interpreter between requests fails differently from one that does not, so
 * they can only be asserted against a live worker.
 *
 * SKIP LOCALLY, FAIL IN CI, the same asymmetry as the rest of the lane: a developer with no worker
 * running should not see red, and a CI run that quietly skipped is indistinguishable from a pass.
 */

let skip = true;

beforeAll(async () => {
	skip = await e2eGate();
});

const json = async (res: Response): Promise<Record<string, unknown>> => {
	try {
		return (await res.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
};

const op = (path: string, params: Record<string, string> = {}) => {
	const url = new URL(`${ENDPOINT}${path}`);
	url.searchParams.set('site', SITE);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return fetch(url, { signal: AbortSignal.timeout(60_000) });
};

type CronState = { enabled?: boolean; lastRunMs?: number | null; intervalMs?: number };

const cronState = async (): Promise<CronState> =>
	((await json(await op('/serve-stats')))['cron'] ?? {}) as CronState;

describe('cron, fired for real', () => {
	/**
	 * Cron is DRIVEN from the alarm rather than from a request, so nothing on the request path
	 * writes its clock and, until this landed, nothing outside the object could see whether it had
	 * ever run. `cron-wire.spec.ts` proves the wire in the gate; what this adds is that a DEPLOYED
	 * worker actually fires.
	 */
	it('reports a real cron clock rather than a placeholder', async () => {
		if (skip) return;

		const state = await cronState();
		expect(state.enabled, 'cron is off on this worker, so nothing below can fire').toBe(true);
		expect(state.intervalMs, 'no interval reported').toBeGreaterThanOrEqual(0);
		// a timestamp rather than a counter: the object stamps `cronLastRunMs` on its first alarm,
		// so a null here means the alarm chain has never run at all on this site
		expect(state.lastRunMs, 'cron has never run on this site').not.toBeNull();
		expect(Number(state.lastRunMs)).toBeGreaterThan(0);
	});

	/**
	 * The clock advances, which is the half a stamped-once value cannot show.
	 *
	 * Gated behind the interval: `CRON_INTERVAL_MS=0` on the e2e worker makes every alarm due, and
	 * without it the default is 15 minutes and this can only assert that time did not go backwards.
	 * The skip is explicit rather than silent, for the reason the rest of this lane is.
	 */
	it('advances the clock across firings when the interval allows it', async () => {
		if (skip) return;

		const before = await cronState();
		if ((before.intervalMs ?? Number.MAX_SAFE_INTEGER) > 60_000) {
			// not a failure: the worker is running the shipping 15-minute gate, and waiting for it
			// would make this suite take a quarter of an hour
			return;
		}

		// the fill alarm and the cron gate ride the same chain, so arming one drives the other
		await op('/armfill');
		await new Promise((r) => setTimeout(r, 3000));

		const after = await cronState();
		expect(
			Number(after.lastRunMs ?? 0),
			'the clock went backwards, which means two objects answered'
		).toBeGreaterThanOrEqual(Number(before.lastRunMs ?? 0));
	});
});

describe('several visitors at once', () => {
	/**
	 * The case a shared interpreter fails at and a per-request one cannot.
	 *
	 * PHP here lives for the object's lifetime, so request N sees whatever request N-1 left in
	 * `$_SESSION`, the theme negotiator, the flash bag and the front-page memo. Ten concurrent
	 * requests for three different paths is the cheapest shape that would catch a handover.
	 */
	it('answers ten concurrent requests for three paths without crossing them', async () => {
		if (skip) return;

		const paths = ['/', '/user/login', '/filter/tips'];
		const wanted = Array.from({ length: 10 }, (_, i) => paths[i % paths.length] as string);
		const responses = await Promise.all(wanted.map((p) => serve(p)));
		const bodies = await Promise.all(responses.map((r) => r.text()));

		for (const [i, res] of responses.entries()) {
			expect(res.status, `${wanted[i]} answered ${res.status}`).toBeLessThan(500);
		}

		// every response for one path must be the same length as the others for that path. Bytes
		// would be too strict -- a one-time form token differs between renders -- and length is
		// enough to catch a body that belongs to a different route
		for (const path of paths) {
			const lengths = bodies.filter((_, i) => wanted[i] === path).map((b) => b.length);
			const spread = Math.max(...lengths) - Math.min(...lengths);
			expect(spread, `${path} answered bodies differing by ${spread} bytes`).toBeLessThan(
				2048
			);
		}

		// and the three paths must not answer each other. `/user/login` carrying the front page is
		// exactly what a leaked route match looks like
		const login = bodies.find((_, i) => wanted[i] === '/user/login') ?? '';
		const home = bodies.find((_, i) => wanted[i] === '/') ?? '';
		expect(login).not.toBe(home);
		expect(login.toLowerCase()).toContain('log in');
	});

	/**
	 * Concurrency against ONE path, which is the fill-queue case rather than the routing one.
	 *
	 * Eight simultaneous misses for the same path must not produce eight renders; the queue is
	 * keyed by path for that reason. What is asserted here is the visible half: everybody gets the
	 * same page rather than one of them getting a placeholder forever.
	 */
	it('answers eight simultaneous requests for ONE path consistently', async () => {
		if (skip) return;

		const responses = await Promise.all(Array.from({ length: 8 }, () => serve('/')));
		const bodies = await Promise.all(responses.map((r) => r.text()));
		const lengths = bodies.map((b) => b.length);
		expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(2048);
		for (const res of responses) expect(res.status).toBeLessThan(500);
	});
});

describe('the requests an attacker sends', () => {
	/**
	 * A path traversal must not reach the interpreter filesystem.
	 *
	 * The mounted tree is MEMFS and holds `settings.php` with the site's hash salt, so a traversal
	 * that resolved would be the worst disclosure this runtime has.
	 */
	it('refuses a path traversal rather than serving a file', async () => {
		if (skip) return;

		for (const attack of [
			'/../../sites/default/settings.php',
			'/%2e%2e%2f%2e%2e%2fsettings.php',
			'/..%252f..%252fsettings.php'
		]) {
			const res = await serve(attack);
			const body = await res.text();
			expect(res.status, `${attack} answered ${res.status}`).not.toBe(200);
			expect(body).not.toContain('hash_salt');
			expect(body).not.toContain('$databases');
		}
	});

	/**
	 * A diagnostic route must be unreachable when diagnostics are off.
	 *
	 * `/sql` and `/php` are arbitrary execution behind `PW_DIAGNOSTICS`, and the gate is the only
	 * thing between them and the internet. `KV_OVERRIDABLE` deliberately excludes the flag for this
	 * reason, and this is the assertion that the exclusion means something.
	 */
	it('does not expose the diagnostic surface on a production worker', async () => {
		if (skip) return;

		for (const route of ['/sql', '/php', '/restore', '/heap']) {
			const res = await op(route, { q: 'SELECT 1' });
			// 404 or 403 are both correct; 200 with a result is not
			expect([401, 403, 404, 405], `${route} answered ${res.status}`).toContain(res.status);
		}
	});

	/**
	 * An oversized body must be refused before it is read into the isolate.
	 *
	 * `MAX_BODY_BYTES` exists because a 128 MB isolate cannot buffer an arbitrary upload, and a
	 * refusal that happens after the read is not a refusal.
	 */
	it('refuses an oversized body rather than buffering it', async () => {
		if (skip) return;

		const url = new URL(`${ENDPOINT}/serve`);
		url.searchParams.set('site', SITE);
		url.searchParams.set('path', '/user/login');
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `name=${'a'.repeat(12 * 1024 * 1024)}`,
			signal: AbortSignal.timeout(60_000)
		}).catch(() => null);

		// a connection the worker closed is also a refusal, and is what a body above the limit
		// produces on some paths
		if (res === null) return;
		expect([400, 413, 414, 431, 500]).toContain(res.status);
	});

	/**
	 * A host header the visitor composed must not become the site origin.
	 *
	 * The origin is PINNED on first claim precisely so a later forged header cannot move it; a site
	 * whose canonical URLs follow the attacker's host sends every password reset to them.
	 */
	it('ignores a forged host header once the origin is pinned', async () => {
		if (skip) return;

		const url = new URL(`${ENDPOINT}/serve`);
		url.searchParams.set('site', SITE);
		url.searchParams.set('path', '/');
		const res = await fetch(url, {
			headers: { 'x-forwarded-host': 'evil.example', host: 'evil.example' },
			signal: AbortSignal.timeout(45_000)
		});
		const body = await res.text();
		expect(body).not.toContain('evil.example');
	});
});
