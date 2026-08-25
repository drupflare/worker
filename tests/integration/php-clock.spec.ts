import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What PHP's wall clock actually reads inside workerd, and what a caller does to it next.
 *
 * P41 SCHEDULED A SECURITY FIX ON A PREMISE NOBODY HAD MEASURED. RULE 0 records that in-PHP
 * `microtime()` "returns 0 on the edge", and every reading behind that sentence is a DELTA --
 * `steadySeqMs: [0]`, `wallMs: 0`, `/clock`'s own `busyMicrotimeMs`. Workers freeze `Date.now()`
 * between I/O boundaries; frozen is not zero, and the report says so itself two sections away. The
 * ABSOLUTE had never been read out of PHP anywhere, and it is a real epoch.
 *
 * WHAT IS REALLY BROKEN IS THE INT WIDTH, AND IT IS NOT THE CLOCK. `PHP_INT_SIZE` is 4 here, so
 * `(int) (microtime(true) * 1000)` and `(int) round(microtime(true) * 1e6)` -- the two idioms P41
 * names a real module uses -- both overflow and wrap. Measured, the cast is modular rather
 * than saturating: 1787454172276.0 casts to 747777140, exactly `mod 2^32` into a signed range.
 * That reorders the fix: a `cfwNow` host bridge returning `Date.now()` would hand PHP the same
 * float `microtime()` already gives it and change nothing. A 64-bit `zend_long` (P28) is what
 * closes it.
 *
 * The two consequences, each the opposite of what was written down:
 *
 *   - a re-authentication window comparing two wrapped millisecond stamps is CORRECT, because both
 *     wrap identically and the difference survives; at a wrap boundary the older stamp is larger,
 *     the age goes negative and an `age >= 0` guard fails CLOSED. Not permanently open.
 *   - a journal refusing a non-positive microsecond stamp is broken for roughly HALF of every
 *     2^32-microsecond cycle -- ~35.8 minutes in every 71.6 -- because that is when the wrap lands
 *     in the negative half. "It never works" and "it works half the time, unpredictably" need
 *     different fixes.
 *
 * WHAT IS STILL TRUE is the freeze, and it is the hazard that actually cost this project 32
 * seconds of billed CPU: a deadline computed and then tested inside ONE invocation never passes,
 * which is why `Lock::wait()` spun for its full 30 s and why `CfwLockBackend` grants instead.
 *
 * A LOCAL READING IS NOT AN EDGE READING and this file does not claim to be one -- miniflare's
 * clock advances where a deployed one does not. What it pins is the clock SOURCE and the int
 * width, neither of which the platform changes: PHP's time comes through the emscripten glue's
 * `_emscripten_date_now = () => Date.now()`, so a frozen edge reading is the same value, held
 * still. `/clock` on `src/probes/min.ts` reports `absoluteS` and `jsAbsoluteMs` for the deployed
 * reading.
 */

type Clock = Record<string, unknown>;

const readClock = (code: string) =>
	inObject(freshSite(), async (site: ServeDo) => site.runJson(code)) as Promise<Clock>;

describe("PHP's wall clock", () => {
	it('is a real epoch, not zero, and agrees with the isolate', async () => {
		const before = Date.now();
		const out = await readClock(
			`<?php echo json_encode([
					'micro' => microtime(true),
					'time' => time(),
					'reqTime' => $_SERVER['REQUEST_TIME'] ?? null,
				]);`
		);
		const after = Date.now();

		// 1.7e9 is 2023-11; anything below it is a clock that did not start at the epoch it
		// claims. The bounds are what stop a frozen-at-boot reading passing as current
		expect(Number(out.micro) * 1000).toBeGreaterThanOrEqual(before - 60_000);
		expect(Number(out.micro) * 1000).toBeLessThanOrEqual(after + 60_000);
		expect(Number(out.time)).toBe(Math.floor(Number(out.micro)));
		expect(Number(out.reqTime)).toBeGreaterThan(1.7e9);
	}, 900_000);

	it('is 32-bit, so a millisecond or microsecond cast WRAPS rather than saturating', async () => {
		const out = await readClock(
			`<?php $m = microtime(true); echo json_encode([
					'intSize' => PHP_INT_SIZE,
					'intMax' => PHP_INT_MAX,
					'reauthMs' => (int) ($m * 1000),
					'journalUs' => (int) round($m * 1e6),
					'fixedCast' => (int) 1787454172276.0,
					'y2038' => (int) 2147483648,
				]);`
		);

		expect(Number(out.intSize)).toBe(4);
		expect(Number(out.intMax)).toBe(2147483647);
		// the two module idioms P41 named. Both are in range for a 32-bit int, which is the
		// whole problem: they look like timestamps and are not
		expect(Math.abs(Number(out.reauthMs))).toBeLessThanOrEqual(2147483647);
		expect(Math.abs(Number(out.journalUs))).toBeLessThanOrEqual(2147483647);
		// MODULAR, not saturating, and measured on a fixed input so the assertion does not
		// depend on when it runs. 1787454172276 mod 2^32 = 747777140
		expect(Number(out.fixedCast)).toBe(747777140);
		expect(Number(out.y2038)).toBe(-2147483648);
	}, 900_000);

	it('reports 0 for memory_get_usage, which is a BUILD property and not an edge one', async () => {
		// grouped with `microtime()` in the report as "also reads 0 on the edge". It reads 0
		// HERE, in a lane where the clock demonstrably works, so the two have nothing to do
		// with each other and only one of them is about the platform
		const out = await readClock(
			`<?php echo json_encode([
					'usage' => memory_get_usage(),
					'peak' => memory_get_peak_usage(true),
					'limit' => ini_get('memory_limit'),
				]);`
		);
		expect(Number(out.usage)).toBe(0);
		expect(Number(out.peak)).toBe(0);
		// while the ini entry the same build reports IS meaningful, which is the contrast
		expect(String(out.limit)).toMatch(/^\d+M$/);
	}, 900_000);
});
