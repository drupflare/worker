/**
 * The browser's way of presenting the owner token.
 *
 * A page cannot set an `Authorization` header on its own navigation, so the cookie carries the
 * token itself (no session id, which would need its own row and expiry). `HttpOnly` keeps it away
 * from page script.
 * @module
 */

/** not session-shaped, so `hasSessionCookie()` never reads it as a Drupal login */
export const ADMIN_COOKIE = 'cfw_admin';

/** a working day; an operator who leaves a tab open overnight signs in again */
export const ADMIN_SESSION_MAX_AGE_S = 43_200;

/** the token a browser presented, or undefined */
export function adminCookieToken(cookieHeader: string | null | undefined): string | undefined {
	if (!cookieHeader) return undefined;
	for (const pair of cookieHeader.split(';')) {
		const eq = pair.indexOf('=');
		if (eq < 0) continue;
		if (pair.slice(0, eq).trim() !== ADMIN_COOKIE) continue;
		const value = pair.slice(eq + 1).trim();
		return value === '' ? undefined : decodeURIComponent(value);
	}
	return undefined;
}

/**
 * The `Set-Cookie` line that signs an operator in.
 *
 * `SameSite=Strict` is the CSRF defence: several owner routes act on a GET, so a cross-site
 * navigation carrying the cookie could install a module. Strict sends it on no cross-site request,
 * top-level links included.
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
 * Guessing the token is not the threat (32 CSPRNG bytes, constant-time compare); the unbounded cost
 * is: each presented token costs a `/__ownercheck` object request, the meter the free plan is
 * scored against. 12 rather than 3 so a stale cookie in an open tab does not lock its owner out.
 */
export const OWNER_FAIL_LIMIT = 12;

/** how long a client stays refused after exhausting the budget */
export const OWNER_FAIL_WINDOW_MS = 60_000;

/**
 * Per isolate, deliberately: a durable counter needs a row per attempt, which spends the meter this
 * protects. It does not stop a distributed attacker; it removes the amplification.
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
	// bounded because the key is attacker-supplied (a rotating IP would grow the map without limit)
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
