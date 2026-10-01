/**
 * How a content change is scheduled, from how many pages it invalidated: three policies, because
 * regenerating a config change's whole closure eagerly would cost more of the daily row budget
 * than the day's traffic.
 * @module
 */

/** at or below this many pages, at the default cost, the write pays for its own regeneration */
export const FANOUT_SMALL = 8;

/** at or below this, the regeneration is queued and drains at the ordinary alarm cadence */
export const FANOUT_MEDIUM = 32;

/**
 * What a re-render costs when the save reached the page's own tags, in charged rows.
 *
 * `ROWS_PER_FILL.realRender`, copied because the measured table lives in a CLI script that must
 * not enter the Worker bundle; a spec pins the two together. It describes
 * `MEMORY_CACHE_BINS=none` (the shipping default is 2).
 */
export const ROWS_PER_TAGGED_PAGE = 8;

/**
 * What a re-queued page costs when the save did not reach its tags.
 *
 * `ROWS_PER_FILL.warmReassemble`: a wholesale purge re-renders from a warm bin and writes only its
 * row. 2, priced on the front page (the dearer path, so it cannot undercut a real fill).
 */
export const ROWS_PER_UNTAGGED_PAGE = 2;

/**
 * The thresholds in rows, the unit the budget is spent in (a fill is 2 to 91 rows, so a page
 * count alone is not a fixed cost); derived from the page counts at the tagged cost.
 */
export const FANOUT_SMALL_ROWS = FANOUT_SMALL * ROWS_PER_TAGGED_PAGE;
/** the medium threshold in rows */
export const FANOUT_MEDIUM_ROWS = FANOUT_MEDIUM * ROWS_PER_TAGGED_PAGE;

/** write pays now, queue for the alarm chain, or leave to the stale tier */
export type FanoutPolicy = 'immediate' | 'background' | 'lazy';

/** the policy for one invalidation and why */
export type FanoutDecision = {
	policy: FanoutPolicy;
	/** how many of the invalidated paths to enqueue now */
	requeue: number;
	/** whether to pull the alarm in rather than leaving it at its normal cadence */
	armNow: boolean;
	/** the charged rows this invalidation is expected to cost (what the policy is picked on) */
	rows: number;
	reason: string;
};

/**
 * Picks the policy for one invalidation.
 *
 * `limit` is `PREFILL_ON_SAVE`'s cap, which still bounds the queue rows of a single save.
 *
 * The lazy branch is safe only when `stale` is true: an unqueued page is served from its previous
 * KV generation (`readStalePage()`, which needs `PAGE_KV`, unbound in the canonical config). With
 * no stale tier the pages are queued for the alarm chain instead.
 */
export function fanoutDecision(
	fanout: number,
	limit: number,
	stale = true,
	rowsPerPage: number = ROWS_PER_TAGGED_PAGE
): FanoutDecision {
	if (fanout <= 0) {
		return {
			policy: 'lazy',
			requeue: 0,
			armNow: false,
			rows: 0,
			reason: 'nothing was invalidated'
		};
	}
	const rows = Math.round(fanout * Math.max(0, rowsPerPage));
	const cost = `${fanout} pages at ${rowsPerPage} rows = ${rows}`;
	if (rows <= FANOUT_SMALL_ROWS) {
		return {
			policy: 'immediate',
			requeue: Math.min(fanout, limit),
			armNow: true,
			rows,
			reason: `${cost}, which the write can pay for`
		};
	}
	if (rows <= FANOUT_MEDIUM_ROWS) {
		return {
			policy: 'background',
			requeue: Math.min(fanout, limit),
			armNow: false,
			rows,
			reason: `${cost}, queued for the ordinary chain`
		};
	}
	if (!stale) {
		return {
			policy: 'background',
			requeue: Math.min(fanout, limit),
			armNow: false,
			rows,
			reason: `${cost}, queued because there is no stale tier to leave them to`
		};
	}
	return {
		policy: 'lazy',
		requeue: 0,
		armNow: false,
		rows,
		reason: `${cost}, left to the stale tier and the visitors who ask`
	};
}
