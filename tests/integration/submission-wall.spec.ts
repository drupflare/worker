import { describe, expect, it } from 'vitest';
import { submissionProbe } from '../../src/drupal/site-php';
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
