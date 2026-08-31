import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_BODY_BYTES } from '../../src/ops/body-limit';
import { isCacheTier } from '../../src/ops/cache-tiers';
import { resetEdgePlans, SAMPLES_PER_COMPILE } from '../../src/ops/edge-plan';
import { ensureFleetTable, reportSite, type FleetDb } from '../../src/ops/fleet';
import { ensureOwnerToken, type SecretStore } from '../../src/ops/site-secrets';
import worker, { bodyTooLarge, isNeverDrupal } from '../../src/site';
import {
	inObject,
	namedSite,
	pageFor,
	provisionedNamedSite,
	queuePath,
	seedPage,
	serveThroughWorker,
	SESSION_COOKIE,
	stubRender,
	type ServeProbe
} from '../helpers/serve-do';

/**
 * Ported from the `the edge tier`, `the never-Drupal edge filter` and generation-pointer parts of
 * `scripts/test-serve-chain.mjs`. This is the Worker in front of the object -- `src/site.js` --
 * rather than the object itself.
 *
 * What changed from the original:
 *
 *   - **The page is seeded as a row rather than rendered.** The edge tier does not care how the
 *     HTML was produced, so no interpreter is involved in most of this file; `cfw_page` is data.
 *   - **`PW_DIAGNOSTICS=0` and `WINDOW_SITES` are now testable.** Both are wrangler vars, so the
 *     original could only reach them by restarting `wrangler dev` with different `--var` flags,
 *     which it never did. Here the handler is called directly with a modified env.
 *   - **The pointer-clobbering regression is asserted for the first time.** `asGeneration()`
 *     carries a comment saying a route that reports no generation once overwrote the pointer with
 *     `Number(null) === 0` and made every later lookup build a key nothing was stored under. The
 *     original found it and then only asserted the symptom; here the sequence that caused it -- a
 *     `/serve-stats` call between two serves -- is a test.
 *
 * `caches.default` is the real Cache API, isolated per test file by the pool's `isolatedStorage`.
 */

/** the window the generation pointer is discovered once per, from wrangler.jsonc */
const GEN_BUCKET_MS = 5000;

/**
 * Retries until the edge answers.
 *
 * Carried across from the original's `edgeHit()`, for the reason it gives: the pointer is
 * discovered once per time window, so a request that lands in a window with no pointer yet
 * cannot use the edge and goes to the object instead. That is correct behaviour, not a failure.
 */
async function untilEdge(site: string, path: string, tries = 6): Promise<ServeProbe | null> {
	for (let i = 0; i < tries; i++) {
		const hit = await serveThroughWorker(site, path);
		if (hit.cache === 'EDGE') return hit;
	}
	return null;
}

const serveRequestsOf = (site: string) =>
	inObject(namedSite(site), (obj) => Number(obj.metaGet('serve_requests', '0')));

/**
 * An oversized body is refused at the edge, before any Durable Object hop.
 *
 * The threat is not bandwidth. A form body is `parse_str()`d inside a 128 MB isolate, and
 * `foo[][][][][]=bar` repeated turns a modest number of wire bytes into orders of magnitude more
 * heap -- and this runtime has no separate process to lose, so an OOM takes the site's object with
 * it. Refusing here costs no DO request and no interpreter.
 *
 * `multipart/form-data` is exempt: that is the upload shape, where size is expected, and
 * it is not parsed into a nested array. A 2 MiB cap on uploads would be a regression wearing a
 * guard's clothes.
 */
describe('an oversized request body never reaches the interpreter', () => {
	const post = (body: string, headers: Record<string, string>) =>
		SELF.fetch('https://cfw.local/serve?site=guarded&path=%2Fuser%2Flogin', {
			method: 'POST',
			body,
			headers
		});

	it('refuses a form body over the limit with 413 and names the limit', async () => {
		const res = await post('x'.repeat(64), {
			'content-type': 'application/x-www-form-urlencoded',
			'content-length': String(4 * 1024 * 1024)
		});
		expect(res.status).toBe(413);
		expect(res.headers.get('x-cfw-deny')).toBe('body-too-large');
		expect(res.headers.get('x-cfw-body-limit')).toBe(String(DEFAULT_MAX_BODY_BYTES));
		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	it('lets a body at the limit through, so the boundary is not off by one', () => {
		const at = new Request('https://cfw.local/x', {
			method: 'POST',
			body: 'a=1',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'content-length': String(DEFAULT_MAX_BODY_BYTES)
			}
		});
		expect(bodyTooLarge(at)).toBeNull();
	});

	it('exempts an upload, which is the one shape where size is expected', () => {
		const upload = new Request('https://cfw.local/x', {
			method: 'POST',
			body: 'a=1',
			headers: {
				'content-type': 'multipart/form-data; boundary=----x',
				'content-length': String(64 * 1024 * 1024)
			}
		});
		expect(bodyTooLarge(upload)).toBeNull();
	});

	it('never refuses a GET, which carries no body to parse', () => {
		const get = new Request('https://cfw.local/x', {
			headers: { 'content-length': String(64 * 1024 * 1024) }
		});
		expect(bodyTooLarge(get)).toBeNull();
	});

	// a chunked request declares no length; measuring it means consuming it, which is the cost
	// the guard exists to avoid. The object's own limits still apply
	it('falls through when no Content-Length is declared', () => {
		const chunked = new Request('https://cfw.local/x', {
			method: 'POST',
			body: 'a=1',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		expect(bodyTooLarge(chunked)).toBeNull();
	});

	it('takes the limit from MAX_BODY_BYTES, and 0 disables it', () => {
		const big = new Request('https://cfw.local/x', {
			method: 'POST',
			body: 'a=1',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'content-length': '5000'
			}
		});
		expect(bodyTooLarge(big, { MAX_BODY_BYTES: 4096 })?.limit).toBe(4096);
		expect(bodyTooLarge(big, { MAX_BODY_BYTES: 0 })).toBeNull();

		// a nonsense value falls back to the default rather than disabling the guard by accident,
		// which needs a body over the DEFAULT to be visible at all
		const huge = new Request('https://cfw.local/x', {
			method: 'POST',
			body: 'a=1',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'content-length': String(DEFAULT_MAX_BODY_BYTES + 1)
			}
		});
		expect(bodyTooLarge(huge, { MAX_BODY_BYTES: 'lots' })?.limit).toBe(DEFAULT_MAX_BODY_BYTES);
		expect(bodyTooLarge(huge, { MAX_BODY_BYTES: -5 })?.limit).toBe(DEFAULT_MAX_BODY_BYTES);
	});
});

/**
 * The setup page an unclaimed site serves must never reach the edge cache.
 *
 * It is a 200, which is the one status `putPage()` stores, and it is keyed by path like any other
 * page -- so a stored copy would keep telling visitors to claim a site that has already been
 * claimed, for the whole edge TTL, with no way to tell it apart from the real front page. What
 * actually refuses it is structural rather than a status check: the response carries no
 * `x-cfw-cache`, and `putPage()` stores only `HIT` and `RENDER`. Asserted because that is a
 * property of a header this module does not set, which is exactly the kind of guarantee that
 * disappears silently.
 */
describe('the setup page is never stored at the edge', () => {
	it('answers the claim page and puts nothing in the cache', async () => {
		const site = 'unclaimed';
		await provisionedNamedSite(site);
		const res = await SELF.fetch(`https://cfw.local/serve?site=${site}&path=%2F`, {
			headers: { accept: 'text/html,application/xhtml+xml' }
		});
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get('x-cfw-setup')).toBe('required');
		expect(body).toContain('Claim This Site');
		// the two that decide storage, read off the response the Worker actually returned
		expect(res.headers.get('x-cfw-cache')).toBeNull();
		expect(res.headers.get('x-cfw-edge-put')).not.toBe('stored');
	});
});

describe('the three tiers are distinguishable, and only one of them costs a DO request', () => {
	it('walks MISS to DO HIT to EDGE, and the edge copy never reaches the object', async () => {
		const site = 'tiers';
		// provisioned first, and it is the only test here that needs saying so: this is the one
		// that serves BEFORE seeding a page, so without a database the first request is the
		// first-run placeholder rather than the MISS the walk starts from
		await provisionedNamedSite(site);
		const miss = await serveThroughWorker(site, '/');
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>tiers</title>'));

		const doHit = await serveThroughWorker(site, '/');
		const warmed = await untilEdge(site, '/');
		expect(warmed?.cache, 'the edge copy never became readable').toBe('EDGE');
		const before = await serveRequestsOf(site);
		const edge = await serveThroughWorker(site, '/');
		const after = await serveRequestsOf(site);

		expect(miss.cache).toBe('MISS');
		expect(miss.status).toBe(503);
		expect(doHit.cache).toBe('HIT');
		// the DO answered, and the Worker handed the edge copy to waitUntil. `deferred` says the
		// write was issued; the EDGE hit two lines down is what says it landed
		expect(doHit.edge).toBe('MISS');
		expect(doHit.edgePut).toBe('deferred');
		expect(edge).not.toBeNull();
		expect(edge?.cache).toBe('EDGE');
		expect(edge?.edge).toBe('HIT');
		// the tier's claim: no DO request at all, asserted on the object's own
		// persisted counter rather than on timing
		expect(after).toBe(before);
		// and the object's own verdict is preserved separately, so a measurement can tell an
		// edge HIT from a DO HIT
		expect(edge?.doCache).toBe('HIT');
		expect(edge?.body).toBe(doHit.body);
		expect(new Set([miss.cache, doHit.cache, edge?.cache]).size).toBe(3);
	});

	it('re-validates at the client so a generation bump is not defeated by a browser cache', async () => {
		const site = 'revalidate';
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>rv</title>'));
		await serveThroughWorker(site, '/');
		const edge = await untilEdge(site, '/');
		expect(edge?.cacheControl).toBe('public, max-age=0, must-revalidate');
	});

	it('edge=0 declines to READ the edge but still stores what it fetched', async () => {
		const site = 'edgeoff';
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>x</title>'));
		// warm the pointer and the edge copy first, so an EDGE hit is available to decline
		await serveThroughWorker(site, '/');
		expect((await untilEdge(site, '/'))?.cache).toBe('EDGE');

		const bypass = await serveThroughWorker(site, '/', '&edge=0');
		// which is what makes it the right instrument for "did the OBJECT think this was a HIT":
		// the answer cannot be a copy the poll itself cached
		expect(bypass.cache).toBe('HIT');
		expect(bypass.edge).toBe('MISS');
		expect(bypass.edgePut).toBe('deferred');
	});

	/**
	 * The three writes a serve makes are issued and not awaited.
	 *
	 * MEASURED ON A DEPLOYED WORKER, which is why this is worth a test: an awaited
	 * `caches.default.put` costs 9 ms for a small body and 12.5 ms for a 97 KB one before the
	 * response leaves, and the same put through `waitUntil` costs 0. The refusals stay synchronous,
	 * so a page that must not be stored is still refused by name rather than deferred.
	 */
	it('defers the edge write and still refuses by name', async () => {
		const site = 'deferred';
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>d</title>'));

		const first = await serveThroughWorker(site, '/');
		expect(first.edgePut).toBe('deferred');
		// the deferred write is the only thing that could have produced this
		expect((await untilEdge(site, '/'))?.cache).toBe('EDGE');

		// a path the object refuses is refused synchronously, not handed to waitUntil
		const denied = await serveThroughWorker(site, '/.env');
		expect(denied.edgePut).not.toBe('deferred');
	});
});

describe('a placeholder is never written to the edge cache', () => {
	it('refuses the placeholder and says so, and does not serve one back', async () => {
		const site = 'placeholder';
		const first = await serveThroughWorker(site, '/');
		const second = await serveThroughWorker(site, '/');
		expect(first.status).toBe(503);
		expect(first.edgePut).toBe('skipped:503');
		// caching a placeholder is how a site serves placeholders forever
		expect(second.cache).not.toBe('EDGE');
		expect(second.edgePut).toBe('skipped:503');
	});

	it('caches nothing at all for a route that is not the serving path', async () => {
		const site = 'notserving';
		const res = await SELF.fetch(`https://cfw.local/serve-stats?site=${site}`);
		expect(res.status).toBe(200);
		// the edge headers are only meaningful on /serve, so they are absent rather than lying
		expect(res.headers.get('x-cfw-edge')).toBeNull();
		expect(res.headers.get('x-cfw-edge-put')).toBeNull();
		expect(res.headers.get('x-cfw-do-cache')).toBe('n/a');
	});
});

describe('the generation pointer survives a response that carries no generation', () => {
	it('keeps serving from the edge across a /serve-stats call between two serves', async () => {
		const site = 'pointer';
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>ptr</title>'));
		await serveThroughWorker(site, '/');
		const edge = await untilEdge(site, '/');
		expect(edge?.cache).toBe('EDGE');

		// /serve-stats reports no x-cfw-generation at all. Reading a missing header straight into
		// Number() gives 0, not NaN, which once overwrote the pointer and made every later lookup
		// build a key nothing had been stored under
		const stats = await SELF.fetch(`https://cfw.local/serve-stats?site=${site}`);
		expect(stats.headers.get('x-cfw-generation')).toBeNull();

		const after = await serveThroughWorker(site, '/');
		expect(after.cache).toBe('EDGE');
	});

	it('discovers the pointer once per window, not once per request', async () => {
		const site = 'window';
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>w</title>'));
		// the first request in a window learns the generation off a response it already paid for
		const learn = await serveThroughWorker(site, '/');
		expect(learn.generation).toBe(1);
		const edge = await untilEdge(site, '/');
		expect(edge?.generation).toBe(1);
		// the bucket width is what bounds cross-colo invalidation lag; see src/site.js
		expect(GEN_BUCKET_MS).toBe(Number(env.GEN_BUCKET_MS));
	});
});

describe('a scanner probe is refused before the object is reached', () => {
	const probes = ['/.env', '/wp-login.php', '/.git/config', '/x.sql'];

	it.each(probes)('refuses %s with 404 and names the filter', async (path) => {
		const res = await SELF.fetch(
			`https://cfw.local/serve?site=deny&path=${encodeURIComponent(path)}`
		);
		expect(res.status).toBe(404);
		expect(res.headers.get('x-cfw-deny')).toBe('never-drupal');
	});

	it('spends no DO request on any of them', async () => {
		const site = 'denycount';
		// one real serve first, so the object exists and the counter is initialised
		await serveThroughWorker(site, '/');
		const before = await serveRequestsOf(site);
		for (const path of probes) {
			await serveThroughWorker(site, path);
		}
		const after = await serveRequestsOf(site);
		// PageCache writes a PERMANENT cache_data row per distinct URL and expire-based GC never
		// removes it, so this is a storage fix rather than a latency one
		expect(after).toBe(before);
	});

	it('lets the refusal itself be cached, since the answer can never change', async () => {
		const res = await SELF.fetch('https://cfw.local/serve?site=deny&path=%2F.env');
		expect(res.headers.get('cache-control')).toBe('public, max-age=300');
		expect(res.headers.get('x-cfw-cache')).toBe('DENY');
	});

	it('does NOT refuse an alias-shaped path, which is why this is a deny list', async () => {
		const aliasish = await serveThroughWorker('deny', '/about-us');
		// a path alias lives in path_alias and appears in no packed route table, so an allowlist
		// would 404 a real page
		expect(aliasish.deny).toBeNull();
		expect(aliasish.status).toBe(503);
	});

	it.each([
		['/.env', true],
		['/wp-login.php', true],
		['/wp-admin/setup-config.php', true],
		['/.git/config', true],
		['/x.sql', true],
		['/backup/db.sql', true],
		['/index.php', true],
		['/phpmyadmin/', true],
		['/config.json', true],
		['/.DS_Store', true],
		['/', false],
		['/about-us', false],
		['/node/1', false],
		['/user/login', false],
		['/admin/config', false],
		['/.well-known/security.txt', false],
		['/sites/default/files/image.png', false]
	])('isNeverDrupal(%s) is %s', (path, expected) => {
		expect(isNeverDrupal(path)).toBe(expected);
	});

	/**
	 * A REGRESSION. The only caller passes `?path=`, which the catch-all builds as
	 * `url.pathname + url.search`, and four of the six patterns are `$`-anchored -- so appending any
	 * parameter walked a scanner straight past the deny list into a DO hop and the permanent
	 * `cache_data` row the list exists to prevent. Every anchored pattern is covered, since one
	 * fixed in isolation would leave the other three open.
	 */
	it.each([
		['/.env?x=1', true],
		['/x.sql?v=2', true],
		['/config.json?cb=9', true],
		['/backup/db.sql?dl=1', true],
		['/xmlrpc.php?a=1', true],
		['/wp-login.php?redirect_to=%2F', true],
		['/.env#frag', true],
		['/about-us?page=2', false],
		['/node/1?destination=/admin', false]
	])('isNeverDrupal(%s) ignores the query string and is %s', (path, expected) => {
		expect(isNeverDrupal(path)).toBe(expected);
	});
});

describe('a DIAGNOSTIC route fails closed; the serving path does not', () => {
	/**
	 * This block asserted the defect.
	 *
	 * It previously required `/serve` to 404 without `PW_DIAGNOSTICS`, which was a faithful
	 * test of the code as written -- every route was behind that one flag. What it could not
	 * see is that `wrangler.jsonc` set the flag to `"1"`, so the only deployable state that
	 * served a page also exposed `/php` (arbitrary PHP) and `/sql` (arbitrary SQL) to the
	 * internet. The test passing was compatible with shipping a remote shell.
	 *
	 * The contract now: public routes serve unconditionally, diagnostics fail closed. The
	 * safety property the old assertion stood for is kept and strengthened below -- it is
	 * now asserted per dangerous route rather than once for the whole table.
	 */

	it('serves the serving path even with diagnostics off', async () => {
		const res = await worker.fetch(new Request('https://cfw.local/serve?site=x&path=%2F'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(res.status).not.toBe(404);
	});

	it.each(['/php', '/sql', '/savenode', '/nativefetch', '/migrate'])(
		'404s %s when diagnostics are off',
		async (route) => {
			const res = await worker.fetch(
				new Request(`https://cfw.local${route}?site=x&path=%2F`),
				{
					...env,
					PW_DIAGNOSTICS: '0'
				}
			);
			expect(res.status).toBe(404);
			expect(await res.text()).toContain('not found');
		}
	);

	it('does NOT 404 /firstrun with diagnostics off, or the token is unobtainable', async () => {
		const res = await worker.fetch(new Request('https://cfw.local/firstrun?site=x'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(res.status).not.toBe(404);
	});

	/**
	 * `/export` is an OWNER route, not a diagnostic.
	 *
	 * It used to sit in the diagnostic set beside `/sql` (arbitrary SQL) and `/restore` (a
	 * whole-database overwrite) behind one boolean, so taking your own data out required exposing a
	 * remote shell to the internet first. It now answers a per-site bearer token instead.
	 *
	 * 401 rather than 404 because the route's EXISTENCE is not the secret -- it is documented -- and
	 * a 404 tells a legitimate owner their export is missing when it is their credential that is.
	 * The token is the secret, and `tokenMatches()` compares it in constant time.
	 */
	it('401s /export with a challenge rather than hiding it, when diagnostics are off', async () => {
		const res = await worker.fetch(new Request('https://cfw.local/export?site=x'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toContain('Bearer');
	});

	/**
	 * AN OWNER ROUTE HAS TO BE IN `ROUTES` TO BE ONE.
	 *
	 * `ROUTES` was `PUBLIC ∪ DIAGNOSTIC`, and `/setup/cf` and `/setup/mail` are in neither -- so the
	 * catch-all rewrote them into `/serve?path=/setup/cf?...` and rendered them as Drupal pages. Both
	 * are documented as live in the README, `docs/configuration.md` and the admin UI, and the request
	 * that tried carried `?client_id=` into the fill queue, `cfw_page` and the edge key as part of
	 * the path.
	 */
	it.each(['/setup/cf', '/setup/mail'])('%s is an owner route, not a page', async (route) => {
		const res = await worker.fetch(new Request(`https://cfw.local${route}`), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		// 401 with a challenge: the route EXISTS and wants a credential. A rewrite would render
		// Drupal's 404 page instead, which is how this shipped
		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
	});

	it('401s /export for a WRONG token, not just an absent one', async () => {
		const res = await worker.fetch(
			new Request('https://cfw.local/export?site=x', {
				headers: { authorization: 'Bearer not-the-token' }
			}),
			{ ...env, PW_DIAGNOSTICS: '0' }
		);
		expect(res.status).toBe(401);
	});

	/**
	 * The positive half, which the two 401s above cannot supply.
	 *
	 * `ownerAuthorised()` returning false unconditionally passes every assertion in this block --
	 * a gate that refuses everyone looks exactly like a gate that works. So this mints the site's
	 * own token, presents it, and requires the dump to come back.
	 */
	it('LETS THE OWNER THROUGH with the site token, and returns a real dump', async () => {
		const site = 'owner-token-ok';
		const token = await inObject(namedSite(site), (obj) =>
			ensureOwnerToken((obj as unknown as { secretStore: () => SecretStore }).secretStore())
		);

		const res = await worker.fetch(
			new Request(`https://cfw.local/export?site=${site}&body=1`, {
				headers: { authorization: `Bearer ${token}` }
			}),
			{ ...env, PW_DIAGNOSTICS: '0' }
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; replayable: boolean; sql: string };
		expect(body.replayable).toBe(true);
		expect(body.sql).toContain('CREATE TABLE');
	});

	it('does not answer the DO path directly, so the gate cannot be stepped around', async () => {
		// the Worker maps `/export` to `/__export`; the inner name is not itself a route, and a
		// request for it must not reach the object without passing the token check first
		for (const route of ['/__export', '/__ownercheck', '/__restore']) {
			const res = await worker.fetch(new Request(`https://cfw.local${route}?site=x`), {
				...env,
				PW_DIAGNOSTICS: '1'
			});
			expect(res.status, route).toBe(404);
		}
	});

	it('still 404s /restore with diagnostics off, so the owner tier did not widen', async () => {
		// the guard that matters: adding a credential path must not have promoted the routes that
		// overwrite the database or run arbitrary SQL
		for (const route of ['/restore', '/sql']) {
			const res = await worker.fetch(new Request(`https://cfw.local${route}?site=x`), {
				...env,
				PW_DIAGNOSTICS: '0'
			});
			expect(res.status, route).toBe(404);
		}
	});

	it('renders an unclaimed path as a page rather than 404ing it', async () => {
		// DRUPAL OWNS THE URL SPACE. This asserted 404 until the front end gained a catch-all, and
		// the old expectation was the bug: `/` answered 404 on a deployed site too, so the only way
		// to reach the product was `/serve?site=X&path=Y`. What must NOT happen is the request being
		// refused by the Worker -- whether Drupal then answers 200 or its own 404 is Drupal's call,
		// and this object holds no migrated site, so the render tier reports itself unready instead.
		const res = await SELF.fetch('https://cfw.local/definitely-not-a-route');
		expect(res.status, 'the Worker refused a path that belongs to Drupal').not.toBe(404);
	});
});

/**
 * What the catch-all rewrites an unclaimed path INTO.
 *
 * The test above only asserts the request was not refused, which was enough to catch the 404 and is
 * not enough to keep the rewrite honest -- a rewrite that dropped the query string, or picked the
 * site out of the visitor's own parameters, passes it just as well.
 *
 * Driven through a STAND-IN namespace rather than the real one, because what is under test is the
 * URL the object is asked for, and that is invisible from the far side of a real DO hop.
 */
describe('the catch-all rewrite', () => {
	/** records the inner URL each hop was made with, and answers without a real object */
	function spySite() {
		const seen: URL[] = [];
		const namespace = {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: (id: { name?: string }) => ({
				fetch: async (r: Request) => {
					seen.push(new URL(r.url));
					return new Response('rendered\n', {
						status: 200,
						headers: { 'x-cfw-spy-site': String(id.name) }
					});
				}
			})
		};
		return { seen, namespace };
	}

	/** one request through the real Worker with the namespace replaced */
	async function hop(path: string, overrides: Record<string, unknown> = {}) {
		const { seen, namespace } = spySite();
		const res = await worker.fetch(new Request(`https://cfw.local${path}`), {
			...env,
			SITE: namespace,
			...overrides
		} as unknown as typeof env);
		return { res, inner: seen[0], seen };
	}

	it('becomes the /serve it would have been, with the path carried in a parameter', async () => {
		const { res, inner } = await hop('/about-rewrite');
		expect(res.status).toBe(200);
		expect(inner?.pathname).toBe('/__serve');
		expect(inner?.searchParams.get('path')).toBe('/about-rewrite');
	});

	it('carries the query string inside `path`, where Drupal reads it', async () => {
		// dropped, a paginated view or a search result serves page 1 to everyone
		const { inner } = await hop('/search?keys=drupal&page=2');
		expect(inner?.searchParams.get('path')).toBe('/search?keys=drupal&page=2');
	});

	it('refuses to let a visitor choose which site answers', async () => {
		// THE REASON THE REWRITE IS BUILT FROM THE ORIGIN. Copying the incoming URL would carry
		// `?site=` straight into /serve's own parameters, and one link would serve another
		// customer's database from this hostname
		const { inner, res } = await hop('/about-guard?site=someone-elses-site');
		expect(inner?.searchParams.get('site')).toBe('cfw.local');
		expect(res.headers.get('x-cfw-spy-site')).toBe('cfw.local');
		// not discarded either -- Drupal still sees the parameter it was sent
		expect(inner?.searchParams.get('path')).toBe('/about-guard?site=someone-elses-site');
	});

	it('resolves the site through the same layers a bare /serve does', async () => {
		const { inner } = await hop('/about-var', { SITE_ID: 'configured-site' });
		expect(inner?.searchParams.get('site')).toBe('configured-site');
	});

	it('claims the root, which is the path the product is actually reached by', async () => {
		const { inner } = await hop('/');
		expect(inner?.pathname).toBe('/__serve');
		expect(inner?.searchParams.get('path')).toBe('/');
	});

	it('leaves a route the Worker owns alone', async () => {
		// `PW_DIAGNOSTICS` is on in this lane, which is what makes `?site=` an instruction here;
		// the case below is the same request with it off
		const { inner } = await hop('/serve?site=named&path=%2Fnode');
		// still one hop, but the explicit parameters are the caller's, not a rewrite's
		expect(inner?.searchParams.get('site')).toBe('named');
		expect(inner?.searchParams.get('path')).toBe('/node');
	});

	/**
	 * `/serve` IS IN `PUBLIC_ROUTES`, so it skips the rewrite above and used to read `?site=` raw.
	 *
	 * The rewrite's guard was the only one, and it only covers paths the Worker does not own -- so
	 * the one route reachable by anybody was the one route with no protection. Measured on a dev
	 * server before the fix: `GET /serve?path=/&site=<a name nobody had used>` provisioned an entire
	 * Drupal database from one unauthenticated request, and a name belonging to another tenant
	 * served their pages from this hostname.
	 */
	it('refuses ?site= on /serve itself once diagnostics are off', async () => {
		const { inner, res } = await hop('/serve?site=someone-elses-site&path=%2Fnode', {
			PW_DIAGNOSTICS: '0'
		});
		// the object that answered is derived from the HOST, not from the parameter
		expect(res.headers.get('x-cfw-spy-site')).toBe('cfw.local');
		// and the object is handed the RESOLVED name, so the value it pins as its own identity --
		// and keys its R2 mirror on -- is never the one the caller asked for
		expect(inner?.searchParams.get('site')).toBe('cfw.local');
	});

	it("does not swallow the object's own routes, which must stay unreachable", async () => {
		// rewriting `/__export` into a page render answers a probe with a render, which reads as
		// "the route exists and something went wrong" rather than "there is no such route"
		for (const route of ['/__export', '/__serve', '/__restore']) {
			const { res, seen } = await hop(route);
			expect(res.status, route).toBe(404);
			expect(seen, route).toHaveLength(0);
		}
	});

	it('still lets the never-Drupal filter refuse what Drupal would never own', async () => {
		// the catch-all forwards, so the filter is now the only thing standing between a wp-admin
		// scan and a DO request per probe
		const { res, seen } = await hop('/wp-login.php');
		expect(res.status).toBe(404);
		expect(res.headers.get('x-cfw-deny')).toBe('never-drupal');
		expect(seen).toHaveLength(0);
	});
});

describe('the cron entry point opens a window per configured site', () => {
	/** the controller a Cron Trigger delivers; `scheduled()` reads none of it, but it is real */
	const cronController = (): ScheduledController => ({
		scheduledTime: Date.now(),
		cron: '*/5 * * * *',
		noRetry: () => {}
	});

	/**
	 * Whether the warm window ever reached this object. NOT `queueDepth()`, which reads 0 both for
	 * a warmed site and for one never created -- so every assertion here used to pass either way.
	 */
	const wasWarmed = (name: string) =>
		inObject(namedSite(name), (obj) =>
			obj.sql
				.exec(
					"SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='cfw_fill_queue'"
				)
				.toArray()
				.map((r) => Number(r.n))
				.some((n) => n > 0)
		);

	it('drains the queue of every site in WINDOW_SITES', async () => {
		const sites = ['cron-a', 'cron-b'];
		for (const site of sites) {
			await inObject(namedSite(site), (obj) => {
				stubRender(obj, ({ path }) => pageFor(path));
				queuePath(obj, '/');
			});
		}

		const ctx = createExecutionContext();
		await worker.scheduled(
			cronController(),
			{
				...env,
				WINDOW_SITES: sites.join(','),
				FLEET_DB: fleetDbOf(sites.map((s) => reported(s)))
			},
			ctx
		);
		await waitOnExecutionContext(ctx);

		for (const site of sites) {
			const depth = await inObject(namedSite(site), (obj) => obj.queueDepth());
			expect(depth).toBe(0);
		}
	});

	/** a stand-in for D1; the inventory branch had no coverage because `FLEET_DB` is empty here */
	const fleetDbOf = (rows: Record<string, unknown>[]): FleetDb => ({
		prepare: () => ({
			bind: () => ({
				run: async () => ({}),
				all: async <T = unknown>() => ({ results: rows as T[] })
			})
		})
	});

	const reported = (site: string, ageMs = 0) => ({
		site,
		pack_generation: 'p1',
		core_version: '11.0.0',
		worker_version: 'w1',
		plan: 'free',
		last_seen_ms: Date.now() - ageMs
	});

	it('creates no object when nothing has reported and nothing is configured', async () => {
		// the defect: `WINDOW_SITES` defaulted to `default`, and `idFromName()` creates what it
		// names -- so this warmed a phantom every five minutes and reported success. Asserted on
		// the object's own existence, because a queue depth of 0 is what a phantom reports too.
		const ctx = createExecutionContext();
		await worker.scheduled(cronController(), { ...env, WINDOW_SITES: undefined }, ctx);
		await waitOnExecutionContext(ctx);
		expect(await wasWarmed('default')).toBe(false);
	});

	it('drives the sites the fleet reported when WINDOW_SITES is unset', async () => {
		const site = 'cron-fleet';
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			queuePath(obj, '/');
		});
		const ctx = createExecutionContext();
		await worker.scheduled(
			cronController(),
			{ ...env, WINDOW_SITES: undefined, FLEET_DB: fleetDbOf([reported(site)]) },
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(await wasWarmed(site)).toBe(true);
	});

	it('refuses a configured name the inventory has never seen', async () => {
		const real = 'cron-known';
		await inObject(namedSite(real), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			queuePath(obj, '/');
		});
		const ctx = createExecutionContext();
		await worker.scheduled(
			cronController(),
			{
				...env,
				WINDOW_SITES: `${real},cron-phantom`,
				FLEET_DB: fleetDbOf([reported(real)])
			},
			ctx
		);
		await waitOnExecutionContext(ctx);
		// the A/B is what makes the refusal mean something: same call, one name warmed and one not
		expect(await wasWarmed(real)).toBe(true);
		expect(await wasWarmed('cron-phantom')).toBe(false);
	});
});

/**
 * The inventory `scripts/security-update.mjs --fleet=<url>` reads.
 *
 * Every function behind it had a unit test and the ROUTE had none, so the endpoint answered 404 to
 * every caller while `fleet.spec.ts` stayed green: `/fleet` does not start with `/admin`, so it never
 * reached `renderAdmin()`, and it has no `DO_ROUTE` entry either, so it fell through to a proxy hop
 * with an undefined inner pathname. A rollout denominator nothing can read is the same defect the
 * endpoint was built to fix.
 */
describe('the fleet inventory a security rollout scores against', () => {
	/** puts the database back to "never reported into", which is the state that used to throw */
	const dropFleetTable = () =>
		(env.FLEET_DB as unknown as FleetDb).prepare('DROP TABLE IF EXISTS cfw_fleet').bind().run();

	it('ANSWERS, rather than falling through to a Durable Object route that does not exist', async () => {
		const res = await worker.fetch(new Request('https://cfw.local/fleet'), {
			...env,
			PW_DIAGNOSTICS: '1'
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		// the three fields `security-update.mjs` reads by name
		expect(body).toHaveProperty('sites');
		expect(body).toHaveProperty('byPackGeneration');
		expect(body).toHaveProperty('stale');
	});

	it('reports an EMPTY fleet before any site has written a row', async () => {
		// D1 is not rolled back between tests in this pool, so the state is staged rather than
		// assumed. The table is created by the OBJECT's write path, so a bound database nobody has
		// reported into threw `no such table: cfw_fleet` -- a 500 that reads as "the fleet read
		// failed" on the endpoint whose whole answer is "how many sites are there"
		await dropFleetTable();
		const res = await worker.fetch(new Request('https://cfw.local/fleet'), {
			...env,
			PW_DIAGNOSTICS: '1'
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { sites: number }).toMatchObject({ sites: 0 });
	});

	it('scores a rollout against a target pack generation', async () => {
		const db = env.FLEET_DB as unknown as FleetDb;
		await dropFleetTable();
		await ensureFleetTable(db);
		await reportSite(db, {
			site: 'a',
			packGeneration: 'new',
			coreVersion: '11.4.5',
			workerVersion: 'v2',
			plan: 'free',
			lastSeenMs: Date.now()
		});
		await reportSite(db, {
			site: 'b',
			packGeneration: 'old',
			coreVersion: '11.4.4',
			workerVersion: 'v1',
			plan: 'free',
			lastSeenMs: Date.now()
		});

		const res = await worker.fetch(new Request('https://cfw.local/fleet?target=new'), {
			...env,
			PW_DIAGNOSTICS: '1'
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sites: number;
			rollout: { patched: number; total: number; fraction: number };
		};
		expect(body.sites).toBe(2);
		expect(body.rollout).toMatchObject({ patched: 1, total: 2, fraction: 0.5 });
	});

	it('404s without diagnostics, so the inventory is not public', async () => {
		const res = await worker.fetch(new Request('https://cfw.local/fleet'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(res.status).toBe(404);
	});
});

// #region TEMPORARY assertion counter
import { afterAll as __afterAll, afterEach as __afterEach } from 'vitest';
let __asserts = 0;
__afterEach(() => {
	__asserts += expect.getState().assertionCalls ?? 0;
});
__afterAll(() => {
	console.log(`ASSERTIONS tests/integration/serve-edge.spec.ts ${__asserts}`);
});
// #endregion

/**
 * A FORM SUBMISSION REACHES DRUPAL THROUGH THE CATCH-ALL, or the site cannot be used.
 *
 * Reported from a `drangler dev` session: creating a page answered "not found" and the node was
 * created anyway. `POST /user/login` reproduces it -- the same shape, on the route every visitor
 * uses first. A GET of the same path works, and `POST /serve?path=...` works, so the failure is
 * specific to a non-GET taking the rewrite.
 */
describe('a submission survives the catch-all rewrite', () => {
	function spy() {
		const seen: URL[] = [];
		const methods: string[] = [];
		const bodies: string[] = [];
		return {
			seen,
			methods,
			bodies,
			namespace: {
				idFromName: (name: string) => ({ name, toString: () => name }),
				newUniqueId: () => ({ toString: () => 'unique' }),
				get: () => ({
					fetch: async (r: Request) => {
						seen.push(new URL(r.url));
						methods.push(r.method);
						bodies.push(await r.text());
						return new Response('rendered\n', {
							status: 200,
							headers: { 'x-cfw-cache': 'RENDER' }
						});
					}
				})
			}
		};
	}

	it('rewrites a POST to /__serve, with its method and body intact', async () => {
		const s = spy();
		const res = await worker.fetch(
			new Request('https://cfw.local/user/login', {
				method: 'POST',
				body: 'name=admin&pass=hunter2',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			}),
			{ ...env, SITE: s.namespace } as unknown as typeof env
		);
		expect(res.status, await res.text()).toBe(200);
		expect(s.seen[0]?.pathname).toBe('/__serve');
		expect(s.seen[0]?.searchParams.get('path')).toBe('/user/login');
		expect(s.methods[0]).toBe('POST');
		// the body is what the submission IS; a rewrite that drops it saves nothing
		expect(s.bodies[0]).toBe('name=admin&pass=hunter2');
	});

	/**
	 * A SUBREQUEST FOLLOWS A 3xx BY DEFAULT, and that ate every submission.
	 *
	 * Drupal answers a successful login with `303 -> /user/1?check_logged_in=1` and a successful
	 * node save with `303 -> /node/N`. The runtime followed it against the OBJECT, which has no
	 * route by that name, so its base class answered `not found` -- measured on a dev server, with
	 * `Session opened for admin.` in the log immediately before the 404. The write had landed; the
	 * visitor was told it had not.
	 *
	 * The 3xx belongs to the browser, which re-enters through the catch-all and gets the page.
	 */
	it('hands a redirect back to the browser instead of chasing it into the object', async () => {
		const seen: URL[] = [];
		const modes: string[] = [];
		const namespace = {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async (r: Request) => {
					seen.push(new URL(r.url));
					modes.push(r.redirect);
					// what a real login answers, once
					return seen.length === 1
						? new Response(null, {
								status: 303,
								headers: { location: 'https://cfw.local/user/1?check_logged_in=1' }
							})
						: new Response('rendered\n', { status: 200 });
				}
			})
		};
		const res = await worker.fetch(
			new Request('https://cfw.local/user/login', {
				method: 'POST',
				body: 'name=admin',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			}),
			{ ...env, SITE: namespace } as unknown as typeof env
		);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('https://cfw.local/user/1?check_logged_in=1');
		// ONE hop. A second means the runtime chased the redirect, which is the defect.
		//
		// AND THE MODE, which is the half this lane can actually fail on: miniflare's stub does not
		// follow a 3xx, so the hop count alone passes with the fix removed. Deployed workerd does
		// follow it -- that is how this was found -- so what a spec here can pin is the request the
		// worker BUILDS, not what the runtime then does with it.
		expect(modes[0]).toBe('manual');
		expect(seen).toHaveLength(1);
	});

	it('CONTROL: the same path as a GET already worked', async () => {
		const s = spy();
		const res = await worker.fetch(new Request('https://cfw.local/user/login'), {
			...env,
			SITE: s.namespace
		} as unknown as typeof env);
		expect(res.status).toBe(200);
		expect(s.seen[0]?.pathname).toBe('/__serve');
	});
});

/**
 * The compiled-plan tier in front of the Durable Object.
 *
 * The observable is the HOP COUNT: this tier exists because a hop costs 12 ms of payload-independent
 * round trip on a deployed paid worker against 0 for isolate memory, so a spec that only checked the
 * bytes would pass against a tier that answered correctly and still went to the object.
 *
 * The namespace is a stand-in rather than a real object, because what is under test is which
 * requests the front worker SENDS. A real render would put the interpreter and the pack in the way
 * of an assertion about the worker.
 */
describe('the compiled plan tier', () => {
	const COOKIE_A = `${SESSION_COOKIE}=session-alpha`;
	const COOKIE_B = `${SESSION_COOKIE}=session-bravo`;
	/** what the first render of a route looks like before Drupal's asset library cache is warm */
	const WARMUP = `<html><body>${'a'.repeat(300)}<link rel="stylesheet" href="/x.css"></body></html>`;
	const STEADY = `<html><body>${'a'.repeat(300)}<p>steady</p></body></html>`;

	beforeEach(() => resetEdgePlans());

	/** a namespace that renders, reports a generation, and counts what reached it */
	function objectSpy(generation = () => 42) {
		const seen: URL[] = [];
		let n = 0;
		return {
			seen,
			namespace: {
				idFromName: (name: string) => ({ name, toString: () => name }),
				newUniqueId: () => ({ toString: () => 'unique' }),
				get: () => ({
					fetch: async (r: Request) => {
						seen.push(new URL(r.url));
						n++;
						return new Response(n === 1 ? WARMUP : STEADY, {
							status: 200,
							headers: {
								'content-type': 'text/html; charset=UTF-8',
								'x-cfw-cache': 'RENDER',
								'x-cfw-generation': String(generation())
							}
						});
					}
				})
			}
		};
	}

	async function visit(
		namespace: unknown,
		path: string,
		cookie: string,
		overrides: Record<string, unknown> = {}
	) {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			new Request(`https://cfw.local${path}`, { headers: { cookie } }),
			{ ...env, SITE: namespace, ...overrides } as unknown as typeof env,
			ctx
		);
		const body = await res.text();
		// the compile runs behind waitUntil, so nothing here may read the store before it finishes
		await waitOnExecutionContext(ctx);
		return {
			body,
			tier: res.headers.get('x-cfw-cache'),
			plan: res.headers.get('x-cfw-plan'),
			cacheControl: res.headers.get('cache-control')
		};
	}

	it('answers from this isolate after three renders, with no further hop', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-basic';
		const first = await visit(spy.namespace, path, COOKIE_A);
		// nothing is served before the isolate has learned a generation to fence against; the render
		// is recorded toward a compile, which is what `sampling` says
		expect(first.tier).not.toBe('PLAN');
		expect(first.plan).toBe('sampling');

		for (let i = 1; i < SAMPLES_PER_COMPILE; i++) {
			expect((await visit(spy.namespace, path, COOKIE_A)).plan).toBe('sampling');
		}
		expect(spy.seen).toHaveLength(SAMPLES_PER_COMPILE);

		const served = await visit(spy.namespace, path, COOKIE_A);
		expect(served.tier).toBe('PLAN');
		expect(served.plan).toBe('mem');
		expect(served.body).toBe(STEADY);
		// per-user output: nothing between here and the browser may store it
		expect(served.cacheControl).toBe('private, no-store');
		// THE POINT OF THE TIER. A correct body that still cost a hop is the failure this catches
		expect(spy.seen).toHaveLength(SAMPLES_PER_COMPILE);
		expect(isCacheTier('PLAN')).toBe(true);
	});

	it('compiles from renders two and three, so the asset warm-up cannot corrupt a plan', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-warmup';
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) await visit(spy.namespace, path, COOKIE_A);
		const served = await visit(spy.namespace, path, COOKIE_A);
		// the first render's stylesheet list is absent, which it would not be from a plan compiled
		// against it -- that compile finds an unnamed varying region and refuses instead
		expect(served.tier).toBe('PLAN');
		expect(served.body).toBe(STEADY);
		expect(served.body).not.toContain('stylesheet');
	});

	it('serves NOTHING to a second session, which is the whole safety argument', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-sessions';
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) await visit(spy.namespace, path, COOKIE_A);
		expect((await visit(spy.namespace, path, COOKIE_A)).tier).toBe('PLAN');

		const hopsBefore = spy.seen.length;
		const other = await visit(spy.namespace, path, COOKIE_B);
		// a different cookie cannot construct the key the first session's page is under, so it pays
		// the object the same as any other first visit
		expect(other.tier).not.toBe('PLAN');
		expect(spy.seen).toHaveLength(hopsBefore + 1);
	});

	/**
	 * A save is the invalidation, and it is what teaches this isolate the new generation.
	 *
	 * There is no cheaper way for it to find out: a bump made anywhere reaches this isolate on its
	 * next Durable Object response, and until then {@link GENERATION_TRUST_MS} bounds how long it
	 * keeps serving the old one -- the same two-window lag the shared generation pointer already has.
	 */
	it('drops every plan when a write moves the generation', async () => {
		let generation = 42;
		const spy = objectSpy(() => generation);
		const path = '/plan-tier-bump';
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) await visit(spy.namespace, path, COOKIE_A);
		expect((await visit(spy.namespace, path, COOKIE_A)).tier).toBe('PLAN');

		generation = 43;
		const ctx = createExecutionContext();
		await worker.fetch(
			new Request(`https://cfw.local${path}`, {
				method: 'POST',
				body: 'title=x',
				headers: { cookie: COOKIE_A, 'content-type': 'application/x-www-form-urlencoded' }
			}),
			{ ...env, SITE: spy.namespace } as unknown as typeof env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		const hopsBefore = spy.seen.length;
		const afterBump = await visit(spy.namespace, path, COOKIE_A);
		expect(afterBump.tier).not.toBe('PLAN');
		expect(spy.seen).toHaveLength(hopsBefore + 1);
	});

	it('never compiles an anonymous render, which the shared tiers already answer', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-anon';
		const first = await visit(spy.namespace, path, 'Drupal.toolbar.collapsed=1');
		expect(first.plan).toBe('skip:not-wanted');
		// later ones may be answered by the edge tier, which returns before this header is set; what
		// has to hold for every one of them is that no plan tier ever claims an anonymous page
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) {
			const res = await visit(spy.namespace, path, 'Drupal.toolbar.collapsed=1');
			expect(res.tier).not.toBe('PLAN');
			expect(res.plan).not.toBe('mem');
		}
	});

	it('is switched off by EDGE_PLAN=0, which is the control arm every measurement needs', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-lever';
		const off = { EDGE_PLAN: '0' };
		for (let i = 0; i <= SAMPLES_PER_COMPILE; i++) {
			const res = await visit(spy.namespace, path, COOKIE_A, off);
			expect(res.tier).not.toBe('PLAN');
			expect(res.plan).toBe('skip:not-wanted');
		}
		// every one of them paid the object, which is what the tier removes
		expect(spy.seen).toHaveLength(SAMPLES_PER_COMPILE + 1);
	});

	it('refuses a response that rotates the session', async () => {
		const seen: URL[] = [];
		const namespace = {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async (r: Request) => {
					seen.push(new URL(r.url));
					return new Response(STEADY, {
						status: 200,
						headers: {
							'content-type': 'text/html; charset=UTF-8',
							'x-cfw-cache': 'RENDER',
							'x-cfw-generation': '42',
							'set-cookie': `${SESSION_COOKIE}=rotated; Path=/`
						}
					});
				}
			})
		};
		const path = '/plan-tier-rotated';
		await visit(namespace, path, COOKIE_A);
		for (let i = 0; i < SAMPLES_PER_COMPILE + 2; i++) {
			const res = await visit(namespace, path, COOKIE_A);
			expect(res.tier).not.toBe('PLAN');
			expect(res.plan).toBe('skip:set-cookie');
		}
	});
});
