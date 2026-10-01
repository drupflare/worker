/**
 * The numeric defaults that differ between the free and paid plans, in one place.
 *
 * Every knob is how much work fits in one invocation or how long a visitor may wait; none touches
 * the meters that bind the free ceiling (rows written and request counts match on both plans).
 * The one that changes an outcome is {@link PlanProfile.bootInline}: a cold object refuses to
 * render inline because `!this.php`, never because of a budget. Every field is an override
 * target: {@link resolvePlanNumber} takes the explicit env value first.
 * @module
 */
import { leverInt } from '../util/lever';
import { isPaid, type PlanEnv } from './plan';

/** the per-plan defaults; every field is a per-invocation budget or a visitor-patience bound */
export type PlanProfile = {
	/** pages one alarm firing may fill before re-arming */
	fillBatchSize: number;
	/** queued outbound requests one alarm firing may fetch */
	httpDrainLimit: number;
	/** files one alarm firing may push to R2 */
	mirrorLimit: number;
	/** wall-clock ms a miss may spend rendering before handing the path to the alarm chain */
	inlineBudgetMs: number;
	/** whether a miss on a cold object may boot the interpreter and render, rather than 503 */
	bootInline: boolean;
};

/**
 * Free: a batch of 5 is what the measured constants fit.
 *
 * `bootInline` is true: the 10 ms cap does not fail an object invocation (1,882 ms `cpuTime`
 * completed on a deployed free worker), and refusing a cold boot is not a short wait (deployed
 * time-to-served for a cold miss was 19,004 ms, only 4 of 8 paths served; boot plus render is
 * ~3.8 s). `inlineBudgetMs` bounds visitor patience, not a billed resource. The object stays
 * protected by `estimateRenderMs()`, herd collapse, the daily meters and `degraded.render`.
 */
export const FREE_PROFILE: PlanProfile = {
	fillBatchSize: 5,
	httpDrainLimit: 3,
	mirrorLimit: 2,
	inlineBudgetMs: 10_000,
	bootInline: true
};

/**
 * Paid: bounded by hit latency, not the 30 s CPU budget.
 *
 * The batch is small because `php._run()` is synchronous: a fill occupies the single-threaded
 * object and queued hits wait. At `fillBatchSize: 25` alarms cost 4,337-5,832 ms of cpuTime (n=6)
 * and racing `/__serve` calls waited 5.0-6.8 s (n=5); a wall-clock guard cannot bound it (frozen
 * clock). The alarm re-arms 130-160 ms apart, so short batches match long ones' throughput; 8
 * fills at ~81 ms is ~650 ms of occupancy. Drain limits stay small for subrequests and memory.
 * Batching does amortise (per-page wall 109 ms at k=1 to 42.9 at k=20, deployed free, n=5), but
 * that is throughput on an idle object; the bounds are hit latency and the 128 MiB isolate.
 */
export const PAID_PROFILE: PlanProfile = {
	fillBatchSize: 8,
	httpDrainLimit: 15,
	mirrorLimit: 10,
	inlineBudgetMs: 10_000,
	bootInline: true
};

/** @returns the profile for this environment (free unless `isPaid()` says otherwise) */
export function planProfile(env?: PlanEnv): PlanProfile {
	return isPaid(env) ? PAID_PROFILE : FREE_PROFILE;
}

/**
 * Resolves one numeric knob: explicit env override first, then the plan profile.
 *
 * @param raw the environment value, which arrives from wrangler as a string
 * @param field which profile field supplies the default
 * @param max a hard cap on both override and profile (an operator typo must not hang the object)
 */
export function resolvePlanNumber(
	raw: string | number | null | undefined,
	field: 'fillBatchSize' | 'httpDrainLimit' | 'mirrorLimit' | 'inlineBudgetMs',
	max: number,
	env?: PlanEnv
): number {
	const profile = planProfile(env);
	// absent or unparseable falls through to the profile; 0 is honoured (`RENDER_BUDGET_MS=0`
	// forces always-503)
	return Math.min(leverInt(raw) ?? profile[field], max);
}
