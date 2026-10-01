import {
	adminCookieToken,
	clearOwnerFailures,
	noteOwnerFailure,
	ownerFailKey,
	ownerRefusedForNow
} from '../ops/admin-session';
import { resolveSite, siteStubOptions } from '../ops/site-id';
import { bearerToken } from '../ops/site-secrets';
import { PUBLIC_ROUTES } from './routes';
import type { SiteWorkerEnv } from './types';

/**
 * Which object answers, with `?site=` refused on routes that take no credential.
 *
 * `/serve` is in `PUBLIC_ROUTES`, so the catch-all's refusal does not cover it: an unauthenticated
 * `GET /serve?site=<unused name>` would provision a whole Drupal database, and another tenant's
 * name would serve their pages. An owner route may name a site (the object validates the token) and
 * so may a diagnostic route (dev and the measurement scripts).
 */
export async function siteFor(url: URL, env: SiteWorkerEnv): Promise<string> {
	const uncredentialed = PUBLIC_ROUTES.has(url.pathname) && env?.PW_DIAGNOSTICS !== '1';
	const { site } = await resolveSite(url, env, { allowParam: !uncredentialed });
	return site;
}

/**
 * The owner token this request proved, or undefined.
 *
 * The token lives in the object's `cfw_meta`, so the check costs one DO request and runs only for
 * a matched route that needs it. A browser presents it as a cookie (a navigation cannot set a
 * header); everything else as a bearer.
 */
export async function ownerCredential(
	request: Request,
	env: SiteWorkerEnv,
	url: URL
): Promise<string | undefined> {
	const presented =
		bearerToken(request.headers.get('authorization')) ??
		adminCookieToken(request.headers.get('cookie'));
	if (!presented) return undefined;

	// before the hop: each presented token cost a DO request, so an anonymous client could drive
	// the free meter to read-only (not a brute-force defence, see `OWNER_FAIL_LIMIT`)
	const failKey = ownerFailKey(request);
	const now = Date.now();
	if (ownerRefusedForNow(failKey, now)) return undefined;

	const site = await siteFor(url, env);
	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const inner = new URL(url);
	inner.pathname = '/__ownercheck';
	try {
		const res = await stub.fetch(
			new Request(inner, { headers: { authorization: `Bearer ${presented}` } })
		);
		if (res.status === 200) {
			// a correct token clears the budget (an earlier typo must not hold back the operator)
			clearOwnerFailures(failKey);
			return presented;
		}
		noteOwnerFailure(failKey, now);
		return undefined;
	} catch {
		// no answer is not a yes, nor a counted failure (that would lock the owner out of the
		// routes needed to repair an unreachable object)
		return undefined;
	}
}

/**
 * Restates a cookie-borne token as a header for the object.
 *
 * `/__git` and `/__firstrun?force=1` re-check the token where the secret lives and read a header,
 * so a cookie-only request needs one attached.
 */
export function withOwnerHeader(request: Request, token: string): Request {
	if (request.headers.has('authorization')) return request;
	// an inbound request's headers are immutable; a constructed one's are not
	const copy = new Request(request);
	copy.headers.set('authorization', `Bearer ${token}`);
	return copy;
}
