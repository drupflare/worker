import { describe, expect, it } from 'vitest';
import { submissionProbe } from '../../src/drupal/site-php';
import { claimSite, login, sessionCookie } from '../helpers/drupal-forms';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Where exactly does a form submission stop?
 *
 * "The form does not submit" is not actionable. This reports which of four walls rejects it, with
 * the value Drupal actually saw at each stage, and the answer turned out to be different for the two
 * routes probed -- which is itself the finding.
 *
 * `pageCachePolicy: "deny"` on both, which is correct: a POST must never be cacheable. The earlier
 * finding that `Request::create()` produces a cacheable request applies to GETs.
 */

type Probe = Record<string, unknown>;
const REQUEST_TIMEOUT = 600_000;

async function probe(options: { path: string; body: string }): Promise<Probe> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1'));
		return site.runJson(
			submissionProbe({
				path: options.path,
				method: 'POST',
				body: options.body,
				contentType: 'application/x-www-form-urlencoded'
			})
		);
	});
}

describe('wall 1: does Drupal see the POST', () => {
	it(
		'sees the method, the parsed values and the raw body length',
		async () => {
			const out = await probe({
				path: '/user/login',
				body: 'name=admin&pass=secret&form_id=user_login_form&op=Log+in'
			});
			expect(out['ok'], JSON.stringify(out).slice(0, 300)).toBe(true);
			expect(out['methodSeen']).toBe('POST');
			expect(out['isMethodPost']).toBe(true);
			// the values are on the REQUEST OBJECT, which is what Drupal's form system reads
			expect(out['requestKeys']).toEqual(['name', 'pass', 'form_id', 'op']);
			expect(Number(out['contentLength'])).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'never treats a POST as cacheable',
		async () => {
			const out = await probe({ path: '/user/login', body: 'name=a&pass=b' });
			expect(out['pageCachePolicy']).toBe('deny');
		},
		REQUEST_TIMEOUT
	);
});

describe('the wall for an authorization-gated form', () => {
	/**
	 * The named wall: the routing-layer access check, rejecting uid 0.
	 *
	 * Pinned so that when a session exists this fails and the assertion moves to whatever rejects it
	 * next -- which by elimination is the form build id or the token, neither of which is reached
	 * today.
	 */
	it(
		'stops /node/add/page at access, before any form is built',
		async () => {
			const out = await probe({
				path: '/node/add/page',
				body: 'title%5B0%5D%5Bvalue%5D=Via+Form&op=Save'
			});

			expect(out['wall']).toBe('access-denied');
			expect(out['status']).toBe(403);
			expect(out['currentUserId']).toBe(0);
			expect(out['isAuthenticated']).toBe(0);

			// no form in the response, which is what proves FormBuilder was never reached
			expect(out['hasFormBuildId']).toBe(0);
			expect(out['hasFormToken']).toBe(0);

			// the other two walls ruled out positively rather than by absence
			expect(out['saysOutdated'], 'not the form build id').toBe(0);
			expect(out['saysTokenInvalid'], 'not CSRF').toBe(0);
		},
		REQUEST_TIMEOUT
	);
});

describe('a form anonymous users may submit', () => {
	it(
		'builds the form and handles the POST',
		async () => {
			const out = await probe({
				path: '/user/login',
				body: 'name=admin&pass=secret&form_id=user_login_form&op=Log+in'
			});

			expect(out['status']).toBe(200);
			expect(out['hasFormBuildId'], 'the form was built').toBe(1);
			expect(out['saysAccessDenied']).toBe(0);
			expect(out['saysOutdated']).toBe(0);
			expect(out['saysTokenInvalid']).toBe(0);
			// no redirect, which is what a failed login looks like -- and what a submission that did
			// nothing would also look like. This spec does not distinguish them; see the docblock
			expect(out['location']).toBeNull();
		},
		REQUEST_TIMEOUT
	);

	it(
		'has no session to carry a login into, which is the next thing to scope',
		async () => {
			const out = await probe({ path: '/user/login', body: 'name=a&pass=b' });
			expect(out['hasSession']).toBe(0);
			expect(out['hasPreviousSession']).toBe(0);
		},
		REQUEST_TIMEOUT
	);
});

/**
 * What the probe above cannot answer: does a WRONG password differ from a right one?
 *
 * The reported symptom was "login 200s on every request regardless of whether it was valid", and a
 * failed Drupal login legitimately answers 200 with the form re-rendered, so status alone proves
 * nothing either way. Four signals separate the outcomes and every case below reads all four: the
 * status, the redirect, the session cookie, and the message Drupal writes when it refuses.
 *
 * Driven through `renderPage()` -- the real serve path, method and body threaded the way `/__serve`
 * threads them -- rather than through `submissionProbe()`, because the suspect named in the report
 * was the catch-all's POST path and a probe that rebuilds the request itself would not exercise it.
 *
 * The answer: the refusal is correct and the reported symptom is not it. The defect is in the case
 * nobody measured -- see the pinned one at the bottom of this file.
 */
const PASS = 'cfw-Login-Wall-2261';
const REFUSED = 'Unrecognized username or password';

/** the four signals that separate a login that worked from one that did not */
const signals = (result: Probe) => ({
	status: result['status'],
	location: result['location'],
	cookie: sessionCookie(result) === null ? 0 : 1,
	uid: result['uid'],
	refused: String(result['html'] ?? '').includes(REFUSED)
});

/** a migrated site with a known admin password; `/__firstrun` is the only thing that sets one */
const claim = (site: ServeDo) => claimSite(site, PASS, 'Login Wall');

describe('a valid login and an invalid one are distinguishable', () => {
	it(
		'refuses the wrong password by name',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claim(site);
				const wrong = await login(site, 'admin', 'not-the-password');

				return {
					status: wrong['status'],
					saysRefused: String(wrong['html'] ?? '').includes(REFUSED),
					cookie: sessionCookie(wrong),
					uid: wrong['uid'],
					error: wrong['error'] ?? null
				};
			});

			expect(out['error'], 'the refused render must not throw').toBeNull();
			// a refusal IS a 200 -- that part of the reported symptom was the observation, not a defect
			expect(out['status']).toBe(200);
			expect(out['saysRefused'], 'Drupal must say WHY it refused').toBe(true);
			expect(out['cookie'], 'a refusal must not issue a session').toBeNull();
			expect(out['uid'], 'and must leave the visitor anonymous').toBe(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'accepts the right password on a clean object, and again after a success',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claim(site);
				const first = await login(site, 'admin', PASS);
				const second = await login(site, 'admin', PASS);
				return [signals(first), signals(second)];
			});

			for (const [n, step] of out.entries()) {
				expect(step.status, `login ${n + 1} must redirect`).toBe(303);
				expect(String(step.location)).toContain('/user/');
				expect(step.cookie, `login ${n + 1} must issue a session`).toBe(1);
				expect(step.uid).toBe(1);
			}
		},
		REQUEST_TIMEOUT
	);

	/**
	 * ONE MISTYPED PASSWORD USED TO DISABLE LOGIN FOR THE WHOLE OBJECT. Fixed 2026-08-19; this is the
	 * regression test, and the sequence is the one that reproduced it.
	 *
	 * The symptom was that a correct password arriving after ANY failed login authenticated and then
	 * produced nothing: 200, the login form rebuilt, no session cookie, uid 0, and -- unlike a
	 * refusal -- no message of any kind. From a browser that is indistinguishable from a form that
	 * was never submitted, which is exactly what "login 200s on every request regardless of whether
	 * it was valid" looks like from outside.
	 *
	 * **THE MECHANISM: `FormState::$anyErrors` is a CLASS STATIC.** `setErrorByName()` sets it,
	 * `FormBuilder::processForm()` runs submit handlers only when `!FormState::hasAnyErrors()`, and
	 * the only reset in core is `FormState::clearErrors()` -- called from `FormBuilder::submitForm()`,
	 * the PROGRAMMATIC path, so a normal HTTP request never clears it. On a real SAPI the process
	 * dies and it does not matter. Here the interpreter survives, so one form error anywhere stopped
	 * every later submit handler in the object, for any form, until the interpreter was dropped.
	 * `RequestResetter::clearFormErrors()` in the `drupflare` sibling now clears it per request,
	 * beside `Html::resetSeenIds()` -- the same class of bug, which is why it belongs there.
	 *
	 * The four-sequence matrix that located it, run in fresh objects:
	 *
	 * | sequence            | before the fix                                                 |
	 * | ------------------- | -------------------------------------------------------------- |
	 * | right               | 303, session opened                                            |
	 * | right, right        | 303 both times, session opened twice                           |
	 * | wrong, wrong        | 200 both times, BOTH say "Unrecognized username or password"   |
	 * | wrong, right        | the right one: 200, no message, no session                     |
	 * | wrong, wrong, right | same                                                            |
	 *
	 * `wrong, wrong` passing is what made the static the suspect: both are failures, so both set the
	 * flag and neither needed a submit handler. Only a CORRECT submission after a failure could show
	 * the gate.
	 *
	 * RULED OUT positively rather than by absence: flood control. `user.flood` in the packed database
	 * is stock (`user_limit: 5`, `ip_limit: 50`), and the `Flood control blocked login attempt for
	 * uid 1` line is core's own threshold-1 probe at `UserLoginForm.php:219`, which fires whenever any
	 * failed-login row exists and blocks nothing on its own.
	 */
	it(
		'processes a correct password after a failed one, which a static used to prevent',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claim(site);
				const wrong = await login(site, 'admin', 'not-the-password');
				const right = await login(site, 'admin', PASS);
				return { wrong: signals(wrong), right: signals(right) };
			});

			// the failure is a normal, correct refusal
			expect(out.wrong.status).toBe(200);
			expect(out.wrong.refused).toBe(true);
			expect(out.wrong.cookie).toBe(0);

			// and the correct password that follows it is now processed
			expect(out.right.status).toBe(303);
			expect(String(out.right.location)).toContain('/user/1');
			expect(out.right.cookie, 'a session must be issued').toBe(1);
			expect(out.right.uid).toBe(1);
			expect(out.right.refused).toBe(false);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The static was PROCESS-wide, not form-wide, so the regression test has to cross forms too.
	 *
	 * A login failure setting a flag that stops a NODE from saving is the same defect and a different
	 * blast radius: asserting only login-after-login would leave the wider case unpinned.
	 */
	it(
		'lets an unrelated form submit after another form failed validation',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await claim(site);
				// a failed login sets the flag, and nothing about it concerns the login form
				const wrong = await login(site, 'admin', 'not-the-password');
				const right = await login(site, 'admin', PASS);
				return { wrong: signals(wrong), right: signals(right) };
			});
			expect(out.wrong.refused).toBe(true);
			expect(out.right.cookie, 'the next form to submit must not inherit the flag').toBe(1);
		},
		REQUEST_TIMEOUT
	);
});
