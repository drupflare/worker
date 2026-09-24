import { describe, expect, it } from 'vitest';
import { emptyTally } from '../../src/db/write-tally';
import { ABSORBED_HEADER } from '../../src/ops/cold-encounter';
import { dayMetersKey } from '../../src/ops/day-meters';
import { freshSite, inObject, markProvisioned, seedPage, type ServeDo } from '../helpers/serve-do';

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

type Share = {
	noPhp: number;
	warm: number;
	cold: number;
	absorbed: number;
	traffic: number;
	coldOfPhp: number | null;
	coldOfObject: number | null;
	coldOfTraffic: number | null;
};

type Rate = { today: Share; incarnation: Share };

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

/**
 * The denominator, which was about 5x too small and looked like a measurement.
 *
 * A plan hit, an isolate memo hit, a `caches.default` hit and a KV page read all return from the
 * front worker, so the object cannot see any of them -- and they are most of the traffic. The count
 * rides in on the next request that hops anyway.
 */
describe('what the front worker absorbed', () => {
	it(
		'reaches the object on a request it was making regardless',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				markProvisioned(site);
				seedPage(site, '/counted', '<html><body>counted</body></html>');
				const rate = () =>
					(site as unknown as { coldEncounterRate(): Rate }).coldEncounterRate();

				await site.fetch(new Request(`${ORIGIN}/__serve?path=/counted`));
				const unreported = rate();

				await site.fetch(
					new Request(`${ORIGIN}/__serve?path=/counted`, {
						headers: { [ABSORBED_HEADER]: '400' }
					})
				);
				const reported = rate();

				// attacker-supplied, because every inbound header is
				await site.fetch(
					new Request(`${ORIGIN}/__serve?path=/counted`, {
						headers: { [ABSORBED_HEADER]: '-1' }
					})
				);
				const afterNonsense = rate();
				return { unreported, reported, afterNonsense };
			});

			// THE CONTROL: with nothing reported the share is withheld rather than reported 5x high
			expect(seen.unreported.incarnation.absorbed).toBe(0);
			expect(seen.unreported.incarnation.coldOfTraffic).toBeNull();

			expect(seen.reported.incarnation.absorbed).toBe(400);
			expect(seen.reported.incarnation.traffic).toBeGreaterThan(
				seen.unreported.incarnation.traffic + 400
			);
			expect(seen.afterNonsense.incarnation.absorbed).toBe(400);
		},
		TIMEOUT
	);
});

/**
 * Four counters, one row.
 *
 * Each had a `cfw_meta` key of its own, so a flush on a trafficked site wrote four rows to record a
 * batch of writes, under comments saying the folding cost no row of its own. The folding saved the
 * ALARM and never the rows.
 */
describe('the packed meter row', () => {
	it(
		'charges one row for all four counters',
		async () => {
			const seen = await inObject(freshSite(), async (site: ServeDo) => {
				markProvisioned(site);
				seedPage(site, '/packed', '<html><body>packed</body></html>');
				site.flushMeters();
				for (let i = 0; i < 4; i++) {
					await site.fetch(
						new Request(`${ORIGIN}/__serve?path=/packed`, {
							headers: { [ABSORBED_HEADER]: '9' }
						})
					);
				}
				site.writeTally = emptyTally();
				const total = site.flushMeters();
				const rows = site.writeTally?.rowsWritten ?? -1;
				const byTable = { ...(site.writeTally?.byTable ?? {}) };
				site.writeTally = undefined;
				return { rows, byTable, total };
			});

			// THE CONTROL: a flush with nothing pending writes nothing and proves nothing
			expect(seen.total.serveTotal, 'nothing was pending').toBeGreaterThan(0);
			expect(seen.total.doRequests).toBeGreaterThan(0);
			expect(seen.total.encounters.absorbed).toBe(36);
			// ONE, against the four keys this replaced
			expect(seen.rows, JSON.stringify(seen.byTable)).toBe(1);
		},
		TIMEOUT
	);

	/**
	 * An object upgraded mid-day would otherwise restart its daily counters at zero, and the row
	 * budget is what the degrade guard reads. The legacy read writes nothing and stops mattering as
	 * soon as the day has been flushed once.
	 */
	it(
		'reads the four keys it replaced while the packed row is absent',
		async () => {
			const seen = await inObject(freshSite(), (site: ServeDo) => {
				const day = new Date().toISOString().slice(0, 10);
				site.metaSet(`rows_written_${day}`, 4_100);
				site.metaSet(`do_requests_${day}`, 900);
				site.metaSet(`encounters_${day}`, '40,8,2');
				site.metaSet('serve_requests', 71_004);
				const legacy = site.storedMeters();

				site.metaSet(dayMetersKey(Date.now()), '1:2:3:0,0,0,0');
				return { legacy, packed: site.storedMeters() };
			});

			expect(seen.legacy).toEqual({
				rows: 4_100,
				doRequests: 900,
				serveTotal: 71_004,
				encounters: { noPhp: 40, warm: 8, cold: 2, absorbed: 0 },
				// the legacy keys predate the KV grant, so they granted none
				kvWrites: 0
			});
			// and the packed row supersedes them the moment it exists
			expect(seen.packed.rows).toBe(1);
			expect(seen.packed.serveTotal).toBe(3);
		},
		TIMEOUT
	);
});
