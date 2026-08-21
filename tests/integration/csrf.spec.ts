import { describe, expect, it } from 'vitest';
import {
	claimSite,
	cookieJar,
	credentials,
	encodeForm,
	formPost as form,
	hiddenFields,
	render
} from '../helpers/drupal-forms';
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

/** everything four of the five cases share, so each case differs in exactly one field */
async function loggedInWithForm(site: ServeDo) {
	await claimSite(site, PASS, 'Csrf');
	const login = await render(site, '/user/login', form(credentials('admin', PASS)));
	const jar = cookieJar(login);
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
	 * A CSRF REJECTION USED TO POISON THE INTERPRETER. Fixed 2026-08-19; this is the regression test.
	 *
	 * After one rejection, no later form submission on that instance was PROCESSED -- not rejected,
	 * not processed. The login form came back rebuilt with no error message of any kind,
	 * `currentUser()` was 0 and no session cookie was issued, so it was indistinguishable from a page
	 * that was never submitted.
	 *
	 * **THE MECHANISM: `FormState::$anyErrors` is a CLASS STATIC**, set by `setErrorByName()` and
	 * read by `FormBuilder::processForm()` to decide whether to run submit handlers at all. Core
	 * resets it only in `FormState::clearErrors()`, which is reached from the PROGRAMMATIC
	 * `FormBuilder::submitForm()` path -- never on a normal HTTP request, because on a real SAPI the
	 * process dies instead. `RequestResetter::clearFormErrors()` clears it per request now.
	 *
	 * The token rejection was never the trigger, only the first way it was found: a plain failed
	 * LOGIN reaches the same state, which is why the second reproducer lives in
	 * `tests/integration/submission-wall.spec.ts`. Both are kept -- they enter the same gate from
	 * different forms, and a fix that only cleared the flag on one path would pass one of them.
	 *
	 * Two things were ruled out along the way and stay ruled out: the superglobals
	 * (`FormBuilder.php:1024-1030` calls `$request->overrideGlobals()` on the rejection path, and
	 * re-initialising `$_POST`/`$_GET`/`$_FILES`/`$_REQUEST` per request did NOT fix it), and flood
	 * control (stock config, and core's own threshold-1 probe fires on any failed-login row).
	 *
	 * BLAST RADIUS while it was live: a visitor who failed a token check -- a stale tab, a back
	 * button, a double submit -- denied the login form to everyone sharing that warm interpreter
	 * until it was dropped. No data corruption and no cross-user leak.
	 */
	it(
		'lets a later login through after a CSRF rejection, which a static used to prevent',
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
				const again = await render(site, '/user/login', form(credentials('admin', PASS)));

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
			// the rejection must not outlive its own request
			expect(out['status']).toBe(303);
			expect(out['uid']).toBe(1);
			expect(out['cookies']).toBeGreaterThan(0);
			expect(out['message'], 'and the credentials were never in question').toBe(false);
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
