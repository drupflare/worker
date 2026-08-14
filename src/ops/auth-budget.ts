import { isPaid, type PlanEnv } from './plan.js';

/**
 * A bounded daily allowance for AUTHENTICATED traffic, and a degrade ladder for past it.
 *
 * MEASURED WITH `bun scripts/measure/free-envelope.ts --visits=3000000 --dynamic=0.01`, and every
 * number below is from that run rather than from arithmetic done here:
 *
 * | ceiling                      | value                              |
 * | ---------------------------- | ---------------------------------- |
 * | serving                      | 100,000/day, worker-bound, **1.00x** |
 * | regeneration, windowed       | **7,575/day, rows-bound**          |
 * | regeneration, alarm chain    | 1,052/day, do-bound                |
 *
 * At the default 25% reservation that splits as:
 *
 * | slice                        | rows/day | what it buys                              |
 * | ---------------------------- | -------- | ----------------------------------------- |
 * | authenticated                | 25,000   | **1,923 authenticated views/day**         |
 * | anonymous regeneration       | 75,000   | **5,681 regenerations/day** (5.68x need)  |
 *
 * The anonymous side still clears the 1,000 regenerations/day a 3M-visit month needs at 1% dynamic,
 * with 5.68x headroom, which is the property that makes the reservation safe to take.
 *
 * PAID HAS NO RESERVATION. The meters it is protecting do not bind there, and a limit that exists
 * only to be never reached is a limit a reader has to explain later.
 */

/**
 * The two figures from `scripts/measure/free-envelope.ts` this module needs.
 *
 * COPIED RATHER THAN IMPORTED, and the reason is the bundle: `free-envelope.ts` carries an
 * `import.meta.main` CLI block that reads `process.argv`, so importing it here would drag a script
 * into the Worker. Copying a measured number is the drift hazard this project has been bitten by
 * twice, so it is pinned instead: `tests/unit/auth-budget.spec.ts` asserts both against the script's
 * own exports, and the spec fails the moment either moves.
 */
export const DAILY_ROWS_QUOTA = 100_000;

/** `ROWS_PER_FILL.realRender`; both cache bins empty, which is what an authenticated view costs */
export const ROWS_PER_AUTH_RENDER = 13;

/** `FREE_QUOTAS.doRequestsPerDay`, same quota shape as rows */
export const DAILY_DO_QUOTA = 100_000;

/**
 * Cookies that mean "this request belongs to a session".
 *
 * `SESS` over HTTP and `SSESS` over HTTPS, then **exactly 32 lowercase hex characters**.
 *
 * READ OFF THE SOURCE, and the first version of this was written from memory and was wrong in a way
 * that mattered. `SessionConfiguration::getName()` is
 * `($request->isSecure() ? 'SSESS' : 'SESS') . $this->getUnprefixedName($request)`
 * (`drupal-src/core/lib/Drupal/Core/Session/SessionConfiguration.php:79`), and
 * `getUnprefixedName()` ends `return substr(hash('sha256', $session_name), 0, 32);` at line 109 --
 * **outside** its if/elseif/else, so all three branches hash. The test-user-agent branch and the
 * `cookie_domain` branch produce 32 hex characters too. There is no unhashed form to be lenient
 * about.
 *
 * The loose pattern that assumed otherwise matched `SESSION=`, which is a common cookie name in
 * other frameworks. Every request carrying one would have been charged as authenticated and
 * rendered, which destroys the allowance this module exists to enforce rather than protecting it.
 *
 * The safety argument that motivated the looseness is real but belongs elsewhere: an authenticated
 * response must never reach the shared anonymous cache -- this project shipped that once, a render
 * that kept uid 1 landing in the anonymous page cache at 90,038 bytes against 12,296. That is
 * enforced STRUCTURALLY in `src/site.ts`, which refuses to cache when the request was authenticated
 * or the response carries `Set-Cookie`, so it does not depend on this pattern being perfect.
 */
export const SESSION_COOKIE_RE = /^S?SESS[0-9a-f]{32}$/;

/**
 * Cookie names that look session-shaped but are NOT a login.
 *
 * `NO_CACHE` is set by Drupal to bypass the page cache without there being a user, and treating it
 * as authenticated would charge the allowance for anonymous traffic.
 */
const NOT_A_SESSION = new Set(['NO_CACHE', 'Drupal.visitor.name', 'Drupal.toolbar.collapsed']);

/**
 * Whether a `Cookie` header carries a Drupal session.
 *
 * @param cookieHeader the raw header value, or null when absent
 * @returns true when at least one cookie name is session-shaped
 */
export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
	if (!cookieHeader) return false;
	for (const pair of cookieHeader.split(';')) {
		const name = pair.split('=')[0]?.trim();
		if (!name || NOT_A_SESSION.has(name)) continue;
		if (SESSION_COOKIE_RE.test(name)) return true;
	}
	return false;
}

/**
 * Whether a request is authenticated, decided from the request alone.
 *
 * MUST BE DECIDED BEFORE ANY DO HOP. The reservation exists to stop authenticated traffic reaching
 * the object once the allowance is gone; a check made inside the object has already spent the DO
 * request it was meant to protect.
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

/** floor and ceiling on the fraction; 0 would delete the capability, 1 would delete the protection */
export const MIN_AUTH_ROWS_FRACTION = 0.05;
export const MAX_AUTH_ROWS_FRACTION = 0.75;

/** the environment an allowance reads */
export type AuthBudgetEnv = PlanEnv & {
	/** fraction of the daily rows budget reserved for authenticated traffic */
	AUTH_ROWS_FRACTION?: string | number | null;
	/** overrides the measured rows-per-authenticated-render, for a site with a different profile */
	AUTH_ROWS_PER_RENDER?: string | number | null;
};

/** the split of a daily meter between authenticated and anonymous use */
export type AuthAllowance = {
	/** the fraction actually applied, after clamping */
	fraction: number;
	rowsPerRender: number;
	/** rows/day authenticated traffic may spend */
	rowsReserved: number;
	/** rows/day left for anonymous regeneration */
	rowsForAnonymous: number;
	/** authenticated views/day the reservation buys */
	rendersPerDay: number;
	/** DO requests/day the reservation buys, at one hop per render */
	doRequestsReserved: number;
	/** which meter runs out first inside the reservation */
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
export function authAllowance(env?: AuthBudgetEnv | null): AuthAllowance {
	const paid = isPaid(env);
	const fraction =
		env?.AUTH_ROWS_FRACTION === undefined ||
		env?.AUTH_ROWS_FRACTION === null ||
		String(env?.AUTH_ROWS_FRACTION) === ''
			? DEFAULT_AUTH_ROWS_FRACTION
			: clampFraction(env?.AUTH_ROWS_FRACTION);

	const perRenderRaw = Number(env?.AUTH_ROWS_PER_RENDER);
	// realRender, not warmReassemble: an authenticated view empties both the page and the
	// dynamic_page_cache bins for that user, which is what a real render costs
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
	remaining: number;
	/** a short reason, safe to put in a header */
	reason: string;
};

/** the UTC day key the meters reset on; the quotas reset at midnight UTC */
export function utcDayKey(now: number = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * A spend record for today, discarding a record from any other day.
 *
 * The quotas reset at midnight UTC, so a counter carried across that boundary would refuse traffic
 * against a budget that has already been refilled.
 */
export function spendForToday(spend: AuthSpend | null | undefined, now = Date.now()): AuthSpend {
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
 * @param spend the durable counter, or null when it has not been read yet
 * @param env carries `PLAN` and the overrides
 * @param now injectable so the UTC-day rollover is testable
 */
export function decideAuthMode(
	request: { method: string },
	spend: AuthSpend | null | undefined,
	env?: AuthBudgetEnv | null,
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
//
// The counter needs durable state, which only the object has. Rather than the Worker asking for it
// -- a DO request spent to decide whether to spend a DO request -- the object reports it on the
// response to the hop the request was making anyway, exactly as the generation pointer already does.
// The Worker memoises that per UTC day, so once the allowance is gone it degrades at the edge with
// ZERO DO cost, which is the only version of this that actually protects the meter.

/** set by the Worker on a `/__serve` hop it wants charged as authenticated */
export const AUTH_REQUEST_HEADER = 'x-cfw-auth';

/** set by the object on every response to such a hop */
export const AUTH_SPENT_HEADER = 'x-cfw-auth-spent';
export const AUTH_ALLOWANCE_HEADER = 'x-cfw-auth-allowance';
export const AUTH_DAY_HEADER = 'x-cfw-auth-day';

/** set by the Worker on the response it returns, so a measurement can see what happened */
export const AUTH_MODE_HEADER = 'x-cfw-auth-mode';
export const AUTH_REASON_HEADER = 'x-cfw-auth-reason';

/**
 * Headers the object should add to a charged response.
 *
 * Exported so the object's hunk calls this rather than formatting the same three headers itself; one
 * codec, two callers, no drift.
 */
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
 * Reads a spend record back off a response, or null when the object did not report one.
 *
 * Null rather than a zeroed record on purpose: "the object did not say" and "the object said zero"
 * lead to different decisions, and collapsing them is how a missing header reads as a fresh budget.
 */
export function parseAuthSpend(headers: { get(name: string): string | null }): AuthSpend | null {
	const day = headers.get(AUTH_DAY_HEADER);
	const spent = headers.get(AUTH_SPENT_HEADER);
	if (!day || spent === null || spent === '') return null;
	const renders = Number(spent);
	if (!Number.isFinite(renders) || renders < 0) return null;
	return { day, renders: Math.floor(renders) };
}
// #endregion
