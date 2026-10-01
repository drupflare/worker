import { lookupPageMemo, pageMemoHeaders, storePageMemo } from '../ops/page-memo';
import { readPage, readStalePage } from '../ops/page-store';
import { pageKeyUrl, readGeneration } from './edge-cache';
import { primeLanes } from './memos';
import type { AuthState, EdgeRead, FrontContext } from './types';

/** Reads the isolate memo and `caches.default`, and primes the lane pointer on the way. */
export async function readEdgeTiers(
	f: FrontContext,
	auth: AuthState
): Promise<Response | EdgeRead> {
	const { env, url, t0, site, path, serving, cache, origin, bucket } = f;
	const { personalised } = auth;
	const edgeWanted = serving && url.searchParams.get('edge') !== '0' && !personalised;

	// before the first routing decision, so a cold isolate routes to the pool on request one;
	// concurrent with the generation read (separate maps, and only a miss routes)
	const [, generationRead] = await Promise.all([
		serving ? primeLanes(cache, origin, site, env.CONFIG_KV) : undefined,
		edgeWanted ? readGeneration(cache, origin, site, bucket) : undefined
	]);

	let generation: number | undefined;
	if (edgeWanted) {
		generation = generationRead;
		if (generation !== undefined) {
			// the key string first: a memo hit skips a URL parse and a `Request`
			const memoKey = pageKeyUrl(origin, site, generation, path);
			// the tier above `caches.default`, answered with no I/O (`anon-cached` is 0.70 ms of
			// cpuTime, nearly all of `x-worker-ms` is the read below)
			const held = lookupPageMemo(memoKey, t0);
			if (held) {
				// headers were assembled at store time; only the timing is stamped here
				const headers = pageMemoHeaders(memoKey, t0) ?? new Headers();
				headers.set('x-worker-ms', String(Date.now() - t0));
				return new Response(held.body, { status: held.status, headers });
			}
			const cached = await cache.match(new Request(memoKey, { method: 'GET' }));
			if (cached) {
				// names the tier that answered (the DO's own verdict stays separate)
				const headers = new Headers(cached.headers);
				headers.set('x-cfw-cache', 'EDGE');
				headers.set('x-cfw-edge', 'HIT');
				headers.set('cache-control', 'public, max-age=0, must-revalidate');
				// buffered, not streamed, so the memo can hold it (12 KB for the front page)
				const body = new Uint8Array(await cached.arrayBuffer());
				storePageMemo(
					memoKey,
					{
						body,
						status: cached.status,
						contentType:
							cached.headers.get('content-type') ?? 'text/html; charset=utf-8',
						// only the object's verdict travels (a memo hit must not claim an edge hit)
						headers: [...cached.headers].filter(
							([name]) =>
								name.startsWith('x-cfw-') &&
								name !== 'x-cfw-cache' &&
								name !== 'x-cfw-edge'
						)
					},
					t0
				);
				headers.set('x-worker-ms', String(Date.now() - t0));
				return new Response(body, {
					status: cached.status,
					headers
				});
			}
		}
	}
	return { wanted: edgeWanted, generation };
}

/** Reads the KV page tier, then the previous generation, before the object is asked. */
export async function readKvTier(f: FrontContext, edge: EdgeRead): Promise<Response | undefined> {
	const { env, t0, site, path, defer, stubOf } = f;
	const { wanted: edgeWanted, generation } = edge;
	// kv tier between the colo cache and the object: answers from any colo with no DO request;
	// it cannot live in the object because `serveFromStorage()` is synchronous
	if (edgeWanted && generation !== undefined) {
		const stored = await readPage(env, site, generation, path);
		if (stored) {
			return new Response(stored.html, {
				status: stored.status,
				headers: {
					'content-type': stored.contentType,
					'x-cfw-cache': 'KV',
					'x-cfw-edge': 'MISS',
					'x-cfw-generation': String(generation),
					'cache-control': 'public, max-age=0, must-revalidate',
					'x-worker-ms': String(Date.now() - t0)
				}
			});
		}
		// a bump changes the key and deletes nothing, so the previous generation is still in kv
		// (the cold path it replaces is 802 ms at p50 against 4-5 warm); the refill is queued
		const stale = await readStalePage(env, site, generation, path, {
			neverStale: env.NEVER_STALE
		});
		if (stale) {
			defer(
				stubOf()
					.fetch(new Request(`https://do.local/__fill?path=${encodeURIComponent(path)}`))
					.then(() => undefined)
					.catch(() => undefined)
			);
			return new Response(stale.page.html, {
				status: stale.page.status,
				headers: {
					'content-type': stale.page.contentType,
					'x-cfw-cache': 'KV',
					'x-cfw-edge': 'STALE',
					'x-cfw-stale-behind': String(stale.behind),
					'x-cfw-generation': String(generation),
					// revalidate always: the body is a content change behind
					'cache-control': 'public, max-age=0, must-revalidate',
					'x-worker-ms': String(Date.now() - t0)
				}
			});
		}
	}
	return undefined;
}
