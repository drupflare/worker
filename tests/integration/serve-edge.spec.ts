import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ATTEMPT_HEADER, ATTEMPT_TTL_MS } from '../../src/ops/attempt';
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_UPLOAD_BYTES } from '../../src/ops/body-limit';
import { isCacheTier } from '../../src/ops/cache-tiers';
import { resetEdgePlans, SAMPLES_PER_COMPILE } from '../../src/ops/edge-plan';
import {
	ensureFleetTable,
	FLEET_SCHEMA_VERSION,
	reportSite,
	type FleetDb
} from '../../src/ops/fleet';
import { affinityKey, chooseTarget } from '../../src/ops/replica-routing';
import { mintOwnerToken, type SecretStore } from '../../src/ops/site-secrets';
import worker, { bodyTooLarge, isNeverDrupal } from '../../src/site';
import { asGeneration } from '../../src/site/edge-cache';
import { refuseOversized } from '../../src/site/screen';
import type { FrontContext } from '../../src/site/types';
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
	type ServeDo,
	type ServeProbe
} from '../helpers/serve-do';

// the worker in front of the object (src/site.ts); most cases seed a cfw_page row, so no interpreter runs
// caches.default is the real cache api, isolated per test file by the pool
const GEN_BUCKET_MS = 5000;

// retries until the edge answers; the pointer is discovered once per window, so an early request goes to the object
async function untilEdge(site: string, path: string, tries = 6): Promise<ServeProbe | null> {
	return untilTier(site, path, (hit) => hit.cache === 'EDGE', tries);
}

/** the same retry for any tier; the generation pointer makes every tier arrive on its own window */
async function untilTier(
	site: string,
	path: string,
	wanted: (hit: ServeProbe) => boolean,
	tries = 6
): Promise<ServeProbe | null> {
	for (let i = 0; i < tries; i++) {
		const hit = await serveThroughWorker(site, path);
		if (wanted(hit)) return hit;
	}
	return null;
}

const serveRequestsOf = (site: string) =>
	inObject(namedSite(site), (obj) => obj.storedMeters().serveTotal);

// an oversized form body is parsed into a nested array inside a 128 MB isolate, so refuse it before any object hop
// multipart uploads get a larger ceiling, since size is what an upload is for; a chunked body is counted as read
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
		expect(bodyTooLarge(at)).toBeUndefined();
	});

	it('gives an upload its own, larger ceiling rather than the form-body one', () => {
		const upload = (length: number) =>
			new Request('https://cfw.local/x', {
				method: 'POST',
				body: 'a=1',
				headers: {
					'content-type': 'multipart/form-data; boundary=----x',
					'content-length': String(length)
				}
			});
		// well past the 2 MiB form ceiling, and still allowed: size is what an upload is for
		expect(bodyTooLarge(upload(64 * 1024 * 1024))).toBeUndefined();
		expect(bodyTooLarge(upload(DEFAULT_MAX_UPLOAD_BYTES))).toBeUndefined();
		const over = bodyTooLarge(upload(DEFAULT_MAX_UPLOAD_BYTES + 1));
		expect(over?.limit).toBe(DEFAULT_MAX_UPLOAD_BYTES);
		expect(bodyTooLarge(upload(10_000), { MAX_UPLOAD_BYTES: 4096 })?.limit).toBe(4096);
		expect(bodyTooLarge(upload(10_000), { MAX_UPLOAD_BYTES: 0 })).toBeUndefined();
	});

	it('never refuses a GET, which carries no body to parse', () => {
		const get = new Request('https://cfw.local/x', {
			headers: { 'content-length': String(64 * 1024 * 1024) }
		});
		expect(bodyTooLarge(get)).toBeUndefined();
	});

	// a chunked request declares no length, so the header check passes; `refuseOversized()` counts
	// the body as it reads it
	it('falls through the header check when no Content-Length is declared', () => {
		const chunked = new Request('https://cfw.local/x', {
			method: 'POST',
			body: 'a=1',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		expect(bodyTooLarge(chunked)).toBeUndefined();
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
		expect(bodyTooLarge(big, { MAX_BODY_BYTES: 0 })).toBeUndefined();

		// a nonsense value falls back to the default rather than disabling the guard; the body must exceed the default
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

	it('the front worker stage answers 413 for an oversized body and nothing for a small one', async () => {
		const post = (length: number) =>
			new Request('https://cfw.local/x', {
				method: 'POST',
				body: 'a=1',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'content-length': String(length)
				}
			});
		const stage = (request: Request) => refuseOversized({ request, env: {} } as FrontContext);
		const refused = await stage(post(DEFAULT_MAX_BODY_BYTES + 1));
		expect(refused?.status).toBe(413);
		expect(refused?.headers.get('x-cfw-body-limit')).toBe(String(DEFAULT_MAX_BODY_BYTES));
		expect(await stage(post(DEFAULT_MAX_BODY_BYTES))).toBeUndefined();
	});

	/** a request whose body arrives as a stream, so it declares no `Content-Length` */
	function streamed(type: string, chunks: number, size: number, pulled?: { n: number }) {
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent === chunks) return controller.close();
				sent += 1;
				if (pulled) pulled.n = sent;
				controller.enqueue(new Uint8Array(size).fill(97));
			}
		});
		return new Request('https://cfw.local/x', {
			method: 'POST',
			body,
			// a streamed request body needs half-duplex, which workerd accepts as an option
			duplex: 'half',
			headers: { 'content-type': type }
		} as RequestInit);
	}
	const stageOf = (request: Request, extra: Record<string, unknown> = {}) => {
		const f = { request, env: extra } as unknown as FrontContext;
		return refuseOversized(f).then((res) => ({ res, f }));
	};

	it('refuses a chunked form body over the cap, and stops reading at the chunk that crosses it', async () => {
		const pulled = { n: 0 };
		const { res } = await stageOf(
			streamed('application/x-www-form-urlencoded', 100, 64 * 1024, pulled)
		);
		expect(res?.status).toBe(413);
		expect(res?.headers.get('x-cfw-deny')).toBe('body-too-large');
		// 2 MiB is 32 chunks of 64 KiB, so it ends at the 33rd and not at the 100th
		expect(pulled.n).toBeLessThan(40);
	});

	it('refuses a chunked multipart body over the upload cap', async () => {
		const { res } = await stageOf(streamed('multipart/form-data; boundary=x', 10, 1024), {
			MAX_UPLOAD_BYTES: 4096
		});
		expect(res?.status).toBe(413);
		expect(res?.headers.get('x-cfw-body-limit')).toBe('4096');
	});

	it('lets a chunked body under the cap through and hands the hop the same bytes', async () => {
		const { res, f } = await stageOf(streamed('application/x-www-form-urlencoded', 4, 1024));
		expect(res).toBeUndefined();
		const forwarded = new Uint8Array(await f.request.arrayBuffer());
		expect(forwarded.byteLength).toBe(4096);
		expect(forwarded.every((b) => b === 97)).toBe(true);
	});

	it('lets a multipart upload larger than the form cap reach the object', async () => {
		// 3 MiB declared: over MAX_BODY_BYTES, far under MAX_UPLOAD_BYTES
		const upload = new Request('https://cfw.local/x', {
			method: 'POST',
			body: 'x',
			headers: {
				'content-type': 'multipart/form-data; boundary=x',
				'content-length': String(3 * 1024 * 1024)
			}
		});
		expect((await stageOf(upload)).res).toBeUndefined();
		const chunked = streamed('multipart/form-data; boundary=x', 48, 64 * 1024);
		const { res, f } = await stageOf(chunked);
		expect(res).toBeUndefined();
		expect((await f.request.arrayBuffer()).byteLength).toBe(3 * 1024 * 1024);
	});

	it('leaves a GET and an empty POST alone', async () => {
		expect((await stageOf(new Request('https://cfw.local/x'))).res).toBeUndefined();
		const empty = new Request('https://cfw.local/x', { method: 'POST' });
		expect((await stageOf(empty)).res).toBeUndefined();
	});
});

describe('the generation header reader', () => {
	it('reads a positive number and refuses anything that is not one', () => {
		expect(asGeneration('42')).toBe(42);
		for (const raw of [null, undefined, '', '0', '-3', 'abc', 'Infinity']) {
			expect(asGeneration(raw), String(raw)).toBeUndefined();
		}
	});
});

// the claim page must never reach the edge cache: it is a 200 keyed by path, so a stored copy would outlive the claim
// it is refused structurally, since the response carries no x-cfw-cache and putPage() stores only HIT and RENDER
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
		// provisioned first: without a database the first request is the first-run placeholder, not the miss
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
		expect(warmed?.edge).toBe('HIT');
		expect(edge).not.toBeNull();
		// the fourth tier: the isolate memo answers with no I/O; both are edge tiers and neither touches the object
		expect(edge?.cache).toBe('MEM');
		expect(edge?.edge).toBe('MEM');
		// the tier's claim: no DO request at all, asserted on the object's own
		// persisted counter rather than on timing
		expect(after).toBe(before);
		// and the object's own verdict is preserved separately, so a measurement can tell an
		// edge HIT from a DO HIT
		expect(edge?.doCache).toBe('HIT');
		expect(edge?.body).toBe(doHit.body);
		expect(new Set([miss.cache, doHit.cache, warmed?.cache, edge?.cache]).size).toBe(4);
	});

	// the front worker answers a previous generation from kv after a content change (x-cfw-edge: STALE)
	// the object's aged serve is a different tier; both can answer x-cfw-cache KV, so x-cfw-edge tells them apart
	it('answers from the previous generation after a bump, rather than waiting for a re-render', async () => {
		const site = 'stalegen';
		await provisionedNamedSite(site);
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>gen one</title>'));

		// the tier is paid-only by default (pageKvEnabled ends in isPaid, and PLAN ships free), so state the configuration
		const paid = { ...env, PAGE_KV_ENABLED: '1' } as unknown as typeof env;
		const serve = async (query = '') => {
			const ctx = createExecutionContext();
			const res = await worker.fetch(
				new Request(
					`https://cfw.local/serve?site=${site}&path=${encodeURIComponent('/')}${query}`
				),
				paid,
				ctx
			);
			await waitOnExecutionContext(ctx);
			return res;
		};

		// warm KV at the current generation, which is what gives the bump something to fall back to.
		// The write is deferred, so the wait above is what makes it observable
		expect((await serve()).status).toBe(200);
		await serve();

		await namedSite(site).fetch(new Request('https://do.local/__bump', { method: 'POST' }));

		// one edge=0 request first: the pointer is discovered once per 5 s window, so a bump is invisible until a request reaches the object
		// edge=0 teaches the pointer forward; it cannot be the assertion, because the KV read sits inside the guard it turns off
		const taught = await serve('&edge=0');
		expect(taught.headers.get('x-cfw-generation')).not.toBe('1');

		let stale: Response | null = null;
		for (let i = 0; i < 6; i++) {
			const res = await serve();
			if (res.headers.get('x-cfw-edge') === 'STALE') {
				stale = res;
				break;
			}
		}
		expect(stale, 'the previous generation was never served').not.toBeNull();
		// both stale tiers answer x-cfw-cache KV; x-cfw-edge separates them from the object's aged serve
		expect(stale?.headers.get('x-cfw-cache')).toBe('KV');
		// how many generations back it came from, so a caller can bound the staleness it accepted
		expect(Number(stale?.headers.get('x-cfw-stale-behind'))).toBeGreaterThanOrEqual(1);
		// the body is the OLD one: serving the new generation here would mean the tier did not fire
		expect(await stale?.text()).toContain('gen one');
		// and it must not settle anywhere downstream, because it is known to be behind
		expect(stale?.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
	});

	// free KV allows 1,000 writes a day for the whole account, so a free site stores a page only while
	// the object's budget lasts, and a spent budget stores nothing for the stale tier to fall back on
	it('stores a free page under its KV budget and none once the budget is spent', async () => {
		const site = 'stalegen-free';
		await provisionedNamedSite(site);
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>free</title>'));
		const granted = await serveThroughWorker(site, '/', '&edge=0');
		expect(granted.header('x-cfw-kv-put')).toBe('deferred');
		const counted = await inObject(namedSite(site), async (obj) => {
			const stats = (await (
				await obj.fetch(new Request('https://do.local/__serve-stats'))
			).json()) as { pageKv: { writesToday: number; budget: number | null } | null };
			obj.env = { ...obj.env, KV_WRITES_PER_DAY: String(stats.pageKv?.writesToday ?? 0) };
			return stats.pageKv;
		});
		expect(counted?.writesToday).toBeGreaterThanOrEqual(1);
		expect(counted?.budget).toBe(800);
		const spent = await serveThroughWorker(site, '/', '&edge=0');
		expect(spent.header('x-cfw-kv-put')).toBe('skipped:no-grant');
	});

	it('re-validates at the client so a generation bump is not defeated by a browser cache', async () => {
		const site = 'revalidate';
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>rv</title>'));
		await serveThroughWorker(site, '/');
		const edge = await untilEdge(site, '/');
		expect(edge?.cacheControl).toBe('public, max-age=0, must-revalidate');
	});

	// the page key carries no request header, so one stored page answers every visitor
	// whether the render varies is measured in forwarded-headers.spec.ts; a render that declares Vary is not stored
	it('answers the same stored page whatever Accept, User-Agent or Origin the visitor sent', async () => {
		const site = 'keyvariance';
		await inObject(namedSite(site), (obj) => seedPage(obj, '/', '<title>one page</title>'));
		await serveThroughWorker(site, '/');
		const plain = await untilEdge(site, '/');
		expect(plain?.cache, 'the edge copy never became readable').toBe('EDGE');

		const variants: Record<string, string>[] = [
			{ accept: 'application/json' },
			{ 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
			{ origin: 'https://other.example' },
			{
				accept: 'application/json',
				'user-agent': 'curl/8.0',
				origin: 'https://other.example'
			}
		];
		for (const headers of variants) {
			const res = await SELF.fetch(
				`https://cfw.local/serve?site=${site}&path=${encodeURIComponent('/')}`,
				{ headers }
			);
			const body = await res.text();
			expect(body, JSON.stringify(headers)).toBe(plain?.body);
			expect(res.status).toBe(200);
			// an edge tier answered; none of the three sent it to the object
			expect(['EDGE', 'MEM'], JSON.stringify(headers)).toContain(
				res.headers.get('x-cfw-cache')
			);
		}
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

	// the three serve writes are deferred through waitUntil: an awaited caches.default.put costs 9 to 12.5 ms
	// refusals stay synchronous, so a page that must not be stored is refused by name
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

		// a missing header read through Number() is 0, not NaN, which once overwrote the generation pointer
		const stats = await SELF.fetch(`https://cfw.local/serve-stats?site=${site}`);
		expect(stats.headers.get('x-cfw-generation')).toBeNull();

		const after = await serveThroughWorker(site, '/');
		// MEM rather than EDGE because `untilEdge` above warmed this isolate's page memo; what the
		// test is about is that the pointer survived, and both tiers require a pointer to build a key
		expect(after.cache).toBe('MEM');
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
		// pagecache writes a permanent cache_data row per distinct url and expiry gc never removes it: a storage fix
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

	// the catch-all passes ?path= as pathname plus search, and four of six patterns are $-anchored
	// so a query walked a scanner past the deny list; every anchored pattern is covered
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
	// diagnostic routes fail closed while public routes serve unconditionally
	// the old assertion passed while wrangler.jsonc shipped PW_DIAGNOSTICS on, exposing /php and /sql

	it('serves the serving path even with diagnostics off', async () => {
		const res = await worker.fetch(new Request('https://cfw.local/serve?site=x&path=%2F'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(res.status).not.toBe(404);
	});

	it.each(['/php', '/sql', '/savenode', '/nativefetch'])(
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

	// owner routes answer 401, not 404: the route's existence is documented, and the token is the secret
	// an uncredentialed caller must get neither the route's work nor a 200
	it.each(['/migrate', '/armfill', '/invalidate', '/bump'])(
		'refuses %s without a credential, with diagnostics off',
		async (route) => {
			const res = await worker.fetch(
				new Request(`https://cfw.local${route}?site=x&path=%2F`),
				{
					...env,
					PW_DIAGNOSTICS: '0'
				}
			);
			expect(res.status).toBe(401);
			expect(res.status).not.toBe(200);
		}
	);

	it('does NOT 404 /firstrun with diagnostics off, or the token is unobtainable', async () => {
		const res = await worker.fetch(new Request('https://cfw.local/firstrun?site=x'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(res.status).not.toBe(404);
	});

	// /export is an owner route, not a diagnostic: it answers a per-site bearer token
	// 401 rather than 404, since a 404 would tell a legitimate owner the export is missing
	it('401s /export with a challenge rather than hiding it, when diagnostics are off', async () => {
		const res = await worker.fetch(new Request('https://cfw.local/export?site=x'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toContain('Bearer');
	});

	// an owner route must be listed in ROUTES; missing, the catch-all rendered /setup/cf as a drupal page
	// and copied its query string into the fill queue, cfw_page and the edge key
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

	// the positive half: a gate that refuses everyone also passes every 401 assertion
	// so this presents the site's own token and requires the dump to come back
	it('LETS THE OWNER THROUGH with the site token, and returns a real dump', async () => {
		const site = 'owner-token-ok';
		const token = await inObject(namedSite(site), (obj) =>
			mintOwnerToken((obj as unknown as { secretStore: () => SecretStore }).secretStore())
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

	it('refuses /restore without a credential and still 404s /sql, so only the owner tier widened', async () => {
		// /restore takes the owner token since v1.0.5; arbitrary SQL does not, and neither is open
		const restore = await worker.fetch(new Request('https://cfw.local/restore?site=x'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(restore.status).toBe(401);
		expect(restore.headers.get('www-authenticate')).toContain('Bearer');
		const sql = await worker.fetch(new Request('https://cfw.local/sql?site=x'), {
			...env,
			PW_DIAGNOSTICS: '0'
		});
		expect(sql.status).toBe(404);
	});

	it('renders an unclaimed path as a page rather than 404ing it', async () => {
		// drupal owns the url space: the worker must not refuse the path, and drupal's own 404 is a valid answer
		// the assertion checks for the worker's refusal string (not found) rather than a status, since drupal can 404 too
		const res = await SELF.fetch('https://cfw.local/definitely-not-a-route');
		const body = await res.text();
		expect(body, 'the Worker refused a path that belongs to Drupal').not.toBe('not found\n');
		// and it reached the serving path rather than some other branch that also answers a body
		expect(
			res.headers.get('x-cfw-cache'),
			'nothing on the serving path answered it'
		).not.toBeNull();
	});
});

// the rewrite is asserted through a stand-in namespace: the url the object is asked for is invisible past a real hop
// a status alone would pass a rewrite that dropped the query string or took the site from the visitor's parameters
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
		// the rewrite is built from the origin: copying the incoming url would carry ?site= into /serve's parameters
		const { inner, res } = await hop('/about-guard?site=someone-elses-site');
		expect(inner?.searchParams.get('site')).toBe('cfw.local');
		expect(res.headers.get('x-cfw-spy-site')).toBe('cfw.local');
		// not discarded either: drupal still sees the parameter it was sent
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

	// /serve is public, so it skipped the rewrite guard and read ?site= raw
	// an unauthenticated request could provision a database, or serve another tenant's pages from this hostname
	it('refuses ?site= on /serve itself once diagnostics are off', async () => {
		const { inner, res } = await hop('/serve?site=someone-elses-site&path=%2Fnode', {
			PW_DIAGNOSTICS: '0'
		});
		// the object that answered is derived from the HOST, not from the parameter
		expect(res.headers.get('x-cfw-spy-site')).toBe('cfw.local');
		// and the object is handed the RESOLVED name, so the value it pins as its own identity --
		// and keys its r2 mirror on: is never the one the caller asked for
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

	// whether the warm window reached this object; queueDepth() reads 0 for a warmed site and for one never created
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
		// WINDOW_SITES must not default to 'default': idFromName() creates what it names, warming a phantom
		// asserted on the object's own existence, since a queue depth of 0 is what a phantom reports too
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

// the inventory scripts/security-update.mjs --fleet reads; every function behind it had a unit test and the route had none
// /fleet fell through to a proxy hop with an undefined inner pathname, so every caller got a 404
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
		// d1 is not rolled back between tests, so the state is staged; the object creates the table, so an unreported database threw a 500
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
			lastSeenMs: Date.now(),
			reconcileVersion: 0,
			schemaVersion: FLEET_SCHEMA_VERSION,
			cms: 'drupal',
			tier: 'managed',
			health: 'ok'
		});
		await reportSite(db, {
			site: 'b',
			packGeneration: 'old',
			coreVersion: '11.4.4',
			workerVersion: 'v1',
			plan: 'free',
			lastSeenMs: Date.now(),
			reconcileVersion: 0,
			schemaVersion: FLEET_SCHEMA_VERSION,
			cms: 'drupal',
			tier: 'managed',
			health: 'ok'
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

// a form submission must survive the catch-all rewrite: POST /user/login reproduces the failure
// a GET of the same path and POST /serve both work, so the failure is specific to a non-GET taking the rewrite
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

	// a subrequest follows a 3xx by default, and the object has no route for the redirect target
	// the 3xx belongs to the browser, which re-enters through the catch-all and gets the page
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
		// one hop: a second means the runtime followed the redirect, which is the defect
		// the mode is what this lane can fail on: miniflare's stub does not follow a 3xx, so pin the request the worker builds
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

// the observable is the hop count: a plan hit must not reach the object, even when the bytes are right
// the namespace is a stand-in because the assertion is about which requests the worker sends
describe('the compiled plan tier', () => {
	const COOKIE_A = `${SESSION_COOKIE}=session-alpha`;
	const COOKIE_B = `${SESSION_COOKIE}=session-bravo`;
	/** what the first render of a route looks like before Drupal's asset library cache is warm */
	const WARMUP = `<html><body>${'a'.repeat(300)}<link rel="stylesheet" href="/x.css"></body></html>`;
	const STEADY = `<html><body>${'a'.repeat(300)}<p>steady</p></body></html>`;

	beforeEach(() => resetEdgePlans());

	/** a namespace that renders, reports a generation, and counts what reached it */
	function objectSpy(
		generation = () => 42,
		roles = () => 'authenticated,editor',
		moduleHeaders: () => Record<string, string> = () => ({})
	) {
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
								...moduleHeaders(),
								'content-type': 'text/html; charset=UTF-8',
								'x-cfw-cache': 'RENDER',
								'x-cfw-generation': String(generation()),
								// the plan tier keys on this and skips entirely without it; only the
								// object can report it, which is what makes it trustworthy
								'x-cfw-roles': roles()
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
			headers: res.headers,
			tier: res.headers.get('x-cfw-cache'),
			plan: res.headers.get('x-cfw-plan'),
			cacheControl: res.headers.get('cache-control')
		};
	}

	/** the renders a compile needs: this session's samples plus one from a second session */
	async function compileFor(namespace: unknown, path: string) {
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) await visit(namespace, path, COOKIE_A);
		// the second witness. A plan compiled from one session's renders would bake anything
		// constant for that user into a page every other user of the role set is served
		await visit(namespace, path, COOKIE_B);
	}

	it('answers from this isolate once two sessions have agreed, with no further hop', async () => {
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
		await visit(spy.namespace, path, COOKIE_B);
		const hops = spy.seen.length;

		const served = await visit(spy.namespace, path, COOKIE_A);
		expect(served.tier).toBe('PLAN');
		expect(served.plan).toBe('mem');
		expect(served.body).toBe(STEADY);
		// per-user output: nothing between here and the browser may store it
		expect(served.cacheControl).toBe('private, no-store');
		// the point of the tier: a correct body that still cost a hop is the failure this catches
		expect(spy.seen).toHaveLength(hops);
		expect(isCacheTier('PLAN')).toBe(true);
	});

	it('compiles from renders two and three, so the asset warm-up cannot corrupt a plan', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-warmup';
		await compileFor(spy.namespace, path);
		const served = await visit(spy.namespace, path, COOKIE_A);
		// the first render's stylesheet list is absent, which it would not be from a plan compiled
		// against it: that compile finds an unnamed varying region and refuses instead
		expect(served.tier).toBe('PLAN');
		expect(served.body).toBe(STEADY);
		expect(served.body).not.toContain('stylesheet');
	});

	describe('module-set headers on a plan hit', () => {
		const MODULE = {
			'referrer-policy': 'no-referrer',
			'content-security-policy': "frame-ancestors 'none'"
		};

		it('replays what the module set, with the defaults filling the rest', async () => {
			const spy = objectSpy(undefined, undefined, () => MODULE);
			const path = '/plan-tier-headers';
			await compileFor(spy.namespace, path);
			const served = await visit(spy.namespace, path, COOKIE_A);
			expect(served.plan).toBe('mem');
			expect(served.headers.get('referrer-policy')).toBe('no-referrer');
			expect(served.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
			expect(served.headers.get('x-content-type-options')).toBe('nosniff');
			expect(served.cacheControl).toBe('private, no-store');
		});

		it('sends the defaults alone when the module set nothing', async () => {
			const spy = objectSpy();
			const path = '/plan-tier-headers-none';
			await compileFor(spy.namespace, path);
			const served = await visit(spy.namespace, path, COOKIE_A);
			expect(served.plan).toBe('mem');
			expect(served.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
			expect(served.headers.has('content-security-policy')).toBe(false);
		});

		it('lets an operator rule beat the module header on a plan hit', async () => {
			const spy = objectSpy(undefined, undefined, () => MODULE);
			const path = '/plan-tier-headers-rule';
			const rules = {
				RESPONSE_HEADERS: JSON.stringify([
					{
						path,
						set: { 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': '' }
					}
				])
			};
			await compileFor(spy.namespace, path);
			const served = await visit(spy.namespace, path, COOKIE_A, rules);
			expect(served.plan).toBe('mem');
			expect(served.headers.get('referrer-policy')).toBe('same-origin');
			expect(served.headers.has('content-security-policy')).toBe(false);
		});

		it('does not compile a plan from two renders that disagree on a header', async () => {
			let renders = 0;
			const spy = objectSpy(undefined, undefined, () => ({
				'x-frame-options': ++renders % 2 === 0 ? 'DENY' : 'SAMEORIGIN'
			}));
			const path = '/plan-tier-headers-split';
			await compileFor(spy.namespace, path);
			const next = await visit(spy.namespace, path, COOKIE_A);
			expect(next.tier).not.toBe('PLAN');
			expect(next.plan).not.toBe('mem');
		});
	});

	// a session of another role set never reaches this plan; one of the same set must agree with it first
	// two sessions agreeing says nothing about a third whose shared region differs
	it('refuses a third session until its own render has agreed', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-sessions';
		await compileFor(spy.namespace, path);
		expect((await visit(spy.namespace, path, COOKIE_A)).tier).toBe('PLAN');

		const hopsBefore = spy.seen.length;
		const carol = `${SESSION_COOKIE}=session-carol`;
		const firstTry = await visit(spy.namespace, path, carol);
		expect(firstTry.tier).not.toBe('PLAN');
		expect(spy.seen).toHaveLength(hopsBefore + 1);
		// that render agreed with the plan, so this session is now proven against it
		expect((await visit(spy.namespace, path, carol)).tier).toBe('PLAN');
	});

	it('never serves a plan to a different role set', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-roles';
		await compileFor(spy.namespace, path);
		expect((await visit(spy.namespace, path, COOKIE_A)).tier).toBe('PLAN');

		// a session the object reports as holding fewer roles keys somewhere else entirely
		const lesser = objectSpy(
			() => 42,
			() => 'authenticated'
		);
		const hopsBefore = lesser.seen.length;
		const other = await visit(lesser.namespace, path, `${SESSION_COOKIE}=session-dave`);
		expect(other.tier).not.toBe('PLAN');
		expect(lesser.seen).toHaveLength(hopsBefore + 1);
	});

	// two sessions of one role set differ in the csrf token on an authenticated page
	// the slot substitutes it per visitor instead of generating it
	it('serves each session its own csrf token from one shared plan', async () => {
		const path = '/plan-tier-csrf';
		const token = (cookie: string) => `tok-${cookie.slice(-5)}`.padEnd(43, 'Z');
		const body = (cookie: string) =>
			`<html><body>\n${'<div>filler filler filler filler</div>\n'.repeat(8)}` +
			`<a href="/user/logout?token=${token(cookie)}">Log out</a>\n</body></html>`;
		const seen: string[] = [];
		const namespace = {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async (r: Request) => {
					const cookie = r.headers.get('cookie') ?? '';
					seen.push(cookie);
					return new Response(body(cookie), {
						status: 200,
						headers: {
							'content-type': 'text/html; charset=UTF-8',
							'x-cfw-cache': 'RENDER',
							'x-cfw-generation': '42',
							'x-cfw-roles': 'authenticated,editor',
							// what PHP re-sends on every `session_start()`; it must not refuse a compile
							'set-cookie': `${cookie}; Max-Age=2000000; path=/`
						}
					});
				}
			})
		};
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) await visit(namespace, path, COOKIE_A);
		await visit(namespace, path, COOKIE_B);

		const hops = seen.length;
		const a = await visit(namespace, path, COOKIE_A);
		const b = await visit(namespace, path, COOKIE_B);
		expect([a.plan, b.plan]).toEqual(['mem', 'mem']);
		// one entry answered both; each carries its own token rather than the compiler's sample
		expect(a.body).toBe(body(COOKIE_A));
		expect(b.body).toBe(body(COOKIE_B));
		expect(a.body).not.toContain(token(COOKIE_B));
		expect(seen).toHaveLength(hops);
	});

	// a site with one editor never gets a second witness; a key naming the session cannot serve anybody else
	it('serves one session from a plan of its own, with no second witness anywhere', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-solo';
		for (let i = 0; i < SAMPLES_PER_COMPILE; i++) {
			expect((await visit(spy.namespace, path, COOKIE_A)).tier).not.toBe('PLAN');
		}
		const hops = spy.seen.length;

		const served = await visit(spy.namespace, path, COOKIE_A);
		expect(served.tier).toBe('PLAN');
		expect(served.plan).toBe('private');
		expect(served.body).toBe(STEADY);
		expect(served.cacheControl).toBe('private, no-store');
		expect(spy.seen).toHaveLength(hops);
	});

	it('never answers another session from it', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-solo-isolation';
		for (let i = 0; i <= SAMPLES_PER_COMPILE; i++) await visit(spy.namespace, path, COOKIE_A);
		expect((await visit(spy.namespace, path, COOKIE_A)).plan).toBe('private');

		const hopsBefore = spy.seen.length;
		const other = await visit(spy.namespace, path, COOKIE_B);
		expect(other.tier).not.toBe('PLAN');
		expect(spy.seen).toHaveLength(hopsBefore + 1);
	});

	// the private plan must not answer its own session first, or the shared key never sees a second sample
	it('lets a second session promote the page to a shared plan', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-solo-promote';
		for (let i = 0; i <= SAMPLES_PER_COMPILE; i++) await visit(spy.namespace, path, COOKIE_A);
		expect((await visit(spy.namespace, path, COOKIE_A)).plan).toBe('private');

		await visit(spy.namespace, path, COOKIE_B);
		const hops = spy.seen.length;
		// the shared plan now outranks the private one for both of them, off a single entry
		expect((await visit(spy.namespace, path, COOKIE_A)).plan).toBe('mem');
		expect((await visit(spy.namespace, path, COOKIE_B)).plan).toBe('mem');
		expect(spy.seen).toHaveLength(hops);
	});

	// a plan compiled from renders without a queued message would drop it after a save
	it('renders again after a write, so a queued message is not dropped', async () => {
		const spy = objectSpy();
		const path = '/plan-tier-solo-message';
		for (let i = 0; i <= SAMPLES_PER_COMPILE; i++) await visit(spy.namespace, path, COOKIE_A);
		expect((await visit(spy.namespace, path, COOKIE_A)).plan).toBe('private');

		const ctx = createExecutionContext();
		await worker.fetch(
			new Request(`https://cfw.local/node/1/edit`, {
				method: 'POST',
				body: 'title=x',
				headers: { cookie: COOKIE_A, 'content-type': 'application/x-www-form-urlencoded' }
			}),
			{ ...env, SITE: spy.namespace } as unknown as typeof env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		const hopsBefore = spy.seen.length;
		expect((await visit(spy.namespace, path, COOKIE_A)).tier).not.toBe('PLAN');
		expect(spy.seen).toHaveLength(hopsBefore + 1);
	});

	// a save is the invalidation; this isolate learns the new generation on its next object response
	// GENERATION_TRUST_MS bounds how long it serves the old one until then
	it('drops every plan when a write moves the generation', async () => {
		let generation = 42;
		const spy = objectSpy(() => generation);
		const path = '/plan-tier-bump';
		await compileFor(spy.namespace, path);
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

describe("a reset object is not the visitor's 1101", () => {
	/** a namespace whose object throws on the first hop the way a reset one does */
	function resettingSite(error: Record<string, unknown>, repeat = new Response('rendered\n')) {
		const methods: string[] = [];
		const attempts: (string | null)[] = [];
		const bodies: string[] = [];
		let calls = 0;
		const namespace = {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async (r: Request) => {
					methods.push(r.method);
					attempts.push(r.headers.get(ATTEMPT_HEADER));
					bodies.push(new TextDecoder().decode(await r.arrayBuffer()));
					if (calls++ === 0)
						throw Object.assign(
							new Error('Durable Object reset because it exceeded its memory limit'),
							error
						);
					return repeat;
				}
			})
		};
		return { methods, attempts, bodies, namespace };
	}

	const send = (request: Request, namespace: unknown) =>
		worker.fetch(request, { ...env, SITE: namespace } as unknown as typeof env);

	it('sends a GET once more to the fresh instance', async () => {
		const s = resettingSite({ retryable: true });
		const res = await send(new Request('https://cfw.local/reset-get'), s.namespace);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-cfw-retried')).toBe('reset');
		expect(s.methods).toEqual(['GET', 'GET']);
	});

	it('repeats a POST with its body and the same attempt id, for the object to refuse if it started', async () => {
		const s = resettingSite({ retryable: true });
		const res = await send(
			new Request('https://cfw.local/user/login', {
				method: 'POST',
				body: 'name=admin',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					// a client cannot choose the id the object keys its marker on
					[ATTEMPT_HEADER]: '00000000-0000-4000-8000-000000000000'
				}
			}),
			s.namespace
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-cfw-retried')).toBe('reset');
		expect(s.methods).toEqual(['POST', 'POST']);
		expect(s.bodies).toEqual(['name=admin', 'name=admin']);
		expect(s.attempts[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(s.attempts[0]).not.toBe('00000000-0000-4000-8000-000000000000');
		expect(s.attempts[1]).toBe(s.attempts[0]);
	});

	it('answers the reset page when the object says the first try had started', async () => {
		const s = resettingSite(
			{ retryable: true },
			new Response(null, { status: 503, headers: { [ATTEMPT_HEADER]: 'started' } })
		);
		const res = await send(
			new Request('https://cfw.local/user/login', {
				method: 'POST',
				body: 'name=admin',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			}),
			s.namespace
		);
		expect(res.status).toBe(503);
		expect(res.headers.get('x-cfw-object-reset')).toBe('1');
		expect(res.headers.get('retry-after')).toBe('2');
		expect(await res.text()).toContain('may not have been saved');
		expect(s.methods).toEqual(['POST', 'POST']);
	});

	it('sends no attempt id with a GET, which is repeated on its own terms', async () => {
		const s = resettingSite({ retryable: true });
		await send(new Request('https://cfw.local/attempt-get'), s.namespace);
		expect(s.attempts).toEqual([null, null]);
	});

	// the shape a memory reset arrives in: overloaded and durableObjectReset set, retryable absent
	const MEMORY_RESET = { overloaded: true, remote: true, durableObjectReset: true };

	it('sends a GET once more after a memory reset, which the platform marks overloaded', async () => {
		const s = resettingSite(MEMORY_RESET);
		const res = await send(new Request('https://cfw.local/reset-memory'), s.namespace);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-cfw-retried')).toBe('reset');
		expect(s.methods).toEqual(['GET', 'GET']);
	});

	it('gives the failover to the primary the same one retry after a memory reset', async () => {
		// a lane that is not ready hands back with a 421, and the primary it fails over to can be
		// resetting; that hop answered the visitor a 500 while the first hop retried
		const cookie = `${SESSION_COOKIE}=reset-failover`;
		const path = Array.from({ length: 64 }, (_, i) => `/failover-${i}`).find(
			(p) =>
				chooseTarget({
					site: 'cfw.local',
					method: 'GET',
					affinity: affinityKey({
						session: 'reset-failover',
						pathname: p
					}),
					replicas: 4,
					pathname: '/serve',
					hasSession: true
				}).role === 'replica'
		)!;
		const methods: string[] = [];
		let calls = 0;
		const namespace = {
			idFromName: (name: string) => ({ name, toString: () => name }),
			newUniqueId: () => ({ toString: () => 'unique' }),
			get: () => ({
				fetch: async (r: Request) => {
					methods.push(r.method);
					calls++;
					if (calls === 1)
						return new Response('lane not ready', {
							status: 421,
							headers: {
								'x-cfw-requires-primary': 'session',
								'x-cfw-retry-safe': '1'
							}
						});
					if (calls === 2)
						throw Object.assign(new Error('Durable Object reset'), MEMORY_RESET);
					return new Response('rendered\n');
				}
			})
		};
		const res = await worker.fetch(
			new Request(`https://cfw.local${path}`, { headers: { cookie } }),
			{
				...env,
				SITE: namespace,
				REPLICA_COUNT: '4'
			} as unknown as typeof env
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-cfw-retried')).toBe('reset');
		expect(methods).toEqual(['GET', 'GET', 'GET']);
	});

	it('repeats a POST after a memory reset, carrying the attempt id', async () => {
		const s = resettingSite(MEMORY_RESET);
		const res = await send(
			new Request('https://cfw.local/admin/config/system/cron', {
				method: 'POST',
				body: 'op=Run+cron'
			}),
			s.namespace
		);
		expect(res.status).toBe(200);
		expect(s.methods).toEqual(['POST', 'POST']);
		expect(s.attempts[1]).toBe(s.attempts[0]);
	});

	it('answers a 503 rather than retrying an error that is neither retryable nor a reset', async () => {
		const s = resettingSite({});
		const res = await send(new Request('https://cfw.local/reset-plain'), s.namespace);
		expect(res.status).toBe(503);
		expect(s.methods).toEqual(['GET']);
	});
});

describe('an attempt the object has started is never run twice', () => {
	const ID = '11111111-2222-4333-8444-555555555555';
	const post = (id: string | null) =>
		new Request('https://do.local/__serve?path=%2Fadmin%2Fconfig%2Fsystem%2Fcron', {
			method: 'POST',
			body: 'op=Run+cron',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				...(id === null ? {} : { [ATTEMPT_HEADER]: id })
			}
		});
	const markers = (obj: ServeDo) =>
		obj.sql
			.exec("SELECT k FROM cfw_meta WHERE k >= 'attempt:' AND k < 'attempt;' ORDER BY k")
			.toArray()
			.map((r) => String(r.k));

	it('records the attempt before its render runs, and refuses a repeat of it', async () => {
		const site = 'attempt-once';
		await provisionedNamedSite(site);
		const first = await inObject(namedSite(site), async (obj) => {
			const seen: (string | null)[] = [];
			stubRender(obj, ({ path }) => {
				seen.push(obj.metaGet(`attempt:${ID}`));
				return pageFor(path);
			});
			const res = await obj.fetch(post(ID));
			return { status: res.status, seen };
		});
		expect(first.status).toBe(200);
		expect(first.seen).toHaveLength(1);
		expect(first.seen[0]).not.toBeNull();

		const again = await inObject(namedSite(site), async (obj) => {
			const calls = stubRender(obj, ({ path }) => pageFor(path));
			const res = await obj.fetch(post(ID));
			return {
				status: res.status,
				said: res.headers.get(ATTEMPT_HEADER),
				rendered: calls.length
			};
		});
		expect(again).toEqual({ status: 503, said: 'started', rendered: 0 });
	});

	it('keeps no marker for a POST without an id or with one the front worker did not mint', async () => {
		const site = 'attempt-none';
		await provisionedNamedSite(site);
		const left = await inObject(namedSite(site), async (obj) => {
			const calls = stubRender(obj, ({ path }) => pageFor(path));
			await obj.fetch(post(null));
			await obj.fetch(post('not-an-id'));
			return { rendered: calls.length, markers: markers(obj) };
		});
		expect(left).toEqual({ rendered: 2, markers: [] });
	});

	it('drops markers past their ttl when it writes one', async () => {
		const site = 'attempt-ttl';
		await provisionedNamedSite(site);
		const left = await inObject(namedSite(site), async (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			const old = 'attempt:99999999-2222-4333-8444-555555555555';
			obj.metaSet(old, obj.nowMs() - ATTEMPT_TTL_MS - 1);
			await obj.fetch(post(ID));
			return markers(obj);
		});
		expect(left).toEqual([`attempt:${ID}`]);
	});
});
