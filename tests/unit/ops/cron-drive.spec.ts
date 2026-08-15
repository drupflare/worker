import { describe, expect, it } from 'vitest';
import {
	cronBudget,
	cronDue,
	cronIntervalMs,
	DEFAULT_CRON_BUDGET,
	DEFAULT_CRON_INTERVAL_MS,
	driveCron,
	drupalCronEnabled
} from '../../../src/ops/cron-drive';
import { NOW_S, seed, type Sql, withSql } from '../../helpers/drupal-schema';

/**
 * The alarm-side budget for Drupal cron.
 *
 * `cron-chain.spec.ts` covers `cronStep()` walking the ring one unit at a time. This covers the
 * layer above it: how many of those units one alarm firing is allowed to spend, and which budget
 * ends the firing. Runs against the REAL `ctx.storage.sql` for the same reason that spec does --
 * the SQL units execute the statements a Durable Object would -- with only PHP stubbed.
 *
 * The property that matters most here is the PHP stop. `cronStep` reports `mayContinue: false` the
 * moment a unit enters the interpreter, and the driver must end the firing there rather than
 * chaining another one. A cron loop that kept the isolate for several hooks would be spending it
 * while a visitor waits behind the fill queue, which is the whole reason the alarm is ordered the
 * way it is.
 */

function stubDeps(sql: Sql, phpReplies: Record<string, Record<string, unknown>> = {}) {
	const calls: string[] = [];
	return {
		calls,
		sql,
		async runJson(code: string) {
			const m = /json_decode\("\\"([a-z0-9_:.-]+)\\""\)/.exec(code);
			const name = m?.[1] ?? 'unknown';
			calls.push(name);
			return phpReplies[name] ?? { ran: true, module: name };
		},
		nowMs: () => NOW_S * 1000
	};
}

const options = { nowMs: NOW_S * 1000 };

describe('drupalCronEnabled', () => {
	it('is ON when nothing says otherwise, because a silent no-op is the worst default', () => {
		// it shipped off, and that made six surveyed contrib modules do nothing with no error
		// anywhere: Scheduler never publishes, Search API never indexes, Simple XML Sitemap never
		// generates. "cron has not run" and "there was nothing to do" look identical from outside
		expect(drupalCronEnabled(null)).toBe(true);
		expect(drupalCronEnabled({})).toBe(true);
		expect(drupalCronEnabled({ DRUPAL_CRON: undefined })).toBe(true);
		expect(drupalCronEnabled({ DRUPAL_CRON: '' })).toBe(true);
	});

	it('is turned OFF explicitly, in the spellings a wrangler var can arrive as', () => {
		expect(drupalCronEnabled({ DRUPAL_CRON: '0' })).toBe(false);
		expect(drupalCronEnabled({ DRUPAL_CRON: 0 })).toBe(false);
		expect(drupalCronEnabled({ DRUPAL_CRON: 'false' })).toBe(false);
	});

	it('accepts the three spellings a wrangler var can arrive as', () => {
		expect(drupalCronEnabled({ DRUPAL_CRON: '1' })).toBe(true);
		expect(drupalCronEnabled({ DRUPAL_CRON: 1 })).toBe(true);
		expect(drupalCronEnabled({ DRUPAL_CRON: 'true' })).toBe(true);
	});
});

describe('cronBudget', () => {
	it('defaults to a budget under half a percent of the daily row ceiling', () => {
		expect(cronBudget(null)).toEqual(DEFAULT_CRON_BUDGET);
		// 500 rows against the 100,000/day free ceiling is 0.5%, so cron firing on every alarm
		// all day cannot by itself consume the regeneration budget
		expect(DEFAULT_CRON_BUDGET.maxRows / 100_000).toBeLessThanOrEqual(0.005);
	});

	it('takes overrides and refuses nonsense ones', () => {
		expect(cronBudget({ CRON_MAX_UNITS: '3', CRON_MAX_ROWS: 50, CRON_MAX_MS: '250' })).toEqual({
			maxUnits: 3,
			maxRows: 50,
			maxMs: 250
		});
		// zero and negative would disable the loop or spin it; both fall back
		expect(cronBudget({ CRON_MAX_UNITS: '0' }).maxUnits).toBe(DEFAULT_CRON_BUDGET.maxUnits);
		expect(cronBudget({ CRON_MAX_ROWS: -1 }).maxRows).toBe(DEFAULT_CRON_BUDGET.maxRows);
		expect(cronBudget({ CRON_MAX_MS: 'soon' }).maxMs).toBe(DEFAULT_CRON_BUDGET.maxMs);
	});
});

describe('driveCron', () => {
	it('runs the cheap SQL units and stops at the first PHP one', async () => {
		await withSql(async (sql) => {
			seed(sql);
			const deps = stubDeps(sql);
			// a generous row budget, so the PHP stop is what ends the firing rather than the
			// watchdog trim below
			const result = await driveCron(null, deps, options, {
				maxUnits: 99,
				maxRows: 1e9,
				maxMs: 1e9
			});
			expect(result.stoppedBy).toBe('php');
			// exactly one interpreter entry per firing, however many SQL units preceded it
			expect(deps.calls.length).toBe(1);
			expect(result.units).toBeGreaterThan(1);
			expect(result.ran.length).toBe(result.units);
			expect(result.ran[0]).toBe('gc:watchdog');
		});
	});

	/**
	 * The first catch-up firing does not fit the default budget, and that is the budget working.
	 *
	 * On the reference site the watchdog trim alone deletes 662 rows and is billed well past the
	 * 500-row default, so cron stops on `rows` before it ever reaches a hook. The alternative --
	 * a budget wide enough to swallow the backlog in one firing -- would spend page fills to trim
	 * a log, which is the trade the row budget exists to refuse. Steady state writes nothing, so
	 * this is a first-run cost rather than a recurring one.
	 */
	it('stops on rows during catch-up, before it reaches a hook at all', async () => {
		await withSql(async (sql) => {
			seed(sql);
			const deps = stubDeps(sql);
			const result = await driveCron(null, deps, options);
			expect(result.stoppedBy).toBe('rows');
			expect(deps.calls).toEqual([]);
			expect(result.rowsWritten).toBeGreaterThan(DEFAULT_CRON_BUDGET.maxRows);
			// and it is resumable: the ring still has work and the cursor moved
			expect(result.more).toBe(true);
		});
	});

	it('resumes where the previous firing stopped', async () => {
		await withSql(async (sql) => {
			seed(sql);
			const first = await driveCron(null, stubDeps(sql), options);
			const second = await driveCron(first.cursor, stubDeps(sql), options);
			// the second firing does not repeat the first firing's last unit
			expect(second.ran[0]).not.toBe(first.ran[first.ran.length - 1]);
		});
	});

	it('stops on the unit budget before it stops on anything else', async () => {
		await withSql(async (sql) => {
			seed(sql);
			const result = await driveCron(null, stubDeps(sql), options, {
				maxUnits: 1,
				maxRows: 1e9,
				maxMs: 1e9
			});
			expect(result.units).toBe(1);
			expect(result.stoppedBy).toBe('units');
		});
	});

	it('stops on the row budget, which is the meter that binds', async () => {
		await withSql(async (sql) => {
			seed(sql);
			// seeded so a SQL pass actually writes; the budget is then hit rather than the ring end
			const result = await driveCron(null, stubDeps(sql), options, {
				maxUnits: 99,
				maxRows: 0.5,
				maxMs: 1e9
			});
			expect(['rows', 'php']).toContain(result.stoppedBy);
		});
	});

	it('stops on the wall-clock guard', async () => {
		await withSql(async (sql) => {
			seed(sql);
			let t = 0;
			// every read advances past the guard, so the first check ends the firing
			const result = await driveCron(
				null,
				stubDeps(sql),
				options,
				{ maxUnits: 99, maxRows: 1e9, maxMs: 10 },
				() => (t += 100)
			);
			expect(result.stoppedBy).toBe('ms');
			expect(result.units).toBe(0);
		});
	});

	it('never throws, and does not advance the cursor past a unit that threw', async () => {
		await withSql(async (sql) => {
			seed(sql);
			const deps = {
				sql,
				async runJson(): Promise<Record<string, unknown>> {
					throw new Error('hook_cron fatal: Asyncify is not defined');
				},
				nowMs: () => NOW_S * 1000
			};
			const result = await driveCron(null, deps, options, {
				maxUnits: 99,
				maxRows: 1e9,
				maxMs: 1e9
			});
			expect(result.stoppedBy).toBe('php');
			expect(result.more).toBe(true);
			expect(result.ran.join(' ')).toContain('Asyncify is not defined');
		});
	});

	it('reports the rows it spent, so a caller can meter cron against page fills', async () => {
		await withSql(async (sql) => {
			seed(sql);
			const result = await driveCron(null, stubDeps(sql), options);
			expect(result.rowsWritten).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(result.rowsWritten)).toBe(true);
		});
	});
});

describe('the interval gate, which is what makes cron-on-by-default safe', () => {
	it('does NOT fire on a site that has never run it', () => {
		// the first alarm on a fresh site carries the migration, the first fills and the first
		// render; an interpreter unit added there buys nothing, because a site with no content has
		// nothing to schedule, index or expire. The caller stamps the clock instead
		expect(cronDue(null, 1_000_000, DEFAULT_CRON_INTERVAL_MS)).toBe(false);
		expect(cronDue(Number.NaN, 1_000_000, DEFAULT_CRON_INTERVAL_MS)).toBe(false);
	});

	it('fires once the interval has elapsed and not before', () => {
		const interval = DEFAULT_CRON_INTERVAL_MS;
		expect(cronDue(1_000_000, 1_000_000 + interval - 1, interval)).toBe(false);
		expect(cronDue(1_000_000, 1_000_000 + interval, interval)).toBe(true);
		expect(cronDue(1_000_000, 1_000_000 + interval * 4, interval)).toBe(true);
	});

	it('is not locked out by a clock that moved backwards', () => {
		// the alarm is not a clock and the platform is not obliged to be monotonic; a stamp in the
		// future would otherwise disable cron until real time caught up to it
		expect(cronDue(5_000_000, 1_000, DEFAULT_CRON_INTERVAL_MS)).toBe(true);
	});

	it('bounds the worst case under the daily row ceiling, which is the whole argument', () => {
		// the per-firing budget bounds a FIRING and says nothing about how many there are. The alarm
		// re-arms at +1 ms while a fill queue drains, so without this gate an active site runs cron
		// once per page. 15 minutes caps it at 96 firings/day
		const firingsPerDay = (24 * 60 * 60 * 1000) / DEFAULT_CRON_INTERVAL_MS;
		expect(firingsPerDay).toBe(96);
		expect(firingsPerDay * DEFAULT_CRON_BUDGET.maxRows).toBeLessThan(100_000);
	});

	it('reads the interval from the environment and refuses nonsense', () => {
		expect(cronIntervalMs({ CRON_INTERVAL_MS: 60_000 })).toBe(60_000);
		expect(cronIntervalMs({ CRON_INTERVAL_MS: '60000' })).toBe(60_000);
		expect(cronIntervalMs({})).toBe(DEFAULT_CRON_INTERVAL_MS);
		expect(cronIntervalMs({ CRON_INTERVAL_MS: 'soon' })).toBe(DEFAULT_CRON_INTERVAL_MS);
		expect(cronIntervalMs({ CRON_INTERVAL_MS: -1 })).toBe(DEFAULT_CRON_INTERVAL_MS);
	});
});
