import { describe, expect, it } from 'vitest';
import {
	EVICT_AFTER_SECONDS,
	hibernationEligible,
	idleBilledSeconds,
	OUTBOUND_PIN_SECONDS
} from '../../../src/ops/hibernation';

/**
 * The duration billing boundary, which is eligibility rather than hibernation itself.
 *
 * P17 was closed on "two always-warm objects exceed the free duration allowance". True, and it
 * closed replicas entirely -- when a replica that HIBERNATES accrues no idle duration at all, so
 * that arithmetic never applied to it. These cases pin the distinction the closure lost.
 *
 * THE ALARM CASE IS THE ONE WORTH READING. A pending alarm is absent from Cloudflare's condition
 * list, so the keep-warm chain does not hold the object resident. It costs a row and a DO request
 * per arm and buys no warmth, which is the opposite of what the name suggests.
 */

describe('what makes a Durable Object ineligible to hibernate', () => {
	it('treats an idle object with nothing open as eligible, so idle is free', () => {
		expect(hibernationEligible().eligible).toBe(true);
		expect(hibernationEligible({}).blockedBy).toEqual([]);
		expect(idleBilledSeconds({})).toBe(0);
	});

	it('does NOT disqualify a pending alarm, which is what keep-warm relies on being wrong', () => {
		const verdict = hibernationEligible({ pendingAlarm: true });
		expect(verdict.eligible).toBe(true);
		expect(verdict.blockedBy).toEqual([]);
		// so an armed alarm costs its row and buys zero seconds of residency
		expect(idleBilledSeconds({ pendingAlarm: true })).toBe(0);
	});

	it('disqualifies each of the five documented conditions on its own', () => {
		const each = [
			'pendingTimer',
			'inflightFetch',
			'standardWebSocket',
			'requestInFlight',
			'outboundSocket'
		] as const;
		for (const key of each) {
			const verdict = hibernationEligible({ [key]: true });
			expect(verdict.eligible, key).toBe(false);
			expect(verdict.blockedBy, key).toHaveLength(1);
		}
	});

	it('reports every reason at once rather than stopping at the first', () => {
		const verdict = hibernationEligible({ outboundSocket: true, pendingTimer: true });
		expect(verdict.eligible).toBe(false);
		// a caller fixing one of two blockers would otherwise believe it was done
		expect(verdict.blockedBy).toHaveLength(2);
	});
});

describe('what an ineligible idle period costs', () => {
	it('charges the eviction window even when the socket closed immediately', () => {
		// the object is billed until eviction, and eviction waits the inactivity window
		expect(idleBilledSeconds({ outboundSocket: true }, 0)).toBe(EVICT_AFTER_SECONDS.min);
	});

	it('caps an outbound connection at 15 minutes of pinning, not the whole day', () => {
		const held = idleBilledSeconds({ outboundSocket: true }, 60 * 60);
		expect(held).toBe(OUTBOUND_PIN_SECONDS + EVICT_AFTER_SECONDS.min);
		// which is the difference between "a leaked socket costs 16 minutes" and "it costs a day"
		expect(held).toBeLessThan(86_400);
	});

	it('scales with how long the socket was really held, below the cap', () => {
		expect(idleBilledSeconds({ outboundSocket: true }, 5)).toBe(5 + EVICT_AFTER_SECONDS.min);
	});
});
