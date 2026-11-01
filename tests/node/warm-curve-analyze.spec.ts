import { describe, expect, it } from 'vitest';
import {
	analyze,
	format,
	median,
	wilson,
	type ProbeRow
} from '../../scripts/measure/warm-curve-analyze';

const row = (over: Partial<ProbeRow>): ProbeRow => ({
	arm: 'off',
	gap: 10,
	status: 200,
	cache: 'RENDER',
	inlineBoot: '0',
	workerMs: '20',
	wallMs: 60,
	cronInGap: false,
	...over
});
const cold = (workerMs: string | null, wallMs: number, over: Partial<ProbeRow> = {}) =>
	row({ inlineBoot: '1', workerMs, wallMs, ...over });

// off at gap 10: three cold (one with the cron inside its gap), three warm, plus three excluded rows
const offCell: ProbeRow[] = [
	cold('400', 500),
	cold('600', 700, { cronInGap: true }),
	cold('500', 650),
	row({ workerMs: '20', wallMs: 60 }),
	row({ workerMs: '30', wallMs: 75 }),
	row({ workerMs: '40', wallMs: 90 }),
	{ arm: 'off', gap: 10, error: 'ECONNRESET' },
	row({ cache: 'KV', inlineBoot: '1', workerMs: '999', wallMs: 999 }),
	row({ status: 503, inlineBoot: '1', workerMs: '999', wallMs: 999 })
];
// dflt at gap 10: no cold row at all
const dfltCell: ProbeRow[] = [
	row({ arm: 'dflt', workerMs: '10', wallMs: 40 }),
	row({ arm: 'dflt', workerMs: '12', wallMs: 44 }),
	row({ arm: 'dflt', workerMs: '14', wallMs: 48 })
];
// on8 at gap 20: four cold (even n) and one warm row whose worker header never arrived
const on8Cell: ProbeRow[] = [
	cold('100', 150, { arm: 'on8', gap: 20 }),
	cold('200', 250, { arm: 'on8', gap: 20 }),
	cold('300', 350, { arm: 'on8', gap: 20 }),
	cold('400', 450, { arm: 'on8', gap: 20 }),
	row({ arm: 'on8', gap: 20, workerMs: null, wallMs: 60 })
];
const rows = [...offCell, ...dfltCell, ...on8Cell];

describe('wilson score interval', () => {
	it('bounds 3 of 6 at 95% to 0.1876 and 0.8124', () => {
		const [lo, hi] = wilson(3, 6) ?? [NaN, NaN];
		expect(lo).toBeCloseTo(0.1876, 4);
		expect(hi).toBeCloseTo(0.8124, 4);
	});

	it('keeps the lower bound at 0 for 0 of 6, where the normal interval goes negative', () => {
		const [lo, hi] = wilson(0, 6) ?? [NaN, NaN];
		expect(lo).toBeCloseTo(0, 9);
		expect(hi).toBeCloseTo(0.39034, 4);
	});

	it('has no interval for zero rows', () => {
		expect(wilson(0, 0)).toBeNull();
	});
});

describe('median', () => {
	it('takes the middle value for an odd n', () => {
		expect(median([400, 600, 500])).toBe(500);
	});

	it('averages the two middle values for an even n', () => {
		expect(median([100, 200, 300, 400])).toBe(250);
	});

	it('is null for an empty list, not NaN', () => {
		expect(median([])).toBeNull();
	});
});

describe('analyze', () => {
	const result = analyze(rows);

	it('excludes error rows, non-200 rows and cache rows other than RENDER, and counts each', () => {
		expect(result.rows).toBe(17);
		expect(result.excluded).toEqual({ error: 1, status: 1, cache: 1 });
		expect(result.usable).toBe(14);
	});

	it('reports the cold share and its Wilson interval per arm and gap', () => {
		const off = result.cells.find((c) => c.arm === 'off' && c.gap === 10);
		expect(off?.all.cold).toBe(3);
		expect(off?.all.n).toBe(6);
		expect(off?.all.share).toBeCloseTo(0.5, 9);
		expect(off?.all.ci?.[0]).toBeCloseTo(0.1876, 4);
		expect(off?.all.ci?.[1]).toBeCloseTo(0.8124, 4);
	});

	it('drops cron-in-gap rows from the no-cron share and keeps them in the full share', () => {
		const off = result.cells.find((c) => c.arm === 'off' && c.gap === 10);
		expect(off?.noCron.n).toBe(5);
		expect(off?.noCron.cold).toBe(2);
		expect(off?.noCron.share).toBeCloseTo(0.4, 9);
	});

	it('takes the worker and wall medians over cold and warm rows separately', () => {
		const off = result.cells.find((c) => c.arm === 'off' && c.gap === 10);
		expect(off?.workerCold).toEqual({ n: 3, median: 500 });
		expect(off?.workerWarm).toEqual({ n: 3, median: 30 });
		expect(off?.wallCold).toEqual({ n: 3, median: 650 });
		expect(off?.wallWarm).toEqual({ n: 3, median: 75 });
	});

	it('takes wall minus worker for warm rows only', () => {
		const off = result.cells.find((c) => c.arm === 'off' && c.gap === 10);
		expect(off?.netWarm).toEqual({ n: 3, median: 45 });
	});

	it('gives a cell with no cold rows a zero share and null cold medians, not NaN', () => {
		const dflt = result.cells.find((c) => c.arm === 'dflt' && c.gap === 10);
		expect(dflt?.all.cold).toBe(0);
		expect(dflt?.all.share).toBe(0);
		expect(dflt?.workerCold).toEqual({ n: 0, median: null });
		expect(dflt?.wallCold).toEqual({ n: 0, median: null });
	});

	it('counts a row missing its worker header in the cell n but not in the worker median', () => {
		const on8 = result.cells.find((c) => c.arm === 'on8' && c.gap === 20);
		expect(on8?.all.n).toBe(5);
		expect(on8?.workerCold).toEqual({ n: 4, median: 250 });
		expect(on8?.workerWarm).toEqual({ n: 0, median: null });
		expect(on8?.netWarm).toEqual({ n: 0, median: null });
		expect(on8?.wallWarm).toEqual({ n: 1, median: 60 });
	});

	it('orders arms off, dflt, on8 and gaps ascending', () => {
		expect(result.cells.map((c) => `${c.arm}/${c.gap}`)).toEqual([
			'off/10',
			'dflt/10',
			'on8/20'
		]);
	});
});

describe('format', () => {
	it('prints n/a where a cell has no data and never prints NaN', () => {
		const text = format(analyze(rows));
		expect(text).not.toContain('NaN');
		expect(text).toContain('n/a (n=0)');
		expect(text).toContain('excluded: error 1, status 1, cache not RENDER 1');
	});
});
