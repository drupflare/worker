import { describe, expect, it } from 'vitest';
import { DAILY_DO_QUOTA, DAILY_ROWS_QUOTA } from '../../../src/ops/auth-budget';
import {
	dailyLimit,
	degradation,
	degradeHeaders,
	READ_ONLY_AT,
	readOnlyResponse,
	REDUCE_AT
} from '../../../src/ops/degrade';

/**
 * The quota ladder.
 *
 * The meters and the thresholds both already existed; what did not was anything between them and a
 * serving decision. `thresholdReport()` had exactly one caller, the admin Limits page, so a site
 * rendered a chart of its own quota right up to the moment it hard-failed for the rest of the day.
 */

describe('the ladder', () => {
	const at = (rows: number, dos = 0) => degradation({ rowsFraction: rows, doFraction: dos });

	it('does nothing under the first rung', () => {
		const d = at(0.79);
		expect(d.level).toBe('normal');
		expect([d.cron, d.queue, d.watchdog, d.imageRegeneration, d.render, d.writes]).toEqual([
			true,
			true,
			true,
			true,
			true,
			true
		]);
	});

	it('stops discretionary work at the first rung and keeps serving', () => {
		const d = at(REDUCE_AT);
		expect(d.level).toBe('reduced');
		expect([d.cron, d.queue, d.watchdog, d.imageRegeneration]).toEqual([
			false,
			false,
			false,
			false
		]);
		// a visitor waiting on a page still gets one; that is the whole point of the rung
		expect(d.render).toBe(true);
		expect(d.writes).toBe(true);
	});

	it('stops writing at the second rung but still serves a GET', () => {
		const d = at(READ_ONLY_AT);
		expect(d.level).toBe('read-only');
		expect(d.writes).toBe(false);
		expect(d.render).toBe(false);
	});

	it('stays read-only past 100%, rather than wrapping to some other state', () => {
		expect(at(3.5).level).toBe('read-only');
	});

	/**
	 * WORST OF THE TWO, never an average.
	 *
	 * The meters bound different things and either one running out stops the site. Averaging a
	 * saturated meter against an idle one reports healthy right up to the failure, which is the
	 * shape of wrong answer this whole file exists to prevent.
	 */
	it('takes the worse meter and names it', () => {
		const rowsBound = at(0.96, 0.1);
		expect(rowsBound.level).toBe('read-only');
		expect(rowsBound.driver).toBe('rows');

		const doBound = at(0.1, 0.96);
		expect(doBound.level).toBe('read-only');
		expect(doBound.driver).toBe('do');

		// the average of 0.96 and 0.1 is 0.53, which would have read as normal
		expect(degradation({ rowsFraction: 0.96, doFraction: 0.1 }).level).not.toBe('normal');
	});

	it('reports no driver when nothing has been spent', () => {
		expect(at(0).driver).toBeNull();
	});

	/**
	 * A missing counter must not take a site read-only.
	 *
	 * This is consulted on the serving path, where the inputs are two `cfw_meta` reads that can be
	 * absent on a fresh object. Failing open is correct here: the cost of under-degrading for one
	 * request is one request, and the cost of over-degrading is a site that refuses everything.
	 */
	it('fails open on a missing or nonsense meter', () => {
		for (const bad of [NaN, Infinity, -1, -0.5]) {
			expect(degradation({ rowsFraction: bad, doFraction: bad }).level).toBe('normal');
		}
		// and a real reading beside a broken one still counts
		expect(degradation({ rowsFraction: NaN, doFraction: 0.99 }).level).toBe('read-only');
	});
});

describe('dailyLimit', () => {
	it('reads the allowance out of THRESHOLDS rather than restating it', () => {
		expect(dailyLimit('rows-written')).toBe(100_000);
		expect(dailyLimit('do-requests')).toBe(100_000);
	});

	/**
	 * THE SAME NUMBER LIVES IN TWO PLACES, so pin them together.
	 *
	 * `auth-budget.ts` declares its own `DAILY_ROWS_QUOTA` and `DAILY_DO_QUOTA`. They agree with
	 * `THRESHOLDS` today. Nothing made them agree, so the first plan change would have moved one and
	 * left the other, and the two surfaces would disagree about when a site is out of quota.
	 */
	it('agrees with the copy in auth-budget.ts', () => {
		expect(dailyLimit('rows-written')).toBe(DAILY_ROWS_QUOTA);
		expect(dailyLimit('do-requests')).toBe(DAILY_DO_QUOTA);
	});

	it('returns 0 for a meter that does not exist, rather than guessing', () => {
		expect(dailyLimit('not-a-meter' as 'rows-written')).toBe(0);
	});
});

describe('the refusal', () => {
	const d = degradation({ rowsFraction: 0.97, doFraction: 0 });

	/**
	 * `Retry-After` is seconds to the UTC reset, because that is when the condition clears.
	 *
	 * A fixed 60 would have a client retry roughly 1,400 times against a site that cannot answer
	 * until midnight.
	 */
	it('tells the client when the quota actually resets', async () => {
		const res = readOnlyResponse(3600, d);
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('3600');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.text()).toContain('rows');
	});

	it('never emits a retry-after of zero, which a client reads as a hot loop', () => {
		expect(readOnlyResponse(0, d).headers.get('retry-after')).toBe('1');
		expect(readOnlyResponse(-5, d).headers.get('retry-after')).toBe('1');
	});

	it('names the driver, so an operator knows which meter to act on', () => {
		expect(readOnlyResponse(60, d).headers.get('x-cfw-degrade-driver')).toBe('rows');
	});
});

describe('degradeHeaders', () => {
	it('adds nothing while the site is normal', () => {
		expect(degradeHeaders(degradation({ rowsFraction: 0.1, doFraction: 0.1 }))).toEqual({});
	});

	/**
	 * A degraded site has to SAY it is degraded.
	 *
	 * Otherwise "cron stopped running" is indistinguishable from "cron is broken", which is a
	 * support ticket rather than a quota reading.
	 */
	it('makes a reduced site observable from outside', () => {
		const h = degradeHeaders(degradation({ rowsFraction: 0.85, doFraction: 0 }));
		expect(h['x-cfw-degrade']).toBe('reduced');
		expect(h['x-cfw-degrade-driver']).toBe('rows');
		expect(h['x-cfw-degrade-at']).toBe('0.850');
	});
});
