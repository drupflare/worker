import { describe, expect, it } from 'vitest';
import {
	ZERO_ENCOUNTERS,
	addEncounters,
	encounterReport,
	parseEncounters,
	recordEncounter,
	serialiseEncounters
} from '../../../src/ops/cold-encounter';

/**
 * The metric that replaces "how long is a cold boot" with "how often does anyone meet one".
 *
 * The cost is measured: 1,264 ms of `cpuTime` for an unimaged cold render on a deployed free worker.
 * What decides whether that matters is the share of requests exposed to it, and `thermal.ts` already
 * exists to keep that share small. No magnitude is asserted here; the properties are.
 */

describe('the two shares, because they answer different questions', () => {
	it('scores the thermal policy against the requests that needed PHP', () => {
		const r = encounterReport({ noPhp: 90, warm: 8, cold: 2 });
		expect(r.php).toBe(10);
		expect(r.coldOfPhp).toBe(0.2);
	});

	it('scores the architecture against every request that reached the object', () => {
		const r = encounterReport({ noPhp: 90, warm: 8, cold: 2 });
		expect(r.total).toBe(100);
		expect(r.coldOfAll).toBe(0.02);
	});

	/**
	 * A site that has served nothing has not demonstrated a 0% cold rate.
	 *
	 * Reporting 0 on an empty denominator would make an unused site read like a well-tuned one, which
	 * is the same distinction `rolloutProgress()` draws for a fleet nobody has heard from.
	 */
	it('answers null on an empty denominator rather than zero', () => {
		const r = encounterReport(ZERO_ENCOUNTERS);
		expect(r.coldOfPhp).toBeNull();
		expect(r.coldOfAll).toBeNull();
	});

	it('answers null for the policy share when nothing needed PHP at all', () => {
		const r = encounterReport({ noPhp: 40, warm: 0, cold: 0 });
		expect(r.coldOfPhp).toBeNull();
		// but the architecture share is real: 40 requests reached the object and none paid a boot
		expect(r.coldOfAll).toBe(0);
	});
});

describe('recording', () => {
	it('counts each outcome in its own bucket', () => {
		let c = ZERO_ENCOUNTERS;
		c = recordEncounter(c, 'cold');
		c = recordEncounter(c, 'warm');
		c = recordEncounter(c, 'warm');
		c = recordEncounter(c, 'no-php');
		expect(c).toEqual({ noPhp: 1, warm: 2, cold: 1 });
	});

	it('never mutates the counts it was handed, so a caller cannot lose a read', () => {
		const before = { noPhp: 1, warm: 1, cold: 1 };
		recordEncounter(before, 'cold');
		expect(before).toEqual({ noPhp: 1, warm: 1, cold: 1 });
	});

	it('adds two days without reaching into either', () => {
		expect(
			addEncounters({ noPhp: 1, warm: 2, cold: 3 }, { noPhp: 10, warm: 20, cold: 30 })
		).toEqual({ noPhp: 11, warm: 22, cold: 33 });
	});
});

describe('the stored form, which a corrupt row must not turn into a wrong share', () => {
	it('round-trips', () => {
		const c = { noPhp: 7, warm: 5, cold: 3 };
		expect(parseEncounters(serialiseEncounters(c))).toEqual(c);
	});

	it('reads an absent row as zero', () => {
		expect(parseEncounters(null)).toEqual(ZERO_ENCOUNTERS);
	});

	it.each([['not,a,number'], ['1,2'], ['1,2,3,4'], ['-1,2,3'], ['']])(
		'reads %s as zero rather than as a partial count',
		(raw) => {
			expect(parseEncounters(raw)).toEqual(ZERO_ENCOUNTERS);
		}
	);
});
