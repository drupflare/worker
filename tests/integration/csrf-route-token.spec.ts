import { describe, expect, it } from 'vitest';
import {
	claimSite,
	cookieJar,
	credentials,
	formPost as form,
	render
} from '../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The `_csrf_token` ROUTE token, which is a different mechanism from the form token and had no test.
 *
 * Reported against `/admin/reports/status/run-cron?destination=/user/1/edit&token=...`:
 * `'csrf_token' URL query argument is invalid`. The form-token cases in `csrf.spec.ts` all passed,
 * so the failure is not in that path.
 *
 * **IT IS NOT A TOKEN AT ALL, which is what took so long to see.** On an HTML request
 * `RouteProcessorCsrf::processOutbound()` does not compute a token: it emits
 * `Crypt::hashBase64($path)` as a PLACEHOLDER and attaches a `#lazy_builder` to replace it later.
 * `UpdateHooks::pageTop()` then passes the requirement description through
 * `Renderer::renderInIsolation()`, which renders the markup and DISCARDS the bubbled
 * `#attached[placeholders]` recipe, so nothing is left to perform the substitution. The raw
 * placeholder ships to the browser.
 *
 * `hashBase64()` is KEYLESS, so that value is the same 43 characters on every site in the world.
 * Measured: two sessions on two freshly provisioned sites, each with its own private key, hash salt
 * and session seed, were both handed `QJoWTyS5Bcf8KP_gvhmjUwm-s1rlrvSqL3XHgVsxEKQ` -- byte-identical
 * to the one in the report, and exactly `Crypt::hashBase64('admin/reports/status/run-cron')`.
 * `validate()` refuses it, correctly, which is the 403.
 *
 * On a generic host this is survivable, because update data arrives and the message stops rendering.
 * **Here it never stops**: a Worker cannot fetch synchronously, so `update` is permanently
 * data-less and this message is on every admin page of every drupflare site, forever.
 * `CsrfPlaceholderSubscriber` in the sibling module is the repair.
 *
 * These assert the property that has to hold however the link is built: a token a page issues must
 * belong to the session it was issued to, and must validate for it.
 */

const TIMEOUT = 900_000;
const PASS = 'cfw-Route-Csrf-2260';

type Payload = Record<string, unknown>;

/** the run-cron token exactly as a page rendered it, `destination` and all */
function runCronToken(html: string): string {
	const link = /\/admin\/reports\/status\/run-cron\?([^"']+)/.exec(html)?.[1] ?? '';
	return /token=([A-Za-z0-9_%-]+)/.exec(link.replace(/&amp;/g, '&'))?.[1] ?? '';
}

/** signs in and returns the jar, so each case can hold two independent sessions */
async function signIn(site: ServeDo): Promise<string> {
	const login = await render(site, '/user/login', form(credentials('admin', PASS)));
	return cookieJar(login);
}

describe('a route CSRF token belongs to the session it was issued to', () => {
	it(
		'issues a different run-cron token to a second session, and validates each for its own',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claimSite(site, PASS, 'Csrf');

				const jarA = await signIn(site);
				// `/admin/modules` takes the verbose branch of `UpdateHooks::pageTop()`, so the
				// no-data message is rendered rather than skipped the way it is on the status report
				const pageA = await render(site, '/admin/modules', { cookie: jarA });
				const htmlA = String(pageA['html'] ?? '');
				const tokenA = runCronToken(htmlA);

				const jarB = await signIn(site);
				const pageB = await render(site, '/admin/modules', { cookie: jarB });
				const tokenB = runCronToken(String(pageB['html'] ?? ''));

				const follow = (token: string, jar: string) =>
					render(
						site,
						`/admin/reports/status/run-cron?destination=/admin/modules&token=${token}`,
						{ cookie: jar }
					);

				const aOwn = tokenA ? await follow(tokenA, jarA) : null;
				const bOwn = tokenB ? await follow(tokenB, jarB) : null;
				// the disclosure case: B presenting the token A was issued
				const bUsesA = tokenA ? await follow(tokenA, jarB) : null;

				return {
					differentSessions: jarA !== jarB && jarA !== '' && jarB !== '',
					hasLink: htmlA.includes('run-cron'),
					tokenA,
					tokenB,
					aOwnStatus: aOwn?.['status'] ?? null,
					bOwnStatus: bOwn?.['status'] ?? null,
					bUsesAStatus: bUsesA?.['status'] ?? null
				} as Payload;
			});

			// eslint-disable-next-line no-console
			console.log('[route-csrf]', JSON.stringify(out));

			expect(out['differentSessions'], 'the two logins must be two sessions').toBe(true);
			expect(
				out['hasLink'],
				'no run-cron link was rendered, so nothing below is tested'
			).toBe(true);

			// A token is per session. Two sessions sharing one means a cached fragment lost its
			// `session` context, and whichever session did not mint it gets a 403 from its own page.
			expect(out['tokenA'], 'each session must be issued its own token').not.toBe(
				out['tokenB']
			);

			// THE REPORTED FAILURE, both ways round
			expect(out['aOwnStatus'], 'session A was refused its own token').not.toBe(403);
			expect(out['bOwnStatus'], 'session B was refused its own token').not.toBe(403);
		},
		TIMEOUT
	);
});
