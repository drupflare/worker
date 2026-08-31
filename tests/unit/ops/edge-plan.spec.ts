import { beforeEach, describe, expect, it } from 'vitest';
import {
	believedGeneration,
	cookieFingerprint,
	EDGE_PLAN_ENTRIES,
	edgePlanKey,
	edgePlanKvKey,
	edgePlanStats,
	GENERATION_TRUST_MS,
	lookupEdgePlan,
	noteEdgeRender,
	PLAN_TTL_MS,
	planEligibility,
	readEdgePlan,
	rememberEdgeGeneration,
	resetEdgePlans,
	runEdgePlan,
	SAMPLES_PER_COMPILE,
	shouldCheckKv,
	storeEdgePlan,
	withDeadline,
	writeEdgePlan,
	type EdgePlanEnv
} from '../../../src/ops/edge-plan';
import { compilePlan, type RenderPlan } from '../../../src/ops/render-plan';

/**
 * The front worker's compiled-plan tier.
 *
 * The load-bearing property is the KEY: a plan is reachable only by a request carrying the cookie
 * header it was rendered for, which is what makes serving an authenticated page from the edge safe
 * without the per-uid re-harvest the shell tier needs. Everything else here is a refusal.
 */

const SITE = 'example.test';
const PATH = '/admin/content';
const COOKIE_A = 'SSESS0123456789abcdef0123456789ab=alpha-session-value';
const COOKIE_B = 'SSESS0123456789abcdef0123456789ab=bravo-session-value';

/** a page with no per-request value at all, which is 48.4% of authenticated routes */
const staticPage = (n = 1) => `<html><body>${'x'.repeat(200)}<p>page ${n}</p></body></html>`;

/** a page whose only variation is something no recogniser names, so the compile must refuse */
const opaquePage = (n: number) =>
	`<html><body>${'x'.repeat(200)}<span>unread: ${n}</span>${'y'.repeat(200)}</body></html>`;

function accepted(overrides: Partial<Parameters<typeof planEligibility>[0]> = {}) {
	return planEligibility({
		method: 'GET',
		status: 200,
		doCache: 'RENDER',
		contentType: 'text/html; charset=UTF-8',
		setCookie: false,
		personalised: true,
		generation: 7,
		cookie: COOKIE_A,
		...overrides
	});
}

/** the smallest KV stand-in `readEdgePlan`/`writeEdgePlan` need */
function fakeKv() {
	const map = new Map<string, string>();
	let reads = 0;
	return {
		map,
		reads: () => reads,
		env: {
			PLAN: 'paid',
			PAGE_KV: {
				async get(key: string) {
					reads++;
					return map.get(key) ?? null;
				},
				async put(key: string, value: string) {
					map.set(key, value);
				},
				async delete(key: string) {
					map.delete(key);
				}
			}
		} as unknown as EdgePlanEnv
	};
}

describe('the plan key', () => {
	beforeEach(() => resetEdgePlans());

	it('separates two sessions, which is the whole safety argument', () => {
		const a = edgePlanKey(SITE, 3, COOKIE_A, PATH);
		const b = edgePlanKey(SITE, 3, COOKIE_B, PATH);
		expect(a).not.toBe(b);

		const plan = compilePlan(staticPage(), staticPage(), PATH);
		storeEdgePlan(a, plan);
		expect(lookupEdgePlan(a)).not.toBeNull();
		// the second session cannot reach the first session's page by any key it can construct
		expect(lookupEdgePlan(b)).toBeNull();
	});

	it('separates two generations, two sites and two paths', () => {
		const base = edgePlanKey(SITE, 3, COOKIE_A, PATH);
		expect(edgePlanKey(SITE, 4, COOKIE_A, PATH)).not.toBe(base);
		expect(edgePlanKey('other.test', 3, COOKIE_A, PATH)).not.toBe(base);
		expect(edgePlanKey(SITE, 3, COOKIE_A, '/admin/content?page=1')).not.toBe(base);
	});

	it('hashes the cookie for KV, so the credential is not the key an operator lists', async () => {
		const one = await cookieFingerprint(COOKIE_A);
		const two = await cookieFingerprint(COOKIE_A);
		const other = await cookieFingerprint(COOKIE_B);
		expect(one).toMatch(/^[0-9a-f]{32}$/);
		expect(one).toBe(two);
		expect(one).not.toBe(other);
		const key = edgePlanKvKey(SITE, 3, one, PATH);
		expect(key).toContain(one);
		expect(key).not.toContain('alpha-session-value');
	});
});

describe('eligibility', () => {
	it('accepts an authenticated HTML render', () => {
		expect(accepted()).toEqual({ ok: true });
		// a shell VERIFY is a real page Drupal produced for this visitor, so it qualifies too
		expect(accepted({ doCache: 'VERIFY' })).toEqual({ ok: true });
	});

	it.each([
		['a submission', { method: 'POST' }, 'skip:post'],
		['anonymous traffic', { personalised: false }, 'skip:not-personalised'],
		['a request with no cookie', { cookie: '' }, 'skip:no-cookie'],
		['a redirect', { status: 302 }, 'skip:302'],
		['a warming placeholder', { doCache: 'MISS' }, 'skip:MISS'],
		['a response with no generation', { generation: null }, 'skip:no-generation'],
		['a rotated session', { setCookie: true }, 'skip:set-cookie'],
		['a JSON response', { contentType: 'application/json' }, 'skip:not-html']
	])('refuses %s', (_label, overrides, reason) => {
		expect(accepted(overrides)).toEqual({ ok: false, reason });
	});
});

describe('the generation fence', () => {
	beforeEach(() => resetEdgePlans());

	it('knows nothing until a response teaches it', () => {
		expect(believedGeneration(SITE, 1_000)).toBeNull();
		rememberEdgeGeneration(SITE, 12, 1_000);
		expect(believedGeneration(SITE, 1_000)).toBe(12);
	});

	it('stops trusting a generation it has not re-learned, which is what bounds staleness', () => {
		rememberEdgeGeneration(SITE, 12, 1_000);
		expect(believedGeneration(SITE, 1_000 + GENERATION_TRUST_MS - 1)).toBe(12);
		expect(believedGeneration(SITE, 1_000 + GENERATION_TRUST_MS)).toBeNull();
	});
});

describe('compiling from renders', () => {
	beforeEach(() => resetEdgePlans());

	it('needs three renders and discards the first', () => {
		const key = edgePlanKey(SITE, 1, COOKIE_A, PATH);
		// the shape the asset-library warm-up produces: render 1 differs from every later one
		expect(noteEdgeRender(key, PATH, staticPage(0))).toBeNull();
		expect(noteEdgeRender(key, PATH, staticPage(1))).toBeNull();
		const plan = noteEdgeRender(key, PATH, staticPage(1));
		expect(plan).not.toBeNull();
		// compiled from renders 2 and 3, so it reproduces THOSE bytes; a compile that had used
		// render 1 would have found an unnamed varying region and refused
		expect(runEdgePlan(plan as RenderPlan)).toBe(staticPage(1));
		expect(Object.keys((plan as RenderPlan).slots)).toHaveLength(0);
	});

	it('refuses a page whose variation nothing recognises, and stops retrying', () => {
		const key = edgePlanKey(SITE, 1, COOKIE_A, PATH);
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) {
			expect(noteEdgeRender(key, PATH, opaquePage(i))).toBeNull();
		}
		expect(lookupEdgePlan(key)).toBeNull();
		// a refusal is remembered: three more renders must not spend another compile
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) {
			expect(noteEdgeRender(key, PATH, opaquePage(10 + i))).toBeNull();
		}
		expect(edgePlanStats().plans).toBe(0);
	});

	it('records nothing more once a plan is held', () => {
		const key = edgePlanKey(SITE, 1, COOKIE_A, PATH);
		noteEdgeRender(key, PATH, staticPage(0));
		noteEdgeRender(key, PATH, staticPage(1));
		expect(noteEdgeRender(key, PATH, staticPage(1))).not.toBeNull();
		expect(noteEdgeRender(key, PATH, staticPage(2))).toBeNull();
		expect(runEdgePlan(lookupEdgePlan(key) as RenderPlan)).toBe(staticPage(1));
	});

	it('consults the cold-isolate tier at most once per key', () => {
		const key = edgePlanKey(SITE, 1, COOKIE_A, PATH);
		expect(shouldCheckKv(key)).toBe(true);
		expect(shouldCheckKv(key)).toBe(false);
	});

	it('evicts the oldest key rather than growing without bound', () => {
		const plan = compilePlan(staticPage(), staticPage(), PATH);
		const first = edgePlanKey(SITE, 1, COOKIE_A, '/p0');
		for (let i = 0; i <= EDGE_PLAN_ENTRIES; i++) {
			storeEdgePlan(edgePlanKey(SITE, 1, COOKIE_A, `/p${i}`), plan);
		}
		expect(edgePlanStats().entries).toBeLessThanOrEqual(EDGE_PLAN_ENTRIES);
		expect(lookupEdgePlan(first)).toBeNull();
	});
});

/**
 * The bound on how long a session Drupal has ENDED keeps being answered from a plan.
 *
 * The key proves the caller held the cookie, and nothing more: a logout, an expiry or a blocked
 * account all leave a client sending a cookie the plan was compiled under. This is what makes that
 * bounded, so it is a security parameter rather than a freshness one.
 */
describe('the proof expires and is renewed against a live render', () => {
	beforeEach(() => resetEdgePlans());

	const at = 1_000_000;
	const compiled = (key: string, page = staticPage(1), now = at) => {
		noteEdgeRender(key, PATH, staticPage(0), now);
		noteEdgeRender(key, PATH, page, now);
		return noteEdgeRender(key, PATH, page, now);
	};

	it('stops serving a plan nothing has re-proved', () => {
		const key = edgePlanKey(SITE, 1, COOKIE_A, PATH);
		expect(compiled(key)).not.toBeNull();
		expect(lookupEdgePlan(key, at + PLAN_TTL_MS - 1)).not.toBeNull();
		expect(lookupEdgePlan(key, at + PLAN_TTL_MS)).toBeNull();
	});

	it('renews on ONE render that agrees, rather than recompiling from three', () => {
		const key = edgePlanKey(SITE, 1, COOKIE_A, PATH);
		compiled(key);
		const later = at + PLAN_TTL_MS;
		// the render the visitor paid for when the plan stopped serving
		expect(noteEdgeRender(key, PATH, staticPage(1), later)).toBeNull();
		expect(lookupEdgePlan(key, later)).not.toBeNull();
		expect(lookupEdgePlan(key, later + PLAN_TTL_MS - 1)).not.toBeNull();
	});

	/**
	 * A dead session renders as somebody else, and that is what the re-proof catches.
	 *
	 * The login form Drupal answers an ended session with shares no structure with the page the plan
	 * holds, so the re-diff finds a region it cannot name and the plan goes.
	 */
	it('drops a plan the live render no longer agrees with', () => {
		const key = edgePlanKey(SITE, 1, COOKIE_A, PATH);
		compiled(key);
		const later = at + PLAN_TTL_MS;
		expect(noteEdgeRender(key, PATH, '<html><body>Log in</body></html>', later)).toBeNull();
		expect(lookupEdgePlan(key, later)).toBeNull();
		expect(edgePlanStats().plans).toBe(0);
		// and it starts sampling again rather than latching
		noteEdgeRender(key, PATH, staticPage(2), later);
		expect(noteEdgeRender(key, PATH, staticPage(2), later)).not.toBeNull();
	});

	it('spends nothing on a render that arrives while the proof still holds', () => {
		const key = edgePlanKey(SITE, 1, COOKIE_A, PATH);
		compiled(key);
		// a render inside the window is not a re-proof and must not extend the window either
		expect(noteEdgeRender(key, PATH, staticPage(1), at + 1)).toBeNull();
		expect(lookupEdgePlan(key, at + PLAN_TTL_MS)).toBeNull();
	});
});

describe('the cold-isolate tier', () => {
	beforeEach(() => resetEdgePlans());

	it('round trips a plan through KV under the hashed key', async () => {
		const { env, map } = fakeKv();
		const plan = compilePlan(staticPage(), staticPage(), PATH);
		expect(await writeEdgePlan(env, SITE, 5, COOKIE_A, PATH, plan)).toBe(true);
		expect(map.size).toBe(1);
		const back = await readEdgePlan(env, SITE, 5, COOKIE_A, PATH);
		expect(back).not.toBeNull();
		expect(runEdgePlan(back as RenderPlan)).toBe(staticPage());
	});

	/**
	 * A read that has not answered inside the deadline must not be waited on.
	 *
	 * Measured on a deployed paid worker, n=20 per arm: the first read of a key a colo has not seen
	 * costs 46-140 ms whether the key exists or not, and a plan key for a session and path nobody has
	 * compiled is new by construction. Unbounded, this tier put 78 ms at the median in front of a
	 * 12 ms object hop on the first visit to every page.
	 */
	it('gives up on a read slower than the hop it replaces', async () => {
		const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
		const t = Date.now();
		expect(await withDeadline(slow, 8)).toBeNull();
		expect(Date.now() - t).toBeLessThan(150);
		// and a read inside the deadline still answers
		expect(await withDeadline(Promise.resolve('quick'), 8)).toBe('quick');
	});

	it('warms the isolate from a read that arrived late, so the next request has it', async () => {
		const { env } = fakeKv();
		const plan = compilePlan(staticPage(), staticPage(), PATH);
		await writeEdgePlan(env, SITE, 5, COOKIE_A, PATH, plan);
		const key = edgePlanKey(SITE, 5, COOKIE_A, PATH);
		const slow = { ...env, PAGE_KV: { ...env.PAGE_KV } } as EdgePlanEnv;
		const inner = env.PAGE_KV as NonNullable<EdgePlanEnv['PAGE_KV']>;
		// a colo that has never seen this key: measured at 46-140 ms, so it loses the race
		(slow.PAGE_KV as { get: unknown }).get = (k: string, t: 'text') =>
			new Promise((resolve) => setTimeout(() => resolve(inner.get(k, t)), 60));
		const read = readEdgePlan(slow, SITE, 5, COOKIE_A, PATH);
		expect(await withDeadline(read, 8)).toBeNull();
		const late = await read;
		expect(late).not.toBeNull();
		storeEdgePlan(key, late as RenderPlan);
		expect(lookupEdgePlan(key)).not.toBeNull();
	});

	it('answers null for another session, another generation and a missing binding', async () => {
		const { env } = fakeKv();
		const plan = compilePlan(staticPage(), staticPage(), PATH);
		await writeEdgePlan(env, SITE, 5, COOKIE_A, PATH, plan);
		expect(await readEdgePlan(env, SITE, 5, COOKIE_B, PATH)).toBeNull();
		expect(await readEdgePlan(env, SITE, 6, COOKIE_A, PATH)).toBeNull();
		expect(await readEdgePlan({ PLAN: 'paid' }, SITE, 5, COOKIE_A, PATH)).toBeNull();
	});

	it('re-proves a record on the way in, because a stored plan is input', async () => {
		const { env, map } = fakeKv();
		const fingerprint = await cookieFingerprint(COOKIE_A);
		const key = edgePlanKvKey(SITE, 5, fingerprint, PATH);
		// a slot with no generator: the object refuses to serve one and so must this
		map.set(
			key,
			JSON.stringify({
				path: PATH,
				ops: [
					['t', '<html>'],
					['s', 'slot0']
				],
				slots: { slot0: { kind: 'unknown', bytes: 4 } },
				sample: { slot0: 'aaaa' },
				sampleB: { slot0: 'bbbb' }
			})
		);
		expect(await readEdgePlan(env, SITE, 5, COOKIE_A, PATH)).toBeNull();

		map.set(key, 'not json at all');
		expect(await readEdgePlan(env, SITE, 5, COOKIE_A, PATH)).toBeNull();
	});

	it('is off without the binding and on free, the same test `pageKvEnabled` already makes', async () => {
		const { env } = fakeKv();
		const free = { ...env, PLAN: 'free' } as EdgePlanEnv;
		const plan = compilePlan(staticPage(), staticPage(), PATH);
		expect(await writeEdgePlan(free, SITE, 5, COOKIE_A, PATH, plan)).toBe(false);
		expect(await readEdgePlan(free, SITE, 5, COOKIE_A, PATH)).toBeNull();
	});
});
