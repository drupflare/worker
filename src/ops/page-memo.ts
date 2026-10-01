/**
 * Anonymous pages held in the isolate that is already answering the request, so a hit needs no
 * I/O (a `caches.default` read is nearly all of an `anon-cached` request's `x-worker-ms`).
 *
 * Keyed by `pageKey()` (origin, site, generation, path), so a bump makes an entry unreachable
 * rather than stale. It never holds a personalised page: the only caller is guarded by
 * `edgeWanted`, and the body was already accepted by `caches.default`. Bounded by bytes and entries
 * with a clear, not an LRU; the TTL mirrors the edge entry's `max-age`.
 * @module
 */

/** how long an entry serves, in ms; the `max-age` the edge tier stores a page under */
export const PAGE_MEMO_TTL_MS = 300_000;

/** how many pages one isolate holds */
export const PAGE_MEMO_ENTRIES = 256;

/** and the ceiling on what they hold, against a 128 MB isolate */
export const PAGE_MEMO_BYTES = 8_388_608;

/** a stored page */
export type MemoPage = {
	body: Uint8Array;
	status: number;
	contentType: string;
	/** every `x-cfw-*` header the stored response carried (so a measurement reads the same) */
	headers: [string, string][];
};

/**
 * What a hit hands back: the page plus response headers assembled once at store time (the hit
 * path runs on every request). A `Headers` instance that callers receive as a clone, so they cannot
 * mutate what the next request sees.
 */
type Entry = MemoPage & { at: number; ready: Headers };

const store = new Map<string, Entry>();
let heldBytes = 0;

/** drops what this isolate holds; tests use it, and so does an explicit refresh */
export function resetPageMemo(): void {
	store.clear();
	heldBytes = 0;
}

/** how many entries and bytes this isolate holds */
export function pageMemoStats(): { entries: number; bytes: number } {
	return { entries: store.size, bytes: heldBytes };
}

/** the page under this key, or undefined when there is none or it has aged out */
export function lookupPageMemo(key: string, nowMs: number = Date.now()): MemoPage | undefined {
	const entry = store.get(key);
	if (!entry) return undefined;
	if (nowMs - entry.at >= PAGE_MEMO_TTL_MS) {
		heldBytes -= entry.body.byteLength;
		store.delete(key);
		return undefined;
	}
	return entry;
}

/**
 * The response headers for a hit, ready to use, or undefined when there is no live entry.
 *
 * Separate from {@link lookupPageMemo} so it cannot answer for an entry that one would drop.
 */
export function pageMemoHeaders(key: string, nowMs: number = Date.now()): Headers | undefined {
	const entry = store.get(key);
	if (!entry || nowMs - entry.at >= PAGE_MEMO_TTL_MS) return undefined;
	// a clone, so one request's `x-worker-ms` never reaches the next response
	return new Headers(entry.ready);
}

/**
 * Holds a page for this isolate.
 *
 * A body larger than the whole budget is refused (storing it would clear every other page).
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
