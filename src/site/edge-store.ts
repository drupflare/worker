import { KV_GRANT_HEADER, pageKvEnabled, writePage } from '../ops/page-store';
import { putPage } from './edge-cache';
import type { AuthState, FrontContext, Learned, StoreOutcome } from './types';

/** Offers the answer to the edge cache and the KV page tier, and reports what each decided. */
export function storeEdge(
	f: FrontContext,
	auth: AuthState,
	res: Response,
	learned: Learned
): StoreOutcome {
	const { env, site, path, serving, cache, origin, defer } = f;
	const { personalised } = auth;
	const { doCache, generation: doGeneration } = learned;
	const paged = serving
		? putPage(cache, origin, site, path, res, doGeneration, doCache, personalised)
		: { outcome: 'skipped:not-serving' };
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
			const generationForKv = doGeneration;
			defer(
				copy
					.text()
					.then((html) =>
						writePage(env, site, generationForKv, path, {
							status,
							contentType,
							html
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
