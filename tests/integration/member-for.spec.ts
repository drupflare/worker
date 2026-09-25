import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/site-php';
import { claimSite, loginJar, render } from '../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * "Member for" on a user page ages with the clock, not with the cache.
 *
 * Core builds the element with no max-age, so the render cache and the dynamic page cache keep the
 * interval they first formatted: `/user/1` read 21 seconds indefinitely on `drupflare-test`.
 * drupflare turns the element into a placeholder, so the page stays cached and only the interval
 * renders per request. The assertion needs both halves: a HIT, and a different interval.
 */

const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Member-5521-pass';
const ORIGIN = 'https://do.local';

// an authenticated render delivers the placeholder through BigPipe, whose replacement is JSON-escaped
const interval = (html: string) =>
	/Member for<\/h4>\s*([^<\\]+)/
		.exec(
			html.replaceAll('\\u003C', '<').replaceAll('\\u003E', '>').replaceAll('\\/', '/')
		)?.[1]
		?.trim() ?? null;

describe('"Member for" on a cached user page', () => {
	it(
		'changes between two renders the dynamic page cache answered',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'MemberFor');
				// the packed container predates the hook; reconciliation drops it on a real site
				site.sql.exec('DELETE FROM cache_container');
				const made = (await site.runJson(
					drupalOp(`$u = \\Drupal\\user\\Entity\\User::create([
	'name' => 'fresh', 'mail' => 'fresh@example.com', 'status' => 1, 'created' => time() - 3,
]);
$u->save();
$out['uid'] = (int) $u->id();`)
				)) as { uid?: number; error?: string };
				const cookie = await loginJar(site, 'admin', PASS, ORIGIN);
				const path = `/user/${made.uid}`;
				const first = await render(site, path, { cookie, origin: ORIGIN });
				const warm = await render(site, path, { cookie, origin: ORIGIN });
				await new Promise((r) => setTimeout(r, 2_500));
				const later = await render(site, path, { cookie, origin: ORIGIN });
				return { made, first, warm, later };
			});
			expect(out.made.error, String(out.made.error ?? '')).toBeUndefined();
			const first = interval(String(out.first['html'] ?? ''));
			const later = interval(String(out.later['html'] ?? ''));
			console.log(
				`[member-for] ${JSON.stringify({ first, later, dpc: [out.first['dynamicCache'], out.warm['dynamicCache'], out.later['dynamicCache']] })}`
			);
			expect(first, 'the page carries no "Member for" element').not.toBeNull();
			// the control: the page itself IS cached, so a changed interval is not a re-render
			expect(out.later['dynamicCache']).toBe('HIT');
			expect(later).not.toBe(first);
		},
		REQUEST_TIMEOUT
	);
});
