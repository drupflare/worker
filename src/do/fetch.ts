import { degradeHeaders } from '../ops/degrade';
import { noteLimit } from '../ops/platform-limits';
import { ReplicaRequiresPrimary } from '../ops/replica';
import type { SitePhpDurableObject } from '../site-do';
import { jsonError } from '../util/reply';
import { recordInDeployment } from './fleet';
import { alarmShape, sleepBudgetMs } from './levers';
import { adoptRetained } from './retention';
import { auditOwnerCall } from './routes/audit';
import { route as routeImpl, withKvGrant } from './serve';

/** serves one request: routes it, hands refusals to the primary, classifies platform limits */
export async function fetchRequest(
	site: SitePhpDurableObject,
	request: Request
): Promise<Response> {
	if (site.retired) return jsonError('this site was retired', 410);
	adoptRetained(site);
	recordInDeployment(site);
	// one allowance per invocation; an alarm overlapping this request shares it until either
	// ends
	site.sleepBudget = { remainingMs: sleepBudgetMs(site.env, 'request') };
	// in-flight requests are the queue (one request at a time); peak, since the alarm reads
	// and resets it per window
	site.inflight = (site.inflight ?? 0) + 1;
	if (site.inflight > (site.inflightPeak ?? 0)) site.inflightPeak = site.inflight;
	site.holdArming();
	// the monotonic total, not the ring's length (capped at 20, so the comparison below
	// saturates and the handoff stops after 20 refusals)
	const refusalsBefore = site.replicaRefusalsTotal;
	const forwardBefore = site.lastForward;
	try {
		const linearBefore = site.heapNow();
		const reusedBefore = site.heapsReused ?? 0;
		site.resetBridgeBytes();
		const res = await routeImpl(site, request);
		if (site.env.COMMIT_SYNC === '1') await site.storage.sync();
		// the wipe is done; anything below would write into the emptied storage
		if (site.retired) return res;
		site.noteDemand(request, linearBefore, reusedBefore);
		// a refusal PHP caught is still a refusal (Drupal's session handler turns it into a
		// 500 the catch below never sees)
		// only when nothing was forwarded: a forwarded batch already committed on the primary,
		// and a retry would apply it twice
		const refusal = site.replicaRefusals.at(-1);
		if (
			res.status >= 500 &&
			site.replicaRefusalsTotal > refusalsBefore &&
			site.lastForward === forwardBefore &&
			refusal !== undefined
		) {
			return site.replicaHandoff(refusal);
		}
		await auditOwnerCall(site, request, res.status);
		return withKvGrant(site, request, withDegradeHeaders(site, res));
	} catch (e) {
		// a replica meeting work it may not do is the guard working; send the caller to the
		// primary
		// an uncommitted forward is retry-safe (the lane rolled back and the primary refused
		// the batch whole)
		if (e instanceof ReplicaRequiresPrimary) {
			return site.replicaHandoff(e, e.capability === 'forward');
		}
		// classified and rethrown, around both lanes (the fast lane reads storage outside the
		// gate)
		noteLimit(site.limitTally, e);
		site.noteRangeError(e, 'fetch', request);
		await auditOwnerCall(site, request, 500);
		throw e;
	} finally {
		site.inflight = Math.max(0, (site.inflight ?? 1) - 1);
		site.releaseArming();
		// a failed move must not fail the request
		if (alarmShape(site.env) === 'end-sync') await site.settleAlarmEnd().catch(() => {});
	}
}

/**
 * Marks every response with the degradation band (so `reduced` is visible before the final
 * 503); at `normal` the response passes untouched.
 */
function withDegradeHeaders(site: SitePhpDurableObject, res: Response): Response {
	let extra: Record<string, string>;
	try {
		extra = degradeHeaders(site.degradation());
	} catch {
		// meters are unreadable before the tables exist; an unmarked response is honest
		return res;
	}
	if (Object.keys(extra).length === 0) return res;
	// a 101 carries no headers a client can read and rewriting one drops the socket
	if (res.status === 101 || res.webSocket) return res;
	const headers = new Headers(res.headers);
	for (const [name, value] of Object.entries(extra)) headers.set(name, value);
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
