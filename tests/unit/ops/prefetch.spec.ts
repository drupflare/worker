import { describe, expect, it } from 'vitest';
import { declaredFetches, pendingDeclared, releaseHistoryUrl } from '../../../src/ops/prefetch';

/**
 * Tier 3 of the outbound ladder: warm the answer before Drupal asks.
 *
 * The deferred tier is cached-or-deferred by construction and that is correct. What it is not is
 * the whole ladder: a URL decidable from the SCHEDULE rather than from a request can be fetched
 * before the render that wants it, and that render then meets a cache hit and never defers.
 */

describe('what the host can name without running Drupal', () => {
	it('builds the release-history URL the way UpdateFetcher does', () => {
		expect(releaseHistoryUrl('drupal')).toBe(
			'https://updates.drupal.org/release-history/drupal/current'
		);
		expect(releaseHistoryUrl('pathauto')).toBe(
			'https://updates.drupal.org/release-history/pathauto/current'
		);
	});

	it('honours a site that points at its own release server', () => {
		expect(releaseHistoryUrl('drupal', 'https://releases.example.test/rh')).toBe(
			'https://releases.example.test/rh/drupal/current'
		);
		// an empty override is not an override
		expect(releaseHistoryUrl('drupal', '')).toContain('updates.drupal.org');
		expect(releaseHistoryUrl('drupal', null)).toContain('updates.drupal.org');
	});

	it('always warms core, which is the project every site has', () => {
		const urls = declaredFetches().map((d) => d.url);
		expect(urls).toContain('https://updates.drupal.org/release-history/drupal/current');
		expect(urls).toContain('https://www.drupal.org/announcements.json');
	});

	it('warms every installed project, and each one once', () => {
		const urls = declaredFetches(['pathauto', 'token', 'pathauto', 'drupal']).map((d) => d.url);
		const releases = urls.filter((u) => u.includes('release-history'));
		expect(releases).toHaveLength(3);
		expect(new Set(releases).size).toBe(3);
	});

	it('names a consumer for every entry, so a warm nobody reads is attributable', () => {
		for (const entry of declaredFetches(['token'])) {
			expect(entry.consumer.length, entry.url).toBeGreaterThan(0);
			expect(entry.freshMs).toBeGreaterThan(0);
		}
	});
});

describe('and a warm round costs nothing when the cache is already warm', () => {
	const declared = declaredFetches(['pathauto', 'token']);

	it('queues nothing at all when every answer is fresh', () => {
		// this is what makes running it on every cron round affordable rather than a second storm
		expect(pendingDeclared(declared, () => true)).toEqual([]);
	});

	it('queues only what is missing', () => {
		const missing = 'https://www.drupal.org/announcements.json';
		expect(pendingDeclared(declared, (url) => url !== missing)).toEqual([missing]);
	});

	it('bounds one round, because each fetch is one of the invocation subrequests', () => {
		expect(pendingDeclared(declared, () => false, 2)).toHaveLength(2);
		expect(pendingDeclared(declared, () => false, 99)).toHaveLength(declared.length);
	});
});
