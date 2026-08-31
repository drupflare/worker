import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL, GUZZLE_HANDLER_CHECK } from '../../src/drupal/site-php';
import { deferredKey, ttlFor } from '../../src/ops/deferred-post';
import { freshSite, inObject, provisionedSite, type ServeDo } from '../helpers/serve-do';

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

	it('rejects on the first call and answers on the second, which is the deferred contract', async () => {
		// THE CYCLE ITSELF, which the test above skips by seeding the row. Every claim
		// that a module "cannot work here because a deferred exchange always misses" rests on what
		// happens on call TWO, and nothing had measured it -- `search_gov_results_api` was
		// classified `blocked` on a sentence about a cycle no test had ever run
		const url = 'https://cfw-deferred.invalid/results';
		const body = '{"results":[{"title":"a stored answer"}]}';
		const ask = `<?php
			$out = ['first' => null, 'second' => null];
			try {
				\\Drupal::httpClient()->get('${url}');
				$out['first'] = 'resolved';
			} catch (\\Throwable $e) {
				$out['first'] = 'rejected:' . get_class($e) . ':' . substr($e->getMessage(), 0, 200);
			}
			echo json_encode($out);`;

		const out = await inObject(freshSite(), async (site: ServeDo) => {
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			site.ensureHttpTables();
			await site.runJson(BOOT_KERNEL);
			const first = (await site.runJson(ask)) as Record<string, unknown>;
			// the queue row the miss armed, which is the deferral being real rather than a failure
			const queued = site.sql
				.exec('SELECT url FROM cfw_http_queue WHERE url = ?', url)
				.toArray().length;
			// stand in for the drain: the endpoint does not resolve, and what is under test is the
			// READ on the second call rather than `fetch()` itself
			site.sql.exec('DELETE FROM cfw_http_queue WHERE url = ?', url);
			site.sql.exec(
				`INSERT INTO cfw_http_cache (key, url, status, headers, body, fetched_at, expires_at)
				 VALUES (?, ?, 200, ?, ?, ?, ?)`,
				deferredKey('GET', url, ''),
				url,
				JSON.stringify({ 'content-type': 'application/json' }),
				body,
				site.nowMs(),
				site.nowMs() + ttlFor('GET')
			);
			const second = (await site.runJson(`<?php
				try {
					$r = \\Drupal::httpClient()->get('${url}');
					echo json_encode(['second' => 'resolved', 'body' => (string) $r->getBody()]);
				} catch (\\Throwable $e) {
					echo json_encode(['second' => 'rejected:' . get_class($e)]);
				}`)) as Record<string, unknown>;
			return { first, queued, second };
		});

		console.log(`[guzzle-deferred] ${JSON.stringify(out)}`);

		// a REJECTION, not an empty body: Guzzle's `http_errors` does not raise on 2xx, so a 202
		// deferral note would be `Json::decode()`d and iterated by a caller that never checked
		expect(String(out.first['first'])).toContain('rejected:');
		expect(out.queued, 'the miss armed no queue row, so nothing would ever fetch it').toBe(1);
		// and the second call gets the real body, which is what makes the cycle a latency cost
		// rather than a capability refusal
		expect(out.second['second']).toBe('resolved');
		expect(out.second['body']).toBe(body);
	}, 900_000);
});
