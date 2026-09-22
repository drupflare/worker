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

/** how `write-tally.ts` names a `setAlarm` in `byTable`; it is a storage op rather than a table */
const ALARM_ROW = '?storage.setAlarm';

/**
 * The other half of an alarm's row cost, and the one a docblock claimed for a year.
 *
 * `armFillAlarm()` sat under "Arms the fill alarm without disturbing one that is already sooner" and
 * called `setAlarm()` unconditionally. Every call is one charged row, on paths that are hot: an
 * aged-page serve, every deferred HTTP call inside one render, and the mail queue. The
 * `ON CONFLICT DO NOTHING` beside the first of those is what made its INSERT cost one row per burst,
 * and the arm on the next line cost one per hit.
 */
describe('a burst of fill enqueues', () => {
	it(
		'charges one alarm row for the burst rather than one per path',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				site.ensureServeTables();
				// consume whatever provisioning armed, so the burst below starts from a clean memo
				await site.alarm();
				site.alarmDueMs = undefined;

				site.writeTally = emptyTally();
				for (let i = 0; i < 12; i++) site.enqueueRefill(`/burst-${i}`);
				const byTable = { ...(site.writeTally?.byTable ?? {}) };
				site.writeTally = undefined;

				// a later alarm set by anything else has to clear the memo, or the next MISS sits
				// behind a keep-warm arm for four minutes -- the failure `/__fill`'s `getAlarm()`
				// check already exists to fix
				site.alarmDueMs = site.nowMs() + 240_000;
				site.writeTally = emptyTally();
				site.enqueueRefill('/after-a-later-alarm');
				const afterLater = { ...(site.writeTally?.byTable ?? {}) };
				site.writeTally = undefined;

				return { byTable, afterLater, queue: site.queueDepth() };
			});

			// the control: every INSERT landed, so what the guard deduped was the arms
			expect(seen.byTable.cfw_fill_queue).toBe(12);
			expect(seen.queue).toBe(13);
			// twelve enqueues, ONE arm
			expect(seen.byTable[ALARM_ROW]).toBe(1);
			// and the memo does not survive a later alarm, so the thirteenth arms again
			expect(seen.afterLater[ALARM_ROW]).toBe(1);
		},
		REQUEST_TIMEOUT
	);
});

describe('an idle warming tick', () => {
	it(
		'writes a bounded number of rows per firing',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				site.ensureServeTables();
				site.ensureHttpTables();
				// SETTLE TO THE STEADY TICK rather than assuming one firing gets there. One used to
				// be enough; the heap image takes a firing of its own once per pack generation, so a
				// fixed settle read the one-off and called it the steady cost
				const settling: number[] = [];
				for (let i = 0; i < 8; i++) {
					site.writeTally = emptyTally();
					await site.alarm();
					settling.push(site.writeTally?.rowsWritten ?? -1);
					site.writeTally = undefined;
					const n = settling.length;
					if (n >= 2 && settling[n - 1] === 1 && settling[n - 2] === 1) break;
				}

				const perFiring: number[] = [];
				const tables: Record<string, number>[] = [];
				for (let i = 0; i < 3; i++) {
					site.writeTally = emptyTally();
					await site.alarm();
					perFiring.push(site.writeTally?.rowsWritten ?? -1);
					tables.push({ ...(site.writeTally?.byTable ?? {}) });
					site.writeTally = undefined;
				}
				return { perFiring, tables, settling, queue: site.queueDepth() };
			});

			// the control: an object with work to do is not measuring an idle tick
			expect(seen.queue).toBe(0);

			// the one-off REACHES the steady tick, which is what says the heap image and the
			// provisioning writes do not recur. Their size is pinned where each is produced; summing
			// them here would measure the first firing's fill work and call it warming's cost
			expect(seen.settling.at(-1), `never settled to the steady tick: ${seen.settling}`).toBe(
				1
			);

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
