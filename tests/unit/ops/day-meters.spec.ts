import { describe, expect, it } from 'vitest';
import { ZERO_ENCOUNTERS } from '../../../src/ops/cold-encounter';
import {
	METER_FLUSH_MS_MAX,
	METER_FLUSH_MS_MIN,
	METER_FLUSH_ROWS_MAX,
	METER_FLUSH_ROWS_MIN,
	ZERO_DAY_METERS,
	dayMetersKey,
	meterFlushBudget,
	readDayMeters,
	writeDayMeters
} from '../../../src/ops/day-meters';

/**
 * One row for four counters, because rows written is the meter the counters are counting.
 *
 * Each had a key of its own, so a flush on a trafficked site wrote four rows to record a batch of
 * them, while the comments beside the calls said the folding cost no row of its own. The folding
 * saved the alarm and never the rows.
 */

describe('the packed day row', () => {
	it('round-trips every counter', () => {
		const meters = {
			rows: 4_211,
			doRequests: 903,
			serveTotal: 71_004,
			encounters: { noPhp: 40, warm: 8, cold: 2, absorbed: 400 },
			kvWrites: 37
		};
		expect(readDayMeters(writeDayMeters(meters))).toEqual(meters);
	});

	it('reads a row written before `kvWrites` existed as having granted none', () => {
		expect(readDayMeters('10:20:30:1,2,3,4')?.kvWrites).toBe(0);
	});

	it('keys by UTC day, so an eviction loses a flush rather than a day', () => {
		expect(dayMetersKey(Date.UTC(2026, 8, 21, 23, 59))).toBe('meters_2026-09-21');
		expect(dayMetersKey(Date.UTC(2026, 8, 22, 0, 1))).toBe('meters_2026-09-22');
	});

	/**
	 * Null rather than a zeroed row, and the caller depends on the difference: an absent row is what
	 * sends it to the legacy keys and carries the lifetime serve total forward, and a zeroed one is a
	 * day that genuinely counted nothing.
	 */
	it('answers null on anything it cannot read', () => {
		for (const raw of [
			'',
			'1:2:3',
			'1:2:3:0,0,0,0:5:6',
			'1:2:3:0,0,0,0:x',
			'a:b:c:0,0,0,0',
			'-1:2:3:0,0,0,0',
			null
		]) {
			expect(readDayMeters(raw), `read ${raw} as a row`).toBeNull();
		}
	});

	it('reads a row whose encounters came from before `absorbed` existed', () => {
		expect(readDayMeters('10:20:30:1,2,3')).toEqual({
			rows: 10,
			doRequests: 20,
			serveTotal: 30,
			encounters: { noPhp: 1, warm: 2, cold: 3, absorbed: 0 },
			kvWrites: 0
		});
	});

	it('starts at zero on every counter', () => {
		expect(ZERO_DAY_METERS.encounters).toEqual(ZERO_ENCOUNTERS);
		expect(writeDayMeters(ZERO_DAY_METERS)).toBe('0:0:0:0,0,0,0:0');
	});
});

/**
 * How often that row is paid for, which was two constants and is now a function of the headroom.
 *
 * The checkpoint bounds one thing only: how much counting an eviction may lose. A constant states
 * that bound in absolute rows, which is 0.025% of a fresh day's budget and 1% of what is left near
 * the ceiling -- so the flat 25 was far too tight at one end and no tighter at the other.
 */
describe('the sparse meter checkpoint', () => {
	const QUOTA = 100_000;

	it('is the loosest bucket on a site that has written nothing', () => {
		const b = meterFlushBudget(0, QUOTA);
		expect(b.rows).toBe(METER_FLUSH_ROWS_MAX);
		expect(b.intervalMs).toBe(METER_FLUSH_MS_MAX);
		// 96 checkpoints a day against the 1,440 a flat 60 s charged, which is the whole saving
		expect(86_400_000 / b.intervalMs).toBe(96);
	});

	/**
	 * THE FLOOR IS THE OLD BEHAVIOUR EXACTLY, which is what makes this safe to ship.
	 *
	 * A site near the daily cap is the only one whose lost count can change a decision, and there
	 * the policy answers the same 25 rows and 60 s the constants did. Nothing is loosened where it
	 * would matter.
	 */
	it('degrades to the constants it replaced as the budget runs out', () => {
		const b = meterFlushBudget(QUOTA - 2_500, QUOTA);
		expect(b.rows).toBe(METER_FLUSH_ROWS_MIN);
		expect(b.intervalMs).toBe(METER_FLUSH_MS_MIN);
		// and past the cap it cannot go looser again
		expect(meterFlushBudget(QUOTA * 2, QUOTA)).toEqual(b);
	});

	it('tightens monotonically as the day is spent', () => {
		let previous = Infinity;
		for (let spent = 0; spent <= QUOTA; spent += 2_500) {
			const b = meterFlushBudget(spent, QUOTA);
			expect(b.intervalMs).toBeLessThanOrEqual(previous);
			previous = b.intervalMs;
			expect(b.rows).toBeGreaterThanOrEqual(METER_FLUSH_ROWS_MIN);
			expect(b.intervalMs).toBeGreaterThanOrEqual(METER_FLUSH_MS_MIN);
		}
		// the control: it did move, so the loop above is not asserting a constant
		expect(meterFlushBudget(QUOTA, QUOTA).intervalMs).toBeLessThan(
			meterFlushBudget(0, QUOTA).intervalMs
		);
	});

	/** both triggers state one bound in two units, so they have to stay in step */
	it('keeps the row trigger and the interval in the same ratio', () => {
		for (const spent of [0, 40_000, 62_500, 80_000, 95_000, 99_000]) {
			const b = meterFlushBudget(spent, QUOTA);
			expect(b.rows / METER_FLUSH_ROWS_MIN).toBeCloseTo(b.intervalMs / METER_FLUSH_MS_MIN, 6);
		}
	});

	/**
	 * Where the tightening starts, stated so a fleet reading can be checked against it.
	 *
	 * A warmed idle site spends about 10,900 rows a day on its own chain, which is nowhere near
	 * this, so the fleet figure `keepWarmFleetCost()` computes is the loosest bucket and not an
	 * average across the ladder.
	 */
	it('holds the loosest bucket until 62.5% of the budget is gone', () => {
		expect(meterFlushBudget(62_500, QUOTA).intervalMs).toBe(METER_FLUSH_MS_MAX);
		expect(meterFlushBudget(63_000, QUOTA).intervalMs).toBeLessThan(METER_FLUSH_MS_MAX);
		expect(meterFlushBudget(10_896, QUOTA).intervalMs).toBe(METER_FLUSH_MS_MAX);
	});
});
