import { describe, expect, it } from 'vitest';
import { claimSite, encodeForm, formPost, hiddenFields, render } from '../helpers/drupal-forms';
import { freshSite, inObject } from '../helpers/serve-do';
import { stubFetch } from '../helpers/stub-fetch';

/**
 * Drupal's own mail path, split from `mail-transport.spec.ts` because it needs the PACK.
 *
 * The eleven tests in that file drive the host binding directly and run in the fast gate on a clean
 * checkout. This one boots Drupal and submits a real form, so it needs `assets/drupal-pf`, which a
 * clean checkout cannot build -- it is on `ARTIFACT_SPECS` and runs in the release lane. Keeping it
 * in the same file would have excluded all twelve from the gate to satisfy one.
 */

/**
 * Drupal's OWN mail path, which is the half `callMail()` cannot reach.
 *
 * Every test above invokes the host binding directly, so they prove the TRANSPORT works. They cannot
 * prove Drupal reaches it, because the two are separated by `system.mail` -- which shipped pointing
 * at `php_mail`, a mailer with no sendmail binary and no sockets on PHP's side. A site could pass
 * every assertion in this file and still drop every password reset a visitor asked for.
 *
 * So this drives the flow a visitor actually performs and asserts the message reached the durable
 * queue. `SETTINGS_OVERRIDE` forces `interface.default` to `cfw_mail`; point it back at `php_mail`
 * and this is the test that goes red.
 */
describe('the path a visitor takes, not the one a test can call', () => {
	it('queues a password-reset mail, which system.mail used to route into nothing', async () => {
		stubFetch();
		const out = await inObject(freshSite(), async (site) => {
			site.env = {
				...site.env,
				CF_EMAIL_ACCOUNT_ID: 'acct-drupal-path',
				CF_EMAIL_TOKEN: 'tok',
				MAIL_DRAIN_ON_ALARM: '0'
			};
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			await claimSite(site, 'cfw-MailPath-2263', 'MailPath');

			const built = await render(site, '/user/password');
			const submitted = await render(
				site,
				'/user/password',
				formPost(
					encodeForm({
						...hiddenFields(String(built['html'] ?? '')),
						name: 'admin',
						op: 'Submit'
					})
				)
			);

			const rows = await site
				.fetch(
					new Request(
						`https://do.local/__sql?q=${encodeURIComponent('SELECT COUNT(*) AS c FROM cfw_mail_queue')}`
					)
				)
				.then((r) => r.json() as Promise<Record<string, unknown>>);
			return {
				status: submitted['status'],
				queued: Number(((rows['rows'] as Record<string, unknown>[]) ?? [])[0]?.['c'] ?? -1)
			};
		});

		// the submission has to have been accepted, or the queue being empty proves nothing
		expect(out.status, 'the reset form must submit').toBe(303);
		expect(out.queued, 'Drupal sent, and it reached the transport').toBeGreaterThan(0);
	}, 900_000);
});
