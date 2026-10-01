import type { SiteEnv } from '../env';

/** how long an edge-cached page stays fresh, in seconds */
export const EDGE_PAGE_TTL_S = 300;

/**
 * Width of the window the generation pointer is discovered once per, in ms. The pointer is an
 * edge-cache entry keyed by window index, because Cloudflare's minimum TTLs would let a
 * `max-age` pointer outlive its window. Costs at most one DO request per window per colo; a bump
 * reaches other colos within two windows.
 */
const GEN_BUCKET_MS = 5000;

/** how long the pointer entry itself may live; only has to outlive its window */
const GEN_POINTER_TTL_S = 60;

/**
 * Isolate-local memo of the generation pointer, keyed by site and window, so staleness is bounded
 * by `GEN_BUCKET_MS` rather than by the isolate's lifetime.
 */
const genMemo = new Map<string, number>();

/** the string half of a cache key; `cacheKey()` is the same identity as a `Request` */
const cacheKeyUrl = (origin: string, parts: string[]) =>
	`${origin}/__cfw/${parts.map(encodeURIComponent).join('/')}`;

/** the edge-cache key for `parts` under `origin`, as a GET `Request` */
export const cacheKey = (origin: string, parts: string[]) =>
	new Request(cacheKeyUrl(origin, parts), { method: 'GET' });

const genKey = (origin: string, site: string, bucket: number) =>
	cacheKey(origin, ['gen', site, String(bucket)]);

/**
 * The page cache key as a string, which the isolate memo is keyed on; split from {@link pageKey}
 * so a memo hit allocates no `Request`.
 */
export const pageKeyUrl = (origin: string, site: string, generation: number, path: string) =>
	cacheKeyUrl(origin, ['page', String(generation), site, path]);

const pageKey = (origin: string, site: string, generation: number, path: string) =>
	new Request(pageKeyUrl(origin, site, generation, path), { method: 'GET' });

/**
 * A positive generation, or undefined; `Number(null)` is 0, which would overwrite the pointer
 * with a key nothing is stored under.
 */
export function asGeneration(raw: string | null | undefined): number | undefined {
	if (raw === null || raw === undefined || raw === '') return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function rememberGeneration(site: string, bucket: number, generation: number): void {
	// bounded by traffic within one window; a clear is cheaper than an LRU here
	if (genMemo.size > 64) genMemo.clear();
	genMemo.set(`${site}#${bucket}`, generation);
}

/** the generation pointer for this site and window, from the memo or the edge cache */
export async function readGeneration(
	cache: Cache,
	origin: string,
	site: string,
	bucket: number
): Promise<number | undefined> {
	const memo = genMemo.get(`${site}#${bucket}`);
	if (memo !== undefined) return memo;
	const hit = await cache.match(genKey(origin, site, bucket));
	if (!hit) return undefined;
	const n = asGeneration((await hit.text()).trim());
	if (n === undefined) return undefined;
	rememberGeneration(site, bucket, n);
	return n;
}

/** records the generation pointer in the memo and the edge cache; a failed put is ignored */
export async function writeGeneration(
	cache: Cache,
	origin: string,
	site: string,
	bucket: number,
	generation: number
): Promise<void> {
	rememberGeneration(site, bucket, generation);
	try {
		await cache.put(
			genKey(origin, site, bucket),
			new Response(String(generation), {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': `public, max-age=${GEN_POINTER_TTL_S}`
				}
			})
		);
	} catch {
		// no pointer just means the next request in this window re-learns from the DO
	}
}

/**
 * Stores a rendered page at the edge, or says why it did not.
 *
 * Only a 200 is stored (a cached 503 placeholder would serve forever), with headers from an
 * allow-list because `cache.put()` rejects some combinations. The write is returned for
 * `waitUntil` rather than awaited: awaiting a 97 KB put cost 12.5 ms before the response left.
 *
 * @returns an x-cfw-edge-put value, and the write to defer when there is one
 */
export function putPage(
	cache: Cache,
	origin: string,
	site: string,
	path: string,
	res: Response,
	generation: number | undefined,
	doCache: string,
	isAuthenticated: boolean
): { outcome: string; write?: Promise<unknown> } {
	const refused = (outcome: string) => ({ outcome });
	if (res.status !== 200) return refused(`skipped:${res.status}`);
	if (doCache !== 'HIT' && doCache !== 'RENDER') return refused(`skipped:${doCache}`);
	if (generation === undefined) return refused('skipped:no-generation');
	// the key has no user in it, so refuse a per-user request or response before the allow-list
	// drops Set-Cookie and makes somebody's page look anonymous
	if (isAuthenticated) return refused('skipped:authenticated');
	if (res.headers.has('set-cookie')) return refused('skipped:set-cookie');

	const headers = new Headers({
		'content-type': res.headers.get('content-type') ?? 'text/html; charset=utf-8',
		'cache-control': `public, max-age=${EDGE_PAGE_TTL_S}`,
		'x-cfw-do-cache': doCache,
		'x-cfw-generation': String(generation)
	});
	for (const h of ['x-cfw-render-ms', 'x-cfw-rendered-at']) {
		const v = res.headers.get(h);
		if (v !== null) headers.set(h, v);
	}

	// cloned now: a clone taken after the caller consumes the body is empty
	const copy = new Response(res.clone().body, { status: 200, headers });
	// no memo seed here: it would hide the `EDGE` tier from `serve-edge.spec.ts` to save one
	// 0.65 ms read per isolate per page
	return {
		outcome: 'deferred',
		// a rejection degrades to "no edge cache"
		write: cache.put(pageKey(origin, site, generation, path), copy).catch(() => undefined)
	};
}

/** the generation window in ms: `GEN_BUCKET_MS` from env, else the default */
export function genBucketMs(env: SiteEnv): number {
	const n = Number(env?.GEN_BUCKET_MS);
	return Number.isFinite(n) && n > 0 ? n : GEN_BUCKET_MS;
}
