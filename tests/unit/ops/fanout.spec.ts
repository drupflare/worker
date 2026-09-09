import { describe, expect, it } from 'vitest';
import {
	FANOUT_MEDIUM,
	FANOUT_SMALL,
	fanoutDecision,
	type FanoutPolicy
} from '../../../src/ops/fanout';

/**
 * One policy replacing "purge everything", and it is a cost optimiser as much as a latency one.
 *
 * The dependency closure of a write is not always small: a node save touches the node page and the
 * listings that carry it, a config change touches every page on the site. Regenerating both eagerly
 * turns the second into a stampede that spends more of the daily row budget than the day's traffic.
 */

const policies = (n: number, limit = 25): FanoutPolicy => fanoutDecision(n, limit).policy;

describe('the fanout decides how a content change is scheduled', () => {
	it('pays for a small change immediately, because the write can afford it', () => {
		const d = fanoutDecision(3, 25);
		expect(d.policy).toBe('immediate');
		expect(d.requeue).toBe(3);
		expect(d.armNow).toBe(true);
	});

	it('queues a medium one without pulling the alarm in', () => {
		const d = fanoutDecision(FANOUT_SMALL + 1, 100);
		expect(d.policy).toBe('background');
		expect(d.requeue).toBe(FANOUT_SMALL + 1);
		// the work happens, it just does not jump the chain
		expect(d.armNow).toBe(false);
	});

	it('leaves a huge one to the stale tier rather than queueing a stampede', () => {
		const d = fanoutDecision(FANOUT_MEDIUM + 1, 100);
		expect(d.policy).toBe('lazy');
		expect(d.requeue).toBe(0);
		expect(d.armNow).toBe(false);
	});

	it('is monotonic: more pages never means more eagerness', () => {
		const rank: Record<FanoutPolicy, number> = { immediate: 2, background: 1, lazy: 0 };
		let previous = rank[policies(1)];
		for (let n = 1; n <= FANOUT_MEDIUM + 5; n++) {
			const here = rank[policies(n)];
			expect(here, `fanout ${n}`).toBeLessThanOrEqual(previous);
			previous = here;
		}
	});

	it('never queues more than PREFILL_ON_SAVE allows', () => {
		// the cap is what stops one save writing an unbounded number of queue rows; this narrows
		// within it rather than replacing it
		expect(fanoutDecision(5, 2).requeue).toBe(2);
		expect(fanoutDecision(FANOUT_SMALL + 1, 3).requeue).toBe(3);
	});

	it('treats nothing invalidated as nothing to do', () => {
		expect(fanoutDecision(0, 25)).toMatchObject({ policy: 'lazy', requeue: 0, armNow: false });
		expect(fanoutDecision(-1, 25).requeue).toBe(0);
	});

	it('names a reason for every branch, so a scheduling decision is legible', () => {
		for (const n of [0, 1, FANOUT_SMALL + 1, FANOUT_MEDIUM + 1]) {
			expect(fanoutDecision(n, 25).reason.length, String(n)).toBeGreaterThan(0);
		}
	});

	it('puts the boundaries where the constants say', () => {
		expect(policies(FANOUT_SMALL)).toBe('immediate');
		expect(policies(FANOUT_SMALL + 1)).toBe('background');
		expect(policies(FANOUT_MEDIUM)).toBe('background');
		expect(policies(FANOUT_MEDIUM + 1)).toBe('lazy');
	});

	/**
	 * The lazy branch leaves pages to a tier that has to exist.
	 *
	 * `readStalePage()` needs `PAGE_KV` and the canonical `wrangler.jsonc` binds none, so the branch
	 * that "is not a refusal" was a cold render or a 503 for every visitor to every invalidated page
	 * after a config change. The precondition was written down and never checked.
	 */
	it('queues instead of going lazy when there is no stale tier to leave pages to', () => {
		const huge = FANOUT_MEDIUM + 1;
		expect(fanoutDecision(huge, 100, true).policy).toBe('lazy');

		const d = fanoutDecision(huge, 100, false);
		expect(d.policy).toBe('background');
		expect(d.requeue).toBe(Math.min(huge, 100));
		// still not jumping the chain: the point is that the work happens, not that it happens now
		expect(d.armNow).toBe(false);
		expect(d.reason.length).toBeGreaterThan(0);
	});

	it('still respects the queue cap with no stale tier', () => {
		expect(fanoutDecision(FANOUT_MEDIUM + 50, 3, false).requeue).toBe(3);
	});

	it('leaves the smaller branches alone, whether or not a stale tier exists', () => {
		for (const stale of [true, false]) {
			expect(fanoutDecision(0, 25, stale).policy).toBe('lazy');
			expect(fanoutDecision(1, 25, stale).policy).toBe('immediate');
			expect(fanoutDecision(FANOUT_SMALL + 1, 25, stale).policy).toBe('background');
		}
	});
});
