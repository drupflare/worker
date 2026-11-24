import { describe, expect, it } from 'vitest';
import {
	dayBudget,
	planDay,
	rotationPeriodDays,
	runCost,
	runsPerDay,
	staleDays,
	type Candidate
} from '../../scripts/e2e/rotation';

const c = (id: string, lastRun: string | undefined, cost = 10, lastPassed = true): Candidate => ({
	id,
	...(lastRun ? { lastRun } : {}),
	lastPassed,
	cost
});

const pool = (n: number) => Array.from({ length: n }, (_, i) => c(`f${i}`, undefined));

describe('the size of a day', () => {
	it('runs at least two a day and grows with the pool', () => {
		expect([7, 14, 21, 28, 35].map((n) => runsPerDay(n))).toEqual([2, 2, 3, 4, 5]);
		expect(runsPerDay(1)).toBe(2);
	});

	it('covers the pool in at most a week', () => {
		expect(rotationPeriodDays(7)).toBe(3.5);
		expect(rotationPeriodDays(14)).toBe(7);
		expect(rotationPeriodDays(21)).toBe(7);
		expect(rotationPeriodDays(30)).toBe(6);
		expect(rotationPeriodDays(100)).toBeCloseTo(100 / 15, 5);
		expect(rotationPeriodDays(0)).toBe(0);
	});
});

describe('the daily rotation', () => {
	it('takes the least recently run fixtures first, up to the day size', () => {
		const day = planDay(
			[
				c('b', '2026-12-05'),
				c('a', '2026-12-01'),
				c('d', '2026-12-09'),
				c('e', '2026-12-07')
			],
			1000
		);
		expect(day.ids).toEqual(['a', 'b']);
		expect(day.cap).toBe(2);
		expect(day.loweredByBudget).toBe(false);
	});

	it('runs a fixture that has never run before any that has', () => {
		expect(
			planDay([c('old', '2026-01-01'), c('new', undefined), c('x', '2026-02-01')], 1000)
				.ids[0]
		).toBe('new');
	});

	it('retries a failed fixture the next day, ahead of older passing ones', () => {
		const day = planDay(
			[c('old', '2026-01-01'), c('failed', '2026-12-09', 10, false), c('x', '2026-02-01')],
			1000
		);
		expect(day.ids[0]).toBe('failed');
	});

	it('respects the day size however many are due', () => {
		expect(planDay(pool(30), 1e9).ids).toHaveLength(runsPerDay(30));
	});

	it('lowers the day when the row budget cannot carry it, and says so', () => {
		const day = planDay(
			[c('a', '2026-01-01', 60), c('b', '2026-01-02', 60), c('c', '2026-01-03', 60)],
			100
		);
		expect(day.ids).toEqual(['a']);
		expect(day.cap).toBe(2);
		expect(day.loweredByBudget).toBe(true);
	});

	it('skips a fixture that no longer fits for a cheaper one', () => {
		const day = planDay(
			[c('a', '2026-01-01', 60), c('b', '2026-01-02', 60), c('c', '2026-01-03', 30)],
			100
		);
		expect(day.ids).toEqual(['a', 'c']);
	});

	it('still runs a fixture dearer than the whole budget, alone', () => {
		expect(
			planDay([c('big', '2026-01-01', 500), c('small', '2026-01-02', 1)], 100).ids
		).toEqual(['big']);
	});

	it('covers every fixture within the rotation period when the days follow the plan', () => {
		const state = new Map<string, string | undefined>(pool(10).map((p) => [p.id, undefined]));
		const days = Math.ceil(rotationPeriodDays(10));
		for (let day = 1; day <= days; day++) {
			const todays = planDay(
				[...state].map(([id, lastRun]) => c(id, lastRun)),
				1e9
			);
			for (const id of todays.ids) state.set(id, `2026-12-${String(day).padStart(2, '0')}`);
		}
		expect([...state.values()].every((v) => v !== undefined)).toBe(true);
	});
});

describe('what a run costs', () => {
	const cfg = {
		rowsPerDay: 100_000,
		reserve: 0.3,
		margin: 1.25,
		baseRows: 12_000,
		defaultDelivery: 22_155,
		delivery: { govcms: 38_949 }
	};

	it('adds the delivery to the stock lane and applies the margin', () => {
		expect(runCost(cfg, 'govcms')).toBe(Math.ceil((12_000 + 38_949) * 1.25));
		expect(runCost(cfg, 'unmeasured')).toBe(Math.ceil((12_000 + 22_155) * 1.25));
	});

	it('holds the reserve back from the day', () => {
		expect(dayBudget(cfg)).toBe(70_000);
	});
});

describe('the window', () => {
	const pools = [7, 14, 21, 28, 35, 50, 100];

	it('sizes the day and the period at a window of seven', () => {
		expect(pools.map((n) => runsPerDay(n, 7))).toEqual([2, 2, 3, 4, 5, 8, 15]);
		expect(pools.map((n) => rotationPeriodDays(n, 7))).toEqual([
			3.5,
			7,
			7,
			7,
			7,
			6.25,
			100 / 15
		]);
	});

	it('sizes the day and the period at a window of fourteen', () => {
		expect(pools.map((n) => runsPerDay(n, 14))).toEqual([2, 2, 2, 2, 3, 4, 8]);
		expect(pools.map((n) => rotationPeriodDays(n, 14))).toEqual([
			3.5,
			7,
			10.5,
			14,
			35 / 3,
			12.5,
			12.5
		]);
	});

	it('never lets the period pass the window', () => {
		for (const window of [7, 14, 30])
			for (let n = 1; n <= 200; n++)
				expect(rotationPeriodDays(n, window)).toBeLessThanOrEqual(window);
	});

	it('lapses a certification after twice the window', () => {
		expect(staleDays()).toBe(14);
		expect(staleDays(14)).toBe(28);
	});

	it('takes the day size from the window, so a wider window runs fewer a day', () => {
		expect(planDay(pool(35), 1e9, 7).ids).toHaveLength(5);
		expect(planDay(pool(35), 1e9, 14).ids).toHaveLength(3);
	});
});
