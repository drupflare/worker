import { describe, expect, it } from 'vitest';
import { renderPage, type RenderRequest } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Does CSRF protection actually protect anything here?
 *
 * The token is real rather than modelled: Drupal computes it as
 * `hmacBase64($form_id, $csrf_seed . $private_key . $hash_salt)` with the seed held in the session,
 * so a tampered token, a missing token and a token minted under a different session all have to be
 * refused, and only the one the form issued may pass.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;
const PASS = 'cfw-Csrf-Pass-2260';

/** the message Drupal produces for a token that does not validate */
const OUTDATED = 'The form has become outdated';

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
		const value = (/value="([^"]*)"/.exec(tag)?.[1] ?? '')
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&#0?39;/g, "'");
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

/** everything four of the five cases share, so each case differs in exactly one field */
async function loggedInWithForm(site: ServeDo) {
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	await site.fetch(
		new Request('https://do.local/__firstrun', {
			method: 'POST',
			body: JSON.stringify({ adminPass: PASS, siteName: 'Csrf' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	const login = await render(
		site,
		'/user/login',
		form(`name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`, '')
	);
	const jar = jarOf(login);
	const built = await render(site, '/node/add/page', { cookie: jar });
	return { jar, fields: hiddenFields(String(built['html'] ?? '')) };
}

const NODE_BODY = {
	'title[0][value]': 'Csrf Probe',
	'body[0][value]': 'body',
	'status[value]': '1',
	op: 'Save'
};

describe('the CSRF token, accepted and refused', () => {
	it(
		'accepts the token the form issued, and refuses the same submission without it',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const { jar, fields } = await loggedInWithForm(site);

				const withToken = await render(
					site,
					'/node/add/page',
					form(encodeForm({ ...fields, ...NODE_BODY }), jar)
				);

				const { form_token: _dropped, ...withoutToken } = fields;
				const missing = await render(
					site,
					'/node/add/page',
					form(encodeForm({ ...withoutToken, ...NODE_BODY }), jar)
				);

				return {
					issued: fields['form_token'] ?? null,
					acceptedStatus: withToken['status'],
					acceptedLocation: withToken['location'],
					refusedStatus: missing['status'],
					refusedSaysOutdated: String(missing['html'] ?? '').includes(OUTDATED),
					nodes: await site
						.fetch(
							new Request(
								`https://do.local/__sql?q=${encodeURIComponent('SELECT COUNT(*) AS c FROM node')}`
							)
						)
						.then((r) => r.json() as Promise<Payload>)
				};
			});

			// the token is a real HMAC, not a placeholder: 43 base64url characters of a sha256 hmac
			expect(String(out['issued'])).toMatch(/^[A-Za-z0-9_-]{43}$/);

			expect(out['acceptedStatus'], 'a valid token must save').toBe(303);
			expect(String(out['acceptedLocation'])).toContain('/node/');

			expect(out['refusedStatus'], 'a missing token must NOT save').toBe(200);
			expect(out['refusedSaysOutdated'], 'and Drupal must say why').toBe(true);

			// exactly one node exists, so the refusal refused a write rather than merely rendering
			// a message beside one it had already performed
			const rows = (out['nodes'] as Payload)['rows'] as Payload[];
			expect(Number(rows[0]?.['c'])).toBe(1);
		},
		REQUEST_TIMEOUT
	);

	it(
		'refuses a token that was tampered with',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const { jar, fields } = await loggedInWithForm(site);
				const issued = String(fields['form_token'] ?? '');

				// one character changed, so length and alphabet still look right
				const flipped = `${issued.slice(0, -1)}${issued.slice(-1) === 'A' ? 'B' : 'A'}`;
				const tampered = await render(
					site,
					'/node/add/page',
					form(encodeForm({ ...fields, form_token: flipped, ...NODE_BODY }), jar)
				);

				return {
					issued,
					flipped,
					tamperedStatus: tampered['status'],
					tamperedSaysOutdated: String(tampered['html'] ?? '').includes(OUTDATED),
					nodes: await site
						.fetch(
							new Request(
								`https://do.local/__sql?q=${encodeURIComponent('SELECT COUNT(*) AS c FROM node')}`
							)
						)
						.then((r) => r.json() as Promise<Payload>)
				};
			});

			expect(out['flipped']).not.toBe(out['issued']);
			expect(out['tamperedStatus'], 'a tampered token must not save').toBe(200);
			expect(out['tamperedSaysOutdated']).toBe(true);

			const rows = (out['nodes'] as Payload)['rows'] as Payload[];
			expect(Number(rows[0]?.['c'])).toBe(0);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A DEFECT, PINNED RATHER THAN DESCRIBED.
	 *
	 * A CSRF rejection poisons the interpreter: after one, no later form submission on the same
	 * instance is PROCESSED. Not rejected -- not processed. The login form comes back rebuilt with
	 * no error message of any kind, `currentUser()` is 0, and no session cookie is issued, so it is
	 * indistinguishable from a page that was never submitted.
	 *
	 * What is established: it is the CSRF-rejection path specifically, not form POSTs in general.
	 * Three logins in a row succeed; a login after an authenticated form GET succeeds; a login after
	 * a token-REJECTED POST fails, and every login after that one fails too. The mechanism is not
	 * established. `FormBuilder::buildForm()` empties the request and calls
	 * `$request->overrideGlobals()` on that path (`FormBuilder.php:1024-1030`), which is the only
	 * process-global mutation in it, but re-initialising `$_POST`, `$_GET`, `$_FILES` and `$_REQUEST`
	 * per request does NOT fix it -- measured, so the superglobals are ruled out rather than blamed.
	 *
	 * BLAST RADIUS. A visitor who fails a token check -- a stale tab, a back button, a double submit
	 * -- takes out logins for everyone sharing that warm interpreter until it is dropped. It does not
	 * corrupt data and it does not leak across users; it denies service to the login form.
	 *
	 * Written as an assertion on the broken behaviour so that fixing it turns this file RED, which is
	 * the signal to delete this case. A comment would not do that.
	 */
	it(
		'PINNED DEFECT: a CSRF rejection stops later logins being processed at all',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const { jar, fields } = await loggedInWithForm(site);
				const { form_token: _dropped, ...noToken } = fields;

				// the rejection
				const rejected = await render(
					site,
					'/node/add/page',
					form(encodeForm({ ...noToken, ...NODE_BODY }), jar)
				);

				// a login that should succeed exactly as the first one did
				const again = await render(
					site,
					'/user/login',
					form(
						`name=admin&pass=${encodeURIComponent(PASS)}&form_id=user_login_form&op=Log+in`,
						''
					)
				);

				return {
					rejectedSaysOutdated: String(rejected['html'] ?? '').includes(OUTDATED),
					status: again['status'],
					uid: again['uid'],
					cookies: (again['setCookie'] as string[])?.length ?? 0,
					// no error text at all is the part that makes this hard to see from outside
					message: String(again['html'] ?? '').includes('Unrecognized')
				};
			});

			expect(out['rejectedSaysOutdated'], 'the setup must actually be a CSRF rejection').toBe(
				true
			);
			expect(out['status'], 'DEFECT: should be 303').toBe(200);
			expect(out['uid'], 'DEFECT: should be 1').toBe(0);
			expect(out['cookies'], 'DEFECT: should issue a session cookie').toBe(0);
			expect(out['message'], 'and it does not even say the credentials were wrong').toBe(
				false
			);
		},
		REQUEST_TIMEOUT
	);

	it(
		'refuses a submission that carries the token but no session at all',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				const { fields } = await loggedInWithForm(site);
				// the token travels, the cookie does not: this is the shape of a cross-site post
				const noSession = await render(
					site,
					'/node/add/page',
					form(encodeForm({ ...fields, ...NODE_BODY }), '')
				);
				return {
					status: noSession['status'],
					uid: noSession['uid'],
					nodes: await site
						.fetch(
							new Request(
								`https://do.local/__sql?q=${encodeURIComponent('SELECT COUNT(*) AS c FROM node')}`
							)
						)
						.then((r) => r.json() as Promise<Payload>)
				};
			});

			// authorization refuses it before the token is ever consulted, which is the correct
			// order: an anonymous request may not create a node whatever it presents
			expect(out['status']).toBe(403);
			expect(out['uid']).toBe(0);
			const rows = (out['nodes'] as Payload)['rows'] as Payload[];
			expect(Number(rows[0]?.['c'])).toBe(0);
		},
		REQUEST_TIMEOUT
	);
});
