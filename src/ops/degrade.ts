/**
 * The quota ladder: what a site stops doing as it approaches its daily ceilings.
 *
 * Today a site that burns its quota hard-fails for the rest of the UTC day, and it fails at the
 * worst possible moment -- the meters are already there, `thresholds.ts` reads them and the admin
 * Limits page renders them, but nothing between the meter and the serving path consults either. An
 * unread meter is the same defect as an unwired health layer.
 *
 * ## The ladder
 *
 * | band | what stops |
 * | --- | --- |
 * | under 80% | nothing |
 * | 80% to 95% | cron, the queue, watchdog writes and image regeneration |
 * | 95% and over | every write; GETs answer from cache, non-GET gets 503 |
 *
 * Each rung drops the most expensive discretionary work first. Cron, queues and image styles are
 * regeneration -- they spend rows and DO invocations on work nobody is waiting for -- so they go
 * before anything a visitor can see. Serving a cached page is the last thing to stop because it is
 * the cheapest thing the object does: measured, a cache HIT costs 0 ms of cpuTime.
 *
 * ## Which meters
 *
 * The two DAILY ceilings, and only those. Rows written and DO requests both reset at midnight UTC,
 * so a degraded site recovers on its own. The monthly image-transform cap is deliberately NOT on
 * this ladder: it does not reset at midnight, so degrading against it would leave a site throttled
 * for weeks with no path back. It is projected and warned about separately.
 */

import type { PlanEnv } from './plan';
import { limitFor, THRESHOLDS } from './thresholds';

/**
 * The daily allowance for one meter, read from `THRESHOLDS` rather than restated.
 *
 * Restating 100,000 here would be a second copy of a number the limits page already renders, and
 * the two would drift the first time a plan changed.
 */
export function dailyLimit(id: 'rows-written' | 'do-requests', env?: PlanEnv | null): number {
	const threshold = THRESHOLDS.find((t) => t.id === id);
	if (!threshold) return 0;
	// null means unmetered on this plan, which is not the same as zero and must not degrade anything
	return limitFor(threshold, env) ?? 0;
}

/** the fraction at which discretionary work stops */
export const REDUCE_AT = 0.8;

/** the fraction at which writes stop */
export const READ_ONLY_AT = 0.95;

export type DegradeLevel = 'normal' | 'reduced' | 'read-only';

export type Meters = {
	/** rows written today against the daily allowance, 0..1+ */
	rowsFraction: number;
	/** Durable Object invocations today against the daily allowance, 0..1+ */
	doFraction: number;
};

export type Degradation = {
	level: DegradeLevel;
	/** the meter that put it here, so an operator knows which number to act on */
	driver: 'rows' | 'do' | null;
	/** worst of the two, which is what the level is decided on */
	fraction: number;
	cron: boolean;
	queue: boolean;
	watchdog: boolean;
	imageRegeneration: boolean;
	/** whether a MISS may render; false means a cache miss answers 503 rather than rendering */
	render: boolean;
	/** whether a non-GET may be accepted at all */
	writes: boolean;
};

/**
 * Reads the ladder.
 *
 * WORST OF THE TWO, never an average. The meters bound different things and either one running out
 * stops the site, so averaging a saturated meter against an idle one reports healthy right up to
 * the failure.
 *
 * A non-finite or negative fraction is treated as 0 rather than throwing: this is consulted on the
 * serving path, and a site must not go read-only because a counter was missing.
 */
export function degradation(meters: Meters): Degradation {
	const rows = clean(meters.rowsFraction);
	const dos = clean(meters.doFraction);
	const fraction = Math.max(rows, dos);
	const driver = fraction <= 0 ? null : rows >= dos ? 'rows' : 'do';

	if (fraction >= READ_ONLY_AT) {
		return {
			level: 'read-only',
			driver,
			fraction,
			cron: false,
			queue: false,
			watchdog: false,
			imageRegeneration: false,
			render: false,
			writes: false
		};
	}
	if (fraction >= REDUCE_AT) {
		return {
			level: 'reduced',
			driver,
			fraction,
			cron: false,
			queue: false,
			watchdog: false,
			imageRegeneration: false,
			// a visitor waiting on a page still gets one; only background work stopped
			render: true,
			writes: true
		};
	}
	return {
		level: 'normal',
		driver,
		fraction,
		cron: true,
		queue: true,
		watchdog: true,
		imageRegeneration: true,
		render: true,
		writes: true
	};
}

const clean = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * What to tell a visitor whose request was refused, and what to tell a monitor.
 *
 * `Retry-After` is seconds to the UTC reset rather than a fixed number, because that is when the
 * condition actually clears. A fixed 60 would have a client retry 1,400 times against a site that
 * cannot answer until midnight.
 */
export function readOnlyResponse(secondsToReset: number, d: Degradation): Response {
	return new Response(
		`this site is read-only until its daily quota resets\n` +
			`driver: ${d.driver ?? 'unknown'} at ${(d.fraction * 100).toFixed(1)}%\n`,
		{
			status: 503,
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'retry-after': String(Math.max(1, Math.floor(secondsToReset))),
				'cache-control': 'no-store',
				'x-cfw-degrade': d.level,
				'x-cfw-degrade-driver': d.driver ?? 'unknown'
			}
		}
	);
}

/** the headers every response carries once the site is off `normal`, so the state is observable */
export function degradeHeaders(d: Degradation): Record<string, string> {
	if (d.level === 'normal') return {};
	return {
		'x-cfw-degrade': d.level,
		'x-cfw-degrade-driver': d.driver ?? 'unknown',
		'x-cfw-degrade-at': d.fraction.toFixed(3)
	};
}
