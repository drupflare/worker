import { describe, expect, it } from 'vitest';
import { GUZZLE_HANDLER_CHECK } from '../../src/drupal/site-php';
import { deferredKey, ttlFor } from '../../src/ops/deferred-post';
import { inObject, provisionedSite, type ServeDo } from '../helpers/serve-do';

/**
 * `Drupal::httpClient()` on the shipping binary, end to end.
 *
 * P39: the fetch succeeded and Guzzle threw the result away. `StreamHandler::createStream()` opens
 * the URL through the registered https wrapper, gets a live resource, and then reads
 * `$http_response_header` -- which only PHP's own http wrapper populates -- so `lastHeaders` is
 * empty, `HeaderProcessor::parseHeaders([])` raises, and every call to every one of the ten core
 * seams rejected with "An error was encountered while creating the response". A comment in
 * `DrupflareServiceProvider` described that path as "the behaviour that actually works today".
 *
 * HERMETIC: the row is seeded straight into `cfw_http_cache`, so nothing here reaches the network
 * and no drain has to run.
 *
 * THE CONTROL IS WHAT MAKES IT A REGRESSION TEST. `GUZZLE_HANDLER_CHECK` drives core's handler over
 * the same wrapper and the same row and requires it to still fail. Remove `CachedFetchHandler` and
 * this file goes red on the fix assertions while the control stays green; if the control ever goes
 * green the seam has stopped measuring the defect.
 */

/** the fragment's own default, the same one `CAPABILITY_CHECK` uses; `CFW_TEST_URL` overrides it */
const URL_UNDER_TEST = 'https://example.com/';
const BODY = '{"advisories":[]}';

type Check = { label: string; ok: boolean; detail?: unknown };

function seedCache(site: ServeDo): void {
	site.ensureHttpTables();
	site.sql.exec(
		`INSERT INTO cfw_http_cache (key, url, status, headers, body, fetched_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at`,
		deferredKey('GET', URL_UNDER_TEST, ''),
		URL_UNDER_TEST,
		200,
		JSON.stringify({ 'content-type': 'application/json' }),
		BODY,
		site.nowMs(),
		site.nowMs() + ttlFor('GET')
	);
}

describe('the Guzzle handler a non-suspending build installs', () => {
	it('returns the fetched body, while core StreamHandler still cannot', async () => {
		const out = await inObject(await provisionedSite(), async (site: ServeDo) => {
			seedCache(site);
			return site.runJson(GUZZLE_HANDLER_CHECK);
		});

		const checks = (out.checks ?? []) as Check[];
		const failed = checks.filter((c) => !c.ok);
		expect(failed, JSON.stringify(failed)).toEqual([]);
		// a fragment that threw before reaching the assertions reports one failure and no
		// passes, which an "every check passed" assertion alone would read as success
		expect(Number(out.passed)).toBeGreaterThanOrEqual(8);
		expect(
			checks.some((c) => c.label.startsWith('CONTROL:')),
			'the control ran'
		).toBe(true);
	}, 900_000);
});
