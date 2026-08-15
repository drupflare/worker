/**
 * The numeric defaults that differ between the free and paid plans, in one place.
 *
 * Before this, `PLAN=paid` reached exactly two decisions -- the migration slicer
 * (`chunksPerInvocation`) and the prefill default -- while five others were flat constants chosen
 * for a 10 ms cap. So a paid site paid for headroom and then behaved like a free one: batches of
 * five, a 2 s inline budget, and a 503 to the first visitor of every cold URL.
 *
 * WHAT PAID ACTUALLY BUYS is a bigger per-invocation CPU budget (30 s against 10 ms) and a longer
 * wall clock, so every knob here is either "how much work fits in one invocation" or "how long a
 * visitor may wait". Nothing here touches the meters that bind the FREE ceiling -- rows written and
 * request counts are the same on both plans, and a paid profile that wrote more rows per fill would
 * be spending the wrong resource.
 *
 * THE ONE THAT MATTERS is {@link PlanProfile.bootInline}. A cold object refuses to render inline
 * because `!this.php`, never because of a budget -- raising `RENDER_BUDGET_MS` from 2,000 to 25,000
 * did not move it, because the estimate is only consulted once an interpreter exists. So on free the
 * first visitor to a cold URL gets a 503 no matter what the budget says, and the fix is not a bigger
 * number but permission to boot. That boot is ~1.4 s, which is why it stays off on free.
 *
 * Every field is an override target: {@link resolvePlanNumber} takes the explicit env value first,
 * so an operator can run a paid profile on free or the reverse without editing code.
 */

import { isPaid, type PlanEnv } from './plan';

/** the per-plan defaults; every field is a per-invocation budget or a visitor-patience bound */
export type PlanProfile = {
	/** pages one alarm firing may fill before re-arming */
	fillBatchSize: number;
	/** wall-clock ms one alarm firing may occupy the object */
	fillBatchWallMs: number;
	/** queued outbound requests one alarm firing may fetch */
	httpDrainLimit: number;
	/** files one alarm firing may push to R2 */
	mirrorLimit: number;
	/** wall-clock ms a MISS may spend rendering before handing the path to the alarm chain */
	inlineBudgetMs: number;
	/**
	 * whether a MISS on a COLD object may boot the interpreter and render, rather than 503.
	 *
	 * The difference between "the first visitor waits" and "the first visitor is turned away", and
	 * the only knob here that changes an outcome rather than a rate.
	 */
	bootInline: boolean;
};

/**
 * Free: sized for a 10 ms per-invocation cap.
 *
 * These are the measured constants the project ran on, unchanged. A batch of 5 and a 2 s budget are
 * not conservative guesses; they are what fits.
 */
export const FREE_PROFILE: PlanProfile = {
	fillBatchSize: 5,
	fillBatchWallMs: 5_000,
	httpDrainLimit: 3,
	mirrorLimit: 2,
	inlineBudgetMs: 2_000,
	bootInline: false
};

/**
 * Paid: sized for a 30 s per-invocation CPU budget, and bounded by HIT LATENCY rather than by it.
 *
 * THE BATCH IS SMALL ON PURPOSE, and the first version of this file got it wrong. A Durable Object
 * is single-threaded and `php._run()` is synchronous, so a fill occupies the object for its whole
 * duration and a queued cache HIT cannot be answered by EITHER lane while it runs. Measured on a
 * deployed worker at `fillBatchSize: 25`: alarms cost 4,337-5,832 ms of cpuTime (n=6) and every
 * `/__serve` racing them waited 5.0-6.8 s of wall (n=5). Nothing tripped -- it was well inside
 * `fillBatchWallMs` -- it just made paid visitors wait seconds on an object that was filling.
 *
 * Throughput does not pay for that, because the alarm RE-ARMS IMMEDIATELY while the queue is
 * non-empty: measured, consecutive firings 130-160 ms apart. So on paid, where DO requests are not
 * the binding meter, many short alarms deliver the same fills per second as one long one and bound
 * the worst HIT wait instead. At a measured 81 ms median per warm render (n=7, 67-107, uncontended),
 * 8 fills is roughly 650 ms of occupancy against 4.5 s.
 *
 * Subrequests are the reason the drain limits stay small-ish: an invocation gets 1,000 on paid
 * against 50 on free, but a fill in the same firing has already spent several, and each mirror put
 * carries a whole file through memory.
 */
export const PAID_PROFILE: PlanProfile = {
	fillBatchSize: 8,
	fillBatchWallMs: 1_500,
	httpDrainLimit: 15,
	mirrorLimit: 10,
	inlineBudgetMs: 10_000,
	bootInline: true
};

/** @returns the profile for this environment; free for anything unrecognised, as `isPaid()` decides */
export function planProfile(env?: PlanEnv | null): PlanProfile {
	return isPaid(env) ? PAID_PROFILE : FREE_PROFILE;
}

/**
 * Resolves one numeric knob: explicit env override first, then the plan profile.
 *
 * @param raw the environment value, which arrives from wrangler as a string
 * @param field which profile field supplies the default
 * @param max a hard cap applied to BOTH the override and the profile, because these bound a single
 *   invocation and an operator typo must not be able to hang the object
 */
export function resolvePlanNumber(
	raw: string | number | null | undefined,
	field:
		'fillBatchSize' | 'fillBatchWallMs' | 'httpDrainLimit' | 'mirrorLimit' | 'inlineBudgetMs',
	max: number,
	env?: PlanEnv | null
): number {
	const profile = planProfile(env);
	const n = Number(raw);
	// an absent or unparseable value falls through to the profile; 0 is honoured where the caller
	// allows it, because `RENDER_BUDGET_MS=0` is the documented way to force the always-503 shape
	if (raw !== null && raw !== undefined && String(raw) !== '' && Number.isFinite(n) && n >= 0) {
		return Math.min(Math.floor(n), max);
	}
	return Math.min(profile[field], max);
}
