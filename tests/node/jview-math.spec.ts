import { describe, expect, it } from 'vitest';
import {
	type BodyReading,
	FLOOR_CLOSED,
	FLOOR_OPEN,
	type FloorRow,
	beatsByTwentyPercent,
	bodiesAgree,
	bootstrapMedianRatio,
	counterDelta,
	derivedJoulesPerView,
	floorBound,
	floorLadder,
	floorOverall,
	floorVerdict,
	jPerView,
	median,
	normalizeBody,
	pairByBlock,
	pairedRatios,
	publishedHostJoulesPerView,
	ratioGate,
	scaleRates,
	seededRandom,
	smoothPicker,
	spread,
	waitOutWifiDrop,
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

	it('pairs an arm and a host by block and drops a block either side lacks', () => {
		const host = new Map([
			[0, 2],
			[1, 4],
			[2, 6],
			[3, 8]
		]);
		const arm = new Map([
			[0, 1],
			[2, 3],
			[3, 4],
			[4, 9]
		]);
		expect(pairByBlock(host, arm)).toEqual({ control: [2, 6, 8], treatment: [1, 3, 4] });
	});

	it('is insufficient at nine aligned blocks and decides at ten', () => {
		const blocks = (n: number, v: number) =>
			new Map(Array.from({ length: n }, (_, i) => [i, v]));
		const nine = pairByBlock(blocks(9, 1), blocks(9, 0.6));
		expect(ratioGate(pairedRatios(nine.control, nine.treatment), 0.75).verdict).toBe(
			'insufficient'
		);
		const near = [0.55, 0.6, 0.62, 0.58, 0.6, 0.63, 0.57, 0.61, 0.59, 0.6];
		const ten = pairByBlock(blocks(10, 1), new Map(near.map((v, i) => [i, v])));
		expect(ratioGate(pairedRatios(ten.control, ten.treatment), 0.75).verdict).toBe('pass');
	});

	it('decides a floor rung on the interval, not the median, and not on nine blocks', () => {
		const spreadAround = (c: number) =>
			[0, 0.01, -0.01, 0.02, -0.02, 0.01, 0, -0.01, 0.02, -0.02].map((d) => c + d);
		expect(floorVerdict(spreadAround(0.6)).verdict).toBe('open');
		expect(floorVerdict(spreadAround(1.0)).verdict).toBe('closed');
		expect(floorVerdict(spreadAround(0.85)).verdict).toBe('between');
		expect(floorVerdict(spreadAround(0.6).slice(0, 9)).verdict).toBe('insufficient');
		const wide = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 0.3, 1.2];
		expect(floorVerdict(wide).median).toBeLessThan(FLOOR_OPEN + 0.1);
		expect(floorVerdict(wide).verdict).toBe('between');
		expect(FLOOR_OPEN).toBeCloseTo(130 / 176, 1);
		expect(FLOOR_CLOSED).toBeGreaterThanOrEqual(170 / 176);
		expect(FLOOR_CLOSED).toBeLessThanOrEqual(180 / 176);
	});

	it('gives the ladder one verdict only when every rung agrees', () => {
		expect(floorOverall(['open', 'open', 'open'])).toBe('open');
		expect(floorOverall(['closed', 'closed'])).toBe('closed');
		expect(floorOverall(['open', 'closed'])).toBe('between');
		expect(floorOverall(['open', 'insufficient'])).toBe('insufficient');
		expect(floorOverall([])).toBe('insufficient');
	});

	it('runs the floor ladder over rows, pairing by round and dropping an unreadable block', () => {
		const idleW = 20;
		const rows: FloorRow[] = [];
		for (let round = 0; round < 10; round += 1) {
			for (const [arm, mj] of [
				['nginx-null', 100],
				['wd-null', 60 + round]
			] as const) {
				rows.push({
					round,
					rate: 120,
					arm,
					pkgJ: idleW * 10 + (mj / 1000) * 1200,
					elapsedMs: 10_000,
					views: 1200
				});
			}
		}
		const [rung] = floorLadder(rows, idleW);
		expect(rung?.n).toBe(10);
		expect(rung?.unreadable).toBe(0);
		expect(rung?.controlMj).toBeCloseTo(100, 6);
		expect(rung?.treatmentMj).toBeCloseTo(64.5, 6);
		expect(rung?.verdict).toBe('open');
		const below = rows.map((r) =>
			r.round === 3 && r.arm === 'nginx-null' ? { ...r, pkgJ: idleW * 10 - 1 } : r
		);
		const [short] = floorLadder(below, idleW);
		expect(short?.n).toBe(9);
		expect(short?.unreadable).toBe(1);
		expect(short?.verdict).toBe('insufficient');
		const drifted = rows.map((r) => (r.arm === 'wd-null' ? { ...r, pkgJ: r.pkgJ + 120 } : r));
		expect(floorLadder(drifted, idleW)[0]?.verdict).toBe('closed');
	});

	it('reads a planned rung with no usable window as insufficient, so it cannot be skipped', () => {
		const idleW = 20;
		const rows: FloorRow[] = [];
		for (let round = 0; round < 10; round += 1) {
			for (const arm of ['nginx-null', 'wd-null'] as const) {
				rows.push({
					round,
					rate: 60,
					arm,
					pkgJ: idleW * 10 + 0.1 * 600,
					elapsedMs: 10_000,
					views: 600
				});
			}
		}
		const ladder = floorLadder(rows, idleW, 'nginx-null', 'wd-null', [60, 240]);
		expect(ladder.map((r) => r.rate)).toEqual([60, 240]);
		expect(ladder[0]?.verdict).toBe('closed');
		expect(ladder[1]?.verdict).toBe('insufficient');
		expect(ladder[1]?.n).toBe(0);
		expect(floorOverall(ladder.map((r) => r.verdict))).toBe('insufficient');
	});

	it('holds a window back from the hourly Wi-Fi drop and leaves the rest of the hour alone', () => {
		const at = (m: number, s: number) => m * 60 + s;
		expect(waitOutWifiDrop(at(10, 0), 20)).toBe(0);
		expect(waitOutWifiDrop(at(22, 20), 20)).toBe(0);
		expect(waitOutWifiDrop(at(22, 40), 20)).toBe(at(23, 40) - at(22, 40));
		expect(waitOutWifiDrop(at(23, 10), 20)).toBe(30);
		expect(waitOutWifiDrop(at(23, 40), 20)).toBe(0);
		expect(waitOutWifiDrop(at(59, 59), 20)).toBe(0);
	});

	it('refuses to read joules when the floor arms answer different bytes', () => {
		const ok: BodyReading = { arm: 'a', status: 200, type: 'text/html', bytes: 100, sha: 'x' };
		expect(bodiesAgree([ok, { ...ok, arm: 'b' }], 100)).toEqual({ ok: true, problems: [] });
		expect(bodiesAgree([ok, { ...ok, arm: 'b', sha: 'y' }]).problems).toEqual([
			'b same length, different bytes'
		]);
		expect(bodiesAgree([ok, { ...ok, arm: 'b', bytes: 99 }]).ok).toBe(false);
		expect(bodiesAgree([ok, { ...ok, arm: 'b', type: 'text/plain' }]).ok).toBe(false);
		expect(bodiesAgree([ok, { ...ok, arm: 'b', status: 404 }]).ok).toBe(false);
		expect(bodiesAgree([ok, { ...ok, arm: 'b' }], 101).ok).toBe(false);
		expect(bodiesAgree([]).ok).toBe(false);
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
