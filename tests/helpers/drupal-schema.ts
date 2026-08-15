import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

/**
 * The Drupal-shaped schema and seed the cron specs run against, on the REAL `ctx.storage.sql`.
 *
 * Shared rather than duplicated: two specs need it, and a 90-line DDL block copied twice is the
 * kind of thing that silently drifts until the two suites are testing different schemas.
 *
 * Not a `.spec.ts`, so vitest does not collect it as a suite, and `tests/helpers/**` is excluded
 * from coverage.
 */

/**
 * The subset of Drupal's schema the GC passes touch, with the indexes that matter.
 *
 * Indexes are included: rows written is the free plan's binding meter and DO
 * SQLite bills per index touched, so a schema without them would understate every figure.
 */
export const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS watchdog (
		wid INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL DEFAULT 0,
		type VARCHAR(64) NOT NULL DEFAULT '', message TEXT, severity INTEGER NOT NULL DEFAULT 0,
		timestamp INTEGER NOT NULL DEFAULT 0)`,
	'CREATE INDEX IF NOT EXISTS watchdog_type ON watchdog (type)',
	'CREATE INDEX IF NOT EXISTS watchdog_uid ON watchdog (uid)',
	'CREATE INDEX IF NOT EXISTS watchdog_severity ON watchdog (severity)',
	`CREATE TABLE IF NOT EXISTS cache_data (
		cid VARCHAR(255) NOT NULL PRIMARY KEY, data BLOB, expire INTEGER NOT NULL DEFAULT 0,
		created NUMERIC NOT NULL DEFAULT 0, serialized INTEGER NOT NULL DEFAULT 0,
		tags TEXT, checksum VARCHAR(255) NOT NULL)`,
	'CREATE INDEX IF NOT EXISTS cache_data_expire ON cache_data (expire)',
	`CREATE TABLE IF NOT EXISTS config (
		collection VARCHAR(255) NOT NULL DEFAULT '', name VARCHAR(255) NOT NULL,
		data BLOB, PRIMARY KEY (collection, name))`,
	`CREATE TABLE IF NOT EXISTS key_value (
		collection VARCHAR(128) NOT NULL, name VARCHAR(128) NOT NULL, value BLOB NOT NULL,
		PRIMARY KEY (collection, name))`,
	`CREATE TABLE IF NOT EXISTS sessions (
		uid INTEGER NOT NULL DEFAULT 0, sid VARCHAR(128) NOT NULL PRIMARY KEY,
		hostname VARCHAR(128) NOT NULL DEFAULT '', timestamp INTEGER NOT NULL DEFAULT 0,
		session BLOB)`,
	'CREATE INDEX IF NOT EXISTS sessions_timestamp ON sessions (timestamp)',
	`CREATE TABLE IF NOT EXISTS flood (
		fid INTEGER PRIMARY KEY AUTOINCREMENT, event VARCHAR(64) NOT NULL DEFAULT '',
		identifier VARCHAR(128) NOT NULL DEFAULT '', timestamp INTEGER NOT NULL DEFAULT 0,
		expiration INTEGER NOT NULL DEFAULT 0)`,
	`CREATE TABLE IF NOT EXISTS key_value_expire (
		collection VARCHAR(128) NOT NULL, name VARCHAR(128) NOT NULL, value BLOB NOT NULL,
		expire INTEGER NOT NULL DEFAULT 2147483647, PRIMARY KEY (collection, name))`,
	`CREATE TABLE IF NOT EXISTS batch (
		bid INTEGER PRIMARY KEY AUTOINCREMENT, token VARCHAR(64) NOT NULL,
		timestamp INTEGER NOT NULL, batch BLOB)`,
	`CREATE TABLE IF NOT EXISTS queue (
		item_id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) NOT NULL DEFAULT '',
		data BLOB, expire INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL DEFAULT 0)`,
	`CREATE TABLE IF NOT EXISTS semaphore (
		name VARCHAR(255) NOT NULL PRIMARY KEY, value VARCHAR(255) NOT NULL DEFAULT '',
		expire NUMERIC NOT NULL DEFAULT 0)`
];

/** the measured reference site: 1,662 watchdog rows against a 1,000 limit, 144 cache_data */
export const WATCHDOG_ROWS = 1662;
export const CACHE_DATA_ROWS = 144;
export const NOW_S = 1786258127;

/**
 * The `ctx.storage.sql` surface, matching what `src/ops/cron.js` documents it consumes.
 *
 * Written out rather than left loose because cron.js carries JSDoc types, so a narrower shape
 * here fails typecheck at every call site -- `rowsWritten` and `rowsRead` are the counters the
 * GC ledger reads, and they are the whole reason this suite runs against the real engine.
 */
export type Sql = {
	exec: (
		text: string,
		...params: unknown[]
	) => { toArray(): Record<string, unknown>[]; rowsWritten: number; rowsRead: number };
};

export function seed(
	sql: Sql,
	opts: { watchdog?: number; cacheData?: number; dblogLimit?: number } = {}
) {
	for (const ddl of SCHEMA) sql.exec(ddl);
	for (const t of [
		'watchdog',
		'cache_data',
		'config',
		'key_value',
		'sessions',
		'flood',
		'key_value_expire',
		'batch',
		'queue',
		'semaphore'
	]) {
		sql.exec(`DELETE FROM ${t}`);
	}

	const wd = opts.watchdog ?? WATCHDOG_ROWS;
	for (let i = 0; i < wd; i++) {
		sql.exec(
			'INSERT INTO watchdog (uid, type, message, severity, timestamp) VALUES (0, ?, ?, 6, ?)',
			'php',
			'm',
			NOW_S
		);
	}
	const cd = opts.cacheData ?? CACHE_DATA_ROWS;
	for (let i = 0; i < cd; i++) {
		sql.exec(
			'INSERT INTO cache_data (cid, data, expire, created, serialized, tags, checksum) VALUES (?, ?, -1, ?, 0, ?, ?)',
			`route:x${String(i).padStart(4, '0')}`,
			'x',
			1000 + i,
			'',
			'0'
		);
	}
	// dblog.settings carries row_limit as a serialized PHP array, which is the only way the
	// GC can learn the site's own cap
	const limit = opts.dblogLimit ?? 1000;
	sql.exec(
		'INSERT INTO config (collection, name, data) VALUES (?, ?, ?)',
		'',
		'dblog.settings',
		`a:1:{s:9:"row_limit";i:${limit};}`
	);
}

/** runs `fn` with the real ctx.storage.sql of a real Durable Object */
export async function withSql<T>(fn: (sql: Sql) => T | Promise<T>): Promise<T> {
	const id = env.SITE.newUniqueId();
	const stub = env.SITE.get(id);
	// the callback's `instance` is typed as the DO class, which this spec does not import; the
	// only thing needed off it is ctx.storage.sql, so it is narrowed here
	return runInDurableObject(stub, async (instance) =>
		fn((instance as unknown as { ctx: { storage: { sql: Sql } } }).ctx.storage.sql)
	);
}
