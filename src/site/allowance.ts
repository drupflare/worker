import {
	AUTH_MODE_HEADER,
	AUTH_REASON_HEADER,
	authAllowance,
	decideAuthMode,
	isAuthenticatedRequest,
	secondsUntilUtcReset,
	type AuthBudgetEnv
} from '../ops/auth-budget';
import { readAuthSpend } from './memos';
import type { AuthState, FrontContext } from './types';

/** Decides the authenticated allowance before any object hop; a spent write answers 503. */
export async function decideAllowance(
	f: FrontContext,
	neverDrupal: boolean
): Promise<Response | AuthState> {
	const { request, env, url, t0, cache, origin, site } = f;
	// #region the authenticated allowance, decided before any DO hop
	// an authenticated page is per-user, so every one is a full render (13 rows, ~500 ms); a check
	// after the hop has already spent the DO request it protects
	const authenticated = neverDrupal ? false : isAuthenticatedRequest(request);
	let authMode: 'render' | 'stale' | 'read-only' = 'render';
	let authReason = '';
	// enforced on free only (reading the counter on paid cost a 9.5 ms `cache.match` per isolate);
	// lazy and memoised because both readers sit behind a check anonymous requests fail
	let enforcedMemo: boolean | undefined;
	const enforcedOf = (): boolean =>
		(enforcedMemo ??= authAllowance(env as AuthBudgetEnv).enforced);
	if (authenticated && url.pathname === '/serve') {
		const spend = enforcedOf() ? await readAuthSpend(cache, origin, site, t0) : undefined;
		const decision = decideAuthMode(request, spend, env as AuthBudgetEnv, t0);
		authMode = decision.mode;
		authReason = decision.reason;

		// never dark: a spent write is refused by name, a spent read falls through as anonymous
		if (authMode === 'read-only') {
			return new Response(`${authReason}\n`, {
				status: 503,
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					// the quotas refill at midnight UTC, so that is the retry time
					'retry-after': String(secondsUntilUtcReset(t0)),
					'cache-control': 'private, no-store',
					[AUTH_MODE_HEADER]: authMode,
					[AUTH_REASON_HEADER]: authReason,
					'x-worker-ms': String(Date.now() - t0)
				}
			});
		}
	}
	// in stale mode the request is served as anonymous (shared tiers, nothing personalised)
	const personalised = authenticated && authMode === 'render';
	// #endregion
	return { authenticated, mode: authMode, reason: authReason, personalised, enforcedOf };
}
