import { describe, expect, it } from 'vitest';
import {
	DEFAULT_GET_TTL_MS,
	DEFAULT_POST_TTL_MS,
	STALE_SERVE_WINDOW_MS,
	isFresh,
	isServableStale,
	staleWindowFor,
	ttlFor
} from '../../../src/ops/deferred-post';

/**
 * One hour was doing two jobs: a garbage-collection bound and a freshness contract.
 *
 * The consumers of the deferred fetch cache are `hook_cron`, and the observed cron period is hours
 * rather than the configured fifteen minutes -- seven timestamps from a real run gave six gaps of
 * 8,142 / 9,016 / 8,303 / 8,840 / 16,235 / 26,033 seconds, every one past the 3,600 second TTL and
 * the smallest by 2.3x. So the entry was expired at the exact moment anything asked for it: fetch,
 * defer, throw, drain, expire, repeat, indefinitely.
 */

const HOUR = 3_600_000;
const RELEASE = 'https://updates.drupal.org/release-history/drupal/current?site_key=x';
const ANNOUNCE = 'https://www.drupal.org/announcements.json';

describe('the fetch cache separates freshness from the GC bound', () => {
	it('gives a cron-driven GET a TTL that outlives a cron interval', () => {
		// the largest observed gap, which the old value lost to by 7.2x
		const worstObservedGapMs = 26_033_000;
		expect(ttlFor('GET', RELEASE)).toBeGreaterThan(worstObservedGapMs);
		expect(ttlFor('GET', ANNOUNCE)).toBeGreaterThan(worstObservedGapMs);
	});

	it('leaves every other GET on the old cap, because that one is a GC bound', () => {
		expect(ttlFor('GET', 'https://example.com/thing')).toBe(DEFAULT_GET_TTL_MS);
		expect(ttlFor('GET')).toBe(DEFAULT_GET_TTL_MS);
		expect(DEFAULT_GET_TTL_MS).toBe(HOUR);
	});

	it('does not widen a POST, which is a replay window rather than a stale page', () => {
		expect(ttlFor('POST', RELEASE)).toBe(DEFAULT_POST_TTL_MS);
		expect(ttlFor('POST', 'https://example.com/verify')).toBe(DEFAULT_POST_TTL_MS);
		expect(DEFAULT_POST_TTL_MS).toBe(120_000);
	});

	it('matches on the host and path rather than on any drupal.org URL', () => {
		// a site pointing at its own release server keeps the ordinary cap; the widening is for the
		// endpoints this project has measured, not for a domain
		expect(ttlFor('GET', 'https://updates.drupal.org/other')).toBe(DEFAULT_GET_TTL_MS);
		expect(ttlFor('GET', 'https://www.drupal.org/node/1')).toBe(DEFAULT_GET_TTL_MS);
	});
});

describe('an expired entry is served rather than thrown, while the drain refreshes it', () => {
	const now = 1_000_000_000;

	it('opens a stale window for an idempotent method', () => {
		expect(staleWindowFor('GET')).toBe(STALE_SERVE_WINDOW_MS);
		expect(staleWindowFor('HEAD')).toBe(STALE_SERVE_WINDOW_MS);
	});

	it('opens none at all for anything that is not', () => {
		// this is the whole reason the two are separate functions: a stale POST result replayed is
		// a different outcome, not a slower one
		expect(staleWindowFor('POST')).toBe(0);
		expect(isServableStale({ expiresAt: now - 1 }, now, 'POST')).toBe(false);
	});

	it('classifies an entry as exactly one of fresh, stale-servable or gone', () => {
		const fresh = { expiresAt: now + 1 };
		const stale = { expiresAt: now - 1 };
		const gone = { expiresAt: now - STALE_SERVE_WINDOW_MS - 1 };

		expect(isFresh(fresh, now)).toBe(true);
		expect(isServableStale(fresh, now)).toBe(false);

		expect(isFresh(stale, now)).toBe(false);
		expect(isServableStale(stale, now)).toBe(true);

		expect(isFresh(gone, now)).toBe(false);
		expect(isServableStale(gone, now)).toBe(false);
	});

	it('treats a missing or non-finite expiry as gone on both sides', () => {
		expect(isServableStale(null, now)).toBe(false);
		expect(isServableStale({ expiresAt: Number.NaN }, now)).toBe(false);
		expect(isServableStale({ expiresAt: Number.POSITIVE_INFINITY }, now)).toBe(false);
	});

	it('covers the largest observed cron gap several times over', () => {
		// the point of the window: a consumer that asks once every few hours must never be the one
		// that meets the exception, and after the first fetch it never is
		expect(STALE_SERVE_WINDOW_MS / 26_033_000).toBeGreaterThan(20);
	});
});
