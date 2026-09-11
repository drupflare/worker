import { beforeEach, describe, expect, it } from 'vitest';
import {
	believedGeneration,
	cookieFingerprint,
	EDGE_PLAN_ENTRIES,
	edgePlanKey,
	edgePlanKvKey,
	edgePlanRefused,
	edgePlanStats,
	forgetWitness,
	GENERATION_TRUST_MS,
	hasEdgePlan,
	isRedirectStatus,
	lookupEdgePlan,
	noteEdgeRender,
	PLAN_COMPILE_ATTEMPTS,
	PLAN_TTL_MS,
	planEligibility,
	privatePlanKey,
	readEdgePlan,
	readRedirectPlan,
	redirectPlanBody,
	rememberEdgeGeneration,
	resetEdgePlans,
	rotatesSession,
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
 * The key is the ROLE SET, and two properties replace what the cookie key used to give for free: a
 * plan is compiled only from two DIFFERENT sessions of that role set, so anything constant for one
 * user and different for another shows up as a region the compiler cannot name and the plan is
 * refused; and it is served to a session only once that session's own render has agreed with it.
 * Everything else here is a refusal.
 */

const SITE = 'example.test';
const PATH = '/admin/content';
const ROLES = 'authenticated,editor';
const SESSION_NAME = 'SSESS0123456789abcdef0123456789ab';
const COOKIE_A = `${SESSION_NAME}=alpha-session-value`;
const COOKIE_B = `${SESSION_NAME}=bravo-session-value`;

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
		setCookie: [],
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
		[
			'a rotated session',
			{ setCookie: [`${SESSION_NAME}=rotated-value; path=/`] },
			'skip:set-cookie'
		],
		['a JSON response', { contentType: 'application/json' }, 'skip:not-html']
	])('refuses %s', (_label, overrides, reason) => {
		expect(accepted(overrides)).toEqual({ ok: false, reason });
	});

	/**
	 * THE REFUSAL THAT REFUSED EVERYTHING.
	 *
	 * PHP re-emits the session cookie on every `session_start()` when `session.cookie_lifetime` is
	 * non-zero, and Drupal ships 2000000. Asking whether the response carried `Set-Cookie` therefore
	 * answered yes on every authenticated page on every site, and the tier never compiled anything.
	 * Measured on a running site before the fix: `x-cfw-plan: skip:set-cookie`, six requests in a
	 * row, the value byte-identical to the jar's each time.
	 */
	it('accepts the session cookie PHP re-sends unchanged on every request', () => {
		const resent = `${SESSION_NAME}=alpha-session-value; expires=Wed, 30 Sep 2026 23:53:18 GMT; Max-Age=2000000; path=/; HttpOnly; SameSite=Lax`;
		expect(rotatesSession(COOKIE_A, [resent])).toBe(false);
		expect(accepted({ setCookie: [resent] })).toEqual({ ok: true });
	});

	it.each([
		['a new session id', [`${SESSION_NAME}=rotated`], true],
		['a logout that clears it', [`${SESSION_NAME}=deleted; Max-Age=0`], true],
		['a cookie the request never held', ['Drupal.visitor.name=alice'], true],
		['a malformed line', ['garbage'], true],
		['no cookie at all', [], false]
	])('treats %s as a rotation: %s', (_label, lines, rotated) => {
		expect(rotatesSession(COOKIE_A, lines as string[])).toBe(rotated);
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
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		// the shape the asset-library warm-up produces: render 1 differs from every later one
		expect(noteEdgeRender(key, PATH, staticPage(0), Date.now(), COOKIE_A)).toBeNull();
		expect(noteEdgeRender(key, PATH, staticPage(1), Date.now(), COOKIE_A)).toBeNull();
		const plan = noteEdgeRender(key, PATH, staticPage(1), Date.now(), COOKIE_B);
		expect(plan).not.toBeNull();
		// compiled from renders 2 and 3, so it reproduces THOSE bytes; a compile that had used
		// render 1 would have found an unnamed varying region and refused
		expect(runEdgePlan(plan as RenderPlan)).toBe(staticPage(1));
		expect(Object.keys((plan as RenderPlan).slots)).toHaveLength(0);
	});

	/** one compile's worth of renders, the last from a second session so the pair is eligible */
	const feedOneCompile = (key: string, page: (i: number) => string, from: number): void => {
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) {
			const who = i === SAMPLES_PER_COMPILE - 1 ? COOKIE_B : COOKIE_A;
			expect(noteEdgeRender(key, PATH, page(from + i), Date.now(), who)).toBeNull();
		}
	};

	it('refuses a page whose variation nothing recognises, and gives up after a bound', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		for (let attempt = 0; attempt < PLAN_COMPILE_ATTEMPTS; attempt++) {
			feedOneCompile(key, opaquePage, attempt * 10);
			expect(lookupEdgePlan(key)).toBeNull();
		}
		expect(edgePlanStats().plans).toBe(0);
		expect(edgePlanRefused(key)).toBe(true);
		// spent: the samples are not even kept now, so nothing can compile under this key again
		feedOneCompile(key, staticPage, 100);
		expect(edgePlanStats().plans).toBe(0);
	});

	it('lets a page recover from a refusal one unlucky pair produced', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		// one bad pair, which is all a ticking timestamp or a queued message costs
		feedOneCompile(key, opaquePage, 0);
		expect(edgePlanRefused(key)).toBe(false);
		// and the page compiles on the next attempt rather than paying a render for the rest of
		// the generation
		expect(noteEdgeRender(key, PATH, staticPage(0), Date.now(), COOKIE_A)).toBeNull();
		expect(noteEdgeRender(key, PATH, staticPage(1), Date.now(), COOKIE_A)).toBeNull();
		expect(noteEdgeRender(key, PATH, staticPage(1), Date.now(), COOKIE_B)).not.toBeNull();
		expect(edgePlanStats().plans).toBe(1);
	});

	it('records nothing more once a plan is held', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		noteEdgeRender(key, PATH, staticPage(0), Date.now(), COOKIE_A);
		noteEdgeRender(key, PATH, staticPage(1), Date.now(), COOKIE_A);
		expect(noteEdgeRender(key, PATH, staticPage(1), Date.now(), COOKIE_B)).not.toBeNull();
		expect(noteEdgeRender(key, PATH, staticPage(2), Date.now(), COOKIE_A)).toBeNull();
		expect(runEdgePlan(lookupEdgePlan(key) as RenderPlan)).toBe(staticPage(1));
	});

	it('consults the cold-isolate tier at most once per key', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		expect(shouldCheckKv(key)).toBe(true);
		expect(shouldCheckKv(key)).toBe(false);
	});

	it('evicts the oldest key rather than growing without bound', () => {
		const plan = compilePlan(staticPage(), staticPage(), PATH);
		const first = edgePlanKey(SITE, 1, ROLES, '/p0');
		for (let i = 0; i <= EDGE_PLAN_ENTRIES; i++) {
			storeEdgePlan(edgePlanKey(SITE, 1, ROLES, `/p${i}`), plan);
		}
		expect(edgePlanStats().entries).toBeLessThanOrEqual(EDGE_PLAN_ENTRIES);
		expect(lookupEdgePlan(first)).toBeNull();
	});
});

/**
 * The fallback for a site that can never produce a second witness.
 *
 * A shared plan needs two different sessions of a role set to agree. A site with one editor has one
 * session, so the tier was absent exactly where the object hop is least amortised. The private key
 * names the session, which is why dropping the two-witness requirement under it removes no proof --
 * and every other refusal still runs.
 */
describe('the private fallback', () => {
	beforeEach(() => resetEdgePlans());

	const shared = edgePlanKey(SITE, 1, ROLES, PATH);
	const mine = privatePlanKey(shared, COOKIE_A);

	/** three renders from ONE session, which is all a single-editor site ever produces */
	const soloRenders = (key: string, page = staticPage(1), owned = true) => {
		noteEdgeRender(key, PATH, staticPage(0), Date.now(), COOKIE_A, owned);
		noteEdgeRender(key, PATH, page, Date.now(), COOKIE_A, owned);
		return noteEdgeRender(key, PATH, page, Date.now(), COOKIE_A, owned);
	};

	it('compiles from one session where the shared key refuses to', () => {
		expect(soloRenders(shared, staticPage(1), false)).toBeNull();
		expect(lookupEdgePlan(shared, Date.now(), COOKIE_A)).toBeNull();

		expect(soloRenders(mine)).toBeNull();
		const held = lookupEdgePlan(mine, Date.now(), COOKIE_A);
		expect(held).not.toBeNull();
		expect(runEdgePlan(held as RenderPlan)).toBe(staticPage(1));
	});

	it('is unreachable by any other session', () => {
		soloRenders(mine);
		// the key carries the cookie, so a second session cannot construct it; and the per-session
		// agreement refuses it even when handed the key directly
		expect(privatePlanKey(shared, COOKIE_B)).not.toBe(mine);
		expect(lookupEdgePlan(mine, Date.now(), COOKIE_B)).toBeNull();
	});

	it('is never mirrored to KV', async () => {
		const kv = fakeKv();
		expect(soloRenders(mine)).toBeNull();
		// `noteEdgeRender` returning null is what the caller keys the mirror off, so a private plan
		// cannot reach a listable namespace even by mistake
		expect(kv.map.size).toBe(0);
		expect(await readEdgePlan(kv.env, SITE, 1, ROLES, PATH)).toBeNull();
	});

	it('keeps every refusal the shared key applies', () => {
		// an unnamed varying region is the one the two-witness rule was NOT what caught
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) {
			noteEdgeRender(mine, PATH, opaquePage(i), Date.now(), COOKIE_A, true);
		}
		expect(lookupEdgePlan(mine, Date.now(), COOKIE_A)).toBeNull();
		expect(edgePlanStats().plans).toBe(0);
	});

	it('a write spends the session agreement so the next render carries the message', () => {
		soloRenders(mine);
		expect(lookupEdgePlan(mine, Date.now(), COOKIE_A)).not.toBeNull();
		forgetWitness(COOKIE_A);
		expect(lookupEdgePlan(mine, Date.now(), COOKIE_A)).toBeNull();
	});

	it('a write leaves a shared plan serving everybody else', () => {
		noteEdgeRender(shared, PATH, staticPage(0), Date.now(), COOKIE_A);
		noteEdgeRender(shared, PATH, staticPage(1), Date.now(), COOKIE_A);
		expect(noteEdgeRender(shared, PATH, staticPage(1), Date.now(), COOKIE_B)).not.toBeNull();
		forgetWitness(COOKIE_A);
		expect(lookupEdgePlan(shared, Date.now(), COOKIE_A)).toBeNull();
		expect(lookupEdgePlan(shared, Date.now(), COOKIE_B)).not.toBeNull();
	});

	it('gives up its entry before a shared plan does', () => {
		const plan = compilePlan(staticPage(), staticPage(), PATH);
		const keep = edgePlanKey(SITE, 1, ROLES, '/kept');
		storeEdgePlan(keep, plan);
		for (let i = 0; i <= EDGE_PLAN_ENTRIES; i++) {
			storeEdgePlan(privatePlanKey(keep, `session-${i}`), plan, Date.now(), true);
		}
		expect(edgePlanStats().entries).toBeLessThanOrEqual(EDGE_PLAN_ENTRIES);
		// insertion order alone would have dropped this first, and it is the one serving a role set
		expect(lookupEdgePlan(keep)).not.toBeNull();
	});

	it('reports whether any plan is serving, which is what gates the private compile', () => {
		expect(hasEdgePlan(shared)).toBe(false);
		noteEdgeRender(shared, PATH, staticPage(0), Date.now(), COOKIE_A);
		noteEdgeRender(shared, PATH, staticPage(1), Date.now(), COOKIE_A);
		noteEdgeRender(shared, PATH, staticPage(1), Date.now(), COOKIE_B);
		expect(hasEdgePlan(shared)).toBe(true);
		expect(hasEdgePlan(shared, Date.now() + PLAN_TTL_MS + 1)).toBe(false);
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
		noteEdgeRender(key, PATH, staticPage(0), now, COOKIE_A);
		noteEdgeRender(key, PATH, page, now, COOKIE_A);
		return noteEdgeRender(key, PATH, page, now, COOKIE_B);
	};

	it('stops serving a plan nothing has re-proved', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		expect(compiled(key)).not.toBeNull();
		expect(lookupEdgePlan(key, at + PLAN_TTL_MS - 1)).not.toBeNull();
		expect(lookupEdgePlan(key, at + PLAN_TTL_MS)).toBeNull();
	});

	it('renews on ONE render that agrees, rather than recompiling from three', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		compiled(key);
		const later = at + PLAN_TTL_MS;
		// the render the visitor paid for when the plan stopped serving
		expect(noteEdgeRender(key, PATH, staticPage(1), later, COOKIE_A)).toBeNull();
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
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		compiled(key);
		const later = at + PLAN_TTL_MS;
		expect(
			noteEdgeRender(key, PATH, '<html><body>Log in</body></html>', later, COOKIE_A)
		).toBeNull();
		expect(lookupEdgePlan(key, later)).toBeNull();
		expect(edgePlanStats().plans).toBe(0);
		// and it starts sampling again rather than latching
		noteEdgeRender(key, PATH, staticPage(2), later, COOKIE_A);
		expect(noteEdgeRender(key, PATH, staticPage(2), later, COOKIE_B)).not.toBeNull();
	});

	it('spends nothing on a render that arrives while the proof still holds', () => {
		const key = edgePlanKey(SITE, 1, ROLES, PATH);
		compiled(key);
		// a render inside the window is not a re-proof and must not extend the window either
		expect(noteEdgeRender(key, PATH, staticPage(1), at + 1, COOKIE_A)).toBeNull();
		expect(lookupEdgePlan(key, at + PLAN_TTL_MS)).toBeNull();
	});
});

describe('the cold-isolate tier', () => {
	beforeEach(() => resetEdgePlans());

	it('round trips a plan through KV under the hashed key', async () => {
		const { env, map } = fakeKv();
		const plan = compilePlan(staticPage(), staticPage(), PATH);
		expect(await writeEdgePlan(env, SITE, 5, ROLES, PATH, plan)).toBe(true);
		expect(map.size).toBe(1);
		const back = await readEdgePlan(env, SITE, 5, ROLES, PATH);
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

/**
 * `/user` is a 302 to `/user/<uid>` and was the only profile the tier structurally could not serve.
 * What is asserted is the round trip and the two refusals that keep it per-session: a body that is
 * not a redirect plan must not be read as one, and two sessions redirecting to different uids must
 * not compile a SHARED plan.
 */
describe('a redirect as a plan', () => {
	beforeEach(() => resetEdgePlans());

	it('round-trips the status and the target', () => {
		expect(readRedirectPlan(redirectPlanBody(302, '/user/1'))).toEqual({
			status: 302,
			location: '/user/1'
		});
		expect(readRedirectPlan(redirectPlanBody(308, 'https://example.com/a?b=c#d'))).toEqual({
			status: 308,
			location: 'https://example.com/a?b=c#d'
		});
	});

	it('reads an ordinary page as a page, whatever it contains', () => {
		expect(readRedirectPlan(staticPage(0))).toBeNull();
		expect(readRedirectPlan('')).toBeNull();
		// the shape without the marker, which a page could otherwise produce by accident
		expect(readRedirectPlan('302\n/user/1')).toBeNull();
	});

	it('refuses a status that carries no target and a target that is empty', () => {
		expect(isRedirectStatus(304)).toBe(false);
		expect(isRedirectStatus(200)).toBe(false);
		expect(readRedirectPlan(redirectPlanBody(302, ''))).toBeNull();
	});

	it('is eligible when it has a Location and refused when it does not', () => {
		const base = {
			method: 'GET',
			doCache: 'RENDER',
			contentType: null,
			setCookie: [] as string[],
			personalised: true,
			generation: 1,
			cookie: COOKIE_A
		};
		expect(planEligibility({ ...base, status: 302, location: '/user/1' }).ok).toBe(true);
		expect(planEligibility({ ...base, status: 302, location: null })).toEqual({
			ok: false,
			reason: 'skip:302'
		});
		// and an ordinary 200 still has to be HTML
		expect(planEligibility({ ...base, status: 200, location: null })).toEqual({
			ok: false,
			reason: 'skip:not-html'
		});
	});

	it('compiles for one session and serves that session its own target', () => {
		const key = privatePlanKey(edgePlanKey(SITE, 1, ROLES, '/user'), COOKIE_A);
		const body = redirectPlanBody(302, '/user/1');
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) {
			noteEdgeRender(key, '/user', body, Date.now(), COOKIE_A, true);
		}
		const plan = lookupEdgePlan(key, Date.now(), COOKIE_A);
		expect(plan).not.toBeNull();
		expect(readRedirectPlan(runEdgePlan(plan as RenderPlan) as string)).toEqual({
			status: 302,
			location: '/user/1'
		});
	});

	it('refuses a SHARED plan when two sessions redirect to different users', () => {
		const key = edgePlanKey(SITE, 1, ROLES, '/user');
		noteEdgeRender(key, '/user', redirectPlanBody(302, '/user/1'), Date.now(), COOKIE_A);
		noteEdgeRender(key, '/user', redirectPlanBody(302, '/user/1'), Date.now(), COOKIE_A);
		// the second session's target differs, which is the whole hazard; the compiler must name it
		// an unknown region and decline rather than send one user to the other's account
		noteEdgeRender(key, '/user', redirectPlanBody(302, '/user/2'), Date.now(), COOKIE_B);
		expect(lookupEdgePlan(key, Date.now(), COOKIE_B)).toBeNull();
		expect(edgePlanStats().plans).toBe(0);
	});
});
