/**
 * Anonymous pages held in the isolate that is already answering the request.
 *
 * ## Why this tier exists
 *
 * `anon-cached` is 0.82 of the traffic weight and is answered by `caches.default`, which is the
 * cheapest tier that leaves the isolate and is still an I/O. Measured on a deployed free worker,
 * 2026-09-10: the whole request costs **0.70 ms of `cpuTime` at p50** and **7.9-14.0 ms of
 * `x-worker-ms`**, so an order of magnitude of the profile that decides the verdict is spent waiting
 * for a read whose answer this isolate has usually just seen. Against a localhost nginx serving the
 * same page in 2-3 ms, that read is the entire gap.
 *
 * The authenticated side already has this: {@link lookupEdgePlan} answers from isolate memory and
 * reports `mem`. The anonymous side had no equivalent and is 27x the weight.
 *
 * ## Why serving one is safe
 *
 * The key is `pageKey()`, unchanged -- origin, site, GENERATION and path. So this adds no staleness
 * that the tier below it does not already have: a bump moves the generation, a new generation is a
 * new key, and an isolate learns the generation from `genMemo` within `GEN_BUCKET_MS`. An entry for
 * a superseded generation is unreachable rather than stale, exactly as it is in `caches.default`.
 *
 * What it must never hold is a personalised page, and it cannot: the only caller is the branch
 * guarded by `edgeWanted`, which is false for a session-carrying request, and the value stored is a
 * body `caches.default` had already accepted -- so `putPage()`'s refusals have run.
 *
 * ## What bounds it
 *
 * Bytes and entries, with a clear rather than an LRU for the reason `genMemo` and the plan store use
 * one: the working set is bounded by the traffic one isolate sees, and eviction accounting costs
 * more than a refill. The TTL mirrors the `max-age` the edge entry carries, so nothing outlives the
 * copy it was taken from.
 */

/** how long an entry serves, in ms; the `max-age` the edge tier stores a page under */
export const PAGE_MEMO_TTL_MS = 300_000;

/** how many pages one isolate holds */
export const PAGE_MEMO_ENTRIES = 256;

/** and the ceiling on what they hold, against a 128 MB isolate */
export const PAGE_MEMO_BYTES = 8_388_608;

export type MemoPage = {
	body: Uint8Array;
	status: number;
	contentType: string;
	/** every `x-cfw-*` header the stored response carried, so a measurement reads the same fields */
	headers: [string, string][];
};

/**
 * What a HIT hands back: the page plus the response headers already assembled.
 *
 * THE HIT PATH DID THE ASSEMBLY, and it is the path that runs on every request. It spread
 * `Object.fromEntries(held.headers)` into a fresh literal and then set five more keys, so a tier
 * whose whole purpose is "no I/O at all" was materialising an array into an object and copying it
 * on every hit. Built once here, at store time, which happens once per isolate per page.
 *
 * A `Headers` instance rather than a plain object because `new Response` accepts it directly and
 * does not re-walk a literal, and because the caller must not be able to mutate what the memo holds
 * for the next request -- it is handed a clone.
 */
type Entry = MemoPage & { at: number; ready: Headers };

const store = new Map<string, Entry>();
let heldBytes = 0;

/** drops what this isolate holds; tests use it, and so does an explicit refresh */
export function resetPageMemo(): void {
	store.clear();
	heldBytes = 0;
}

export function pageMemoStats(): { entries: number; bytes: number } {
	return { entries: store.size, bytes: heldBytes };
}

/** the page under this key, or null when there is none or it has aged out */
export function lookupPageMemo(key: string, nowMs: number = Date.now()): MemoPage | null {
	const entry = store.get(key);
	if (!entry) return null;
	if (nowMs - entry.at >= PAGE_MEMO_TTL_MS) {
		heldBytes -= entry.body.byteLength;
		store.delete(key);
		return null;
	}
	return entry;
}

/**
 * The response headers for a hit, ready to use, or null when there is no live entry.
 *
 * Separate from {@link lookupPageMemo} so the TTL and the eviction stay in one place and this
 * cannot answer for an entry that one would have dropped.
 */
export function pageMemoHeaders(key: string, nowMs: number = Date.now()): Headers | null {
	const entry = store.get(key);
	if (!entry || nowMs - entry.at >= PAGE_MEMO_TTL_MS) return null;
	// a CLONE: the caller sets `x-worker-ms` on it, and the stored copy must not carry one request's
	// timing into the next request's response
	return new Headers(entry.ready);
}

/**
 * Holds a page for this isolate.
 *
 * A body larger than the whole budget is REFUSED rather than stored and immediately cleared, which
 * would empty the memo for every other page on the site.
 */
export function storePageMemo(key: string, page: MemoPage, nowMs: number = Date.now()): void {
	if (page.body.byteLength > PAGE_MEMO_BYTES) return;
	const existing = store.get(key);
	if (existing) heldBytes -= existing.body.byteLength;
	const entry: Entry = { ...page, at: nowMs, ready: readyHeaders(page) };
	store.set(key, entry);
	heldBytes += page.body.byteLength;
	if (store.size <= PAGE_MEMO_ENTRIES && heldBytes <= PAGE_MEMO_BYTES) return;
	store.clear();
	heldBytes = page.body.byteLength;
	store.set(key, entry);
}

/** the exact header set a MEM hit answers with, minus the per-request `x-worker-ms` */
function readyHeaders(page: MemoPage): Headers {
	const headers = new Headers(page.headers);
	headers.set('content-type', page.contentType);
	headers.set('x-cfw-cache', 'MEM');
	headers.set('x-cfw-edge', 'MEM');
	headers.set('cache-control', 'public, max-age=0, must-revalidate');
	return headers;
}
