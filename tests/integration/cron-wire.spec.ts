import { describe, expect, it } from 'vitest';
import { writeCursor, type StoredCursor } from '../../src/ops/cron';
import { DEFAULT_CRON_BUDGET, driveCron } from '../../src/ops/cron-drive';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Drupal's cron, run for real, more than once.
 *
 * **Driven directly rather than through the alarm.** The alarm gates cron behind a 15-minute
 * interval that a test cannot wait out and must not reach into storage to forge; `cron-drive.spec.ts`
 * owns that gate as pure logic. This owns the half that gate protects: what happens when it opens.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;

const deps = (site: ServeDo) => ({
	sql: site.sql,
	runJson: (code: string) => site.runJson(code)
});

/** several firings in a row, the way the alarm chain would deliver them */
async function sweep(site: ServeDo, passes: number) {
	let cursor: unknown = undefined;
	const runs: Array<{ units: number; rowsWritten: number; more: boolean; ran: string[] }> = [];
	for (let i = 0; i < passes; i++) {
		const driven = await driveCron(cursor, deps(site), {}, DEFAULT_CRON_BUDGET);
		cursor = writeCursor(driven.cursor as StoredCursor);
		runs.push({
			units: driven.units,
			rowsWritten: driven.rowsWritten,
			more: driven.more,
			ran: driven.ran
		});
	}
	return runs;
}

describe('the cron wire, against a real interpreter', () => {
	it(
		'discovers Drupal cron handlers and invokes them across several firings',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const runs = await sweep(site, 6);
				const state = (await site
					.fetch(
						new Request(
							`https://do.local/__sql?q=${encodeURIComponent(
								"SELECT name FROM key_value WHERE collection = 'state' AND name LIKE '%cron%'"
							)}`
						)
					)
					.then((r) => r.json())) as Payload;
				return { runs, state };
			});

			const runs = out.runs as Array<{ units: number; rowsWritten: number; ran: string[] }>;

			// something ran. A driver that returns zero units every firing is the silent-no-op shape
			// this file exists to refuse
			const totalUnits = runs.reduce((n, r) => n + r.units, 0);
			expect(totalUnits, 'no cron unit ran at all').toBeGreaterThan(0);

			// and it ran across MORE THAN ONE firing, which is what a sliced cron means
			expect(runs.filter((r) => r.units > 0).length).toBeGreaterThan(1);

			// no unit reported a PHP error; `driveCron` encodes those into `ran` rather than throwing,
			// so a run that failed every unit still returns cleanly and would pass a naive check
			const errors = runs.flatMap((r) => r.ran).filter((name) => name.startsWith('error:'));
			expect(errors, `cron units failed: ${errors.join(' | ')}`).toEqual([]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'stays inside its row budget on every firing, so a busy site cannot spend the ceiling',
		async () => {
			const runs = (await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				return sweep(site, 8);
			})) as Array<{ rowsWritten: number; units: number }>;

			for (const run of runs) {
				expect(
					run.rowsWritten,
					`a firing wrote ${run.rowsWritten} rows against a budget of ${DEFAULT_CRON_BUDGET.maxRows}`
				).toBeLessThanOrEqual(DEFAULT_CRON_BUDGET.maxRows);
				expect(run.units).toBeLessThanOrEqual(DEFAULT_CRON_BUDGET.maxUnits);
			}

			// the whole sweep is what a day of alarms costs; a figure worth having in front of the
			// regeneration ceiling rather than an assertion with a made-up threshold
			const total = runs.reduce((n, r) => n + r.rowsWritten, 0);
			console.log(`[cron] 8 firings wrote ${total} charged rows`);
			expect(total).toBeGreaterThanOrEqual(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'repeats: a second sweep over the same site runs again rather than latching done',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await sweep(site, 6);
				const second = await sweep(site, 6);
				return { first, second };
			});

			const unitsOf = (runs: unknown) =>
				(runs as Array<{ units: number }>).reduce((n, r) => n + r.units, 0);

			// a cron that runs once and then latches is the scheduler failure mode: content is
			// published on the first pass and never again
			expect(unitsOf(out.first)).toBeGreaterThan(0);
			expect(unitsOf(out.second), 'the second sweep did nothing').toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);
});
