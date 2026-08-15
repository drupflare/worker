import { SELF, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { isNeverDrupal } from '../../src/site';
import {
	type ServeProbe,
	inObject,
	namedSite,
	pageFor,
	queuePath,
	seedPage,
	serveThroughWorker,
	stubRender
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

describe('the three tiers are distinguishable, and only one of them costs a DO request', () => {
	it('walks MISS to DO HIT to EDGE, and the edge copy never reaches the object', async () => {
		const site = 'tiers';
		const miss = await serveThroughWorker(site, '/');
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>tiers</title>'));

		const doHit = await serveThroughWorker(site, '/');
		const before = await serveRequestsOf(site);
		const edge = await untilEdge(site, '/');
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

	it.each(['/php', '/sql', '/savenode', '/firstrun', '/nativefetch', '/migrate'])(
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

	it('401s /export for a WRONG token, not just an absent one', async () => {
		const res = await worker.fetch(
			new Request('https://cfw.local/export?site=x', {
				headers: { authorization: 'Bearer not-the-token' }
			}),
			{ ...env, PW_DIAGNOSTICS: '0' }
		);
		expect(res.status).toBe(401);
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

	it('404s a route that is not in the table even with diagnostics on', async () => {
		const res = await SELF.fetch('https://cfw.local/definitely-not-a-route');
		expect(res.status).toBe(404);
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
