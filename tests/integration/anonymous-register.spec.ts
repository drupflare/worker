import { describe, expect, it } from 'vitest';
import { drupalOp, renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A visitor creating their own account.
 *
 * The whole flow was a WSOD until the image toolkit resolved: the user picture field asks
 * `ImageFactory` for its supported extensions and, with no AVAILABLE toolkit, the id is null and
 * plugin lookup raises. That is `pack-consistency.spec.ts`. This owns the rest of the flow --
 * whether the form Drupal renders can actually be posted back and create a row.
 *
 * Driven through `renderPage()` rather than `/__serve`, for the reason `crud-journey.spec.ts` gives:
 * a free-plan MISS answers 503 and queues, which is correct product behaviour and useless for
 * asserting what Drupal did.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;

const render = (site: ServeDo, path: string, request: RenderRequest = {}) =>
	site.runJson(renderPage(path, [], false, request)) as Promise<Payload>;

const form = (body: string, cookie = ''): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	...(cookie ? { cookie } : {})
});

function hiddenFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		const value = /value="([^"]*)"/.exec(tag)?.[1] ?? '';
		if (name) {
			fields[name] = value
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#0?39;/g, "'");
		}
	}
	return fields;
}

const encodeForm = (fields: Record<string, string>) =>
	Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');

describe('a visitor registering an account', () => {
	it(
		'creates a user row from the form Drupal rendered',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Reg-8842-pass',
							siteName: 'Reg'
						})
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);

				// the shipped default is admin-only, which is a 403 rather than a form.
				// `drupalOp` rather than a bare fragment: provisioning drops the interpreter, so
				// there is no resident container to reach `\Drupal::` through
				await site.runJson(
					drupalOp(`\\Drupal::configFactory()->getEditable('user.settings')
						->set('register', 'visitors')->save();`)
				);

				const page = await render(site, '/user/register');
				const html = String(page['html'] ?? '');
				const fields = hiddenFields(html);

				const posted = await render(
					site,
					'/user/register',
					form(
						encodeForm({
							...fields,
							mail: 'visitor@example.com',
							name: 'newvisitor',
							op: 'Create new account'
						})
					)
				);

				const users = site.sql
					.exec('SELECT uid, name FROM users_field_data ORDER BY uid')
					.toArray() as unknown as { uid: number; name: string }[];

				return {
					status: Number(page['status'] ?? 0),
					hasForm:
						html.includes('user-register-form') || html.includes('user_register_form'),
					hiddenNames: Object.keys(fields),
					postStatus: Number(posted['status'] ?? 0),
					postHtml: String(posted['html'] ?? ''),
					users
				};
			});

			console.log(
				`[anon-register] ${JSON.stringify({
					status: out.status,
					hasForm: out.hasForm,
					hiddenNames: out.hiddenNames,
					postStatus: out.postStatus,
					users: out.users
				})}`
			);

			// the form has to render at all, which is what the toolkit fix restored
			expect(out.status).toBe(200);
			expect(
				out.hiddenNames,
				'no form_build_id, so no POST can ever be matched to this form'
			).toContain('form_build_id');

			// and posting it has to produce an account
			const names = (out.users as { name: string }[]).map((u) => u.name);
			expect(
				names,
				`registration created nothing; post returned ${out.postStatus}`
			).toContain('newvisitor');
		},
		REQUEST_TIMEOUT
	);
});
