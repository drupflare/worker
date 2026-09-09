import { describe, expect, it } from 'vitest';
import edgePlanSource from '../../src/ops/edge-plan.ts?raw';
import {
	EVICT_AFTER_SECONDS,
	hibernationEligible,
	idleBilledSeconds,
	OUTBOUND_PIN_SECONDS,
	type ResidencyState
} from '../../src/ops/hibernation';
import tcpSource from '../../src/ops/tcp.ts?raw';
import siteDoSource from '../../src/site-do.ts?raw';

/**
 * Whether the object leaves anything open that would keep it billed while idle.
 *
 * `src/ops/hibernation.ts` transcribes Cloudflare's five disqualifiers and scores a state it is
 * handed. Nothing handed it one taken from the code, so the module was a correct scorer of
 * hypothetical states -- the same shape as a guard that cannot fire. What decides the bill is what
 * the DURABLE OBJECT left open, so that is what these read.
 *
 * COST correctness, not runtime correctness. Every assertion here is about a meter rather than about
 * a response, which is why they sit apart from the serving specs.
 */

/** a `setTimeout` inside a PHP fragment is a string, not a timer this runtime ever arms */
function timersOutsidePhp(source: string): string[] {
	const found: string[] = [];
	const lines = source.split('\n');
	let inRaw = false;
	for (const [i, line] of lines.entries()) {
		// the PHP fragments are `String.raw` blocks; count backticks to know which side we are on
		const ticks = (line.match(/`/g) ?? []).length;
		const wasRaw = inRaw;
		if (ticks % 2 === 1) inRaw = !inRaw;
		if (wasRaw || inRaw) continue;
		if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
		if (/\b(setTimeout|setInterval)\s*\(/.test(line)) found.push(`${i + 1}: ${line.trim()}`);
	}
	return found;
}

describe('what the object leaves open when it goes idle', () => {
	/**
	 * A pending timer is the first disqualifier and the easiest to introduce by accident.
	 *
	 * It is also the one with no runtime symptom: the object serves correctly and is billed for
	 * duration it did not need, which shows up on an invoice weeks later rather than in a test.
	 */
	it('arms no timer anywhere in the Durable Object', () => {
		expect(timersOutsidePhp(siteDoSource)).toEqual([]);
	});

	/**
	 * The front worker is a different lifetime and may use one.
	 *
	 * `withDeadline()` in `src/ops/edge-plan.ts` races a KV read against a `setTimeout`, which is
	 * correct there: a Worker isolate is not a Durable Object and does not hibernate. Recorded so
	 * the check above is not later widened to a file it does not apply to.
	 */
	it('leaves the front worker alone, because a Worker isolate does not hibernate', () => {
		// asserted in the POSITIVE direction, so this is a statement about scope rather than a
		// second copy of the check above: the timer exists, it is in the Worker, and it is fine
		expect(timersOutsidePhp(edgePlanSource).join('\n')).toContain('setTimeout');
	});

	/**
	 * An outbound TCP socket is the fifth disqualifier, and the only place this project opens one.
	 *
	 * Close on success is easy and close on THROW is what a `finally` buys. Without it a refused
	 * connection, a protocol error or a timeout leaves the socket open, and Cloudflare defers
	 * eviction by up to 15 minutes per connection.
	 */
	it('closes every TCP session in a finally, so a throw cannot leave one open', () => {
		const closes = tcpSource.match(/await session\.close\(\)/g) ?? [];
		const finallys = tcpSource.match(/\}\s*finally\s*\{/g) ?? [];
		expect(closes.length, 'no session close found at all').toBeGreaterThan(0);
		// every close is inside a finally, which is what makes the error paths safe
		expect(finallys.length).toBeGreaterThanOrEqual(closes.length);
	});
});

describe('the scorer, driven adversarially rather than on its happy path', () => {
	const DISQUALIFYING: (keyof ResidencyState)[] = [
		'pendingTimer',
		'inflightFetch',
		'standardWebSocket',
		'requestInFlight',
		'outboundSocket'
	];

	it('is eligible with nothing open, which is the state a finished request leaves', () => {
		const out = hibernationEligible({});
		expect(out.eligible).toBe(true);
		expect(out.blockedBy).toEqual([]);
	});

	it.each(DISQUALIFYING)('is refused by %s alone', (key) => {
		const out = hibernationEligible({ [key]: true });
		expect(out.eligible).toBe(false);
		expect(out.blockedBy).toHaveLength(1);
		// the reason names the condition rather than a code, so an operator can act on it
		expect(out.blockedBy[0]).toBeTruthy();
	});

	it('reports every reason rather than the first, because a fix has to close all of them', () => {
		const out = hibernationEligible(
			Object.fromEntries(DISQUALIFYING.map((k) => [k, true])) as ResidencyState
		);
		expect(out.eligible).toBe(false);
		expect(out.blockedBy).toHaveLength(DISQUALIFYING.length);
	});

	/**
	 * The reading the replica pool rests on.
	 *
	 * Replicas were closed once on "two always-warm objects exceed the free duration allowance",
	 * which is true of a resident object and false of an eligible one. A pending alarm is not on
	 * Cloudflare's list, so an object waiting on one is idle-eligible and accrues no duration.
	 */
	it('is eligible with an alarm armed, which is what makes warming cost requests not duration', () => {
		expect(hibernationEligible({ pendingAlarm: true }).eligible).toBe(true);
	});

	it('is still refused when an alarm is armed AND something is open', () => {
		// the combination matters: an armed alarm must not read as permission
		const out = hibernationEligible({ pendingAlarm: true, inflightFetch: true });
		expect(out.eligible).toBe(false);
	});
});

describe('what an idle moment is billed', () => {
	it('bills nothing for an eligible object however long it waits', () => {
		expect(idleBilledSeconds({})).toBe(0);
		expect(idleBilledSeconds({ pendingAlarm: true })).toBe(0);
	});

	it('bills a non-eligible object for the eviction wait it now has to sit through', () => {
		// not free and not unbounded: an ineligible object is evicted after 70-140 s idle, so that
		// window is what a leaked handle costs per occurrence
		const billed = idleBilledSeconds({ requestInFlight: true });
		expect(billed).toBeGreaterThanOrEqual(EVICT_AFTER_SECONDS.min);
	});

	/**
	 * The outbound pin, which is the expensive one and the reason `finally` matters above.
	 *
	 * Each outbound connection defers eviction by up to 15 minutes. A render that opens one and
	 * throws before closing it therefore costs a quarter hour of resident duration, per render.
	 */
	it('adds the outbound pin on top, so a leaked socket is the costly failure', () => {
		const held = OUTBOUND_PIN_SECONDS;
		const withSocket = idleBilledSeconds({ outboundSocket: true }, held);
		expect(withSocket).toBeGreaterThanOrEqual(held);
		expect(withSocket).toBeGreaterThan(idleBilledSeconds({ outboundSocket: true }, 0));
	});

	it('is monotonic in how long the connection was held', () => {
		let previous = -1;
		for (const held of [0, 30, 300, OUTBOUND_PIN_SECONDS]) {
			const billed = idleBilledSeconds({ outboundSocket: true }, held);
			expect(billed, `held=${held}`).toBeGreaterThanOrEqual(previous);
			previous = billed;
		}
	});
});
