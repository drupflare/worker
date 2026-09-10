import { describe, expect, it } from 'vitest';
import {
	type Cell,
	TRAFFIC_MIX,
	decide,
	ratio,
	weightedP50,
	withRtt
} from '../../scripts/measure/verdict-math';
import type { Summary } from '../../scripts/measure/vps-compare';

/**
 * The viability predicate, driven over fixtures rather than over two live hosts.
 *
 * `host-verdict.ts` needs nginx, php-fpm, a `wrangler dev` and several minutes to produce one
 * verdict, so nothing in a hermetic lane can exercise the decision it makes. The decision is where
 * the mistakes live: this project's "225x" came from a human dividing two numbers taken under
 * different conditions, and a weighted mean plus two refusal rules has more ways to be wrong than
 * that did.
 *
 * Every case below is a shape the runner can emit, including the ones a real run is unlikely to
 * reach: a cell where drupflare loses, a generator-bound cell, an empty matrix, a partial workload
 * set. A predicate that only holds on the happy result is not a predicate.
 */

/** a Summary with the fields the verdict reads, and defaults for the rest */
function summary(p50: number, p95 = p50, over: Partial<Summary> = {}): Summary {
	return {
		workload: 'anon-cached',
		concurrency: 1,
		n: 100,
		errors: 0,
		rps: 100,
		p50,
		p95,
		p99: p95,
		min: p50,
		max: p95,
		// the MEAN defaults to p50 here rather than being omitted: the verdict does not read it, and a
		// fixture that left it undefined would make every cell look like a tight distribution
		mean: p50,
		tiers: {},
		workerMs: null,
		clientMs: null,
		gateAhead: null,
		bytes: 12_000,
		...over
	};
}

/**
 * A cell from two arms, with the ratios DERIVED rather than passed in.
 *
 * Deriving them is what keeps a fixture from asserting a ratio the arms beside it do not support,
 * which the first version of this helper did: a partial `vps` override replaced the whole summary
 * and silently dropped its p50.
 */
function cell(workload: string, vps: Summary, edge: Summary, generatorBound = false): Cell {
	return {
		workload,
		concurrency: vps.concurrency,
		vps,
		edge,
		p50Ratio: ratio(vps.p50, edge.p50),
		p95Ratio: ratio(vps.p95, edge.p95),
		rpsRatio: ratio(edge.rps, vps.rps),
		generatorBound
	};
}

/** the common case: two arms that differ only in latency */
const pair = (workload: string, vpsP50: number, edgeP50: number): Cell =>
	cell(workload, summary(vpsP50), summary(edgeP50));

describe('ratio', () => {
	it('is above 1 when drupflare is faster, which is the direction every caller reads', () => {
		expect(ratio(100, 10)).toBe(10);
	});

	it('is 1 for two zeroes rather than NaN', () => {
		// both arms under the timer's resolution is agreement, not a division to report
		expect(ratio(0, 0)).toBe(1);
	});

	it('is Infinity when only drupflare is at zero', () => {
		expect(ratio(50, 0)).toBe(Infinity);
	});
});

describe('withRtt', () => {
	it('leaves the localhost reading alone at rtt 0, which is what the verdict uses', () => {
		expect(withRtt(12, 0)).toBe(12);
	});

	it('adds ONE round trip, not two', () => {
		// a doubled term would overstate the gap, and overstating is the error this whole harness
		// is arranged to avoid
		expect(withRtt(12, 25)).toBe(37);
	});
});

describe('weightedP50', () => {
	it('renormalises over the workloads present, so a partial run is not deflated', () => {
		// anon-cached alone carries weight 0.82; a mean that divided by 1.0 would report 82% of the
		// real figure and make any arm look better than it is
		const cells = [pair('anon-cached', 100, 10)];
		expect(weightedP50(cells, (c) => c.vps.p50)).toBe(100);
	});

	it('averages the concurrency levels within one workload before weighting', () => {
		const cells = [
			{ ...pair('anon-cached', 10, 5), concurrency: 1 },
			{ ...pair('anon-cached', 30, 5), concurrency: 4 }
		];
		expect(weightedP50(cells, (c) => c.vps.p50)).toBe(20);
	});

	it('weights a heavy slice above a light one', () => {
		// anon-cached 0.82 against auth-admin 0.03: a slow authenticated cell cannot dominate
		const cells = [pair('anon-cached', 10, 10), pair('auth-admin', 1000, 1000)];
		const weighted = weightedP50(cells, (c) => c.vps.p50);
		expect(weighted).toBeGreaterThan(10);
		expect(weighted).toBeLessThan(60);
	});

	it('is 0 for an empty matrix rather than NaN', () => {
		expect(weightedP50([], (c) => c.vps.p50)).toBe(0);
	});

	it('ignores a workload the mix does not name, instead of weighting it at zero silently', () => {
		const cells = [pair('anon-cached', 10, 10), pair('not-a-workload', 9999, 9999)];
		expect(weightedP50(cells, (c) => c.vps.p50)).toBe(10);
	});
});

describe('decide', () => {
	it('calls a clean sweep viable', () => {
		const cells = [pair('anon-cached', 40, 4), pair('auth-admin', 70, 5)];
		const v = decide(cells);
		expect(v.viable).toBe(true);
		expect(v.regressions).toEqual([]);
		expect(v.weightedRatio).toBeGreaterThan(1);
	});

	it('refuses an empty matrix rather than calling a host viable on no evidence', () => {
		// 0 <= 0 is true, so a verdict built only from the weighted comparison would answer yes
		expect(decide([]).viable).toBe(false);
	});

	it('fails on an error drupflare produced and the VPS did not', () => {
		const cells = [cell('anon-cached', summary(40), summary(4, 4, { errors: 3 }))];
		const v = decide(cells);
		expect(v.viable).toBe(false);
		expect(v.regressions[0]).toContain('errored');
	});

	it('does NOT fail on an error both arms produced', () => {
		// a workload that 404s on both sides is a rig fault, not a host regression
		const cells = [
			cell('anon-cached', summary(40, 40, { errors: 3 }), summary(4, 4, { errors: 3 }))
		];
		expect(decide(cells).viable).toBe(true);
	});

	it('fails a cell more than 2x worse on p95', () => {
		const cells = [cell('anon-cached', summary(10, 10), summary(10, 40))];
		const v = decide(cells);
		expect(v.viable).toBe(false);
		expect(v.regressions[0]).toContain('worse than 2x');
	});

	it('excuses that same cell when the generator bounded it', () => {
		// a cell at the generator's ceiling measures the generator; a p95 taken there is not the
		// host's to be judged on
		const cells = [cell('anon-cached', summary(10, 10), summary(10, 40), true)];
		expect(decide(cells).regressions).toEqual([]);
	});

	it('tolerates losing the uncached tail while the weighted mean still wins', () => {
		// the shape a real run is expected to produce: drupflare regenerates asynchronously, so the
		// 9.5% miss slice is slower, and the 82% cached slice is what decides the host
		const cells = [pair('anon-cached', 40, 3), pair('anon-miss', 60, 90)];
		const v = decide(cells);
		expect(v.viable).toBe(true);
		expect(v.weighted.edge).toBeLessThan(v.weighted.vps);
	});

	it('fails when a slice large enough to matter loses, even with no single-cell regression', () => {
		// every cell inside 2x, so rule 2 passes; rule 3 is what catches it
		const cells = [pair('anon-cached', 10, 18), pair('auth-admin', 100, 60)];
		const v = decide(cells);
		expect(v.regressions).toEqual([]);
		expect(v.viable).toBe(false);
	});

	it('carries the notes it was given through to the verdict', () => {
		const v = decide([pair('anon-cached', 40, 4)], 0, ['the plan tier never answered']);
		expect(v.notes).toEqual(['the plan tier never answered']);
	});

	it('moves the weighted VPS figure up when a network term is priced, never down', () => {
		const cells = [pair('anon-cached', 40, 4)];
		const local = decide(cells, 0);
		const remote = decide(cells, 25);
		expect(remote.weighted.vps).toBeGreaterThan(local.weighted.vps);
		expect(remote.weighted.edge).toBe(local.weighted.edge);
	});
});

describe('the traffic mix', () => {
	it('sums to 1', () => {
		const total = Object.values(TRAFFIC_MIX).reduce((n, m) => n + m.weight, 0);
		expect(total).toBeCloseTo(1, 6);
	});

	it('gives every slice a stated reason, so a weight cannot be a bare number', () => {
		for (const [name, m] of Object.entries(TRAFFIC_MIX)) {
			expect(m.why, name).not.toBe('');
			expect(m.weight, name).toBeGreaterThan(0);
		}
	});

	it('makes the anonymous cached read the dominant slice', () => {
		const anon = TRAFFIC_MIX['anon-cached']?.weight ?? 0;
		const rest = Object.entries(TRAFFIC_MIX)
			.filter(([k]) => k !== 'anon-cached')
			.reduce((n, [, m]) => n + m.weight, 0);
		expect(anon).toBeGreaterThan(rest);
	});
});
