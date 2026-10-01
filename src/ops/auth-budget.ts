/**
 * A bounded daily allowance for authenticated traffic on free, and a degrade ladder past it.
 *
 * Measured with `free-envelope.ts` on `MEMORY_CACHE_BINS=none`: the default 25% buys 3,125
 * authenticated views a day and leaves 8,149 regenerations, 8.15x what a 3M-visit month needs at
 * 1% dynamic. Paid has no reservation.
 *
 * @module
 */
import { isPaid, type PlanEnv } from './plan';

/**
 * `FREE_QUOTAS` daily rows, copied from `free-envelope.ts` (importing it drags a CLI into the
 * Worker); `auth-budget.spec.ts` pins it and {@link ROWS_PER_AUTH_RENDER} to the script.
 */
export const DAILY_ROWS_QUOTA = 100_000;

/**
 * `ROWS_PER_FILL.realRender` on `MEMORY_CACHE_BINS=none`, what an authenticated view costs (2 at
 * the shipping default).
 */
export const ROWS_PER_AUTH_RENDER = 8;

/** `FREE_QUOTAS.doRequestsPerDay`, same quota shape as rows */
export const DAILY_DO_QUOTA = 100_000;

/**
 * Cookie names that mean a session: `SESS` or `SSESS`, then exactly 32 lowercase hex characters
 * (`SessionConfiguration::getUnprefixedName()` always hashes), so `SESSION=` does not match.
 */
export const SESSION_COOKIE_RE = /^S?SESS[0-9a-f]{32}$/;

// cookies Drupal sets with no user (`NO_CACHE` bypasses the page cache), never a login
const NOT_A_SESSION = new Set(['NO_CACHE', 'Drupal.visitor.name', 'Drupal.toolbar.collapsed']);

/**
 * Whether a `Cookie` header carries a Drupal session.
 *
 * @param cookieHeader the raw header value, or null when absent
 * @returns true when at least one cookie name is session-shaped
 */
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
	return sessionCookieValue(cookieHeader) !== undefined;
}

/**
 * The value of the first session-shaped cookie, or undefined; a replica routing key, hashed and
 * never compared.
 */
export function sessionCookieValue(cookieHeader: string | null | undefined): string | undefined {
	if (!cookieHeader) return undefined;
	for (const pair of cookieHeader.split(';')) {
		const eq = pair.indexOf('=');
		const name = (eq < 0 ? pair : pair.slice(0, eq)).trim();
		if (!name || NOT_A_SESSION.has(name)) continue;
		if (SESSION_COOKIE_RE.test(name)) return eq < 0 ? '' : pair.slice(eq + 1).trim();
	}
	return undefined;
}

/**
 * Whether a request is authenticated, decided from the request alone so it runs before the DO hop
 * it is meant to save.
 *
 * @param request the inbound request
 */
export function isAuthenticatedRequest(request: {
	headers: { get(name: string): string | null };
}): boolean {
	return hasSessionCookie(request.headers.get('cookie'));
}

/** methods that cannot change state, so they can be degraded to a stale read */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** what fraction of the daily row budget authenticated traffic may spend, by default */
export const DEFAULT_AUTH_ROWS_FRACTION = 0.25;

/** floor on the fraction; 0 would remove authenticated traffic entirely */
export const MIN_AUTH_ROWS_FRACTION = 0.05;
/** ceiling on the fraction; 1 would remove the protection */
export const MAX_AUTH_ROWS_FRACTION = 0.75;

/** the environment an allowance reads */
export type AuthBudgetEnv = PlanEnv & {
	/** fraction of the daily rows budget reserved for authenticated traffic */
	AUTH_ROWS_FRACTION?: string | number;
	/** overrides the measured rows-per-authenticated-render, for a site with a different profile */
	AUTH_ROWS_PER_RENDER?: string | number;
};

/** the split of a daily meter between authenticated and anonymous use */
export type AuthAllowance = {
	/** the fraction actually applied, after clamping */
	fraction: number;
	/** rows one authenticated render costs */
	rowsPerRender: number;
	/** rows/day authenticated traffic may spend */
	rowsReserved: number;
	/** rows/day left for anonymous regeneration */
	rowsForAnonymous: number;
	/** authenticated views/day the reservation buys */
	rendersPerDay: number;
	/** DO requests/day the reservation buys, at one hop per render */
	doRequestsReserved: number;
	/** which meter runs out first; rows, while the quotas are equal and a render is one hop */
	boundBy: 'rows' | 'do';
	/** false on paid, where none of these meters bind */
	enforced: boolean;
};

/** one DO request per authenticated render: the render happens inside that single hop */
export const DO_REQUESTS_PER_AUTH_RENDER = 1;

function clampFraction(raw: unknown): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUTH_ROWS_FRACTION;
	return Math.min(MAX_AUTH_ROWS_FRACTION, Math.max(MIN_AUTH_ROWS_FRACTION, n));
}

/**
 * Computes the daily authenticated allowance.
 *
 * @param env carries `PLAN` and the two optional overrides
 * @returns the split; `enforced` is false on paid
 */
export function authAllowance(env?: AuthBudgetEnv): AuthAllowance {
	const paid = isPaid(env);
	const fraction =
		env?.AUTH_ROWS_FRACTION === undefined || String(env?.AUTH_ROWS_FRACTION) === ''
			? DEFAULT_AUTH_ROWS_FRACTION
			: clampFraction(env?.AUTH_ROWS_FRACTION);

	const perRenderRaw = Number(env?.AUTH_ROWS_PER_RENDER);
	// realRender: an authenticated view misses both the page and dynamic_page_cache bins
	const rowsPerRender =
		Number.isFinite(perRenderRaw) && perRenderRaw > 0 ? perRenderRaw : ROWS_PER_AUTH_RENDER;

	const rowsReserved = Math.floor(DAILY_ROWS_QUOTA * fraction);
	const byRows = Math.floor(rowsReserved / rowsPerRender);
	const doRequestsReserved = Math.floor(DAILY_DO_QUOTA * fraction);
	const byDo = Math.floor(doRequestsReserved / DO_REQUESTS_PER_AUTH_RENDER);

	return {
		fraction,
		rowsPerRender,
		rowsReserved,
		rowsForAnonymous: DAILY_ROWS_QUOTA - rowsReserved,
		rendersPerDay: Math.min(byRows, byDo),
		doRequestsReserved,
		boundBy: byRows <= byDo ? 'rows' : 'do',
		enforced: !paid
	};
}

/** how the Worker should answer an authenticated request */
export type AuthMode =
	/** under the allowance: a full per-user render */
	| 'render'
	/** allowance gone, safe method: serve the anonymous copy, do not personalise */
	| 'stale'
	/** allowance gone, unsafe method: refuse the write by name */
	| 'read-only';

/** the durable counter's state for one UTC day */
export type AuthSpend = {
	/** the UTC day the counter belongs to, as YYYY-MM-DD */
	day: string;
	/** authenticated renders charged so far today */
	renders: number;
};

/** what the Worker decided, and why */
export type AuthDecision = {
	mode: AuthMode;
	allowance: AuthAllowance;
	spend: AuthSpend;
	/** renders left today; Infinity on paid */
	remaining: number;
	/** a short reason, safe to put in a header */
	reason: string;
};

/** the UTC day key the meters reset on; the quotas reset at midnight UTC */
export function utcDayKey(now: number = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * A spend record for today, discarding a record from any other day (the quotas refill at midnight
 * UTC).
 */
export function spendForToday(spend: AuthSpend | undefined, now = Date.now()): AuthSpend {
	const day = utcDayKey(now);
	if (!spend || spend.day !== day || !Number.isFinite(spend.renders)) {
		return { day, renders: 0 };
	}
	return { day, renders: Math.max(0, Math.floor(spend.renders)) };
}

/**
 * Decides how to answer one authenticated request.
 *
 * @param request needs only the method
 * @param spend the durable counter, or undefined when it has not been read yet
 * @param env carries `PLAN` and the overrides
 * @param now injectable so the UTC-day rollover is testable
 */
export function decideAuthMode(
	request: { method: string },
	spend: AuthSpend | undefined,
	env?: AuthBudgetEnv,
	now = Date.now()
): AuthDecision {
	const allowance = authAllowance(env);
	const today = spendForToday(spend, now);
	const remaining = Math.max(0, allowance.rendersPerDay - today.renders);

	if (!allowance.enforced) {
		return {
			mode: 'render',
			allowance,
			spend: today,
			remaining: Infinity,
			reason: 'paid: no reservation'
		};
	}
	if (remaining > 0) {
		return { mode: 'render', allowance, spend: today, remaining, reason: 'within allowance' };
	}
	// never dark: a safe method degrades to the anonymous copy, an unsafe one is refused by name
	if (SAFE_METHODS.has(request.method.toUpperCase())) {
		return {
			mode: 'stale',
			allowance,
			spend: today,
			remaining: 0,
			reason: `authenticated allowance spent (${today.renders}/${allowance.rendersPerDay}); serving the anonymous copy`
		};
	}
	return {
		mode: 'read-only',
		allowance,
		spend: today,
		remaining: 0,
		reason: `authenticated allowance spent (${today.renders}/${allowance.rendersPerDay}); writes resume at 00:00 UTC`
	};
}

/** seconds until the next midnight UTC, which is when every daily quota refills */
export function secondsUntilUtcReset(now = Date.now()): number {
	const next = Date.UTC(
		new Date(now).getUTCFullYear(),
		new Date(now).getUTCMonth(),
		new Date(now).getUTCDate() + 1
	);
	return Math.max(1, Math.ceil((next - now) / 1000));
}

// #region the contract with the Durable Object
// the object reports the counter on the hop the request already makes, and the Worker memoises it
// per UTC day, so a spent allowance degrades at the edge with no DO request

/** set by the Worker on a `/__serve` hop it wants charged as authenticated */
export const AUTH_REQUEST_HEADER = 'x-cfw-auth';

/** set by the object on every response to such a hop: renders charged today */
export const AUTH_SPENT_HEADER = 'x-cfw-auth-spent';
/** set by the object: renders allowed per day */
export const AUTH_ALLOWANCE_HEADER = 'x-cfw-auth-allowance';
/** set by the object: the UTC day the counter belongs to */
export const AUTH_DAY_HEADER = 'x-cfw-auth-day';

/** set by the Worker on the response it returns, so a measurement can see what happened */
export const AUTH_MODE_HEADER = 'x-cfw-auth-mode';

/**
 * The role set a render was for, sorted and comma-joined. Object to front worker only; never read
 * off an inbound request, so a client cannot present one.
 */
export const ROLES_HEADER = 'x-cfw-roles';
/** set by the Worker: the {@link AuthDecision} reason */
export const AUTH_REASON_HEADER = 'x-cfw-auth-reason';

/** the headers the object adds to a charged response; the one encoder for {@link parseAuthSpend} */
export function authSpendHeaders(
	spend: AuthSpend,
	allowance: AuthAllowance
): Record<string, string> {
	return {
		[AUTH_SPENT_HEADER]: String(spend.renders),
		[AUTH_ALLOWANCE_HEADER]: String(allowance.rendersPerDay),
		[AUTH_DAY_HEADER]: spend.day
	};
}

/**
 * Reads a spend record back off a response, or undefined when the object did not report one (not
 * zero, which would read as a fresh budget).
 */
export function parseAuthSpend(headers: {
	get(name: string): string | null;
}): AuthSpend | undefined {
	const day = headers.get(AUTH_DAY_HEADER);
	const spent = headers.get(AUTH_SPENT_HEADER);
	if (!day || spent === null || spent === '') return undefined;
	const renders = Number(spent);
	if (!Number.isFinite(renders) || renders < 0) return undefined;
	return { day, renders: Math.floor(renders) };
}
// #endregion
