import { describe, expect, it } from 'vitest';
import {
	beatsByTwentyPercent,
	bootstrapMedianRatio,
	counterDelta,
	derivedJoulesPerView,
	floorBound,
	jPerView,
	median,
	normalizeBody,
	pairedRatios,
	publishedHostJoulesPerView,
	ratioGate,
	scaleRates,
	seededRandom,
	smoothPicker,
	spread,
	weightedMean
} from '../../scripts/measure/jview-math';
import { TRAFFIC_MIX } from '../../scripts/measure/verdict-math';

describe('jview-math', () => {
	it('takes the median of an even and an odd sample, and of nothing', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([])).toBe(0);
		expect(spread([5, 1, 3])).toEqual({ median: 3, min: 1, max: 5, n: 3 });
		expect(spread([]).n).toBe(0);
	});

	it('reads a counter across a wrap', () => {
		expect(counterDelta(100, 160, 1000)).toBe(60);
		expect(counterDelta(990, 30, 1000)).toBe(40);
	});

	it('subtracts idle for one figure and charges it for the other', () => {
		const j = jPerView({ windowJ: 300, elapsedS: 10, idleW: 18, views: 600 });
		expect(j?.subtracted).toBeCloseTo((300 - 180) / 600, 12);
		expect(j?.charged).toBeCloseTo(300 / 600, 12);
		expect(jPerView({ windowJ: 300, elapsedS: 10, idleW: 18, views: 0 })).toBeNull();
		expect(jPerView({ windowJ: 300, elapsedS: 0, idleW: 18, views: 5 })).toBeNull();
	});

	it('goes negative when a window cost less than the idle floor, rather than clamping it', () => {
		const j = jPerView({ windowJ: 170, elapsedS: 10, idleW: 18, views: 100 });
		expect(j?.subtracted).toBeLessThan(0);
	});

	it('picks every class in the stated proportion', () => {
		const pick = smoothPicker(
			Object.fromEntries(Object.entries(TRAFFIC_MIX).map(([k, v]) => [k, v.weight]))
		);
		const counts: Record<string, number> = {};
		for (let i = 0; i < 1000; i += 1) {
			const c = pick();
			counts[c] = (counts[c] ?? 0) + 1;
		}
		for (const [name, { weight }] of Object.entries(TRAFFIC_MIX)) {
			expect(Math.abs((counts[name] ?? 0) - weight * 1000)).toBeLessThanOrEqual(1);
		}
	});

	it('keeps the ratios of a rate ladder when it has to be scaled down', () => {
		expect(scaleRates([30, 60, 120], 1000)).toEqual([30, 60, 120]);
		expect(scaleRates([30, 60, 120], 60)).toEqual([8, 15, 30]);
		expect(Math.min(...scaleRates([30, 60, 120], 0.2))).toBeGreaterThanOrEqual(1);
	});

	it('reduces two hosts rendering one page to the same markup', () => {
		const a =
			'<head><link rel="stylesheet" href="/a.css"><script src="/a.js"></script></head>' +
			'<a href="http://100.1.1.1:8099/x">x</a><div class="js-view-dom-id-abc123">hi</div>';
		const b =
			'<head><link rel="stylesheet" href="/agg/1.css"></head>' +
			'<a href="http://bench.localhost/x">x</a><div class="js-view-dom-id-ffe902">hi</div>';
		expect(normalizeBody(a)).toBe(normalizeBody(b));
		expect(normalizeBody(a)).not.toBe(normalizeBody(b.replace('hi', 'bye')));
	});

	it('renormalises a weighted mean over the classes that have a value', () => {
		const w = { a: 0.5, b: 0.3, c: 0.2 };
		expect(weightedMean({ a: 10, b: 20, c: 30 }, w)).toBeCloseTo(17, 12);
		expect(weightedMean({ a: 10, b: 20 }, w)).toBeCloseTo((5 + 6) / 0.8, 12);
		expect(weightedMean({}, w)).toBeNull();
		expect(weightedMean({ a: Number.NaN }, w)).toBeNull();
	});

	it('applies the twenty percent rule at every rate and not at one', () => {
		expect(beatsByTwentyPercent([0.7, 0.75, 0.79], [1, 1, 1]).beats).toBe(true);
		expect(beatsByTwentyPercent([0.7, 0.75, 0.81], [1, 1, 1]).beats).toBe(false);
		expect(beatsByTwentyPercent([], []).beats).toBe(false);
		expect(beatsByTwentyPercent([0.8], [1]).beats).toBe(true);
	});

	it('pairs treatment over control and refuses what is not a ratio', () => {
		expect(pairedRatios([2, 4], [1, 1])).toEqual([0.5, 0.25]);
		expect(() => pairedRatios([1, 2], [1])).toThrow(/differ in length/);
		expect(() => pairedRatios([], [])).toThrow(/no paired blocks/);
		expect(() => pairedRatios([1, 0], [1, 1])).toThrow(/positive control/);
		expect(() => pairedRatios([1, -3], [1, 1])).toThrow(/positive control/);
	});

	it('bootstraps the same interval for one seed and another for a second', () => {
		const noisy = [0.5, 0.9, 0.6, 1.1, 0.7, 0.8, 1.3, 0.4, 0.95, 0.65];
		const o = { iterations: 40, level: 0.5 };
		const a = bootstrapMedianRatio(noisy, { ...o, seed: 7 });
		expect(bootstrapMedianRatio(noisy, { ...o, seed: 7 })).toEqual(a);
		const b = bootstrapMedianRatio(noisy, { ...o, seed: 8 });
		expect([b.lo, b.hi]).not.toEqual([a.lo, a.hi]);
		expect(a.lo).toBeLessThanOrEqual(a.median);
		expect(a.hi).toBeGreaterThanOrEqual(a.median);
		expect(a.n).toBe(10);
		const flat = bootstrapMedianRatio([0.6, 0.6, 0.6, 0.6]);
		expect([flat.lo, flat.hi, flat.median]).toEqual([0.6, 0.6, 0.6]);
		const r = seededRandom(3);
		const xs = Array.from({ length: 100 }, r);
		expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
		expect(Array.from({ length: 100 }, seededRandom(3))).toEqual(xs);
	});

	it('passes a ratio gate only on the upper bound, and never on a short sample', () => {
		const near = [0.55, 0.6, 0.62, 0.58, 0.6, 0.63, 0.57, 0.61, 0.59, 0.6];
		expect(ratioGate(near, 0.75).verdict).toBe('pass');
		const wide = [0.5, 0.6, 0.7, 0.8, 0.9, 0.55, 0.65, 0.74, 0.85, 0.95];
		const g = ratioGate(wide, 0.75);
		expect(g.median).toBeLessThanOrEqual(0.75);
		expect(g.hi).toBeGreaterThan(0.75);
		expect(g.verdict).toBe('fail');
		const nine = ratioGate(Array(9).fill(0.1), 0.75);
		expect(nine.verdict).toBe('insufficient');
		expect(ratioGate(Array(9).fill(0.1), 0.75, { minBlocks: 9 }).verdict).toBe('pass');
		const aa = pairedRatios(Array(10).fill(5), Array(10).fill(5));
		expect(ratioGate(aa, 0.75).verdict).toBe('fail');
		expect(ratioGate(aa, 0.75).threshold).toBe(0.75);
	});

	it('bounds the best ratio by what a null responder already costs', () => {
		const f = floorBound(176, 120);
		expect(f.minRatio).toBeCloseTo(0.682, 3);
		expect(f.share).toBe(f.minRatio);
		expect(f.canShow(0.75)).toBe(true);
		expect(floorBound(176, 150).canShow(0.75)).toBe(false);
		expect(floorBound(100, 120).minRatio).toBeGreaterThan(1);
		expect(() => floorBound(0, 1)).toThrow(/positive/);
		expect(() => floorBound(-1, 1)).toThrow(/positive/);
		expect(() => floorBound(10, -1)).toThrow(/null responder/);
	});

	it('attributes a network total over its requests and then over a view', () => {
		const j = derivedJoulesPerView({
			cloudflareJoulesPerYear: 3_155_760_000,
			requestsPerSecond: 100,
			requestsPerView: 3
		});
		expect(j).toBeCloseTo((3_155_760_000 / (100 * 31_557_600)) * 3, 12);
	});

	it('charges a shared server its idle over the views it answers', () => {
		const j = publishedHostJoulesPerView({
			idleW: 100,
			loadedW: 300,
			loadedFraction: 0,
			sitesPerServer: 10,
			viewsPerSitePerMonth: 2_629_800,
			pue: 1
		});
		expect(j).toBeCloseTo(10 / 1, 6);
	});
});
