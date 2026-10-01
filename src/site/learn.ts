import { parseAuthSpend } from '../ops/auth-budget';
import { isCacheTier } from '../ops/cache-tiers';
import { rememberEdgeGeneration } from '../ops/edge-plan';
import { LANES_EPOCH_HEADER, LANES_HEADER, rememberLanes } from '../ops/replica-routing';
import { asGeneration, writeGeneration } from './edge-cache';
import { writeAuthSpend, writeLanes } from './memos';
import type { AuthState, EdgeRead, FrontContext, Learned } from './types';

/** Reads what the object's answer teaches this isolate: cache tier, generation, spend and lanes. */
export async function learnFromReply(
	f: FrontContext,
	auth: AuthState,
	edge: EdgeRead,
	res: Response
): Promise<Learned> {
	const { url, site, cache, origin, bucket, defer } = f;
	const { personalised, enforcedOf } = auth;
	const { generation } = edge;
	// don't wake the refill here: an install leaves the object near its memory cap and a
	// `setAlarm()` inside that event resets it and rolls the install back (0/6 landed, 6/6 without)
	let armedFill = 'n/a';
	if (url.pathname === '/enable' && res.ok) {
		try {
			const body = (await res.clone().json()) as { armFill?: boolean };
			armedFill = body?.armFill === true ? 'deferred' : 'not-requested';
		} catch {
			armedFill = 'unreadable';
		}
	}

	// an unrecognised tier means this worker and the object disagree about the header
	// contract, which is the drift `CACHE_TIERS` exists to make visible rather than silent
	const rawTier = res.headers.get('x-cfw-cache');
	const doCache =
		rawTier === null ? 'n/a' : isCacheTier(rawTier) ? rawTier : `unknown:${rawTier}`;
	const doGeneration = asGeneration(res.headers.get('x-cfw-generation'));

	// the isolate memo is set synchronously; only another isolate waits on the cache copy (defer)
	if (personalised && enforcedOf()) {
		const reported = parseAuthSpend(res.headers);
		if (reported) defer(writeAuthSpend(cache, origin, site, reported));
	}

	// forward only (a lane trails by up to `DEFAULT_REPLICA_LAG_MS`; `!==` empties the edge tier)
	// and only within the bucket, so a restore is picked up at the next boundary
	if (doGeneration !== undefined && (generation === undefined || doGeneration > generation)) {
		defer(writeGeneration(cache, origin, site, bucket, doGeneration));
	}
	// the plan tier fences on the generation this isolate last learned, which is this one
	if (doGeneration !== undefined) rememberEdgeGeneration(site, doGeneration, Date.now());
	// the pool the primary has built, so an autoscaled lane receives traffic
	const reportedLanes = Number(res.headers.get(LANES_HEADER) ?? '');
	if (Number.isFinite(reportedLanes) && reportedLanes > 0) {
		const reportedEpoch = Number(res.headers.get(LANES_EPOCH_HEADER) ?? 0) || 0;
		rememberLanes(site, reportedLanes, Date.now(), reportedEpoch);
		// at the edge too, so the next cold isolate routes on it
		defer(writeLanes(cache, origin, site, reportedLanes, reportedEpoch));
	}
	return { armedFill, doCache, generation: doGeneration };
}
