import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_BODY_BYTES } from '../../src/ops/body-limit';
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
 * `multipart/form-data` is exempt on purpose: that is the upload shape, its size is the point, and
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

	it('exempts an upload, which is the one shape whose size is the point', () => {
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
		// the DO answered, and the Worker put a copy at the edge
		expect(doHit.edge).toBe('MISS');
		expect(doHit.edgePut).toBe('stored');
		expect(edge).not.toBeNull();
		expect(edge?.cache).toBe('EDGE');
		expect(edge?.edge).toBe('HIT');
		// the whole point of the tier: no DO request at all, asserted on the object's own
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
		expect(bypass.edgePut).toBe('stored');
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
	 * `/export` is an OWNER route, not a diagnostic, and the difference is the whole point.
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

	it('drains the queue of every site in WINDOW_SITES', async () => {
		const sites = ['cron-a', 'cron-b'];
		for (const site of sites) {
			await inObject(namedSite(site), (obj) => {
				stubRender(obj, ({ path }) => pageFor(path));
				queuePath(obj, '/');
			});
		}

		const ctx = createExecutionContext();
		await worker.scheduled(cronController(), { ...env, WINDOW_SITES: sites.join(',') }, ctx);
		await waitOnExecutionContext(ctx);

		for (const site of sites) {
			const depth = await inObject(namedSite(site), (obj) => obj.queueDepth());
			expect(depth).toBe(0);
		}
	});

	it('defaults to a single site rather than every object in the namespace', async () => {
		const ctx = createExecutionContext();
		// no WINDOW_SITES: one Worker serves many sites and each has its own object, so the
		// default has to be a name rather than a wildcard
		await worker.scheduled(cronController(), { ...env, WINDOW_SITES: undefined }, ctx);
		await waitOnExecutionContext(ctx);
		const depth = await inObject(namedSite('default'), (obj) => obj.queueDepth());
		expect(depth).toBe(0);
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
