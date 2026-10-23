import { describe, expect, it } from 'vitest';
import {
	armSamples,
	percentile,
	roundCpu,
	type Invocation,
	type Row
} from '../../scripts/measure/boot-image-deployed';

const row = (round: number, t0: number, extra: Partial<Row> = {}): Row => ({
	arm: 'a',
	round,
	t0,
	t1: t0 + 1_000,
	status: 200,
	bytes: 100,
	cold: true,
	...extra
});
const ev = (at: number, cpuMs: number, extra: Partial<Invocation> = {}): Invocation => ({
	at,
	cpuMs,
	entrypoint: 'SitePhpDurableObject',
	type: 'fetch',
	...extra
});

describe('a round window', () => {
	it('sums the object invocations inside it, padded, and nothing outside', () => {
		const events = [ev(9_000, 5), ev(10_500, 900), ev(11_500, 40), ev(20_000, 7_000)];
		expect(roundCpu(row(1, 10_000), events)).toEqual({ fetch: 945, alarm: 0, total: 945 });
		expect(roundCpu(row(1, 30_000), events)).toBeUndefined();
	});

	it('adds the alarm the request queued behind and leaves out the front worker', () => {
		const events = [
			ev(10_400, 1_764, { type: 'alarm' }),
			ev(10_300, 14, { entrypoint: '' }),
			ev(10_500, 763)
		];
		expect(roundCpu(row(1, 10_000), events)).toEqual({
			fetch: 763,
			alarm: 1_764,
			total: 2_527
		});
	});
});

describe('an arm', () => {
	it('counts only cold, answered rounds and says how many it could not read', () => {
		const rows = [
			row(1, 10_000),
			row(2, 70_000),
			row(3, 130_000, { cold: false }),
			row(4, 190_000, { status: 503 }),
			row(5, 250_000)
		];
		const s = armSamples(rows, [ev(10_400, 800), ev(70_300, 1_000)]);
		expect(s).toMatchObject({ rounds: 5, cold: 3, unread: 1, cpu: [800, 1_000], median: 800 });
		expect(s.max).toBe(1_000);
	});

	it('reads zero for an arm with nothing cold, not NaN', () => {
		expect(armSamples([row(1, 1, { cold: false })], [])).toMatchObject({
			cold: 0,
			median: 0,
			min: 0
		});
	});
});

describe('the percentile', () => {
	it('is nearest rank and zero for nothing', () => {
		expect(percentile([], 50)).toBe(0);
		expect(percentile([5, 1, 3], 50)).toBe(3);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
	});
});
