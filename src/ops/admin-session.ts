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

// #region the failure budget

/**
 * How many wrong tokens one client may present before it is refused without an object hop.
 *
 * **THE THREAT IS THE METER, NOT THE TOKEN.** The owner token is 32 CSPRNG bytes and
 * `tokenMatches()` is constant-time over its full width, so guessing it is not a practical attack
 * and this is not a brute-force defence. What was unbounded is the COST of guessing:
 * `ownerCredential()` resolves the site and fetches `/__ownercheck` on the Durable Object for every
 * presented token, so an unauthenticated client could drive the object's request counter -- the
 * meter the whole free-plan model is scored against -- at one request per HTTP request, for free,
 * until the site degraded to read-only.
 *
 * 12 rather than 3, because an operator with a stale cookie in an open tab should not lock
 * themselves out of their own site: every navigation presents the same wrong token, and the window
 * below is what clears it.
 */
export const OWNER_FAIL_LIMIT = 12;

/** how long a client stays refused after exhausting the budget */
export const OWNER_FAIL_WINDOW_MS = 60_000;

/**
 * Per isolate, deliberately.
 *
 * A durable counter would need a row per attempt, which spends the meter this exists to protect --
 * the same self-defeating shape as the daily counters that were most of what they counted. An
 * isolate-local bound does not stop a distributed attacker and is not meant to; it removes the
 * amplification, which is the part that was free.
 */
const failures = new Map<string, { count: number; first: number }>();

/** drops the budget; tests use it, and so does an isolate that has been idle */
export function resetOwnerFailures(): void {
	failures.clear();
}

/** how the budget identifies a client; the connecting IP, or one bucket when there is none */
export function ownerFailKey(request: { headers: { get(name: string): string | null } }): string {
	return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

/** whether this client has spent its budget and must be refused before the object is asked */
export function ownerRefusedForNow(key: string, nowMs: number): boolean {
	const held = failures.get(key);
	if (!held) return false;
	if (nowMs - held.first >= OWNER_FAIL_WINDOW_MS) {
		failures.delete(key);
		return false;
	}
	return held.count >= OWNER_FAIL_LIMIT;
}

/** records one refused credential; returns how many this client has spent */
export function noteOwnerFailure(key: string, nowMs: number): number {
	// bounded, because the key is attacker-supplied: a rotating IP would otherwise grow this map
	// without limit inside one isolate, which is a second amplification through the same door
	if (failures.size > 4096) failures.clear();
	const held = failures.get(key);
	if (!held || nowMs - held.first >= OWNER_FAIL_WINDOW_MS) {
		failures.set(key, { count: 1, first: nowMs });
		return 1;
	}
	held.count += 1;
	return held.count;
}

/** a success clears the budget, so a correct token is never held back by an earlier typo */
export function clearOwnerFailures(key: string): void {
	failures.delete(key);
}

// #endregion
