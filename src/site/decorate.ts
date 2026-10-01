import { AUTH_MODE_HEADER, AUTH_REASON_HEADER } from '../ops/auth-budget';
import { REPLICA_HEADER } from '../ops/replica-routing';
import type { AuthState, FrontContext, Hop, Learned, StoreOutcome } from './types';

/** The facts the response headers report about how a request was answered. */
export interface ReplyFacts {
	auth: AuthState;
	hop: Hop;
	learned: Learned;
	stored: StoreOutcome;
	planTier: string;
}

/** Streams the object's body back with the tier, plan, lane and timing headers. */
export function decorateReply(f: FrontContext, facts: ReplyFacts): Response {
	const { t0, serving, laneOf } = f;
	const { authenticated, mode: authMode, reason: authReason } = facts.auth;
	const { res, failedOverFrom, failoverReason } = facts.hop;
	const { armedFill, doCache } = facts.learned;
	const { put, kvPut } = facts.stored;
	const { planTier } = facts;
	// carry every header the object set through: the x-cfw-* ones are the measurement
	const headers = new Headers(res.headers);
	if (!headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	headers.set('x-cfw-do-cache', doCache);
	if (serving) {
		headers.set('x-cfw-edge', 'MISS');
		headers.set('x-cfw-edge-put', put);
		// a tier that silently declined to store looks identical to one that stored, so the
		// outcome is reported on the header a measurement reads
		headers.set('x-cfw-kv-put', kvPut);
		headers.set('x-cfw-plan', planTier);
	}
	if (authenticated) {
		headers.set(AUTH_MODE_HEADER, authMode);
		if (authReason !== '') headers.set(AUTH_REASON_HEADER, authReason);
		// a per-user page must not be stored by any shared cache between here and the browser
		headers.set('cache-control', 'private, no-store');
	}
	headers.set('x-worker-ms', String(Date.now() - t0));
	// names the object that answered, not the routing decision: a lane that refuses hands back and
	// the primary re-serves; the failover rate (below) is what says whether a pool works
	headers.set(
		REPLICA_HEADER,
		laneOf().lane === 0 || failedOverFrom !== undefined ? 'primary' : `r${laneOf().lane}`
	);
	if (failedOverFrom !== undefined) {
		headers.set('x-cfw-failover', `r${failedOverFrom}`);
		if (failoverReason !== undefined) headers.set('x-cfw-failover-reason', failoverReason);
	}
	if (armedFill !== 'n/a') headers.set('x-cfw-arm-fill', armedFill);
	return new Response(res.body, { status: res.status, headers });
}
