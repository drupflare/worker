/**
 * How a content change is scheduled, from how many pages it invalidated.
 *
 * Once the dependency closure of a write is known, the expensive work can happen DURING the
 * editorial operation rather than on the next visitor. For a CMS that is the right place to spend
 * CPU: the write already carries an expensive human operation and nobody is waiting on it the way a
 * reader is.
 *
 * What stops that being unconditional is that the closure is not always small. A node save touches
 * the node page and the listings that carry it; a config change touches everything. Regenerating
 * both eagerly turns the second into a stampede that costs more of the daily row budget than the
 * whole day's traffic. So the fanout picks the policy, and there are exactly three.
 */

/** at or below this many pages, at the default cost, the write pays for its own regeneration */
export const FANOUT_SMALL = 8;

/** at or below this, the regeneration is queued and drains at the ordinary alarm cadence */
export const FANOUT_MEDIUM = 32;

/**
 * What a re-render costs when the save reached the page's own tags, in charged rows.
 *
 * `ROWS_PER_FILL.realRender`, copied rather than imported: the measured table lives in
 * `scripts/measure/free-envelope.ts` and a CLI script has no business in the Worker bundle. Pinned
 * against the original in `tests/unit/ops/fanout.spec.ts`, the same arrangement `auth-budget.ts`
 * uses for the two constants it copies.
 *
 * It describes `MEMORY_CACHE_BINS=none`; with the shipping default a tagged page is 2, and the
 * constant tracks `ROWS_PER_FILL.realRender` deliberately rather than leading it. See that class,
 * which says why both of these lost a row on 2026-09-23.
 */
export const ROWS_PER_TAGGED_PAGE = 8;

/**
 * And what a re-queued page costs when the save did NOT reach its tags.
 *
 * `ROWS_PER_FILL.warmReassemble`. A `cachetags` bump leaves `dynamic_page_cache` alone except for
 * tag-matched entries, so a page re-queued by a wholesale purge re-renders from a warm bin: it
 * stores its row and writes nothing else. 2, priced on the front page: `/user/login` reassembles in
 * one row and `/` in two, and the class takes the dearer path so it cannot undercut a real fill.
 */
export const ROWS_PER_UNTAGGED_PAGE = 2;

/**
 * The thresholds, in the unit the budget is actually spent in.
 *
 * FANOUT WAS A PAGE COUNT AND A PAGE IS NOT A FIXED COST. The two constants above differ by 4.5x,
 * and across the whole measured table a fill is 2 to 91 rows -- so 8 pages is 16 rows or 728
 * depending on what those pages are, and one threshold could not be right for both. Expressed as
 * rows, derived from the page counts at the tagged cost, so the decision is unchanged for the case
 * the counts were chosen against and correct for the others.
 */
export const FANOUT_SMALL_ROWS = FANOUT_SMALL * ROWS_PER_TAGGED_PAGE;
export const FANOUT_MEDIUM_ROWS = FANOUT_MEDIUM * ROWS_PER_TAGGED_PAGE;

export type FanoutPolicy = 'immediate' | 'background' | 'lazy';

export type FanoutDecision = {
	policy: FanoutPolicy;
	/** how many of the invalidated paths to enqueue now */
	requeue: number;
	/** whether to pull the alarm in rather than leaving it at its normal cadence */
	armNow: boolean;
	/** the charged rows this invalidation is expected to cost, which is what the policy is picked on */
	rows: number;
	reason: string;
};

/**
 * Picks the policy for one invalidation.
 *
 * `limit` is `PREFILL_ON_SAVE`'s cap, which still applies: it is what stops a single save writing
 * an unbounded number of queue rows, and this narrows within it rather than replacing it.
 *
 * THE LAZY BRANCH IS NOT A REFUSAL, AND `stale` IS WHAT MAKES THAT TRUE. A page that is not
 * re-queued is not lost only because it has a previous generation in KV and the stale tier serves it
 * while the visitor's own arrival queues the regeneration.
 *
 * That precondition was ASSERTED AND NOT CHECKED. The stale tier is `readStalePage()`, which needs
 * `PAGE_KV`, and the canonical `wrangler.jsonc` binds no such namespace -- so on the shipping config
 * the branch degraded every invalidated page to a cold render or a `503 warming` after any change
 * touching more than {@link FANOUT_MEDIUM} pages. With no stale tier the honest answer is one tier
 * down: queue them and let the ordinary alarm chain drain them.
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
