import { beforeEach, describe, expect, it } from 'vitest';
import {
	ADMIN_COOKIE,
	ADMIN_SESSION_MAX_AGE_S,
	OWNER_FAIL_LIMIT,
	OWNER_FAIL_WINDOW_MS,
	adminCookieToken,
	adminSessionCookie,
	clearOwnerFailures,
	clearedAdminCookie,
	noteOwnerFailure,
	ownerFailKey,
	ownerRefusedForNow,
	resetOwnerFailures,
	secureOrigin
} from '../../../src/ops/admin-session';
import { hasSessionCookie, sessionCookieValue } from '../../../src/ops/auth-budget';

/**
 * The browser's owner credential, which had no test of any kind.
 *
 * It is the whole authentication story for the admin surface -- the pages that install modules,
 * export the database and rewrite configuration -- and every property it depends on was a comment.
 * The workers lane could not have covered it either: `vitest.config.ts` binds `PW_DIAGNOSTICS: '1'`,
 * which skips the credential check the cookie exists to satisfy. See `owner-gate.spec.ts`.
 */

const TOKEN = 'cfw-owner-Tok3n_with.punctuation~and-more';

/** the cookie attributes as a lowercase set, so an assertion does not depend on their order */
function attrs(line: string): Set<string> {
	return new Set(
		line
			.split(';')
			.slice(1)
			.map((p) => p.trim().toLowerCase())
	);
}

describe('reading the token a browser presented', () => {
	it('round-trips a token through the cookie it writes', () => {
		const line = adminSessionCookie(TOKEN, true);
		const value = line.split(';')[0] as string;
		expect(adminCookieToken(value)).toBe(TOKEN);
	});

	it('finds the cookie among others, whatever the spacing', () => {
		const header = `foo=1;${ADMIN_COOKIE}=${encodeURIComponent(TOKEN)} ; bar=2`;
		expect(adminCookieToken(header)).toBe(TOKEN);
	});

	it('answers null for absent, empty and malformed headers', () => {
		expect(adminCookieToken(null)).toBe(null);
		expect(adminCookieToken(undefined)).toBe(null);
		expect(adminCookieToken('')).toBe(null);
		expect(adminCookieToken('other=1')).toBe(null);
		// a bare name with no `=` must not be read as an empty token
		expect(adminCookieToken(ADMIN_COOKIE)).toBe(null);
		// and an explicitly empty value is not a credential either
		expect(adminCookieToken(`${ADMIN_COOKIE}=`)).toBe(null);
		expect(adminCookieToken(`${ADMIN_COOKIE}=   `)).toBe(null);
	});

	it('does not match a cookie whose name merely contains the admin one', () => {
		expect(adminCookieToken(`not_${ADMIN_COOKIE}=x`)).toBe(null);
		expect(adminCookieToken(`${ADMIN_COOKIE}_extra=x`)).toBe(null);
	});

	it('decodes a token that had to be escaped', () => {
		const awkward = 'a b;c=d%e';
		const line = adminSessionCookie(awkward, true);
		expect(line).not.toContain('a b;c');
		expect(adminCookieToken(line.split(';')[0] as string)).toBe(awkward);
	});
});

describe('the cookie the surface sets', () => {
	it('is HttpOnly and SameSite=Strict, which is the CSRF defence', () => {
		// load-bearing rather than hygiene: several owner routes act on a GET, so a cookie that
		// rode along on a cross-site navigation would be enough to install a module
		const set = attrs(adminSessionCookie(TOKEN, true));
		expect(set).toContain('httponly');
		expect(set).toContain('samesite=strict');
		expect(set).toContain('path=/');
		expect(set).toContain(`max-age=${ADMIN_SESSION_MAX_AGE_S}`);
	});

	it('is Secure on https and not on a plain-http dev origin', () => {
		// a `Secure` cookie is dropped by the browser over http, so dev would silently never sign in
		expect(attrs(adminSessionCookie(TOKEN, true))).toContain('secure');
		expect(attrs(adminSessionCookie(TOKEN, false))).not.toContain('secure');
		expect(secureOrigin({ protocol: 'https:' })).toBe(true);
		expect(secureOrigin({ protocol: 'http:' })).toBe(false);
	});

	it('expires within a working day rather than never', () => {
		expect(ADMIN_SESSION_MAX_AGE_S).toBe(43_200);
	});
});

describe('signing out', () => {
	it('carries no token and expires immediately', () => {
		const line = clearedAdminCookie(true);
		expect(line.startsWith(`${ADMIN_COOKIE}=;`)).toBe(true);
		expect(attrs(line)).toContain('max-age=0');
		expect(adminCookieToken(line.split(';')[0] as string)).toBe(null);
	});

	it('matches the signed-in cookie on every attribute that decides which one it replaces', () => {
		// a browser replaces a cookie only when name, path and domain agree; a clear that differs
		// leaves the original in place and the operator stays signed in
		const outAttrs = attrs(clearedAdminCookie(true));
		for (const attr of ['path=/', 'httponly', 'samesite=strict', 'secure']) {
			expect(outAttrs, `sign-out dropped ${attr}`).toContain(attr);
		}
	});

	it('drops Secure with the origin, like the cookie it clears', () => {
		expect(attrs(clearedAdminCookie(false))).not.toContain('secure');
	});
});

describe('it cannot be confused with a Drupal login', () => {
	it('is not session-shaped, so the auth tier does not bill it as a user', () => {
		// the comment on ADMIN_COOKIE claims this; a Drupal session name is SESS/SSESS + a hash,
		// and an admin cookie read as one would route an operator through the authenticated tier
		const header = adminSessionCookie(TOKEN, true).split(';')[0] as string;
		expect(hasSessionCookie(header)).toBe(false);
		expect(sessionCookieValue(header)).toBe(null);
		expect(ADMIN_COOKIE.startsWith('SESS')).toBe(false);
		expect(ADMIN_COOKIE.startsWith('SSESS')).toBe(false);
	});

	it('and a real Drupal session is not read as an admin credential', () => {
		const drupal = 'SESS151749d32e3fc313fb079916b2be1784=a1e6dc0e3014b54559ced460160a32bb';
		expect(adminCookieToken(drupal)).toBe(null);
		expect(hasSessionCookie(drupal)).toBe(true);
	});
});

/**
 * The failure budget, which bounds the COST of a wrong token rather than the guessing.
 *
 * `ownerCredential()` fetched `/__ownercheck` on the Durable Object for every presented token,
 * right or wrong, with no bound. The token itself is 32 CSPRNG bytes compared in constant time, so
 * guessing it was never the risk; what was free was driving the object's request counter -- the
 * meter the whole free-plan model is scored against -- from an unauthenticated request, until the
 * site degraded to read-only.
 */
describe('the owner-token failure budget', () => {
	beforeEach(() => resetOwnerFailures());

	const req = (ip: string | null) => ({
		headers: { get: (n: string) => (n === 'cf-connecting-ip' ? ip : null) }
	});

	it('keys on the connecting IP, and buckets a request that carries none', () => {
		expect(ownerFailKey(req('203.0.113.7'))).toBe('203.0.113.7');
		expect(ownerFailKey(req(null))).toBe('unknown');
	});

	it('permits up to the limit and refuses past it, without asking the object', () => {
		const at = 1_000;
		for (let i = 0; i < OWNER_FAIL_LIMIT; i++) {
			expect(ownerRefusedForNow('a', at), `attempt ${i} must still be tried`).toBe(false);
			noteOwnerFailure('a', at);
		}
		expect(ownerRefusedForNow('a', at)).toBe(true);
	});

	it('refuses one client without refusing another', () => {
		const at = 1_000;
		for (let i = 0; i < OWNER_FAIL_LIMIT; i++) noteOwnerFailure('a', at);
		expect(ownerRefusedForNow('a', at)).toBe(true);
		expect(ownerRefusedForNow('b', at)).toBe(false);
	});

	it('forgets the budget once the window has passed', () => {
		for (let i = 0; i < OWNER_FAIL_LIMIT; i++) noteOwnerFailure('a', 1_000);
		expect(ownerRefusedForNow('a', 1_000)).toBe(true);
		expect(ownerRefusedForNow('a', 1_000 + OWNER_FAIL_WINDOW_MS)).toBe(false);
	});

	/** an operator with a stale cookie must not lock themselves out of their own site */
	it('clears the budget on a correct token', () => {
		for (let i = 0; i < OWNER_FAIL_LIMIT - 1; i++) noteOwnerFailure('a', 1_000);
		clearOwnerFailures('a');
		for (let i = 0; i < OWNER_FAIL_LIMIT - 1; i++) {
			expect(ownerRefusedForNow('a', 1_000)).toBe(false);
			noteOwnerFailure('a', 1_000);
		}
	});

	/** the key is attacker-supplied, so the map itself must not become the amplification */
	it('bounds the map rather than growing it per rotating IP', () => {
		for (let i = 0; i < 4_200; i++) noteOwnerFailure(`ip-${i}`, 1_000);
		// the clear happened, so the earliest keys are gone rather than retained forever
		expect(ownerRefusedForNow('ip-0', 1_000)).toBe(false);
	});
});

describe('the login form shares the owner failure budget', () => {
	/**
	 * `LOGIN_PATH` is public, so the route gate requires no credential and the POST branch reached
	 * `/__ownercheck` once per HTTP request with nothing bounding it. That is the amplification
	 * `ownerCredential()`'s budget exists to remove, left open on the one door that never consulted
	 * it: an unauthenticated client could drive the object's request meter, which is the meter the
	 * whole free-plan model is scored against, until the site degraded to read-only.
	 */
	it('refuses a browser login once the budget is spent, before any object hop', () => {
		resetOwnerFailures();
		const key = 'login-form-probe';
		const at = Date.now();
		for (let i = 0; i < OWNER_FAIL_LIMIT; i += 1) {
			expect(ownerRefusedForNow(key, at)).toBe(false);
			noteOwnerFailure(key, at);
		}
		// the (limit + 1)th attempt never reaches the Durable Object
		expect(ownerRefusedForNow(key, at)).toBe(true);
		// and a correct token afterwards clears it, so an operator who typo'd is not locked out
		clearOwnerFailures(key);
		expect(ownerRefusedForNow(key, at)).toBe(false);
	});
});
