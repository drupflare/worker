/**
 * The quota ladder: what a site stops doing as it approaches its daily ceilings.
 *
 * Under 80% nothing stops; 80% to 95% stops cron, the queue, watchdog writes and image
 * regeneration (work nobody waits for); 95% and over stops every write (GETs answer from cache,
 * non-GET gets 503, since a cache HIT costs 0 ms of cpuTime).
 *
 * Only the two daily meters (rows written, DO requests) are on it, since they reset at midnight
 * UTC. The monthly image-transform cap is not (a site would stay throttled for weeks).
 * @module
 */
import type { PlanEnv } from './plan';
import { limitFor, THRESHOLDS } from './thresholds';

/** the daily allowance for one meter, read from `THRESHOLDS` (not a second copy of the number) */
export function dailyLimit(id: 'rows-written' | 'do-requests', env?: PlanEnv): number {
	const threshold = THRESHOLDS.find((t) => t.id === id);
	if (!threshold) return 0;
	// null means unmetered on this plan (not zero; must not degrade anything)
	return limitFor(threshold, env) ?? 0;
}

/** the fraction at which discretionary work stops */
export const REDUCE_AT = 0.8;

/** the fraction at which writes stop */
export const READ_ONLY_AT = 0.95;

/** where the site is on the ladder */
export type DegradeLevel = 'normal' | 'reduced' | 'read-only';

/** the two daily meters as fractions of their allowance */
export type Meters = {
	/** rows written today against the daily allowance, 0..1+ */
	rowsFraction: number;
	/** Durable Object invocations today against the daily allowance, 0..1+ */
	doFraction: number;
};

/** what the current level allows */
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
 * Reads the ladder from the worse of the two meters, never an average (a saturated meter beside an
 * idle one must not read healthy).
 *
 * A non-finite or negative fraction counts as 0: this runs on the serving path, and a missing
 * counter must not make a site read-only.
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
 * `Retry-After` is seconds to the UTC reset, when the condition clears (a fixed 60 would have a
 * client retry 1,400 times).
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
