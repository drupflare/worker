import { describe, expect, it } from 'vitest';
import {
	TRAFFIC_MIX,
	decide,
	generatorBound,
	ratio,
	unusable,
	weightedP50,
	withRtt,
	type Cell
} from '../../scripts/measure/verdict-math';
import { isLocalTarget, spreadHeaders, type Summary } from '../../scripts/measure/vps-compare';

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
		// zero is the only healthy value; a run with any of these exits before it reaches a verdict
		edgeRefusals: 0,
		// the MEAN defaults to p50 here rather than being omitted: the verdict does not read it, and a
		// fixture that left it undefined would make every cell look like a tight distribution
		mean: p50,
		tiers: {},
		// which objects answered; a fixture asserts on the verdict maths and drives no pool
		replicas: {},
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

describe('the p95 rule needs a gap the clock can resolve', () => {
	// THE CELL THAT FAILED THE WHOLE VERDICT, 2026-09-11: `anon-cached c=1`, edge p95 3ms against
	// the VPS's 1ms. Every sample is a `Date.now()` delta, so both readings are small integer counts
	// of quanta and "3x worse" is arithmetic on the quantisation
	const quantised = cell('anon-cached', summary(0, 1), summary(2, 3));

	it('does not call a 2ms gap a regression when the rig resolves 2ms', () => {
		const v = decide([quantised], 0, [], TRAFFIC_MIX, 'total-p50', 2);
		expect(v.regressions).toEqual([]);
	});

	it('SAYS it skipped one rather than dropping it silently', () => {
		const notes: string[] = [];
		decide([quantised], 0, notes, TRAFFIC_MIX, 'total-p50', 2);
		expect(notes.join('\n')).toContain('clock quantum');
	});

	it('still fails the same ratio once the gap clears the floor', () => {
		// the falsifying half: identical ratio, magnitudes the clock can actually separate
		const real = cell('anon-cached', summary(0, 40), summary(2, 120));
		const v = decide([real], 0, [], TRAFFIC_MIX, 'total-p50', 2);
		expect(v.regressions).toEqual(['anon-cached c=1: p95 120ms against 40ms, worse than 2x']);
	});

	it('defaults to the clock quantum, so a caller with no measured floor still gets one', () => {
		const v = decide([cell('anon-cached', summary(0, 1), summary(0, 3))]);
		expect(v.regressions).toEqual(['anon-cached c=1: p95 3ms against 1ms, worse than 2x']);
	});
});

describe('generatorBound reads the ceiling at the cell own width', () => {
	// the shape that was measured: one ceiling for every level, taken by a batched `Promise.all`
	// barrier while the cells drove an open pool, so the VPS cleared its own asserted bound by 2.2x
	const perLevel = { vps: { 1: 2000, 4: 6000, 16: 9000 }, edge: { 1: 500, 4: 900, 16: 1100 } };

	it('flags a cell within 20% of the ceiling for ITS concurrency', () => {
		expect(generatorBound(4, { vps: 5900, edge: 640 }, perLevel)).toBe(true);
	});

	it('leaves the same reading alone at a width whose ceiling is higher', () => {
		// 5,900 req/s clears the c=1 ceiling of 2,000 outright and sits inside 20% of the c=4 one;
		// against the c=16 ceiling of 9,000 it is not bound at all. One number cannot answer all
		// three, which is the defect this function replaced
		expect(generatorBound(16, { vps: 5900, edge: 640 }, perLevel)).toBe(false);
	});

	it('flags on EITHER arm, because a bound cell measures neither host', () => {
		expect(generatorBound(1, { vps: 10, edge: 480 }, perLevel)).toBe(true);
	});

	it('answers false for a level with no ceiling rather than excluding the cell', () => {
		// generatorBound excludes a cell from the p95 rule downstream, so a missing measurement
		// that answered true would switch a verdict rule off silently
		expect(generatorBound(32, { vps: 99_999, edge: 99_999 }, perLevel)).toBe(false);
	});

	it('does not divide by a zero ceiling', () => {
		expect(generatorBound(1, { vps: 1, edge: 1 }, { vps: { 1: 0 }, edge: { 1: 0 } })).toBe(
			false
		);
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

/**
 * A cell that measured a stopped server.
 *
 * The local worker crashed mid-run and every later request returned status 0 in about a
 * millisecond, so the arm read `p50 0ms` and -- before `rps` counted successes only -- 45,279
 * req/s. The `ERRORS` flag fired and the verdict still folded that p50 into the weighted mean, so a
 * crash could read as a win on the slice it crashed during.
 */
describe('a run that measured a crash cannot answer either way', () => {
	/** what a stopped server looks like: instant, and every request a failure */
	const dead = (workload: string): Cell =>
		cell(workload, summary(10), { ...summary(0), n: 200, errors: 200 });

	it('names the cell as unusable rather than as a fast one', () => {
		const out = decide([pair('anon-cached', 3, 2), dead('anon-cached')]);
		expect(out.regressions.join(' ')).toContain('unusable');
		expect(out.viable, 'a crash produced a verdict').toBe(false);
	});

	it('keeps the dead cell out of the weighted mean', () => {
		const healthy = [pair('anon-cached', 10, 5)];
		const alone = decide(healthy);
		const withDead = decide([...healthy, dead('anon-cached')]);
		// a p50 of 0 folded in would drag the edge mean down and flatter the arm that failed:
		// (5 + 0) / 2 against 5. The control below is that the maths is reachable at all
		expect(withDead.weighted.edge).toBe(alone.weighted.edge);
		expect(alone.weighted.edge).toBe(5);
	});

	it('leaves a cell with a few errors alone, because a refusal is sometimes the measurement', () => {
		const flaky = cell('anon-miss', summary(20), { ...summary(25), n: 200, errors: 2 });
		expect(unusable(flaky)).toBe(false);
		// still reported as a regression, which is the existing behaviour and is not this rule
		expect(decide([flaky]).regressions.join(' ')).toContain('errored');
	});
});

/**
 * The generator's own trust boundary, and the one place it can measure something other than a host.
 *
 * Cloudflare owns `cf-connecting-ip` and answers 403 at the edge to any request that presents one.
 * miniflare accepts whatever is sent, and that header is the only spread a single-address generator
 * has locally -- so the header is right on one target and fatal on the other, and nothing in a
 * summary says which happened: a refusal is a fast 403.
 */
describe('the spread header', () => {
	it('is sent to a local target and to nothing else', () => {
		expect(spreadHeaders('http://127.0.0.1:8787', 0)).toHaveProperty('cf-connecting-ip');
		expect(spreadHeaders('http://localhost:8099', 3)).toHaveProperty('cf-connecting-ip');
		expect(spreadHeaders('https://cfw-probe.example.workers.dev', 0)).toEqual({});
		expect(spreadHeaders('https://example.com', 7)).toEqual({});
	});

	it('gives each local client its own address, which is what reaches more than one lane', () => {
		const a = spreadHeaders('http://127.0.0.1:8787', 0)['cf-connecting-ip'];
		const b = spreadHeaders('http://127.0.0.1:8787', 1)['cf-connecting-ip'];
		expect(a).not.toBe(b);
	});

	it('recognises the hosts that are this machine', () => {
		expect(isLocalTarget('http://127.0.0.1:8787')).toBe(true);
		expect(isLocalTarget('http://[::1]:8787')).toBe(true);
		expect(isLocalTarget('https://rig.local')).toBe(true);
		expect(isLocalTarget('https://cfw-probe.example.workers.dev')).toBe(false);
	});
});

/**
 * The rig can measure two different quantities and they answer different questions. What is pinned
 * here is that the verdict SAYS which one, and that choosing service time cannot quietly flatter the
 * edge arm: a cell that stamped no `x-worker-ms` falls back to its own p50 rather than to 0.
 */
describe('which quantity the verdict decided on', () => {
	const withWorker = (p50: number, workerMs: number | null): Summary => ({
		...summary(p50),
		workerMs
	});

	it('uses total p50 by default and says so', () => {
		const out = decide([cell('anon-cached', summary(10), withWorker(40, 3))]);
		expect(out.decidedOn).toBe('total-p50');
		expect(out.weighted.edge).toBe(40);
		expect(out.because).toContain('TOTAL p50');
	});

	it('uses the edge arm own clock when asked, and reports the choice', () => {
		const out = decide(
			[cell('anon-cached', summary(10), withWorker(40, 3))],
			0,
			[],
			undefined,
			'service-time'
		);
		expect(out.decidedOn).toBe('service-time');
		// 40 ms of total was 37 ms of network to one colo; 3 ms is what the host did
		expect(out.weighted.edge).toBe(3);
		expect(out.weightedRatio).toBeCloseTo(10 / 3, 5);
		expect(out.because).toContain('SERVICE TIME');
	});

	it('falls back to p50 for a cell that stamped no worker time', () => {
		const out = decide(
			[cell('anon-cached', summary(10), withWorker(40, null))],
			0,
			[],
			undefined,
			'service-time'
		);
		// 0 would make the arm that reported nothing look infinitely fast
		expect(out.weighted.edge).toBe(40);
	});

	it('still prices the network on the vps side when one is stated', () => {
		const out = decide(
			[cell('anon-cached', summary(10), withWorker(40, 3))],
			25,
			[],
			undefined,
			'service-time'
		);
		expect(out.weighted.vps).toBe(35);
	});
});
