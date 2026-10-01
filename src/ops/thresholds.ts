/**
 * Every meter a site can run out of, what it costs, and how it fails (a bill or an outage).
 *
 * Image transformations (5,000 uniques per month on free) are the only monthly meter and a hard cap
 * with no warning; a unique is (source image x style), so it tracks content, not traffic.
 * @module
 */
import { isPaid, type PlanEnv } from './plan';

/** how a meter behaves when it runs out */
export type FailureMode =
	/** stops working until the period resets; no bill, no error a site owner sees */
	| 'hard-cap'
	/** keeps working, costs money */
	| 'billed'
	/** requests are refused with a documented error while the site stays up */
	| 'error';

/** the window a meter resets on */
export type MeterPeriod = 'day' | 'month' | 'invocation';

/** one meter: its allowances, how it fails and what spends it */
export type Threshold = {
	/** stable id, safe to key a UI row on */
	id: string;
	label: string;
	period: MeterPeriod;
	/** the free-plan allowance; null when the plan does not meter it */
	free: number | null;
	/** the paid allowance, or null when it is effectively unmetered */
	paid: number | null;
	failure: FailureMode;
	/** what spends it, in the site's own terms rather than Cloudflare's */
	spentBy: string;
	/** why it matters, or what it broke */
	note: string;
	/** the reason, when this site structurally cannot count the meter (not "not wired yet") */
	unmeasurable?: string;
};

/** the meters, ordered by how badly the failure surprises (monthly cap first, then daily) */
export const THRESHOLDS: readonly Threshold[] = [
	{
		id: 'image-transforms',
		label: 'Image transformations (unique)',
		period: 'month',
		free: 5_000,
		paid: null,
		failure: 'hard-cap',
		spentBy: 'one per image style per image; a style added later re-spends every image',
		note: 'THE ONE THAT FAILS SILENTLY. Ten styles over 2,000 images is 20,000 -- 4x over -- and images just stop being transformed partway through the month. Monthly, so it does not clear at midnight.'
	},
	{
		id: 'worker-requests',
		label: 'Worker requests',
		period: 'day',
		free: 100_000,
		paid: null,
		failure: 'error',
		spentBy: 'every visit, including a cache HIT',
		note: 'The serving ceiling. A cache hit still costs one, so a 99%-cached architecture rescues CPU and does nothing for this. Saturated at 1.00x for a 3M-visit month.',
		unmeasurable:
			'not countable from inside this site: a request answered by the edge cache never enters an isolate that could count it, so any figure here would undercount by exactly the traffic the cache absorbs. Read it from Cloudflare analytics.'
	},
	{
		id: 'rows-written',
		label: 'Durable Object rows written',
		period: 'day',
		free: 100_000,
		paid: null,
		failure: 'error',
		spentBy:
			'a page render (8 rows, 2 with the default in-memory bin), an authenticated view (8), an alarm re-arm (1)',
		note: 'The regeneration ceiling, and what actually binds it on both the alarm chain and the fill window.'
	},
	{
		id: 'do-requests',
		label: 'Durable Object requests',
		period: 'day',
		free: 100_000,
		paid: null,
		failure: 'error',
		spentBy: 'every cache miss, and every alarm invocation',
		note: 'Explicitly includes alarm invocations, so slicing work into more invocations spends the meter it is trying to dodge.'
	},
	{
		id: 'workflow-steps',
		label: 'Workflow steps',
		period: 'day',
		free: 3_000,
		paid: 500_000,
		failure: 'error',
		spentBy: 'a module install, sliced into 10 ms steps',
		note: 'A Workflow invocation is billed against the SAME daily quota as a Worker request, so an install spends the serving ceiling.'
	},
	{
		id: 'workflow-steps-instance',
		label: 'Workflow steps in one instance',
		period: 'invocation',
		free: 1_024,
		paid: 25_000,
		failure: 'error',
		spentBy: 'one install run',
		note: 'Free gets 1,024 per instance, not the 25,000 the paid docs quote. Past it an install needs child instances.'
	}
] as const;

/** the allowance for a plan, or null when that plan does not meter it */
export function limitFor(threshold: Threshold, env?: PlanEnv): number | null {
	return isPaid(env) ? threshold.paid : threshold.free;
}

/** the meters that stop working rather than billing, which are the ones worth a warning */
export function hardCaps(): readonly Threshold[] {
	return THRESHOLDS.filter((t) => t.failure === 'hard-cap');
}

/** how close to a limit counts as worth saying out loud */
export const WARN_FRACTION = 0.8;

/** where a reading sits against its limit; `unknown` means nothing measures it */
export type MeterStatus = 'ok' | 'warn' | 'over' | 'unmetered' | 'unknown';

/** one scored meter, with a message ready to show */
export type MeterReading = {
	threshold: Threshold;
	limit: number | null;
	used: number | null;
	fraction: number | null;
	status: MeterStatus;
	message: string;
};

/**
 * Scores one meter against its limit.
 *
 * @param used null when nothing measures it yet, which is not the same as zero
 */
export function readMeter(threshold: Threshold, used: number | null, env?: PlanEnv): MeterReading {
	const limit = limitFor(threshold, env);
	if (limit === null) {
		return {
			threshold,
			limit,
			used,
			fraction: null,
			status: 'unmetered',
			message: 'not metered on this plan'
		};
	}
	if (used === null) {
		// unmeasured is not zero (it would read as healthy); `unmeasurable` marks a structural gap
		return {
			threshold,
			limit,
			used,
			fraction: null,
			status: 'unknown',
			message: threshold.unmeasurable ?? 'nothing measures this yet'
		};
	}
	const fraction = limit > 0 ? used / limit : 0;
	const status: MeterStatus = fraction >= 1 ? 'over' : fraction >= WARN_FRACTION ? 'warn' : 'ok';
	const per = threshold.period === 'invocation' ? 'per run' : `this ${threshold.period}`;
	return {
		threshold,
		limit,
		used,
		fraction,
		status,
		message:
			status === 'over'
				? threshold.failure === 'hard-cap'
					? `OVER by ${used - limit} ${per}: this has already stopped working, and it does not reset until next month`
					: `OVER by ${used - limit} ${per}`
				: `${used.toLocaleString()} of ${limit.toLocaleString()} ${per}`
	};
}

// #region the image-transform projection, which is the one a site can compute BEFORE it bites

/** the inputs to an image-transform projection */
export type ImagePlan = {
	/** distinct source images the site will ask Cloudflare to transform */
	images: number;
	/** enabled image styles; each one is a separate parameter set per image */
	styles: number;
	/** transformations already spent this month, when something knows */
	alreadyUsed?: number;
};

/** the projected monthly uniques against the cap, with ways to fit */
export type ImageProjection = {
	uniques: number;
	limit: number | null;
	status: MeterStatus;
	/** how many times over the allowance, when it is over */
	overBy: number;
	multiple: number;
	/** the largest style count that still fits, or null when even one style does not */
	stylesThatFit: number | null;
	/** the largest image count that fits at the requested style count */
	imagesThatFit: number | null;
	message: string;
	/** concrete, ordered, and each one actually reduces uniques */
	remedies: string[];
};

/** projects images x styles against the monthly cap before the cap is reached */
export function projectImageTransforms(plan: ImagePlan, env?: PlanEnv): ImageProjection {
	const threshold = THRESHOLDS.find((t) => t.id === 'image-transforms') as Threshold;
	const limit = limitFor(threshold, env);
	const images = Math.max(0, Math.floor(plan.images));
	const styles = Math.max(0, Math.floor(plan.styles));
	const uniques = images * styles + Math.max(0, Math.floor(plan.alreadyUsed ?? 0));

	if (limit === null) {
		return {
			uniques,
			limit,
			status: 'unmetered',
			overBy: 0,
			multiple: 0,
			stylesThatFit: null,
			imagesThatFit: null,
			message: `${uniques.toLocaleString()} transformations; not capped on this plan`,
			remedies: []
		};
	}

	const fraction = uniques / limit;
	const status: MeterStatus = fraction >= 1 ? 'over' : fraction >= WARN_FRACTION ? 'warn' : 'ok';
	const stylesThatFit = images > 0 ? Math.floor(limit / images) : null;
	const imagesThatFit = styles > 0 ? Math.floor(limit / styles) : null;

	const remedies: string[] = [];
	if (status !== 'ok') {
		if (stylesThatFit !== null && stylesThatFit < styles) {
			remedies.push(
				stylesThatFit === 0
					? `even one style over ${images.toLocaleString()} images does not fit; reduce the image count or serve originals`
					: `reduce to ${stylesThatFit} style(s) over ${images.toLocaleString()} images`
			);
		}
		if (imagesThatFit !== null) {
			remedies.push(
				`or transform at most ${imagesThatFit.toLocaleString()} images at ${styles} styles`
			);
		}
		// these two reduce uniques rather than deferring the problem
		remedies.push(
			'serve one responsive size and let the browser scale, which is one unique per image'
		);
		remedies.push(
			'pre-render derivatives into R2 once, which spends the meter once rather than per month'
		);
	}

	return {
		uniques,
		limit,
		status,
		overBy: Math.max(0, uniques - limit),
		multiple: limit > 0 ? Number((uniques / limit).toFixed(2)) : 0,
		stylesThatFit,
		imagesThatFit,
		message:
			status === 'over'
				? `${uniques.toLocaleString()} unique transformations against ${limit.toLocaleString()}/month: ${Number((uniques / limit).toFixed(2))}x OVER. Images stop being transformed once it is reached, and it does not reset until the first of the month.`
				: status === 'warn'
					? `${uniques.toLocaleString()} of ${limit.toLocaleString()}/month: within ${Math.round((1 - fraction) * 100)}% of a HARD CAP`
					: `${uniques.toLocaleString()} of ${limit.toLocaleString()}/month`,
		remedies
	};
}
// #endregion

/** the environment a threshold report reads */
export type ThresholdEnv = PlanEnv;

/** a full report, for a UI or a diagnostic route */
export function thresholdReport(
	used: Partial<Record<string, number>> = {},
	env?: ThresholdEnv
): { plan: 'free' | 'paid'; readings: MeterReading[]; hardCapCount: number } {
	return {
		plan: isPaid(env) ? 'paid' : 'free',
		readings: THRESHOLDS.map((t) => readMeter(t, used[t.id] ?? null, env)),
		hardCapCount: hardCaps().length
	};
}
