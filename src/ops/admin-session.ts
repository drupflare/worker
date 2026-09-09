/**
 * The browser's way of presenting the owner token.
 *
 * A page cannot set an `Authorization` header on its own navigation, so the admin surface had two
 * states and both were wrong: behind `PW_DIAGNOSTICS` it was reachable by anybody who could reach
 * the worker, and without it every button called `window.prompt()` and pasted the token again. The
 * Access page's Configure form could not work in either state, because a plain HTML POST has nowhere
 * to put a bearer token.
 *
 * The cookie carries the token itself rather than a session id derived from it. A session id would
 * need its own row and its own expiry in the object; the token already exists, already has a
 * constant-time comparison, and is checked on exactly the hop that a session id would have cost.
 * `HttpOnly` keeps it out of reach of page script, which is stronger than the prompt it replaces.
 */

/** not session-shaped, so `hasSessionCookie()` never reads it as a Drupal login */
export const ADMIN_COOKIE = 'cfw_admin';

/** a working day; an operator who leaves a tab open overnight signs in again */
export const ADMIN_SESSION_MAX_AGE_S = 43_200;

/** the token a browser presented, or null */
export function adminCookieToken(cookieHeader: string | null | undefined): string | null {
	if (!cookieHeader) return null;
	for (const pair of cookieHeader.split(';')) {
		const eq = pair.indexOf('=');
		if (eq < 0) continue;
		if (pair.slice(0, eq).trim() !== ADMIN_COOKIE) continue;
		const value = pair.slice(eq + 1).trim();
		return value === '' ? null : decodeURIComponent(value);
	}
	return null;
}

/**
 * The `Set-Cookie` line that signs an operator in.
 *
 * `SameSite=Strict` is the CSRF defence and it is load-bearing: several owner routes act on a GET,
 * so a cross-site navigation carrying this cookie would be enough to install a module. Strict means
 * no cross-site request carries it at all, including a top-level link.
 *
 * @param secure false only for a plain-http local dev origin, where a `Secure` cookie is dropped
 */
export function adminSessionCookie(token: string, secure: boolean): string {
	const parts = [
		`${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Strict',
		`Max-Age=${ADMIN_SESSION_MAX_AGE_S}`
	];
	if (secure) parts.push('Secure');
	return parts.join('; ');
}

/** the same cookie with an expiry in the past, which is the only way to remove one */
export function clearedAdminCookie(secure: boolean): string {
	const parts = [`${ADMIN_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
	if (secure) parts.push('Secure');
	return parts.join('; ');
}

/** whether the origin that served this page can hold a `Secure` cookie */
export function secureOrigin(url: { protocol: string }): boolean {
	return url.protocol === 'https:';
}
