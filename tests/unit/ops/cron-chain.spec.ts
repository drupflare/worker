import { describe, expect, it } from 'vitest';
import {
	cronAlarmDelayMs,
	cronStep,
	cronUnits,
	readCursor,
	writeCursor
} from '../../../src/ops/cron';
import { NOW_S, SCHEMA, type Sql, WATCHDOG_ROWS, seed, withSql } from '../../helpers/drupal-schema';

/**
 * Runs against the REAL `ctx.storage.sql`, so `cronStep()` executes the same statements the
 * Durable Object would. Only the PHP side is stubbed, because there is no interpreter in this
 * lane -- and that stub is doing real work: `cronStep` decides whether to enter PHP AT ALL from
 * a SQL read, so the assertion "no PHP was entered" is the one that proves an empty queue costs
 * one read rather than a 4-second boot.
 */

/** the same DDL with `queue` left out, for the missing-table case */
const SCHEMA_WITHOUT_QUEUE = SCHEMA.filter(
	(ddl) => !/CREATE TABLE IF NOT EXISTS queue\b/.test(ddl)
);

/** how many rows the watchdog trim must remove on the reference site */
const EXPECTED_TRIM = WATCHDOG_ROWS - 1000;

/**
 * The dependency bag `cronStep()` takes, with PHP stubbed.
 *
 * `runJson` recognises which unit is being run by pulling the name out of the emitted fragment,
 * exactly as the original did, so a change to how the fragment names its module shows up here
 * rather than silently making every reply generic.
 */
function stubDeps(sql: Sql, phpReplies: Record<string, Record<string, unknown>> = {}) {
	const calls: string[] = [];
	return {
		calls,
		sql,
		async runJson(code: string) {
			const m = /json_decode\("\\"([a-z0-9_:.-]+)\\""\)/.exec(code);
			// `m[1]` is optional under noUncheckedIndexedAccess even inside the truthy branch
			const name = m?.[1] ?? 'unknown';
			calls.push(name);
			return phpReplies[name] ?? { ran: true, module: name };
		},
		nowMs: () => NOW_S * 1000
	};
}

describe('cronStep: one full round', () => {
	it('visits every unit in order and returns to zero', async () => {
		const { seen, raw, calls } = await withSql(async (sql) => {
			seed(sql);
			const deps = stubDeps(sql);
			const units = cronUnits();
			let cursor: string | null = null;
			const visited: string[] = [];
			for (let i = 0; i < units.length; i++) {
				const step = await cronStep(cursor, deps, {});
				visited.push(step.unit);
				cursor = writeCursor(step.cursor);
			}
			return { seen: visited, raw: cursor, calls: deps.calls };
		});

		expect(seen).toEqual(cronUnits().map((u) => u.id));
		expect(readCursor(raw, cronUnits().length).i).toBe(0);
		// the whole point of the unit list: a round enters the interpreter exactly twice
		expect(calls).toEqual(['file', 'layout_builder']);
	});
});

describe('cronStep: the first unit', () => {
	it('is the watchdog trim, and a SQL unit lets the caller continue', async () => {
		const first = await withSql(async (sql) => {
			seed(sql);
			return cronStep(null, stubDeps(sql), {});
		});
		expect(first.unit).toBe('gc:watchdog');
		expect(first.kind).toBe('sql');
		expect(first.mayContinue).toBe(true);
		expect(first.more).toBe(true);
		// re-arms fast while the round has more to do
		expect(cronAlarmDelayMs(first)).toBe(1);
	});

	it('reports what it deleted exactly, and what it cost as the engine measured it', async () => {
		const first = await withSql(async (sql) => {
			seed(sql);
			return cronStep(null, stubDeps(sql), {});
		});
		expect(first.result.rowsDeleted).toBe(EXPECTED_TRIM);
		// a delete writes at least as many rows as it removed; the exact multiple is the
		// engine's index accounting, not a number this test gets to choose
		expect(first.rowsWritten).toBeGreaterThanOrEqual(EXPECTED_TRIM);
		// the running total is carried on the cursor so a round can be costed end to end
		expect(first.cursor.rowsWritten).toBe(first.rowsWritten);
	});
});

describe('cronStep: a PHP unit must be the last thing an invocation does', () => {
	it('reports kind php and refuses to let the caller continue', async () => {
		const step = await withSql(async (sql) => {
			seed(sql);
			return cronStep({ i: 3 }, stubDeps(sql), {});
		});
		expect(step.kind).toBe('php');
		// entering the interpreter is the expensive, unbounded thing; one per invocation
		expect(step.mayContinue).toBe(false);
		expect(step.rowsWritten).toBe(0);
	});
});

describe('cronStep: closing the round', () => {
	it('ends on cron_last and drops the alarm back to the keep-warm interval', async () => {
		const units = cronUnits();
		const step = await withSql(async (sql) => {
			seed(sql);
			return cronStep({ i: units.length - 1 }, stubDeps(sql), {});
		});
		expect(step.unit).toBe('cron_last');
		expect(step.more).toBe(false);
		expect(cronAlarmDelayMs(step)).toBe(240000);
		expect(cronAlarmDelayMs(step, { idleMs: 10000 })).toBe(10000);
	});
});

describe('cronStep: the queue costs one read when there is nothing to do', () => {
	it('skips without entering PHP and says why', async () => {
		const units = cronUnits();
		const { step, calls } = await withSql(async (sql) => {
			seed(sql);
			const deps = stubDeps(sql);
			const s = await cronStep({ i: units.length - 2 }, deps, {});
			return { step: s, calls: deps.calls };
		});
		expect(step.unit).toBe('queue');
		// the assertion that matters: an empty queue must not cost a boot
		expect(calls).toHaveLength(0);
		expect(step.result.skipped).toBe('queue is empty');
		expect(step.mayContinue).toBe(true);
	});

	it('treats a missing queue table as a skip rather than an error', async () => {
		const units = cronUnits();
		const { step, calls } = await withSql(async (sql) => {
			for (const ddl of SCHEMA_WITHOUT_QUEUE) sql.exec(ddl);
			const deps = stubDeps(sql);
			const s = await cronStep({ i: units.length - 2 }, deps, {});
			return { step: s, calls: deps.calls };
		});
		expect(step.result.skipped).toBe('no queue table');
		expect(calls).toHaveLength(0);
	});
});

describe('cronStep: a queue with items repeats the unit instead of advancing', () => {
	it('holds the cursor and counts the repeat, so N-at-a-time chains across invocations', async () => {
		const units = cronUnits();
		const at = units.length - 2;
		const { step, calls } = await withSql(async (sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			sql.exec(
				'INSERT INTO queue (name, data, expire, created) VALUES (?, ?, 0, ?)',
				'media_entity_thumbnail',
				'a',
				1
			);
			sql.exec(
				'INSERT INTO queue (name, data, expire, created) VALUES (?, ?, 0, ?)',
				'media_entity_thumbnail',
				'b',
				2
			);
			const deps = stubDeps(sql, {
				media_entity_thumbnail: { ran: true, processed: 1, remaining: 4 }
			});
			const s = await cronStep({ i: at }, deps, {});
			return { step: s, calls: deps.calls };
		});
		expect(calls[0]).toBe('media_entity_thumbnail');
		expect(step.cursor.i).toBe(at);
		expect(step.cursor.queueRepeats).toBe(1);
		expect(step.more).toBe(true);
	});

	it('advances past a queue that never drains, so a bad worker cannot chain forever', async () => {
		const units = cronUnits();
		const at = units.length - 2;
		const step = await withSql(async (sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			sql.exec(
				'INSERT INTO queue (name, data, expire, created) VALUES (?, ?, 0, ?)',
				'media_entity_thumbnail',
				'a',
				1
			);
			const deps = stubDeps(sql, {
				media_entity_thumbnail: { ran: true, processed: 1, remaining: 99 }
			});
			return cronStep({ i: at, queueRepeats: 20 }, deps, {});
		});
		expect(step.cursor.i).toBe(at + 1);
		expect(step.cursor.queueRepeats).toBe(0);
	});

	it('does not let a SUSPENDED queue hold the chain', async () => {
		const units = cronUnits();
		const at = units.length - 2;
		const step = await withSql(async (sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			sql.exec(
				'INSERT INTO queue (name, data, expire, created) VALUES (?, ?, 0, ?)',
				'media_entity_thumbnail',
				'a',
				1
			);
			const deps = stubDeps(sql, {
				media_entity_thumbnail: { ran: true, processed: 0, remaining: 3, suspended: true }
			});
			return cronStep({ i: at }, deps, {});
		});
		expect(step.cursor.i).toBe(at + 1);
	});
});

describe('cronStep: recovering from a lost or stale cursor', () => {
	it('starts a fresh round when the object was evicted and came back with nothing', async () => {
		const step = await withSql(async (sql) => {
			seed(sql);
			return cronStep(undefined, stubDeps(sql), {});
		});
		expect(step.unit).toBe('gc:watchdog');
	});

	it('falls back to the first unit when a redeploy shortened the list', async () => {
		const step = await withSql(async (sql) => {
			seed(sql);
			// a stored index of 7 against a 4-unit list, which is what removing a hook leaves
			return cronStep({ i: 7 }, stubDeps(sql), {
				hooks: ['file'],
				includeQueue: false,
				includeCronLast: false
			});
		});
		expect(step.unit).toBe('gc:watchdog');
		expect(step.units).toBe(4);
	});
});
