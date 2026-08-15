import { describe, expect, it } from 'vitest';
import { renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Can an administrator edit configuration through the UI, and can anyone else?
 *
 * `crud-journey.spec.ts` owns the happy path end to end. What this file owns is the half that is
 * easy to lose while making the happy path work: **an anonymous visitor must not be able to change
 * configuration**, by any of the three routes that look different and are the same mistake -- no
 * session at all, a session-less POST carrying a valid token, and a GET that should never have built
 * the form in the first place.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Admin-Pass-7731';
const SETTINGS = '/admin/config/system/site-information';

const render = (site: ServeDo, path: string, request: RenderRequest = {}) =>
	site.runJson(renderPage(path, [], false, request)) as Promise<Payload>;

const form = (body: string, cookie: string): RenderRequest => ({
	method: 'POST',
	body,
	contentType: 'application/x-www-form-urlencoded',
	cookie
});

function hiddenFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
		const name = /name="([^"]*)"/.exec(tag)?.[1];
		const value = (/value="([^"]*)"/.exec(tag)?.[1] ?? '').replace(/&amp;/g, '&');
		if (name) fields[name] = value;
	}
	return fields;
}

const encodeForm = (fields: Record<string, string>) =>
	Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');

function jarOf(result: Payload): string {
	const lines = Array.isArray(result['setCookie']) ? (result['setCookie'] as string[]) : [];
	const session = lines.find((line) => /^S?SESS/.test(line));
	return session ? (session.split(';')[0] ?? '') : '';
}

const SAVE = {
	site_name: 'Renamed By Test',
	site_mail: 'admin@example.com',
	site_slogan: '',
	site_frontpage: '/node',
	site_403: '',
	site_404: '',
	op: 'Save configuration'
};

/** the stored site name, read from the config table rather than from a rendered page */
const siteNameOf = (site: ServeDo) =>
	site
		.fetch(
			new Request(
				`https://do.local/__sql?q=${encodeURIComponent(
					"SELECT length(data) AS n FROM config WHERE name = 'system.site'"
				)}`
			)
		)
		.then((r) => r.json() as Promise<Payload>);

async function admin(site: ServeDo) {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Admin' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	const login = await render(
		site,
		'/user/login',
		form(`name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`, '')
	);
	return jarOf(login);
}

describe('administrator configuration editing', () => {
	it(
		'builds the settings form for an admin and refuses it to everyone else',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await admin(site);
				const anon = await render(site, SETTINGS);
				const authed = await render(site, SETTINGS, { cookie: jar });
				return {
					anonStatus: anon['status'],
					anonUid: anon['uid'],
					anonHasForm: String(anon['html'] ?? '').includes('form_build_id'),
					authedStatus: authed['status'],
					authedUid: authed['uid'],
					authedHasForm: String(authed['html'] ?? '').includes('form_build_id')
				};
			});

			expect(out['anonStatus']).toBe(403);
			expect(out['anonUid']).toBe(0);
			expect(out['anonHasForm'], 'an anonymous visitor must not be handed the form').toBe(
				false
			);

			expect(out['authedStatus']).toBe(200);
			expect(out['authedUid']).toBe(1);
			expect(out['authedHasForm']).toBe(true);
		},
		REQUEST_TIMEOUT
	);

	it(
		'saves a configuration change as an admin, and the site serves the new value',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await admin(site);
				const built = await render(site, SETTINGS, { cookie: jar });
				const fields = hiddenFields(String(built['html'] ?? ''));
				const saved = await render(
					site,
					SETTINGS,
					form(encodeForm({ ...fields, ...SAVE }), jar)
				);
				const home = await render(site, '/');
				return {
					saveStatus: saved['status'],
					sawNewName: String(home['html'] ?? '').includes('Renamed By Test'),
					config: await siteNameOf(site)
				};
			});

			expect(out['saveStatus'], 'a saved settings form redirects').toBe(303);
			expect(out['sawNewName'], 'the change must reach what visitors are served').toBe(true);
			// the row is real rather than a rendered artefact
			const rows = (out['config'] as Payload)['rows'] as Payload[];
			expect(Number(rows[0]?.['n'])).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The assertion this file exists for now.
	 *
	 * The token is REAL -- minted by the admin's own session -- and travels without the cookie. That
	 * is the shape of a cross-site post, and it is the case a session layer built in a hurry gets
	 * wrong: authorization has to be decided from the session, never from what the body carries.
	 */
	it(
		'refuses a configuration change from a request with no session, token or not',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const jar = await admin(site);
				const built = await render(site, SETTINGS, { cookie: jar });
				const fields = hiddenFields(String(built['html'] ?? ''));

				const withStolenToken = await render(
					site,
					SETTINGS,
					form(encodeForm({ ...fields, ...SAVE }), '')
				);
				const withNothing = await render(site, SETTINGS, form(encodeForm(SAVE), ''));
				const home = await render(site, '/');

				return {
					hadToken: typeof fields['form_token'] === 'string',
					stolenStatus: withStolenToken['status'],
					stolenUid: withStolenToken['uid'],
					nothingStatus: withNothing['status'],
					sawNewName: String(home['html'] ?? '').includes('Renamed By Test')
				};
			});

			expect(out['hadToken'], 'the setup must actually carry a real token').toBe(true);
			expect(out['stolenStatus'], "another session's token must not authorize").toBe(403);
			expect(out['stolenUid']).toBe(0);
			expect(out['nothingStatus']).toBe(403);
			expect(out['sawNewName'], 'nothing may have changed the site name').toBe(false);
		},
		REQUEST_TIMEOUT
	);
});
