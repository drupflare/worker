import { describe, expect, it } from 'vitest';
import { emptyTally } from '../../src/db/write-tally';
import { inObject, markProvisioned, provisionedSite, type ServeDo } from '../helpers/serve-do';

/**
 * What one IDLE warming tick writes, which is the meter `SITE_WARM` is priced against.
 *
 * ROWS ARE MEASURED HERE AND TIME IS NOT. A row count is deterministic and free, so it belongs in
 * the gate; `activeTime` and `cpuTime` are only observable on a deployed worker's billing GraphQL,
 * because `Date.now()` is frozen between I/O inside a Worker and a duration taken from it would be
 * wrong in a way that survives review.
 *
 * Idle means: nothing queued, no cron due, no mail, no HTTP drain. That is the tick a warmed site
 * spends almost all of its firings on -- 10,800 a day at 8 s -- so it is the one that decides
 * whether warming fits inside a plan's daily row budget.
 */

const REQUEST_TIMEOUT = 300_000;

describe('an idle warming tick', () => {
	it(
		'writes a bounded number of rows per firing',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				site.ensureServeTables();
				site.ensureHttpTables();
				// a first firing settles whatever one-off state the object writes on its way to idle,
				// so the reading below is of the STEADY tick rather than of the first one
				await site.alarm();

				const perFiring: number[] = [];
				const tables: Record<string, number>[] = [];
				for (let i = 0; i < 3; i++) {
					site.writeTally = emptyTally();
					await site.alarm();
					perFiring.push(site.writeTally?.rowsWritten ?? -1);
					tables.push({ ...(site.writeTally?.byTable ?? {}) });
					site.writeTally = undefined;
				}
				return { perFiring, tables, queue: site.queueDepth() };
			});

			// the control: an object with work to do is not measuring an idle tick
			expect(seen.queue).toBe(0);

			for (const rows of seen.perFiring) {
				// EXACTLY ONE: the `setAlarm`, and nothing else. This charged three until
				// `shouldFlushMeters()` gated the daily counters, and the two extra rows were those
				// counters recording their own writes -- on an idle tick there is nothing else for
				// them to record. At 8 s that difference is 32,400 rows a day against 13,680.
				expect(
					rows,
					`an idle tick wrote ${rows} rows; tables: ${JSON.stringify(seen.tables)}`
				).toBe(1);
			}

			// steady rather than growing: a tick whose cost climbs is an accumulating write, and it
			// would not show up in a single reading
			expect(new Set(seen.perFiring).size, `not steady: ${seen.perFiring}`).toBe(1);
		},
		REQUEST_TIMEOUT
	);
});
