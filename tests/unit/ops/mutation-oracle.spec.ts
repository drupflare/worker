import { describe, expect, it } from 'vitest';
import {
	ineligibleKind,
	ineligibleSplit,
	type Effect,
	type EffectProfile
} from '../../../src/ops/mutation-oracle';

/**
 * Why an ineligible path wrote, which is a different question from whether it wrote.
 *
 * A path that writes only because a precondition is missing can be made routable by establishing the
 * precondition. A path that writes authoritative state as its purpose cannot. Collapsing the two
 * pins routable traffic to the primary forever for a reason that stopped being true, and the census
 * measured both current exceptions as the SAME cause -- a deferred fetch on a cold object -- which is
 * exactly the shape that would be mistaken for an intrinsic write.
 *
 * **Every ambiguous case here asserts the INTRINSIC answer.** The two errors are not symmetric:
 * calling an intrinsic write bootstrap routes an authoritative mutation to a replica, and calling a
 * bootstrap write intrinsic only pins a path that could have been shared.
 */

const profile = (effects: Effect[], over: Partial<EffectProfile> = {}): EffectProfile => ({
	effects,
	wrapped: ['cfwSqlExec'],
	armed: true,
	replicaEligible: effects.length === 0,
	reasons: effects.map((e) => `${e.effect}: ${e.detail}`),
	...over
});

const effect = (e: Effect['effect'], detail: string, count = 1): Effect => ({
	effect: e,
	detail,
	count
});

/** what the census actually recorded for `/admin/config` and `/admin/reports/status` */
const COLD_ADVISORIES: Effect[] = [
	effect('outbound-http', 'cfwFetch'),
	effect('authoritative-sql', 'watchdog', 5),
	effect('alarm', 'setAlarm')
];

describe('why an ineligible path wrote', () => {
	it('has nothing to explain about an eligible path', () => {
		expect(ineligibleKind(profile([]))).toBe('unknown');
	});

	it('has nothing to explain about a profile nobody armed', () => {
		// an unarmed oracle observed nothing, which reads exactly like a clean request
		expect(ineligibleKind(profile(COLD_ADVISORIES, { armed: false, wrapped: [] }))).toBe(
			'unknown'
		);
	});

	it('calls the cold advisories fetch bootstrap, which is the census exception', () => {
		expect(ineligibleKind(profile(COLD_ADVISORIES))).toBe('bootstrap');
	});

	it('calls an authoritative write intrinsic', () => {
		expect(ineligibleKind(profile([effect('authoritative-sql', 'node_field_data', 3)]))).toBe(
			'intrinsic'
		);
	});

	it('calls a sequence allocation intrinsic', () => {
		expect(ineligibleKind(profile([effect('sequence', 'sequences')]))).toBe('intrinsic');
	});

	it('refuses to call a queue bootstrap when no fetch is behind it', () => {
		// a queue armed by something other than a deferred fetch is work being scheduled, not a cold
		// cache, and there is no precondition to establish that would remove it
		expect(ineligibleKind(profile([effect('queue', 'cfwQueueFetch')]))).toBe('intrinsic');
		expect(ineligibleKind(profile([effect('alarm', 'setAlarm')]))).toBe('intrinsic');
	});

	it('refuses to call a watchdog write bootstrap on its own', () => {
		// `watchdog` is bootstrap only as the LOG of a deferral; Drupal logs on any authenticated GET
		// that has something to say, and that is not a precondition anyone can establish
		expect(ineligibleKind(profile([effect('authoritative-sql', 'watchdog', 5)]))).toBe(
			'intrinsic'
		);
	});

	it('one dangerous effect outweighs any number of bootstrap ones', () => {
		expect(ineligibleKind(profile([...COLD_ADVISORIES, effect('session', 'sessions')]))).toBe(
			'intrinsic'
		);
		expect(
			ineligibleKind(
				profile([...COLD_ADVISORIES, effect('unclassified-capability', 'cfwNew')])
			)
		).toBe('intrinsic');
	});

	it('splits a set into the two kinds and counts neither eligible path', () => {
		const split = ineligibleSplit([
			profile([]),
			profile(COLD_ADVISORIES),
			profile(COLD_ADVISORIES),
			profile([effect('mail', 'cfwMail')]),
			profile(COLD_ADVISORIES, { armed: false, wrapped: [] })
		]);
		expect(split).toEqual({ bootstrap: 2, intrinsic: 1 });
	});
});
