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

describe('the hook list the object schedules from', () => {
	it(
		'discovers it from the site rather than using the shipped fallback',
		async () => {
			// `cronHookList()` was exported, spec`d and called by NOTHING, so `cronUnits()` always
			// fell back to KNOWN_CRON_HOOKS and a customer module`s hook_cron never ran
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await (site as any).cronHooksForSite();
				const second = await (site as any).cronHooksForSite();
				return {
					first,
					second,
					cached: (site as any).metaGet('cron_hooks')
				};
			});

			// the first call boots the kernel and asks the site; the second reads the cache
			expect(out.first.discovered).toBe(true);
			expect(out.first.hooks.length).toBeGreaterThan(0);
			expect(out.second.discovered).toBe(false);
			expect(out.second.hooks).toEqual(out.first.hooks);

			const cached = JSON.parse(String(out.cached)) as { at: string; hooks: string[] };
			expect(cached.at).not.toBe('');
			expect(cached.hooks).toEqual(out.first.hooks);
		},
		REQUEST_TIMEOUT
	);

	it(
		're-discovers when the enabled module set moves',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const before = (site as any).enabledModulesFingerprint();
				await (site as any).cronHooksForSite();
				site.sql.exec(
					"UPDATE config SET data = data || ? WHERE collection = '' AND name = 'core.extension'",
					' '
				);
				const after = (site as any).enabledModulesFingerprint();
				return { before, after, again: await (site as any).cronHooksForSite() };
			});

			expect(out.before).not.toBe('');
			expect(out.after).not.toBe(out.before);
			expect(out.again.discovered).toBe(true);
		},
		REQUEST_TIMEOUT
	);

	it(
		'the ALARM schedules from the discovered list, not just the helper',
		async () => {
			// the defect being closed is "exported, spec'd, called by nothing". A test that only
			// drives the helper would pass against exactly that, which is how it survived
			const out = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				// the heap image owns a firing of its own, so the chain has to run on
				const seen: string[][] = [];
				for (let i = 0; i < 6 && seen.length < 2; i++) {
					// open the 15-minute gate without reaching past it
					await site.storage.put('cronLastRunMs', Date.now() - 60 * 60 * 1000);
					await site.storage.setAlarm(Date.now() + 1);
					await site.alarm();
					const hooks = (site as any).lastCronHooks;
					if (Array.isArray(hooks)) seen.push(hooks);
				}
				return { seen, cron: (site as any).lastCron };
			});

			expect(out.seen.length, 'the alarm never asked for a hook list').toBeGreaterThan(1);
			expect(out.seen[0]!.length).toBeGreaterThan(0);
			// one firing discovered and the next scheduled from the cache
			expect(out.seen[1]).toEqual(out.seen[0]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'a discovered module reaches the ring, which is the half the list exists for',
		async () => {
			// asserting only that the alarm ASKED for a list passes against an alarm that asks and
			// then schedules from KNOWN_CRON_HOOKS anyway, which is the original defect exactly
			const ran = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				(site as any).metaSet(
					'cron_hooks',
					JSON.stringify({
						at: (site as any).enabledModulesFingerprint(),
						hooks: ['system', 'a_contrib_module']
					})
				);
				// one PHP unit per firing, so the second hook lands on a later one
				const seen: string[] = [];
				for (let i = 0; i < 8; i++) {
					await site.storage.put('cronLastRunMs', Date.now() - 60 * 60 * 1000);
					await site.storage.setAlarm(Date.now() + 1);
					await site.alarm();
					const last = (site as any).lastCron;
					if (Array.isArray(last?.ran)) seen.push(...last.ran);
				}
				return seen;
			});

			expect(ran.length).toBeGreaterThan(0);
			expect(
				ran.some((unit) => unit === 'hook:a_contrib_module'),
				`the ring ran ${JSON.stringify(ran)} and never reached the discovered module`
			).toBe(true);
		},
		REQUEST_TIMEOUT
	);
});
