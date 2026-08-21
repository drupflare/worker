import { describe, expect, it } from 'vitest';
import {
	MIN_SAMPLES,
	pairedSlope,
	renderReport,
	slopeDispersion,
	summarise,
	type Pair,
	type Reading
} from '../../scripts/measure/bench';

/**
 * The harness that makes RULE 0 mechanical.
 *
 * Every sweep in this project so far hand-rolled its own median and its own honesty, and the
 * failures were always the same three: a figure quoted at n=1, a figure quoted without its spread,
 * and a comparison made across objects rather than within one. These tests pin the refusals, because
 * a harness that CAN produce a forbidden number will eventually produce one.
 *
 * The 2.8x dispersion is not illustrative. It is the range of marginal render cost measured across
 * real objects, and it is why the theme-reset sweep would have published 2.7x the true figure if
 * nobody had paired.
 */

/** the four samples that must not be enough, whatever they say */
const TOO_FEW = [10, 10, 10, 10];

describe('summarise refuses what RULE 0 refuses', () => {
	it('returns null below the sample floor rather than a confident median', () => {
		expect(TOO_FEW).toHaveLength(MIN_SAMPLES - 1);
		expect(summarise(TOO_FEW)).toBeNull();
		// and a single sample is the case that has actually been quoted before
		expect(summarise([1234])).toBeNull();
	});

	it('answers at exactly the floor, so the boundary is inclusive', () => {
		const s = summarise([5, 1, 3, 2, 4]);
		expect(s?.n).toBe(5);
		expect(s?.median).toBe(3);
		expect(s?.min).toBe(1);
		expect(s?.max).toBe(5);
		expect(s?.spread).toBe(4);
	});

	it('takes the mean of the middle two on an even count', () => {
		expect(summarise([1, 2, 3, 4, 10, 20])?.median).toBe(3.5);
	});

	it('drops non-finite samples rather than poisoning the median', () => {
		// a dropped tag or a failed query arrives as NaN; it must not become a number
		expect(summarise([1, 2, NaN, 3, 4, 5])?.n).toBe(5);
		expect(summarise([1, NaN, NaN, 2, 3])).toBeNull();
	});

	it('does not mutate the caller array, which is shared with the report', () => {
		const input = [3, 1, 2, 5, 4];
		summarise(input);
		expect(input).toEqual([3, 1, 2, 5, 4]);
	});
});

describe('pairing, which is the part that was getting the answer wrong', () => {
	/** five objects, each ~4 ms/request slower in the high arm, on wildly different baselines */
	const PAIRS: Pair[] = [
		{ object: 'a', lowMs: 200, highMs: 580 },
		{ object: 'b', lowMs: 2400, highMs: 2790 },
		{ object: 'c', lowMs: 4800, highMs: 5170 },
		{ object: 'd', lowMs: 1800, highMs: 2200 },
		{ object: 'e', lowMs: 4300, highMs: 4680 }
	];

	it('divides by the span between arms, not by the high arm', () => {
		const s = pairedSlope(PAIRS, 5, 100);
		// each object moved ~380-390 ms across 95 renders, so ~4 ms/request
		expect(s?.n).toBe(5);
		expect(s?.median).toBeGreaterThan(3.9);
		expect(s?.median).toBeLessThan(4.2);
	});

	it('refuses a non-positive span rather than dividing by zero', () => {
		expect(pairedSlope(PAIRS, 100, 100)).toBeNull();
		expect(pairedSlope(PAIRS, 100, 5)).toBeNull();
	});

	it('inherits the sample floor, so four paired objects are still not a measurement', () => {
		expect(pairedSlope(PAIRS.slice(0, 4), 5, 100)).toBeNull();
	});

	/**
	 * THE MEASUREMENT THAT SAYS WHETHER PAIRING MATTERED.
	 *
	 * Real objects ranged 45.4 to 135.8 ms/render for identical work. Dispersion reports that
	 * disagreement directly, which is the honest thing paired data can support -- an earlier metric
	 * here tried to report "how wrong unpaired would have been" and could not, because within a
	 * matched set both medians land on the same object. It read 1.026x on a fixture built to show a
	 * gap, and the test asserting `> 1` passed anyway. That is a probe that cannot fail.
	 */
	it('reports how far the objects disagree in per-request cost', () => {
		const varied: Pair[] = [
			{ object: 'a', lowMs: 200, highMs: 200 + 95 * 1 },
			{ object: 'b', lowMs: 400, highMs: 400 + 95 * 2 },
			{ object: 'c', lowMs: 2000, highMs: 2000 + 95 * 4 },
			{ object: 'd', lowMs: 4000, highMs: 4000 + 95 * 8 },
			{ object: 'e', lowMs: 5000, highMs: 5000 + 95 * 10 }
		];
		// slopes 1, 2, 4, 8, 10 -> the population spans a factor of ten
		expect(slopeDispersion(varied, 5, 100)).toBeCloseTo(10, 6);
	});

	it('reports ~1 when every object agrees, which means pairing was not load-bearing', () => {
		expect(slopeDispersion(PAIRS, 5, 100)).toBeLessThan(1.1);
	});

	it('refuses a dispersion below the sample floor or on a non-positive slope', () => {
		expect(slopeDispersion(PAIRS.slice(0, 4), 5, 100)).toBeNull();
		const flat: Pair[] = ['a', 'b', 'c', 'd', 'e'].map((object) => ({
			object,
			lowMs: 1000,
			highMs: 1000
		}));
		expect(slopeDispersion(flat, 5, 100)).toBeNull();
	});
});

describe('the report, which has no format that omits n or spread', () => {
	const scenario = { name: 'front page', path: '/', bins: ['page'], lowN: 5, highN: 100 };

	const reading = (paired: Reading['paired'], extra: Partial<Reading> = {}): Reading => ({
		scenario,
		paired,
		dispersion: null,
		discardedContended: 0,
		...extra
	});

	it('prints n, min, median, max and spread on every resolved row', () => {
		const out = renderReport([reading({ n: 7, min: 3.1, median: 4.4, max: 9.8, spread: 6.7 })]);
		expect(out).toContain('| 7 |');
		expect(out).toContain('4.4 ms');
		expect(out).toContain('3.1 ms');
		expect(out).toContain('9.8 ms');
		expect(out).toContain('6.7 ms');
	});

	it('renders a refusal rather than a number when the samples were too few', () => {
		const out = renderReport([reading(null)]);
		expect(out).toContain('unresolved');
		expect(out).toContain('too few');
		expect(out).not.toMatch(/\d+\.\d ms/);
	});

	it('names the emptied bins, and says so explicitly when none were', () => {
		expect(renderReport([reading(null)])).toContain('page');
		const warm = renderReport([{ ...reading(null), scenario: { ...scenario, bins: [] } }]);
		// silence would read as "unknown"; this reads as a stated condition
		expect(warm).toContain('none (all warm)');
	});

	it('surfaces a large slope dispersion as its own section', () => {
		const out = renderReport([
			reading({ n: 10, min: -9.9, median: 4.4, max: 9.8, spread: 19.7 }, { dispersion: 2.8 })
		]);
		expect(out).toContain('2.8x');
		expect(out).toContain('measured the assignment');
	});

	it('says how many contended samples it dropped, since a silent drop is a changed population', () => {
		const out = renderReport([
			reading({ n: 6, min: 1, median: 2, max: 3, spread: 2 }, { discardedContended: 12 })
		]);
		expect(out).toContain('12 contended samples');
		expect(out).toContain('single-threaded');
	});
});
