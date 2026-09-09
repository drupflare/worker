import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The cold-encounter rate, counted at the boundary that knows.
 *
 * `tests/unit/ops/cold-encounter.spec.ts` owns the arithmetic. This owns the question a unit test
 * cannot ask: does the object actually classify its own requests, and does dropping the interpreter
 * move the count. A counter wired to nothing reports a plausible 0% forever, which is worse than
 * reporting nothing at all -- and this project has shipped that shape enough times to check for it.
 *
 * Nothing here asserts a duration. The cold boot's COST is measured on a deployed worker; what this
 * file establishes is that the SHARE is observable, which is the figure a boot proposal is scored
 * against.
 */

type Rate = {
	today: { noPhp: number; warm: number; cold: number; coldOfPhp: number | null };
	incarnation: { noPhp: number; warm: number; cold: number; coldOfPhp: number | null };
};

const ORIGIN = 'https://do.local';
const TIMEOUT = 900_000;

describe('the cold-encounter rate, wired', () => {
	it(
		'counts a boot as cold, the next entry as warm, and a dropped interpreter as cold again',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				const rate = () =>
					(site as unknown as { coldEncounterRate(): Rate }).coldEncounterRate();

				// the migrate already entered the interpreter, so start from a known drop
				(site as unknown as { php: unknown }).php = null;
				const before = rate();

				await site.runJson('<?php echo json_encode(["a" => 1]);');
				const afterBoot = rate();
				await site.runJson('<?php echo json_encode(["a" => 2]);');
				const afterWarm = rate();

				(site as unknown as { php: unknown }).php = null;
				await site.runJson('<?php echo json_encode(["a" => 3]);');
				const afterDrop = rate();
				return { before, afterBoot, afterWarm, afterDrop };
			});

			// THE CONTROL: if the counter never moves, every assertion below passes on a dead counter
			expect(
				seen.afterBoot.incarnation.cold,
				'the cold counter did not move, so nothing is counting'
			).toBeGreaterThan(seen.before.incarnation.cold);

			// a boot is one cold encounter and re-entering the resident interpreter is a warm one
			expect(seen.afterWarm.incarnation.warm).toBeGreaterThan(
				seen.afterBoot.incarnation.warm
			);
			expect(seen.afterWarm.incarnation.cold).toBe(seen.afterBoot.incarnation.cold);

			// and an evicted interpreter is cold again, which is the whole point of the metric
			expect(seen.afterDrop.incarnation.cold).toBeGreaterThan(
				seen.afterWarm.incarnation.cold
			);
		},
		TIMEOUT
	);

	it(
		'answers null rather than zero before anything has needed PHP',
		async () => {
			const rate = await inObject(freshSite(), (site: ServeDo) =>
				(site as unknown as { coldEncounterRate(): Rate }).coldEncounterRate()
			);
			// a site that has served nothing has not demonstrated a 0% cold rate; reporting one would
			// make an unused site read like a well-tuned one
			expect(rate.incarnation.coldOfPhp).toBeNull();
		},
		TIMEOUT
	);

	it(
		'survives the daily flush, so the share is not lost when the alarm folds it',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				const obj = site as unknown as {
					coldEncounterRate(): Rate;
					flushEncounters(): { cold: number };
				};
				// PHP driven explicitly, because the default migration engine is `sql` and replays the
				// packed chunks in JavaScript without entering the interpreter at all. The control
				// below caught that: a migrate alone counts no encounter of any kind
				await site.runJson('<?php echo json_encode(["ready" => 1]);');
				const beforeFlush = obj.coldEncounterRate();
				const flushed = obj.flushEncounters();
				const afterFlush = obj.coldEncounterRate();
				return { beforeFlush, flushed, afterFlush };
			});

			// THE CONTROL: with nothing counted the flush is a no-op and proves nothing
			expect(
				seen.beforeFlush.incarnation.cold,
				'nothing was counted before the flush'
			).toBeGreaterThan(0);
			// the incarnation counter resets and the day's total keeps it, which is what makes the
			// meter cost one row on a firing rather than one per request
			expect(seen.afterFlush.incarnation.cold).toBe(0);
			expect(seen.afterFlush.today.cold).toBe(seen.beforeFlush.today.cold);
		},
		TIMEOUT
	);
});
