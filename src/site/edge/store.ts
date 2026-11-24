import { carriesAuthorization } from '../../ops/meters/auth-budget';
import { moduleHeadersOf } from '../../ops/module/headers';
import { KV_GRANT_HEADER, pageKvEnabled, writePage } from '../../ops/page/store';
import { servingFor } from '../../ops/store-rule';
import { cmsOf } from '../../util/cms';
import type { AuthState, FrontContext, Learned, StoreOutcome } from '../types';
import { putPage } from './cache';

/** Offers the answer to the edge cache and the KV page tier, and reports what each decided. */
export function storeEdge(
	f: FrontContext,
	auth: AuthState,
	res: Response,
	learned: Learned
): StoreOutcome {
	const { env, site, path, serving, cache, origin, defer, request } = f;
	const { personalised } = auth;
	const { doCache, generation: doGeneration } = learned;
	// the CMS's own rule on what the request and the response say; the body is not read here, so
	// the object's `private, no-store` on an uncacheable render is what keeps one out
	const refusal = serving
		? servingFor(cmsOf(env)).refuse(
				{
					method: request.method,
					status: res.status,
					hasCookie: request.headers.has('cookie'),
					hasAuthorization: carriesAuthorization(request),
					setsCookie: res.headers.has('set-cookie'),
					cacheControl: res.headers.get('cache-control'),
					path,
					contentType: res.headers.get('content-type'),
					headerNames: [...request.headers.keys()]
				},
				env
			)
		: undefined;
	const paged = !serving
		? { outcome: 'skipped:not-serving' }
		: refusal !== undefined
			? { outcome: `skipped:${refusal}` }
			: putPage(cache, origin, site, path, res, doGeneration, doCache, personalised);
	defer(paged.write);
	const put = paged.outcome;

	// mirror into KV so the next colo does not pay a DO request (`res.clone()` as in putPage(),
	// since the returned body can only be read once)
	let kvPut = 'skipped:not-serving';
	if (serving && personalised) {
		// the KV key has no user in it either, so the same structural refusal applies
		kvPut = 'skipped:authenticated';
	} else if (serving && res.headers.has('set-cookie')) {
		kvPut = 'skipped:set-cookie';
	} else if (serving && refusal !== undefined) {
		kvPut = `skipped:${refusal}`;
	} else if (serving && pageKvEnabled(env)) {
		if (doGeneration === undefined) {
			kvPut = 'skipped:no-generation';
		} else if (doCache !== 'HIT' && doCache !== 'RENDER') {
			// a 503 warming placeholder is not a page; storing it would pin "warming" globally
			kvPut = `skipped:${doCache}`;
		} else if (res.headers.get(KV_GRANT_HEADER) !== '1') {
			// the object holds the daily write budget; no grant means spent, or a lane answered
			kvPut = 'skipped:no-grant';
		} else {
			// cloned now, read later: the body below is returned to the caller, and a clone taken
			// after that has been consumed is empty
			const copy = res.clone();
			const status = res.status;
			const contentType = res.headers.get('content-type') ?? 'text/html; charset=utf-8';
			const headers = moduleHeadersOf(res.headers);
			const generationForKv = doGeneration;
			defer(
				copy
					.text()
					.then((html) =>
						writePage(env, site, generationForKv, path, {
							status,
							contentType,
							html,
							...(Object.keys(headers).length > 0 ? { headers } : {})
						})
					)
					.catch(() => undefined)
			);
			kvPut = 'deferred';
		}
	} else if (serving) {
		kvPut = 'skipped:disabled';
	}
	return { put, kvPut };
}
