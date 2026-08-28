import { isPaid, type PlanEnv } from './plan.js';

/**
 * Every meter a site can run out of, what it costs, and HOW IT FAILS.
 *
 * The failure mode is a first-class field. A limit that bills you is an invoice; a limit that
 * stops working is an outage. This project has both, and they were being read the same way -- so the
 * one that matters most got the least attention:
 *
 * **Cloudflare Images allows 5,000 unique transformations per MONTH on free, and it fails as a HARD
 * CAP rather than as a bill.** `CfwImageToolkit` defers every manipulation to a `/cdn-cgi/image/`
 * URL, so an image style IS a transformation. Ten styles over 2,000 images is 20,000 uniques -- 4x
 * over -- and nothing in the system says so. A real site stops transforming images partway through a
 * month, with no warning and no error anywhere a site owner would look. Thumbnails simply stop
 * appearing.
 *
 * It is also the only meter here that is MONTHLY. Every other one resets at midnight UTC, so a bad
 * day is a bad day; this one, once spent, is spent until the first of the month.
 *
 * A UNIQUE IS (source image x parameter set), which is what makes the multiplication the danger. Two
 * styles over the same image are two uniques. Re-requesting the same style over the same image is
 * not, so the meter tracks the site's CONTENT, not its traffic -- which is why traffic-based
 * intuition gets this wrong in both directions.
 */

/** how a meter behaves when it runs out; the field that was missing */
export type FailureMode =
	/** stops working until the period resets; no bill, no error a site owner sees */
	| 'hard-cap'
	/** keeps working, costs money */
	| 'billed'
	/** requests are refused with a documented error while the site stays up */
	| 'error';

/** the window a meter resets on */
export type MeterPeriod = 'day' | 'month' | 'invocation';

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
	/**
	 * Set when this site STRUCTURALLY cannot count the meter, with the reason.
	 *
	 * Distinct from "not wired yet". A meter nobody has got to invites someone to wire it; a meter
	 * that cannot be counted here invites them to produce a confident wrong number instead of
	 * finding out why. Naming the reason is what stops that.
	 */
	unmeasurable?: string;
};

/**
 * The meters, in the order a site owner should read them.
 *
 * Ordered by how badly the failure surprises you, not by size: the monthly hard cap first, then the
 * two daily ceilings the whole architecture is scored against, then the rest.
 */
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
		spentBy: 'a page render (13 rows), an authenticated view (13), an alarm re-arm (1)',
		note: 'The regeneration ceiling, and what actually binds it: 8,196 regenerations/day windowed.'
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
export function limitFor(threshold: Threshold, env?: PlanEnv | null): number | null {
	return isPaid(env) ? threshold.paid : threshold.free;
}

/** the meters that stop working rather than billing, which are the ones worth a warning */
export function hardCaps(): readonly Threshold[] {
	return THRESHOLDS.filter((t) => t.failure === 'hard-cap');
}

/** how close to a limit counts as worth saying out loud */
export const WARN_FRACTION = 0.8;

export type MeterStatus = 'ok' | 'warn' | 'over' | 'unmetered' | 'unknown';

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
 * @param used null when nothing measures it yet, which is NOT the same as zero
 */
export function readMeter(
	threshold: Threshold,
	used: number | null,
	env?: PlanEnv | null
): MeterReading {
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
		// "nothing counts this yet" and "this is at zero" lead to different actions, and collapsing
		// them is how an unmeasured meter reads as a healthy one.
		//
		// A THIRD case matters as much: a meter this site CANNOT count, however much work is done.
		// Reporting that as "not yet" invites someone to go and wire it, and they will produce a
		// confident wrong number instead of finding out it is structural.
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

export type ImagePlan = {
	/** distinct source images the site will ask Cloudflare to transform */
	images: number;
	/** enabled image styles; each one is a separate parameter set per image */
	styles: number;
	/** transformations already spent this month, when something knows */
	alreadyUsed?: number;
};

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

/**
 * Projects a site's image-style configuration against the monthly cap, BEFORE it is reached.
 *
 * This is what the module is for: the meter is a function of the site's CONTENT and
 * CONFIGURATION, both of which are known in advance, so the answer does not have to wait for the
 * failure. Nothing else in the system multiplies styles by images and compares.
 */
export function projectImageTransforms(plan: ImagePlan, env?: PlanEnv | null): ImageProjection {
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
		// these two genuinely reduce uniques rather than deferring the problem
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
	env?: ThresholdEnv | null
): { plan: 'free' | 'paid'; readings: MeterReading[]; hardCapCount: number } {
	return {
		plan: isPaid(env) ? 'paid' : 'free',
		readings: THRESHOLDS.map((t) => readMeter(t, used[t.id] ?? null, env)),
		hardCapCount: hardCaps().length
	};
}
