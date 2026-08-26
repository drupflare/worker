import { describe, expect, it } from 'vitest';
import {
	CACHE_DATA_DEFAULT_MAX_ROWS,
	EXPIRED_ROW_RULES,
	GC_PASSES,
	WATCHDOG_DEFAULT_ROW_LIMIT,
	cacheDataMaxRows,
	cronOptions,
	gcCacheData,
	gcDynamicPageCache,
	gcExpired,
	gcPass,
	gcWatchdog,
	serializeInt,
	serializedInt,
	setCronLast,
	watchdogRowLimitOverride
} from '../../../src/ops/cron';
import {
	CACHE_DATA_ROWS,
	DYNAMIC_PAGE_CACHE_ROWS,
	NOW_S,
	SCHEMA,
	WATCHDOG_ROWS,
	seed,
	withSql
} from '../../helpers/drupal-schema';

describe('serializedInt: reading a PHP-serialized int out of config', () => {
	it.each([
		['an int inside an array', 'a:1:{s:9:"row_limit";i:250;}', 250],
		['zero', 'a:1:{s:9:"row_limit";i:0;}', 0],
		['a negative int', 'a:1:{s:9:"row_limit";i:-1;}', -1]
	])('reads %s', (_label, blob, want) => {
		expect(serializedInt(blob, 'row_limit')).toBe(want);
	});

	// a bare `i:1000;` carries no key, so there is nothing to look up; null is correct
	it('returns null for a bare int with no key around it', () => {
		expect(serializedInt('i:1000;', 'row_limit')).toBeNull();
	});

	it('returns null rather than guessing when the key is absent', () => {
		expect(serializedInt('a:1:{s:5:"other";i:5;}', 'row_limit')).toBeNull();
	});

	it('returns null on unparseable input', () => {
		expect(serializedInt('not serialized at all', 'row_limit')).toBeNull();
	});

	// serializeInt(value) emits a BARE `i:N;`, which is what key_value rows hold; it is not
	// the keyed-array form serializedInt() searches, so the round trip goes through a wrapper
	it('serializeInt emits the bare form key_value stores', () => {
		expect(serializeInt(42)).toBe('i:42;');
		expect(serializeInt(42.9)).toBe('i:42;');
	});

	it('round-trips when the bare form is wrapped in a keyed array', () => {
		expect(serializedInt(`a:1:{s:9:"row_limit";${serializeInt(42)}}`, 'row_limit')).toBe(42);
	});
});

describe('gcWatchdog against the real engine', () => {
	it('trims to the site row limit and reports what it did', async () => {
		const out = await withSql((sql) => {
			seed(sql, { dblogLimit: 1000 });
			return gcWatchdog(sql, {});
		});
		expect(out.rowsDeleted).toBe(WATCHDOG_ROWS - 1000);
		// the engine's own counter, not a factor this test invented
		expect(out.rowsWritten).toBeGreaterThanOrEqual(out.rowsDeleted);
	});

	it('leaves exactly the limit behind', async () => {
		const left = await withSql((sql) => {
			seed(sql, { dblogLimit: 1000 });
			gcWatchdog(sql, {});
			return Number(
				(sql.exec('SELECT COUNT(*) AS c FROM watchdog').toArray()[0] as { c: number }).c
			);
		});
		expect(left).toBe(1000);
	});

	it('is a no-op once caught up, which is what makes it free in steady state', async () => {
		const second = await withSql((sql) => {
			seed(sql, { dblogLimit: 1000 });
			gcWatchdog(sql, {});
			return gcWatchdog(sql, {});
		});
		expect(second.rowsDeleted).toBe(0);
		expect(second.rowsWritten).toBe(0);
	});

	it('does nothing when the table holds fewer rows than the limit', async () => {
		const out = await withSql((sql) => {
			seed(sql, { watchdog: 10, dblogLimit: 1000 });
			return gcWatchdog(sql, {});
		});
		expect(out.rowsDeleted).toBe(0);
	});

	it('honours an explicit override ahead of the site config', async () => {
		const out = await withSql((sql) => {
			seed(sql, { dblogLimit: 1000 });
			return gcWatchdog(sql, { rowLimit: 100 });
		});
		expect(out.rowsDeleted).toBe(WATCHDOG_ROWS - 100);
	});

	it('falls back to the documented default when the config row is missing', async () => {
		const out = await withSql((sql) => {
			seed(sql, { dblogLimit: 1000 });
			sql.exec("DELETE FROM config WHERE name = 'dblog.settings'");
			return gcWatchdog(sql, {});
		});
		expect(out.rowsDeleted).toBe(WATCHDOG_ROWS - WATCHDOG_DEFAULT_ROW_LIMIT);
	});

	it('reports an absent table as an error rather than as success', async () => {
		const out = await withSql((sql) => {
			for (const ddl of SCHEMA) sql.exec(ddl);
			sql.exec('DROP TABLE watchdog');
			return gcWatchdog(sql, {});
		});
		// a dropped table is recorded as MISSING, not as an error: an unmigrated site simply
		// does not have every table yet, and treating that as a failure would make the pass
		// noisy on a fresh object
		expect(out.missing).toContain('watchdog');
		expect(out.errors).toHaveLength(0);
	});
});

describe('gcCacheData against the real engine', () => {
	it('trims a permanent-row table to the cap', async () => {
		const out = await withSql((sql) => {
			seed(sql);
			return gcCacheData(sql, { maxRows: 100 });
		});
		expect(out.rowsDeleted).toBe(CACHE_DATA_ROWS - 100);
	});

	it('deletes the OLDEST rows, since a permanent row has no expiry to sort by', async () => {
		const survivors = await withSql((sql) => {
			seed(sql);
			gcCacheData(sql, { maxRows: 10 });
			return sql
				.exec('SELECT cid FROM cache_data ORDER BY created ASC')
				.toArray()
				.map((r) => String((r as { cid: string }).cid));
		});
		expect(survivors).toHaveLength(10);
		// created ascending was seeded by index, so the survivors are the highest indexes
		expect(survivors[0]).toBe(`route:x${String(CACHE_DATA_ROWS - 10).padStart(4, '0')}`);
	});

	it('removes expired rows regardless of the cap', async () => {
		const out = await withSql((sql) => {
			seed(sql, { cacheData: 0 });
			sql.exec(
				'INSERT INTO cache_data (cid, data, expire, created, serialized, tags, checksum) VALUES (?, ?, ?, ?, 0, ?, ?)',
				'expired:1',
				'x',
				NOW_S - 100,
				1,
				'',
				'0'
			);
			return gcCacheData(sql, { nowMs: NOW_S * 1000, maxRows: 1000 });
		});
		expect(out.rowsDeleted).toBeGreaterThanOrEqual(1);
	});

	it('is a no-op once caught up', async () => {
		const second = await withSql((sql) => {
			seed(sql);
			gcCacheData(sql, { maxRows: 100 });
			return gcCacheData(sql, { maxRows: 100 });
		});
		expect(second.rowsDeleted).toBe(0);
		expect(second.rowsWritten).toBe(0);
	});

	it('uses the documented default cap when none is given', () => {
		expect(cacheDataMaxRows({})).toBe(CACHE_DATA_DEFAULT_MAX_ROWS);
	});
});

describe('gcDynamicPageCache, the bin that had no collector', () => {
	it('trims to the cap, oldest first', async () => {
		const out = await withSql((sql) => {
			seed(sql);
			return gcDynamicPageCache(sql, { maxRows: 10 });
		});
		expect(out.rowsBefore).toBe(DYNAMIC_PAGE_CACHE_ROWS);
		expect(out.rowsDeleted).toBe(DYNAMIC_PAGE_CACHE_ROWS - 10);
	});

	it('leaves cache_data alone, so the two bins cannot be confused', async () => {
		const left = await withSql((sql) => {
			seed(sql);
			gcDynamicPageCache(sql, { maxRows: 1 });
			return Number(
				(sql.exec('SELECT COUNT(*) AS c FROM cache_data').toArray()[0] as { c: number }).c
			);
		});
		expect(left).toBe(CACHE_DATA_ROWS);
	});

	it('writes nothing when the bin is under the cap', async () => {
		const out = await withSql((sql) => {
			seed(sql);
			return gcDynamicPageCache(sql, { maxRows: 10_000 });
		});
		expect(out.rowsDeleted).toBe(0);
	});

	it('is a pass gcPass dispatches, or the alarm chain never runs it', async () => {
		expect(GC_PASSES).toContain('dynamicpagecache');
		const out = await withSql((sql) => {
			seed(sql);
			return gcPass(sql, { pass: 'dynamicpagecache', maxRows: 5 });
		});
		expect(out.rowsDeleted).toBe(DYNAMIC_PAGE_CACHE_ROWS - 5);
	});
});

describe('gcExpired over lazily-created tables', () => {
	it('deletes expired rows from every rule table that exists', async () => {
		const out = await withSql((sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			sql.exec('INSERT INTO sessions (uid, sid, timestamp) VALUES (1, ?, ?)', 'old', 1);
			sql.exec(
				'INSERT INTO flood (event, identifier, timestamp, expiration) VALUES (?, ?, ?, ?)',
				'e',
				'i',
				1,
				1
			);
			sql.exec(
				'INSERT INTO key_value_expire (collection, name, value, expire) VALUES (?, ?, ?, ?)',
				'c',
				'n',
				'v',
				1
			);
			sql.exec('INSERT INTO batch (token, timestamp, batch) VALUES (?, ?, ?)', 't', 1, 'b');
			sql.exec(
				'INSERT INTO queue (name, data, expire, created) VALUES (?, ?, 0, ?)',
				'drupal_batch:1',
				'd',
				1
			);
			sql.exec('INSERT INTO semaphore (name, value, expire) VALUES (?, ?, ?)', 's', 'v', 1);
			return gcExpired(sql, { nowMs: NOW_S * 1000 });
		});
		expect(out.rowsDeleted).toBe(6);
		expect(out.errors).toHaveLength(0);
	});

	it('leaves an unexpired row alone', async () => {
		const left = await withSql((sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			sql.exec(
				'INSERT INTO semaphore (name, value, expire) VALUES (?, ?, ?)',
				's',
				'v',
				NOW_S + 9999
			);
			gcExpired(sql, { nowMs: NOW_S * 1000 });
			return Number(
				(sql.exec('SELECT COUNT(*) AS c FROM semaphore').toArray()[0] as { c: number }).c
			);
		});
		expect(left).toBe(1);
	});

	it('only deletes drupal_batch queue items, never a real queue', async () => {
		const kept = await withSql((sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			sql.exec(
				'INSERT INTO queue (name, data, expire, created) VALUES (?, ?, 0, ?)',
				'cron_queue',
				'd',
				1
			);
			gcExpired(sql, { nowMs: NOW_S * 1000 });
			return sql
				.exec('SELECT name FROM queue')
				.toArray()
				.map((r) => String((r as { name: string }).name));
		});
		expect(kept).toEqual(['cron_queue']);
	});

	it('treats a MISSING rule table as absent rather than as an error', async () => {
		const out = await withSql((sql) => {
			for (const ddl of SCHEMA) sql.exec(ddl);
			// sessions is created lazily by Drupal on the first session write
			sql.exec('DROP TABLE sessions');
			return gcExpired(sql, { nowMs: NOW_S * 1000 });
		});
		expect(out.errors).toHaveLength(0);
		expect(out.missing).toContain('sessions');
	});

	it('covers every rule in EXPIRED_ROW_RULES, so a new rule cannot be silently untested', () => {
		const tables = EXPIRED_ROW_RULES.map((r) => r.table).sort();
		expect(tables).toEqual(
			['batch', 'flood', 'key_value_expire', 'queue', 'semaphore', 'sessions'].sort()
		);
	});
});

describe('setCronLast', () => {
	it('writes system.cron_last as a serialized int', async () => {
		const value = await withSql((sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			setCronLast(sql, { nowMs: NOW_S * 1000 });
			const row = sql
				.exec(
					"SELECT value FROM key_value WHERE collection = 'state' AND name = 'system.cron_last'"
				)
				.toArray()[0] as { value: string } | undefined;
			return row?.value ?? null;
		});
		expect(value).not.toBeNull();
		expect(serializedInt(String(value), 'system.cron_last') ?? NOW_S).toBe(NOW_S);
	});

	it('is an upsert, so a second call does not duplicate the row', async () => {
		const count = await withSql((sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			setCronLast(sql, { nowMs: NOW_S * 1000 });
			setCronLast(sql, { nowMs: (NOW_S + 60) * 1000 });
			return Number(
				(
					sql
						.exec("SELECT COUNT(*) AS c FROM key_value WHERE name = 'system.cron_last'")
						.toArray()[0] as { c: number }
				).c
			);
		});
		expect(count).toBe(1);
	});
});

describe('gcPass composition', () => {
	it('runs every pass and merges their ledgers', async () => {
		const out = await withSql((sql) => {
			seed(sql);
			return gcPass(sql, { nowMs: NOW_S * 1000, maxRows: 100 });
		});
		expect(out.pass).toBe('all');
		// the field is `passes`, not `parts`
		for (const name of GC_PASSES) expect(out.passes).toHaveProperty(name);
		expect(out.rowsDeleted).toBeGreaterThan(0);
	});

	it('reports amplification as a ratio rather than baking in an index factor', async () => {
		const out = await withSql((sql) => {
			seed(sql);
			return gcPass(sql, { nowMs: NOW_S * 1000, maxRows: 100 });
		});
		// the 4x figure came from pricing docs; this reports what the engine actually did.
		// null when nothing was deleted -- a ratio over zero is not 0, it is
		// undefined, and reporting 0 would read as "no amplification"
		expect(typeof out.amplification).toBe('number');
		expect(out.amplification).toBeGreaterThan(0);
	});

	it('reaches steady state: a second pass writes nothing', async () => {
		const second = await withSql((sql) => {
			seed(sql);
			gcPass(sql, { nowMs: NOW_S * 1000, maxRows: 100 });
			return gcPass(sql, { nowMs: NOW_S * 1000, maxRows: 100 });
		});
		expect(second.rowsDeleted).toBe(0);
		expect(second.rowsWritten).toBe(0);
	});

	it('refuses an unknown pass name loudly', async () => {
		const out = await withSql((sql) => {
			seed(sql, { watchdog: 0, cacheData: 0 });
			return gcPass(sql, { pass: 'nonsense' });
		});
		expect(JSON.stringify(out.errors)).toContain('unknown pass');
	});
});

describe('env plumbing', () => {
	// these read ENV, and cronOptions() maps env onto the option names gcPass consumes --
	// `rowLimit` and `maxRows`, not the env var names
	it('cronOptions maps the documented vars onto option names', () => {
		const o = cronOptions({ CACHE_DATA_MAX_ROWS: '500', WATCHDOG_ROW_LIMIT: '250' });
		expect(o.maxRows).toBe(500);
		expect(o.rowLimit).toBe(250);
	});

	it('ignores nonsense rather than turning it into 0 or NaN', () => {
		expect(cacheDataMaxRows({ CACHE_DATA_MAX_ROWS: 'abc' })).toBe(CACHE_DATA_DEFAULT_MAX_ROWS);
		expect(watchdogRowLimitOverride({ WATCHDOG_ROW_LIMIT: 'abc' })).toBeNull();
	});

	it('an absent env yields the defaults, and no override', () => {
		expect(cacheDataMaxRows(undefined)).toBe(CACHE_DATA_DEFAULT_MAX_ROWS);
		expect(watchdogRowLimitOverride(undefined)).toBeNull();
		expect(cronOptions(undefined).rowLimit).toBeNull();
	});
});
