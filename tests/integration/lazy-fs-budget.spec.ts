import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The lazy-FS budget is a TRADE between two ceilings, and neither side had been measured.
 *
 * `LAZY_FS_BUDGET_BYTES` bounds the inflated file cache. MEMFS contents are typed arrays on the JS
 * heap, invisible to a reading of wasm linear memory, and the isolate's 128 MB covers both halves --
 * so the budget is not a performance knob, it is how much of the isolate the JS side may take.
 *
 * **RAISING IT TO FIT THE RENDER PATH BREAKS THE INSTALL PATH, measured 2026-08-19.** The backlog
 * carried "eviction budget 20 MB -> 4 MB reclaims ~16 MB with no rebuild" as free headroom, and the
 * shipping config already sat at 4 MiB. Two measurements, in the order they were taken:
 *
 * 1. With the budget raised to 64 MiB so nothing evicts, five ordinary page renders demand
 *    **12,564,673 bytes** on the shipping 8.5 interpreter. At 4 MiB the same five renders evict and
 *    **re-inflate 4 files**. So the render path IS paying for the budget -- that part was real.
 * 2. Raising it to 16 MiB to stop that took the JS side to **24,237,990 bytes** during a module
 *    install, over the 20 MiB ceiling `enable-memory.spec.ts` pins -- and that ceiling exists
 *    because the wasm heap peaks ~110 MB during an install against a 128 MB isolate.
 *
 * **The install wins, and it is not close.** Exceeding the isolate limit during an install takes the
 * object down; a re-inflation costs milliseconds on a render and is reversible by construction,
 * because eviction drops inflated contents while the compressed blob stays resident. So 4 MiB is not
 * over-tight tuning inherited from the 8.3 build -- it is the price of the install envelope, and
 * nothing had written that down.
 *
 * This file exists so the next person to see `reinflated: 4` and reach for a bigger number finds the
 * reason first. It asserts the trade, not a value.
 */

const REQUEST_TIMEOUT = 900_000;

/** what `wrangler.jsonc` sets */
const CONFIGURED_BUDGET = 4 * 1024 * 1024;

/**
 * True demand, measured with the budget raised to 64 MiB so nothing was evicted: **12,564,673
 * bytes** across the five paths below, on the shipping 8.5 interpreter.
 */
const MEASURED_DEMAND = 12_564_673;

type MountReport = {
	mount?: {
		budgetBytes?: number;
		inflateStats?: {
			residentBytes?: number;
			highWaterBytes?: number;
			evicted?: number;
			reinflated?: number;
		};
	} | null;
};

/** the paths a visitor actually reaches on the shipped site, so the figure is a real one */
const PATHS = ['/', '/node', '/user/login', '/user/password', '/filter/tips'];

async function measure(site: ServeDo, budget?: number) {
	if (budget !== undefined) site.env.LAZY_FS_BUDGET_BYTES = String(budget);
	await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
	for (const path of PATHS) {
		await site.runJson(renderPage(path, [], false, { origin: 'https://budget.example' }));
	}
	const res = await site.fetch(new Request('https://do.local/__php'));
	const body = (await res.json()) as MountReport;
	const stats = body.mount?.inflateStats;
	return {
		budget: body.mount?.budgetBytes ?? 0,
		resident: stats?.residentBytes ?? 0,
		highWater: stats?.highWaterBytes ?? 0,
		evicted: stats?.evicted ?? 0,
		reinflated: stats?.reinflated ?? 0
	};
}

describe('the lazy-FS budget against real render demand', () => {
	it(
		'is deliberately BELOW demand, so eviction on the render path is the expected state',
		async () => {
			const out = await inObject(freshSite(), (site: ServeDo) => measure(site));

			// the mount reported something, or every assertion below is vacuous
			expect(out.budget, 'the lazy mount must be the one in use').toBeGreaterThan(0);
			expect(out.budget).toBe(CONFIGURED_BUDGET);

			// the trade, stated as an assertion: the budget does not cover demand, on purpose
			expect(CONFIGURED_BUDGET).toBeLessThan(MEASURED_DEMAND);
			expect(out.evicted, 'a budget under demand must actually evict').toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * Demand itself, measured with eviction disabled.
	 *
	 * A ceiling rather than an equality: what a render touches moves with the templates, and pinning
	 * the exact figure would fail this file on an unrelated change. What must stay true is that
	 * demand has not grown to a size where even the compressed blob plus a minimal cache would
	 * threaten the install envelope.
	 */
	it(
		'measures demand with eviction off, and it has not run away',
		async () => {
			const out = await inObject(freshSite(), (site: ServeDo) =>
				measure(site, 64 * 1024 * 1024)
			);

			expect(out.reinflated, 'nothing may evict at 64 MiB, or this is not demand').toBe(0);
			expect(out.highWater).toBeGreaterThan(0);
			// 50% above the recorded figure: room for template churn, not for a doubling
			expect(out.highWater).toBeLessThan(MEASURED_DEMAND * 1.5);
		},
		REQUEST_TIMEOUT
	);
});
