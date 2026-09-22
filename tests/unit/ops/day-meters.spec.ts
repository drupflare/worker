import { describe, expect, it } from 'vitest';
import { ZERO_ENCOUNTERS } from '../../../src/ops/cold-encounter';
import {
	ZERO_DAY_METERS,
	dayMetersKey,
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
			encounters: { noPhp: 40, warm: 8, cold: 2, absorbed: 400 }
		};
		expect(readDayMeters(writeDayMeters(meters))).toEqual(meters);
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
		for (const raw of ['', '1:2:3', '1:2:3:4:5', 'a:b:c:0,0,0,0', '-1:2:3:0,0,0,0', null]) {
			expect(readDayMeters(raw), `read ${raw} as a row`).toBeNull();
		}
	});

	it('reads a row whose encounters came from before `absorbed` existed', () => {
		expect(readDayMeters('10:20:30:1,2,3')).toEqual({
			rows: 10,
			doRequests: 20,
			serveTotal: 30,
			encounters: { noPhp: 1, warm: 2, cold: 3, absorbed: 0 }
		});
	});

	it('starts at zero on every counter', () => {
		expect(ZERO_DAY_METERS.encounters).toEqual(ZERO_ENCOUNTERS);
		expect(writeDayMeters(ZERO_DAY_METERS)).toBe('0:0:0:0,0,0,0');
	});
});
