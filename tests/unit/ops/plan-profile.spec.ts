import { describe, expect, it } from 'vitest';
import {
	FREE_PROFILE,
	PAID_PROFILE,
	planProfile,
	resolvePlanNumber
} from '../../../src/ops/plan-profile';

/**
 * `PLAN=paid` used to reach two decisions and leave five constants sized for a 10 ms cap, so a paid
 * site paid for headroom and then behaved like a free one. These assertions are the five knobs and
 * the one outcome, not a restatement of the table.
 */

describe('the profiles', () => {
	it('gives free everything sized for a 10 ms cap, unchanged from the measured constants', () => {
		expect(FREE_PROFILE).toEqual({
			fillBatchSize: 5,
			fillBatchWallMs: 5_000,
			httpDrainLimit: 3,
			mirrorLimit: 2,
			inlineBudgetMs: 2_000,
			bootInline: false
		});
	});

	it('raises the budgets paid can actually spend', () => {
		for (const key of [
			'fillBatchSize',
			'httpDrainLimit',
			'mirrorLimit',
			'inlineBudgetMs'
		] as const) {
			expect(PAID_PROFILE[key], key).toBeGreaterThan(FREE_PROFILE[key]);
		}
	});

	it('SHORTENS the fill occupancy on paid rather than lengthening it', () => {
		// the batch is bounded by HIT latency, not by the CPU budget. A fill holds the object's
		// single thread, so at fillBatchSize 25 a deployed alarm cost 4,337-5,832 ms of cpuTime and
		// every cache HIT racing it waited 5.0-6.8 s of wall. The alarm re-arms in 130-160 ms while
		// the queue is non-empty, so a smaller batch costs no throughput
		expect(PAID_PROFILE.fillBatchWallMs).toBeLessThan(FREE_PROFILE.fillBatchWallMs);
		// 8 fills at a measured 81 ms median render is ~650 ms of worst-case occupancy
		expect(PAID_PROFILE.fillBatchSize * 100).toBeLessThan(PAID_PROFILE.fillBatchWallMs * 2);
	});

	it('permits a cold boot on paid only, which is the one knob that changes an outcome', () => {
		expect(FREE_PROFILE.bootInline).toBe(false);
		expect(PAID_PROFILE.bootInline).toBe(true);
	});

	it('keeps paid BOUNDED rather than unlimited', () => {
		// a DO is single-threaded and a fill holds the gate, so an unbounded batch would block
		// every request to the object for its duration
		expect(PAID_PROFILE.fillBatchSize).toBeLessThanOrEqual(50);
		expect(Number.isFinite(PAID_PROFILE.fillBatchWallMs)).toBe(true);
	});

	it('never lets an occupancy bound be raised past what a HIT will tolerate', () => {
		// paid also bills duration, so a long alarm is a GB-s cost as well as a latency one
		expect(PAID_PROFILE.fillBatchWallMs).toBeLessThanOrEqual(5_000);
	});
});

describe('planProfile', () => {
	it('reads PLAN=paid', () => {
		expect(planProfile({ PLAN: 'paid' })).toBe(PAID_PROFILE);
		expect(planProfile({ PLAN: 'PAID' })).toBe(PAID_PROFILE);
	});

	it('falls to free for absent, empty and misspelled values', () => {
		// a typo must not silently grant a paid profile to something with a 10 ms cap
		for (const PLAN of [undefined, '', 'free', 'paidd', 'Paid ', 'pro', '1']) {
			expect(planProfile({ PLAN }), String(PLAN)).toBe(FREE_PROFILE);
		}
		expect(planProfile(null)).toBe(FREE_PROFILE);
		expect(planProfile()).toBe(FREE_PROFILE);
	});
});

describe('resolvePlanNumber', () => {
	it('prefers an explicit override over the profile, on either plan', () => {
		expect(resolvePlanNumber('11', 'fillBatchSize', 50, { PLAN: 'free' })).toBe(11);
		expect(resolvePlanNumber('11', 'fillBatchSize', 50, { PLAN: 'paid' })).toBe(11);
	});

	it('accepts the value as a number as well as a string, because wrangler sends strings', () => {
		expect(resolvePlanNumber(7, 'httpDrainLimit', 25, null)).toBe(7);
	});

	it('falls to the profile for absent, empty and unparseable values', () => {
		for (const raw of [undefined, null, '', 'lots', NaN]) {
			expect(resolvePlanNumber(raw, 'fillBatchSize', 50, { PLAN: 'paid' })).toBe(
				PAID_PROFILE.fillBatchSize
			);
		}
	});

	it('caps the override, so an operator typo cannot hang the object', () => {
		expect(resolvePlanNumber('100000', 'fillBatchSize', 50, { PLAN: 'paid' })).toBe(50);
	});

	it('caps the PROFILE too, not just the override', () => {
		// the cap bounds one invocation; a profile raised past it later must not slip through
		expect(resolvePlanNumber(undefined, 'fillBatchSize', 3, { PLAN: 'paid' })).toBe(3);
	});

	it('honours a zero, because RENDER_BUDGET_MS=0 is the documented always-503 switch', () => {
		expect(resolvePlanNumber('0', 'inlineBudgetMs', 60_000, { PLAN: 'paid' })).toBe(0);
	});

	it('refuses a negative rather than treating it as a budget', () => {
		expect(resolvePlanNumber('-5', 'inlineBudgetMs', 60_000, { PLAN: 'free' })).toBe(
			FREE_PROFILE.inlineBudgetMs
		);
	});
});
