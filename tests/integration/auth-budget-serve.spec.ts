import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	AUTH_MODE_HEADER,
	AUTH_REASON_HEADER,
	authAllowance,
	utcDayKey
} from '../../src/ops/auth-budget';
import { SESSION_COOKIE, provisionedNamedSite } from '../helpers/serve-do';

/**
 * The authenticated allowance, driven rather than read.
 *
 * `tests/unit/auth-budget.spec.ts` asserts the ladder over `src/site.ts?raw` -- an ORDERING check
 * by string index, on the stated reasoning that the decision sits in the Worker's `fetch` and there
 * is "nothing to drive it against without a real Durable Object". That premise is stale: `SELF`
 * reaches the whole front worker in this lane, and the two rungs that keep a site from going dark
 * were consequently asserted by regex and executed by nothing.
 *
 * So this file EXECUTES both, and what it pins is the answer rather than the source text: a spent
 * safe request falls through as anonymous, a spent unsafe one is refused by name with a retry time.
 * The source-index assertions stay where they are; they cover ordering, which running one request
 * cannot.
 */

/**
 * The spend record the front worker reads before deciding, written where it reads it.
 *
 * Priming the EDGE record rather than the object's `authSpend` is deliberate: the first
 * authenticated request would otherwise have to render for the object to report a spend, and a
 * render puts this file behind the pack. The key shape is `site.ts`'s `authKey()`, which is module
 * private; if it drifts the degrade stops happening and every assertion here goes red, which is the
 * coupling working rather than a duplicated literal going stale.
 */
async function primeSpentAllowance(origin: string, site: string, renders: number): Promise<void> {
	const day = utcDayKey(Date.now());
	await caches.default.put(
		new Request(
			`${origin}/__cfw/${['authbudget', site, day].map(encodeURIComponent).join('/')}`
		),
		new Response(JSON.stringify({ day, renders }), {
			headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' }
		})
	);
}

const ORIGIN = 'https://cfw.local';

/** an authenticated request through the front worker, which is the only path the ladder is on */
const authed = (site: string, path: string, method = 'GET') =>
	SELF.fetch(`${ORIGIN}/serve?site=${site}&path=${encodeURIComponent(path)}`, {
		method,
		headers: { accept: 'text/html', cookie: SESSION_COOKIE }
	});

describe('the allowance is enforced on the free plan', () => {
	it('is enforced at all, which is what every case below depends on', () => {
		// `enforced: !paid`. If this lane ever runs paid, every degrade below becomes `render`
		// and the file would pass by measuring nothing
		expect(authAllowance({ PLAN: 'free' }).enforced).toBe(true);
	});

	/**
	 * NEVER DARK. A safe method with the allowance gone is served as the ANONYMOUS copy rather
	 * than refused: the session cookie is stripped from the inner request, so the shared tiers
	 * answer it and the object is never charged for a personalised render.
	 */
	it('degrades a spent GET to the anonymous copy rather than refusing it', async () => {
		const site = 'authbudget-stale';
		await provisionedNamedSite(site);
		const allowance = authAllowance({ PLAN: 'free' }).rendersPerDay;
		await primeSpentAllowance(ORIGIN, site, allowance + 1);

		const res = await authed(site, '/');
		expect(res.headers.get(AUTH_MODE_HEADER)).toBe('stale');
		expect(res.headers.get(AUTH_REASON_HEADER)).toContain('serving the anonymous copy');
		// the refusal is what it is NOT: a 503 here would be the site going dark
		expect(res.status).not.toBe(503);
	});

	/**
	 * A spent WRITE is refused BY NAME, with the retry time the quotas actually refill at.
	 *
	 * Midnight UTC rather than a fixed backoff: a client told to retry in 60 s when the budget
	 * refills in six hours retries 360 times and spends the meter the refusal exists to protect.
	 */
	it('refuses a spent POST with 503 and a retry-after that lands on the UTC reset', async () => {
		const site = 'authbudget-readonly';
		await provisionedNamedSite(site);
		const allowance = authAllowance({ PLAN: 'free' }).rendersPerDay;
		await primeSpentAllowance(ORIGIN, site, allowance + 1);

		const res = await authed(site, '/node/1', 'POST');
		expect(res.status).toBe(503);
		expect(res.headers.get(AUTH_MODE_HEADER)).toBe('read-only');
		expect(res.headers.get(AUTH_REASON_HEADER)).toContain('writes resume at 00:00 UTC');
		expect(res.headers.get('cache-control')).toBe('private, no-store');

		// bounded by the day rather than pinned: a pinned magnitude is only correct at one hour
		const retry = Number(res.headers.get('retry-after'));
		expect(retry).toBeGreaterThan(0);
		expect(retry).toBeLessThanOrEqual(86_400);

		// the body NAMES the refusal, so an operator reading a log knows which rung answered
		expect(await res.text()).toContain('allowance spent');
	});

	/**
	 * CONTROL. The same two requests with the allowance intact take neither rung.
	 *
	 * Without this the file would pass on a build where every authenticated request degrades,
	 * which is a worse failure than the one it exists to catch.
	 */
	it('CONTROL: takes neither rung while the allowance remains', async () => {
		const site = 'authbudget-within';
		await provisionedNamedSite(site);
		await primeSpentAllowance(ORIGIN, site, 0);

		const res = await authed(site, '/');
		expect(res.status).not.toBe(503);
		expect(res.headers.get(AUTH_MODE_HEADER)).not.toBe('read-only');
		expect(res.headers.get(AUTH_MODE_HEADER)).not.toBe('stale');
	});

	/**
	 * A record naming another UTC day is not this day's budget.
	 *
	 * `readAuthSpend()` discards it rather than carrying it across, so a site that spent its
	 * allowance yesterday is not refused this morning.
	 */
	it('ignores a spend record from another day rather than carrying it over', async () => {
		const site = 'authbudget-yesterday';
		await provisionedNamedSite(site);
		const day = utcDayKey(Date.now() - 86_400_000);
		await caches.default.put(
			new Request(
				`${ORIGIN}/__cfw/${['authbudget', site, day].map(encodeURIComponent).join('/')}`
			),
			new Response(JSON.stringify({ day, renders: 1_000_000 }), {
				headers: { 'content-type': 'application/json' }
			})
		);

		// A GET, AND ASSERTED ON THE MODE. Both halves matter. The mode rather than the status,
		// because an unfilled path answers 503 `warming` too and a status check would pass for the
		// wrong reason; a GET rather than a POST because the front worker forwards an unsafe
		// method to the object, which needs the pack -- the first version used POST and was red on
		// a clean checkout while passing on every machine that has one.
		//
		// `stale` is what a carried-over record would produce for a safe method, so its absence is
		// the claim.
		const res = await authed(site, '/');
		expect(res.headers.get(AUTH_MODE_HEADER)).not.toBe('stale');
		expect(res.headers.get(AUTH_MODE_HEADER)).not.toBe('read-only');
	});
});
