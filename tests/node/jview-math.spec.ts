import { describe, expect, it } from 'vitest';
import {
	beatsByTwentyPercent,
	counterDelta,
	derivedJoulesPerView,
	jPerView,
	median,
	normalizeBody,
	publishedHostJoulesPerView,
	scaleRates,
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
