import { describe, expect, it } from 'vitest';
import {
	ABSORBED_REPORT_MAX,
	ZERO_ENCOUNTERS,
	addEncounters,
	encounterReport,
	foldAbsorbed,
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

describe('the three shares, because they answer different questions', () => {
	it('scores the thermal policy against the requests that needed PHP', () => {
		const r = encounterReport({ noPhp: 90, warm: 8, cold: 2, absorbed: 0 });
		expect(r.php).toBe(10);
		expect(r.coldOfPhp).toBe(0.2);
	});

	it('scores the object against every request that reached it', () => {
		const r = encounterReport({ noPhp: 90, warm: 8, cold: 2, absorbed: 0 });
		expect(r.total).toBe(100);
		expect(r.coldOfObject).toBe(0.02);
	});

	/**
	 * The defect this field exists to close.
	 *
	 * A plan hit, an isolate memo hit, an edge hit and a KV read all return from the front worker, so
	 * the object's own denominator is the leftovers. Measured, those leftovers are about a fifth of
	 * anonymous traffic, so a share taken against them reads roughly 5x high.
	 */
	it('scores the visitor against every request made for the site', () => {
		const r = encounterReport({ noPhp: 90, warm: 8, cold: 2, absorbed: 400 });
		expect(r.traffic).toBe(500);
		expect(r.coldOfTraffic).toBe(0.004);
		expect(r.coldOfObject).toBe(0.02);
		expect(r.coldOfObject).toBeGreaterThan(r.coldOfTraffic as number);
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
		expect(r.coldOfObject).toBeNull();
		expect(r.coldOfTraffic).toBeNull();
	});

	it('answers null for the policy share when nothing needed PHP at all', () => {
		const r = encounterReport({ noPhp: 40, warm: 0, cold: 0, absorbed: 0 });
		expect(r.coldOfPhp).toBeNull();
		// but the object share is real: 40 requests reached it and none paid a boot
		expect(r.coldOfObject).toBe(0);
	});

	/**
	 * An unreported absorbed count and a genuinely unabsorbed one are indistinguishable here, and one
	 * of the two makes the share read 5x high. A front worker too old to report reads as the first.
	 */
	it('withholds the traffic share while nothing has been reported', () => {
		const r = encounterReport({ noPhp: 40, warm: 8, cold: 2, absorbed: 0 });
		expect(r.coldOfObject).toBe(0.04);
		expect(r.coldOfTraffic).toBeNull();
	});
});

describe('what the front worker reports', () => {
	it('folds a count in', () => {
		expect(foldAbsorbed(ZERO_ENCOUNTERS, '17').absorbed).toBe(17);
	});

	it('treats an absent header as nothing to fold rather than as zero traffic', () => {
		expect(foldAbsorbed({ noPhp: 0, warm: 0, cold: 0, absorbed: 5 }, null).absorbed).toBe(5);
	});

	/** every inbound header is attacker-supplied, and this one is a denominator */
	it.each([['0'], ['-4'], ['1.5'], ['nonsense'], [''], [String(ABSORBED_REPORT_MAX + 1)]])(
		'ignores %s rather than poisoning the denominator with it',
		(raw) => {
			expect(foldAbsorbed(ZERO_ENCOUNTERS, raw).absorbed).toBe(0);
		}
	);

	it('accepts the cap itself, so the bound is inclusive', () => {
		expect(foldAbsorbed(ZERO_ENCOUNTERS, String(ABSORBED_REPORT_MAX)).absorbed).toBe(
			ABSORBED_REPORT_MAX
		);
	});
});

describe('recording', () => {
	it('counts each outcome in its own bucket', () => {
		let c = ZERO_ENCOUNTERS;
		c = recordEncounter(c, 'cold');
		c = recordEncounter(c, 'warm');
		c = recordEncounter(c, 'warm');
		c = recordEncounter(c, 'no-php');
		expect(c).toEqual({ noPhp: 1, warm: 2, cold: 1, absorbed: 0 });
	});

	it('never mutates the counts it was handed, so a caller cannot lose a read', () => {
		const before = { noPhp: 1, warm: 1, cold: 1, absorbed: 1 };
		recordEncounter(before, 'cold');
		foldAbsorbed(before, '9');
		expect(before).toEqual({ noPhp: 1, warm: 1, cold: 1, absorbed: 1 });
	});

	it('adds two days without reaching into either', () => {
		expect(
			addEncounters(
				{ noPhp: 1, warm: 2, cold: 3, absorbed: 4 },
				{ noPhp: 10, warm: 20, cold: 30, absorbed: 40 }
			)
		).toEqual({ noPhp: 11, warm: 22, cold: 33, absorbed: 44 });
	});
});

describe('the stored form, which a corrupt row must not turn into a wrong share', () => {
	it('round-trips', () => {
		const c = { noPhp: 7, warm: 5, cold: 3, absorbed: 11 };
		expect(parseEncounters(serialiseEncounters(c))).toEqual(c);
	});

	it('reads an absent row as zero', () => {
		expect(parseEncounters(null)).toEqual(ZERO_ENCOUNTERS);
	});

	/**
	 * A row written before `absorbed` existed. It reads as zero absorbed, which is what it means, and
	 * `coldOfTraffic` is null on it rather than wrong.
	 */
	it('reads a three-field row from before the field existed', () => {
		expect(parseEncounters('7,5,3')).toEqual({ noPhp: 7, warm: 5, cold: 3, absorbed: 0 });
		expect(encounterReport(parseEncounters('7,5,3')).coldOfTraffic).toBeNull();
	});

	it.each([['not,a,number'], ['1,2'], ['1,2,3,4,5'], ['-1,2,3'], ['']])(
		'reads %s as zero rather than as a partial count',
		(raw) => {
			expect(parseEncounters(raw)).toEqual(ZERO_ENCOUNTERS);
		}
	);
});
