import { sessionCookieValue } from '../ops/auth-budget';
import {
	affinityKey,
	believedLanes,
	chooseTarget,
	replicaCount,
	type RoutingDecision
} from '../ops/replica-routing';
import { siteStubOptions } from '../ops/site-id';
import { writeForwardEnabled } from '../ops/write-forwarding';
import { genBucketMs } from './edge-cache';
import { siteFor } from './owner';
import type { FrontContext, FrontEntry } from './types';

/** Chooses the site and lane a request belongs to and opens the shared serving context. */
export async function openContext(entry: FrontEntry): Promise<FrontContext> {
	const { request, url, env, t0, resolvedSite, pageRequest } = entry;
	// one object per site (a replica lane is the name plus a suffix); a rewritten page request
	// carries the site resolved at the top, so only a directly addressed route resolves here
	const site = pageRequest ? resolvedSite : await siteFor(url, env);
	// the visitor's path (the rewrite moved it to `?path=`, so `affinityKey()` would hash one
	// constant); the query is dropped so a page is one key
	const visitorPath = (url.searchParams.get('path') ?? url.pathname).split('?')[0] as string;
	// lane and stub are lazy and memoised: the tier answering 82% of traffic never reads either
	let laneMemo: RoutingDecision | undefined;
	// read once: a regex over the whole cookie header, on every request that reaches an object
	const sessionValue = sessionCookieValue(request.headers.get('cookie'));
	const laneOf = (): RoutingDecision =>
		(laneMemo ??= chooseTarget({
			site,
			method: request.method,
			affinity: affinityKey({
				session: sessionValue,
				address: request.headers.get('cf-connecting-ip') ?? undefined,
				pathname: visitorPath
			}),
			// `REPLICA_COUNT` is a floor; autoscaled lanes count too
			replicas: Math.max(replicaCount(env), believedLanes(site, t0)),
			// post-rewrite, so a visitor path reads `/serve` and diagnostic and owner routes pin to
			// the primary
			pathname: url.pathname,
			writeForward: writeForwardEnabled(env),
			// a write without a session may mint one, which never reaches the primary from a lane
			hasSession: sessionValue !== undefined,
			visitorPath,
			contentType: request.headers.get('content-type') ?? undefined
		}));
	let stubMemo: DurableObjectStub | undefined;
	const stubOf = (): DurableObjectStub =>
		(stubMemo ??= env.SITE.get(env.SITE.idFromName(laneOf().target), siteStubOptions(env)));

	const cache = caches.default;
	const origin = url.origin;
	const bucket = Math.floor(Date.now() / genBucketMs(env));
	// only the serving path is cacheable, and only for a safe method
	const serving = url.pathname === '/serve' && request.method === 'GET';
	return {
		...entry,
		site,
		visitorPath,
		cache,
		origin,
		bucket,
		serving,
		path: url.searchParams.get('path') ?? '/',
		laneOf,
		stubOf,
		forgetStub: () => {
			stubMemo = undefined;
		}
	};
}
