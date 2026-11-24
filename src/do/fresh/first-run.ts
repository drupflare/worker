import type { SitePhpDurableObject } from '../../site-do';
import { GrowthRefused } from '../growth/cap';
import { isolateResidency, spareMemoryBytes } from '../isolate';
import { FRESH_FIRST_ABORT_REASON, FRESH_FIRST_RETRY_VALUE, freshFirstAbortDue } from './first';
import {
	completeFreshFirst,
	recordFreshFirst,
	type FreshFirstEnd,
	type IsolateReading
} from './first-log';

/** what one render of a page request answers */
type FillOutcome = Awaited<ReturnType<SitePhpDurableObject['fillOne']>>;

/** the isolate as the record reads it: the fields `/serve-stats` `isolateBytes` reports */
export function isolateReading(site: SitePhpDurableObject): IsolateReading {
	return {
		totalBytes: site.isolateNow(),
		linearBytes: site.heapNow(),
		interpreters: isolateResidency().interpreters,
		spareBytes: spareMemoryBytes()
	};
}

/** what one request needs from the surrounding serve path */
export interface FreshFirstRun {
	method: string;
	path: string;
	retryHeader: string | null;
	/** the render itself, which boots an interpreter when none is resident */
	render: () => Promise<FillOutcome>;
}

/**
 * Runs the render for a request.
 *
 * In `abort` mode, for a registered route with an interpreter resident, the object writes and
 * syncs the record and resets itself before anything has run, so the request has had no side
 * effect and the front worker's one repeat is safe; the repeat lands on a new isolate and marks the
 * record finished, whether it answers or is refused.
 */
export async function runFreshFirst(
	site: SitePhpDurableObject,
	run: FreshFirstRun
): Promise<FillOutcome> {
	const { method, path, retryHeader } = run;

	if (freshFirstAbortDue(site.env, method, path, retryHeader, site.php !== undefined)) {
		try {
			recordFreshFirst(site.sql, {
				at: site.nowMs(),
				route: site.growthRoute ?? `${method} ${path}`,
				heapBeforeBytes: site.heapNow(),
				before: isolateReading(site)
			});
			await site.storage.sync();
		} catch (e) {
			site.noteError('fresh-first-log', e);
		}
		site.ctx.abort(FRESH_FIRST_ABORT_REASON);
		throw new Error(FRESH_FIRST_ABORT_REASON);
	}

	let end: FreshFirstEnd = 'ok';
	try {
		return await run.render();
	} catch (e) {
		end = e instanceof GrowthRefused ? 'refused' : 'error';
		throw e;
	} finally {
		// written for a response and for a refusal or error alike, after the run's rollback
		if (retryHeader === FRESH_FIRST_RETRY_VALUE) {
			try {
				completeFreshFirst(site.sql, isolateReading(site), site.nowMs(), end);
			} catch (e) {
				site.noteError('fresh-first-log', e);
			}
		}
	}
}
