import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * `USE_ZEND_ALLOC=0` is baked in, so `memory_get_usage()` reading 0, the collector never running and
 * `memory_limit` never binding are ONE cause. A runaway takes the object, not one request.
 */

const run = (code: string) =>
	inObject(freshSite(), async (s: ServeDo) => s.runJson(code)) as Promise<
		Record<string, unknown>
	>;

describe("PHP's allocator on the shipping build", () => {
	it("runs with Zend's memory manager disabled", async () => {
		const out = await run(
			`<?php echo json_encode([
					'useZendAlloc' => getenv('USE_ZEND_ALLOC') === false ? 'unset' : getenv('USE_ZEND_ALLOC'),
					'startupLimit' => ini_get('memory_limit'),
				]);`
		);
		expect(out.useZendAlloc).toBe('0');
		// the seam does apply, which is what makes the next test a refutation
		expect(out.startupLimit).toBe('96M');
	}, 900_000);

	it('does NOT enforce memory_limit, so the ini in site-do.ts is decorative', async () => {
		const out = await run(
			`<?php
				ini_set('memory_limit', '8M');
				$err = null;
				try {
					$acc = [];
					for ($i = 0; $i < 300000; $i++) { $acc[] = str_repeat('y', 128); }
					$held = count($acc);
				} catch (\\Throwable $e) { $held = -1; $err = get_class($e); }
				echo json_encode([
					'limit' => ini_get('memory_limit'),
					'held' => $held,
					'error' => $err,
					'usage' => memory_get_usage(true),
					'peak' => memory_get_peak_usage(true),
				]);`
		);
		// ~38 MB of payload against a stated 8 MB cap
		expect(out.limit).toBe('8M');
		expect(out.held).toBe(300_000);
		expect(out.error).toBeNull();
		// and the counter that would have tripped the cap is the one reading zero
		expect(out.usage).toBe(0);
		expect(out.peak).toBe(0);
	}, 900_000);

	it('never runs the cycle collector, so baseline GC is not a cost', async () => {
		const out = await run(
			`<?php
				$acc = [];
				for ($i = 0; $i < 20000; $i++) { $acc[] = str_repeat('x', 64); }
				$acc = null;
				$s = gc_status();
				echo json_encode([
					'runs' => $s['runs'],
					'collected' => $s['collected'],
					'threshold' => $s['threshold'],
					'forced' => gc_collect_cycles(),
				]);`
		);
		// counts, not clocks; RULE 0 forbids the duration and not the counter
		expect(out.runs).toBe(0);
		expect(out.collected).toBe(0);
		expect(out.forced).toBe(0);
	}, 900_000);
});
