import { describe, expect, it } from 'vitest';
import type { EnergyRow } from '../../scripts/measure/headers-energy';
import { disagreeingRounds, idleWatts, summarize } from '../../scripts/measure/spool-report';

const row = (
	arm: string,
	round: number,
	pkgJ: number,
	extra: Partial<EnergyRow> = {}
): EnergyRow => ({
	arm,
	round,
	navs: arm === 'idle' ? 0 : 100,
	requests: arm === 'idle' ? 0 : 100,
	errors: 0,
	elapsedMs: 10_000,
	pkgJ,
	coreJ: pkgJ / 2,
	load0: 0.1,
	load1: 0.1,
	...extra
});

/** idle at 10 W, so 100 J over a 10 s window is idle itself */
const round = (n: number, on: number, off: number, idleJ = 100) => [
	row('on', n, on),
	row('off', n, off),
	row('idle', n, idleJ)
];

describe('the idle draw', () => {
	it('reads watts from the idle window of each round', () => {
		expect(idleWatts(round(0, 200, 300, 100))).toEqual(new Map([[0, 10]]));
	});

	it('drops a round whose idle draw sits more than a quarter from the median', () => {
		const rows = [...round(0, 200, 300), ...round(1, 200, 300), ...round(2, 200, 300, 160)];
		expect(disagreeingRounds(rows)).toEqual([2]);
		expect(disagreeingRounds(rows, 0.7)).toEqual([]);
	});
});

describe('one run reduced', () => {
	it('subtracts idle per navigation and pairs the off arm over the on arm', () => {
		const rows = [...round(0, 200, 300), ...round(1, 220, 340)];
		const s = summarize(rows);
		// (200 - 100) / 100 = 1.0 J on, (300 - 100) / 100 = 2.0 J off
		expect(s.joulesPerNav['on']?.median).toBeCloseTo(1.1, 6);
		expect(s.joulesPerNav['off']?.median).toBeCloseTo(2.2, 6);
		expect(s.ratio.min).toBeCloseTo(2, 6);
		expect(s.ratio.max).toBeCloseTo(2.4 / 1.2, 6);
		expect(s.rounds).toBe(2);
	});

	it('leaves a disagreeing round out of every figure', () => {
		const rows = [...round(0, 200, 300), ...round(1, 200, 300), ...round(2, 900, 100, 160)];
		const s = summarize(rows);
		expect(s.droppedRounds).toEqual([2]);
		expect(s.rounds).toBe(2);
		expect(s.ratio.median).toBeCloseTo(2, 6);
	});

	it('carries bytes and requests a navigation, and bytes only when the run recorded them', () => {
		const cold = [
			row('on', 0, 200, { bytes: 20_000, requests: 300 }),
			row('off', 0, 300, { bytes: 1_300_000, requests: 500 }),
			row('idle', 0, 100)
		];
		const s = summarize(cold);
		expect(s.bytesPerNav).toEqual({ on: 200, off: 13_000 });
		expect(s.requestsPerNav).toEqual({ on: 3, off: 5 });
		expect(summarize(round(0, 200, 300)).bytesPerNav).toBeUndefined();
	});

	it('refuses arms with no common rounds', () => {
		expect(() => summarize([row('on', 0, 200), row('idle', 0, 100)])).toThrow();
	});
});
