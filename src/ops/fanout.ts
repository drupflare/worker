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

/** at or below this, the write pays for its own regeneration immediately */
export const FANOUT_SMALL = 8;

/** at or below this, the regeneration is queued and drains at the ordinary alarm cadence */
export const FANOUT_MEDIUM = 32;

export type FanoutPolicy = 'immediate' | 'background' | 'lazy';

export type FanoutDecision = {
	policy: FanoutPolicy;
	/** how many of the invalidated paths to enqueue now */
	requeue: number;
	/** whether to pull the alarm in rather than leaving it at its normal cadence */
	armNow: boolean;
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
export function fanoutDecision(fanout: number, limit: number, stale = true): FanoutDecision {
	if (fanout <= 0) {
		return { policy: 'lazy', requeue: 0, armNow: false, reason: 'nothing was invalidated' };
	}
	if (fanout <= FANOUT_SMALL) {
		return {
			policy: 'immediate',
			requeue: Math.min(fanout, limit),
			armNow: true,
			reason: `${fanout} pages, which the write can pay for`
		};
	}
	if (fanout <= FANOUT_MEDIUM) {
		return {
			policy: 'background',
			requeue: Math.min(fanout, limit),
			armNow: false,
			reason: `${fanout} pages, queued for the ordinary chain`
		};
	}
	if (!stale) {
		return {
			policy: 'background',
			requeue: Math.min(fanout, limit),
			armNow: false,
			reason: `${fanout} pages, queued because there is no stale tier to leave them to`
		};
	}
	return {
		policy: 'lazy',
		requeue: 0,
		armNow: false,
		reason: `${fanout} pages, left to the stale tier and the visitors who ask`
	};
}
