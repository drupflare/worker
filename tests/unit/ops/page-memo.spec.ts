import { beforeEach, describe, expect, it } from 'vitest';
import {
	lookupPageMemo,
	PAGE_MEMO_BYTES,
	PAGE_MEMO_ENTRIES,
	PAGE_MEMO_TTL_MS,
	pageMemoHeaders,
	pageMemoStats,
	resetPageMemo,
	storePageMemo,
	type MemoPage
} from '../../../src/ops/page-memo';

/**
 * The tier answers `anon-cached`, which is 0.82 of the traffic weight, so its refusals matter more
 * than its hits. What is asserted here is that it cannot outlive the entry it copied, cannot grow
 * past its budget, and cannot be filled by one oversized page.
 */
const page = (bytes: number, status = 200): MemoPage => ({
	body: new Uint8Array(bytes),
	status,
	contentType: 'text/html; charset=utf-8',
	headers: [['x-cfw-do-cache', 'HIT']]
});

describe('the isolate page memo', () => {
	beforeEach(() => resetPageMemo());

	it('answers a stored key and reports nothing for one it has not seen', () => {
		storePageMemo('k1', page(16), 1_000);
		expect(lookupPageMemo('k1', 1_000)?.status).toBe(200);
		expect(lookupPageMemo('k2', 1_000)).toBeNull();
	});

	it('stops serving at the TTL the edge entry it copied carries', () => {
		storePageMemo('k1', page(16), 1_000);
		expect(lookupPageMemo('k1', 1_000 + PAGE_MEMO_TTL_MS - 1)).not.toBeNull();
		expect(lookupPageMemo('k1', 1_000 + PAGE_MEMO_TTL_MS)).toBeNull();
		// and the expired entry is gone rather than merely unserved
		expect(pageMemoStats().entries).toBe(0);
	});

	it('carries the object verdict through but not the tier headers', () => {
		storePageMemo('k1', page(16), 1_000);
		expect(lookupPageMemo('k1', 1_000)?.headers).toEqual([['x-cfw-do-cache', 'HIT']]);
	});

	it('does not double-count a key that is stored twice', () => {
		storePageMemo('k1', page(100), 1_000);
		storePageMemo('k1', page(100), 1_100);
		expect(pageMemoStats()).toEqual({ entries: 1, bytes: 100 });
	});

	it('clears rather than growing past the entry budget', () => {
		for (let i = 0; i <= PAGE_MEMO_ENTRIES; i++) storePageMemo(`k${i}`, page(8), 1_000);
		// the clear keeps the page that tripped it, so the request that paid for it is not wasted
		expect(pageMemoStats().entries).toBe(1);
		expect(lookupPageMemo(`k${PAGE_MEMO_ENTRIES}`, 1_000)).not.toBeNull();
	});

	it('clears rather than growing past the byte budget', () => {
		const big = Math.floor(PAGE_MEMO_BYTES / 2) + 1;
		storePageMemo('a', page(big), 1_000);
		storePageMemo('b', page(big), 1_000);
		expect(pageMemoStats().entries).toBe(1);
		expect(pageMemoStats().bytes).toBe(big);
	});

	it('refuses a page bigger than the whole budget instead of emptying itself for it', () => {
		storePageMemo('small', page(64), 1_000);
		storePageMemo('huge', page(PAGE_MEMO_BYTES + 1), 1_000);
		expect(lookupPageMemo('huge', 1_000)).toBeNull();
		// the refusal must not cost the pages already held, which a store-then-clear would
		expect(lookupPageMemo('small', 1_000)).not.toBeNull();
	});
});

// #region the headers a hit answers with

describe('the response headers a MEM hit returns', () => {
	beforeEach(() => resetPageMemo());

	// ASSEMBLED AT STORE TIME, because the hit path runs on every request and the store path runs
	// once per isolate per page. It used to spread `Object.fromEntries(entry.headers)` into a fresh
	// literal and then set five more keys, per hit, in the one tier whose whole claim is "no I/O"
	it('carries the stored headers plus the tier the caller would have set', () => {
		storePageMemo('k1', page(16), 1_000);
		const headers = pageMemoHeaders('k1', 1_000);
		expect(headers?.get('x-cfw-do-cache')).toBe('HIT');
		expect(headers?.get('x-cfw-cache')).toBe('MEM');
		expect(headers?.get('x-cfw-edge')).toBe('MEM');
		expect(headers?.get('content-type')).toBe('text/html; charset=utf-8');
		expect(headers?.get('cache-control')).toBe('public, max-age=0, must-revalidate');
	});

	it('hands back a COPY, so one request cannot stamp the next one', () => {
		// the caller sets `x-worker-ms` on what it gets; a shared instance would carry the first
		// request's timing into every later response off the same entry
		storePageMemo('k1', page(16), 1_000);
		pageMemoHeaders('k1', 1_000)?.set('x-worker-ms', '999');
		expect(pageMemoHeaders('k1', 1_000)?.get('x-worker-ms')).toBeNull();
	});

	it('answers null for a key it does not hold', () => {
		expect(pageMemoHeaders('missing', 1_000)).toBeNull();
	});

	it('answers null past the TTL, agreeing with the lookup rather than outliving it', () => {
		// the two read the same store, so a header set surviving an expired entry would serve a
		// dead page's headers beside a fresh body
		storePageMemo('k1', page(16), 1_000);
		expect(pageMemoHeaders('k1', 1_000 + PAGE_MEMO_TTL_MS)).toBeNull();
		expect(lookupPageMemo('k1', 1_000 + PAGE_MEMO_TTL_MS)).toBeNull();
	});

	it('survives the clear that keeps the page which tripped it', () => {
		for (let i = 0; i <= PAGE_MEMO_ENTRIES; i++) storePageMemo(`k${i}`, page(8), 1_000);
		expect(pageMemoHeaders(`k${PAGE_MEMO_ENTRIES}`, 1_000)?.get('x-cfw-cache')).toBe('MEM');
	});
});

// #endregion
