/**
 * Garbage collection and the decomposed cron chain.
 *
 * The GC passes are pure SQL against `ctx.storage.sql`; the chain runs one unit per alarm
 * invocation (a fresh CPU budget each), with PHP units last in an invocation.
 * @module
 */

import {
	cronHookList,
	runAdvisoryScan,
	runCronHook,
	runCronQueue,
	runFetchReopen,
	runHealthSelfTest
} from '../drupal/cron-php';
import { errorMessage } from '../util/errors';
import { GENERATED_CRON_KNOWN, GENERATED_CRON_POLICY } from './generated/modules';

/** the cursor `exec()` hands back, narrowed to what a ledger reads */
export interface CronCursor {
	toArray(): Record<string, unknown>[];
	rowsWritten: number;
	rowsRead: number;
}

/** `ctx.storage.sql`, or anything with the same `exec()`/cursor shape */
export interface CronSql {
	exec(text: string, ...params: unknown[]): CronCursor;
}

/** whether one module's `hook_cron` runs, and the reason when it does not */
export interface CronHookPolicy {
	run: boolean;
	reason?: string;
}

/** one table's share of a pass; `rowsReleased` is the queue-lease `UPDATE` only */
export type TableLedger = {
	rowsDeleted: number;
	rowsWritten: number;
	statements: number;
	rowsReleased?: number;
};

/**
 * A pass's accounting record.
 *
 * It is a `type`, not an `interface`, so its implicit index signature lets it be returned as
 * `cronStep()`'s `result` beside a PHP reply. `t0` lives only until `finish()` seals the record;
 * the fields from `rowLimit` down are set by the one pass that computes them.
 */
export type Ledger = {
	pass: string;
	tables: Record<string, TableLedger>;
	rowsDeleted: number;
	rowsWritten: number;
	rowsRead: number;
	statements: number;
	missing: string[];
	errors: Array<{ table: string | null; error: string }>;
	t0?: number;
	ms?: number;
	amplification?: number | null;
	rowLimit?: number | null;
	maxRows?: number;
	rowsBefore?: number;
	overCap?: number;
	rowsReleased?: number;
	cronLast?: number;
	skipped?: string;
	underLimit?: boolean;
	passes?: Record<string, Ledger>;
};

/** one statement's rows and cost; `missing` and `error` are the two guarded outcomes */
export interface ExecResult {
	rows: Record<string, unknown>[];
	rowsWritten: number;
	rowsRead: number;
	missing?: boolean;
	error?: string;
}

/** every knob the GC passes and the chain accept; each reads only what it needs */
export interface CronOptions {
	pass?: string;
	nowMs?: number;
	rowLimit?: number;
	maxRows?: number;
	tables?: string[];
	queueBatchSize?: number;
	maxQueueRepeats?: number;
	idleMs?: number;
	chainMs?: number;
	hooks?: string[];
	hookPolicy?: Record<string, CronHookPolicy>;
	includeQueue?: boolean;
	/** the advisory scan unit; off only for a test that is measuring something else */
	includeAdvisories?: boolean;
	/** the PHP health unit; off only for a test that is measuring something else */
	includeHealth?: boolean;
	/**
	 * What the host already knows about itself, handed to `BootSelfTest`.
	 *
	 * Every key is a host fact, so passing them in lets the unit run with no Drupal kernel.
	 */
	healthObservation?: Record<string, unknown>;
	/** the update-fetch reopen unit; off only for a test that is measuring something else */
	includeFetchReopen?: boolean;
	includeCronLast?: boolean;
	/**
	 * The `scheme://host[:port]` a cron fragment boots Drupal against.
	 *
	 * Cron sends mail and `user_pass_reset_url()` builds an absolute link from the request, so the
	 * default would point every mailed link at the recipient's own machine. Empty keeps that
	 * default, which is right for a probe.
	 */
	origin?: string;
}

/** one unit of the chain; `module` is set only on hook units */
export interface CronUnit {
	id: string;
	kind: string;
	pass?: string;
	module?: string;
	unreviewed?: boolean;
}

/** the cursor as stored; `wrapped` is not part of it */
export interface StoredCursor {
	v: number;
	i: number;
	round: number;
	queueRepeats: number;
	rowsWritten: number;
	lastUnit: string | null;
	lastQueue: string | null;
	lastAt: number;
}

/** what `advanceCursor()` returns: a stored cursor plus the end-of-round signal */
export type AdvancedCursor = StoredCursor & { wrapped: boolean };

/** whatever storage handed back; `undefined` is real (an evicted object has nothing) */
export type CursorInput = Record<string, unknown> | string | null | undefined;

/** the queue with work, or null plus the reason why not */
export interface QueuePending {
	name: string | null;
	reason?: string;
	pending?: number;
	queues: Record<string, number>;
}

/** what a cron PHP fragment prints back; the shape depends on which fragment ran */
export interface CronPhpReply {
	skipped?: string;
	remaining?: number;
	processed?: number;
	suspended?: boolean;
	repeats?: number;
	[key: string]: unknown;
}

/** the dependencies `cronStep()` takes; it owns no transport, alarm or env */
export interface CronDeps {
	sql: CronSql;
	runJson: (code: string) => Promise<Record<string, unknown>>;
	nowMs?: () => number;
}

/** the outcome of one unit of cron work */
export interface CronStep {
	unit: string;
	kind: string;
	module: string | null;
	unreviewed: boolean;
	result: Record<string, unknown>;
	cursor: StoredCursor & { wrapped?: boolean };
	units: number;
	more: boolean;
	mayContinue: boolean;
	rowsWritten: number;
	ms: number;
}

/** Drupal's own default when `dblog.settings` has no `row_limit` */
export const WATCHDOG_DEFAULT_ROW_LIMIT = 1000;

/** `DatabaseBackend::DEFAULT_MAX_ROWS`, the cap Drupal sets on every bin */
export const CACHE_DATA_DEFAULT_MAX_ROWS = 5000;

/** `session.gc_maxlifetime` as shipped in `default.services.yml` */
export const SESSION_DEFAULT_MAX_AGE_S = 200000;

/** 10 days, as `BatchStorage::cleanup()` and `DatabaseQueue::garbageCollection()` use */
export const BATCH_MAX_AGE_S = 864000;

/**
 * Tables Drupal creates lazily, and the expiry condition each one needs.
 *
 * Every entry is guarded: each table is created on first write by its backend's
 * `ensureTableExists()`, so a `DELETE` on a site that never wrote one is a hard error, not a no-op.
 *
 * Each condition is copied from the owning Drupal service (`SessionHandler::gc()`,
 * `Flood\DatabaseBackend::garbageCollection()`, `KeyValueDatabaseExpirableFactory`,
 * `BatchStorage::cleanup()`, `DatabaseQueue::garbageCollection()`), so this is Drupal's policy
 * run by another caller. `BatchStorage::cleanup()` has no caller in Drupal 11.4.5 (only its
 * declaration, interface and proxy), so batch GC is ours or nobody's.
 */
export const EXPIRED_ROW_RULES = [
	{
		table: 'sessions',
		where: 'timestamp < ?',
		ageS: SESSION_DEFAULT_MAX_AGE_S
	},
	{ table: 'flood', where: 'expiration < ?', ageS: 0 },
	{ table: 'key_value_expire', where: 'expire < ?', ageS: 0 },
	{ table: 'batch', where: 'timestamp < ?', ageS: BATCH_MAX_AGE_S },
	{
		table: 'queue',
		where: "created < ? AND name LIKE 'drupal_batch:%'",
		ageS: BATCH_MAX_AGE_S
	},
	// `alarm()` in src/site-do already runs this one inline (a duplicate statement)
	{ table: 'semaphore', where: 'expire < ?', ageS: 0 }
];

/**
 * Which cron implementations run, and why one that does not is skipped.
 *
 * The measured set on this install (`invokeAllWith('cron')` against the real site) is
 * announcements_feed, dblog, file, layout_builder, system, update. A module added later shows up in
 * `cronHookList()` and runs by default; a hook that reaches for a socket fails into a caught
 * error (the host stubs Asyncify), costing an invocation, not the interpreter.
 *
 * A `run: false` removes the hook from every site and nothing reports it; three entries outlived
 * their limit. Before adding one, check the limit still holds.
 */
export const CRON_HOOKS: Record<string, CronHookPolicy> = GENERATED_CRON_POLICY;

/** the knobs the GC passes and the chain read from env; values arrive as strings */
export interface CronEnv {
	CRON_QUEUE_BATCH_SIZE?: string | number;
	CACHE_DATA_MAX_ROWS?: string | number;
	WATCHDOG_ROW_LIMIT?: string | number;
	KEEP_WARM_MS?: string | number;
	WARM_INTERVAL_MS?: string | number;
	SITE_WARM?: string | number;
	RETAIN_INTERPRETER?: string | number;
}

/**
 * The cron hook modules this site has, measured, for when discovery has not run.
 *
 * The order carries nothing: `cronHooksFromList()` sorts. The `update` dependency is held by
 * `fetch_reopen` and `advisories` being pushed after the whole loop in {@link cronUnits}
 * (`cron-step.spec.ts` asserts it against a reversed list).
 */
export const KNOWN_CRON_HOOKS: readonly string[] = GENERATED_CRON_KNOWN;

/** a discovered hook list and the enabled-module set it was discovered against */
export type CronHookCache = { at: string; hooks: string[] };

/**
 * Module names out of a {@link cronHookList} payload.
 *
 * Undefined, not empty, when the run failed or reported nothing, so a caller keeps its list rather
 * than scheduling no hooks.
 */
export function cronHooksFromList(payload: unknown): string[] | undefined {
	const body = payload as { ok?: unknown; shapes?: unknown } | null;
	if (body === null || typeof body !== 'object' || body.ok !== true) return undefined;
	const shapes = body.shapes;
	if (shapes === null || typeof shapes !== 'object') return undefined;
	const names = Object.keys(shapes as Record<string, unknown>).filter((name) => name !== '');
	return names.length > 0 ? names.sort() : undefined;
}

/**
 * The hooks to schedule, and whether the cache still describes this site.
 *
 * `KNOWN_CRON_HOOKS` is only the shipped install's list, so a customer module's `hook_cron` needs
 * discovery. The cache is keyed on the enabled-module set, not the generation (which moves on every
 * content save and would re-boot the kernel each time).
 */
export function cronHooksFor(
	cache: CronHookCache | undefined,
	fingerprint: string
): { hooks: string[]; stale: boolean } {
	if (cache === undefined || !Array.isArray(cache.hooks) || cache.hooks.length === 0) {
		return { hooks: [...KNOWN_CRON_HOOKS], stale: true };
	}
	return { hooks: cache.hooks, stale: cache.at !== fingerprint };
}

/** how many queue items one invocation may process */
export function queueBatchSize(env?: CronEnv): number {
	const n = Number(env?.CRON_QUEUE_BATCH_SIZE ?? 5);
	return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 50) : 5;
}

/** row cap for cache_data; Drupal's own bin default is 5000 */
export function cacheDataMaxRows(env?: CronEnv): number {
	const n = Number(env?.CACHE_DATA_MAX_ROWS ?? CACHE_DATA_DEFAULT_MAX_ROWS);
	return Number.isFinite(n) && n >= 1
		? Math.min(Math.floor(n), 1000000)
		: CACHE_DATA_DEFAULT_MAX_ROWS;
}

/** row cap for watchdog, or undefined to read dblog.settings from the database */
export function watchdogRowLimitOverride(env?: CronEnv): number | undefined {
	if (env?.WATCHDOG_ROW_LIMIT === undefined) return undefined;
	const n = Number(env.WATCHDOG_ROW_LIMIT);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * Everything `gcPass()` and `cronStep()` need, read from env in one call.
 *
 * The default path is `cronStep(cursor, deps, cronOptions(env))`; the result is plain data, so a
 * caller can spread over any field.
 */
export function cronOptions(env?: CronEnv): CronOptions {
	return {
		rowLimit: watchdogRowLimitOverride(env),
		maxRows: cacheDataMaxRows(env),
		queueBatchSize: queueBatchSize(env),
		idleMs: keepWarmMs(env)
	};
}

/**
 * When a Durable Object loses its in-memory state, measured on a deployed worker.
 *
 * A throwaway object minted an id in its constructor and held 32 MB, so a changed id is a lost
 * isolate. Re-arming every 8 s held one incarnation across 71 firings; at 12, 20, 30 and 45 s the
 * id changed on every probe. With no alarm it changed across a 20 s gap, the shortest measured.
 * `KEEP_WARM_MS` (240,000) is 24x this, so it is an idle re-arm and keeps nothing warm.
 */
export const HIBERNATION_IDLE_MS = 10_000;

/** the idle re-arm, which keeps nothing warm; see {@link HIBERNATION_IDLE_MS} */
export function keepWarmMs(env?: CronEnv): number {
	const n = Number(env?.KEEP_WARM_MS ?? 240000);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 240000;
}

/**
 * The re-arm that actually holds an object resident, for a site designated warm.
 *
 * Clamped below the threshold: a larger value buys nothing and still spends an object request and
 * an alarm row per firing.
 */
export function warmIntervalMs(env?: CronEnv): number {
	const n = Number(env?.WARM_INTERVAL_MS ?? 8000);
	const ms = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 8000;
	// with retention a longer interval still adopts an interpreter sometimes; without it every
	// firing re-boots
	if (String(env?.RETAIN_INTERPRETER ?? '1') !== '0') return Math.min(ms, WARM_INTERVAL_MAX_MS);
	return Math.min(ms, HIBERNATION_IDLE_MS - 2000);
}

/**
 * The longest warming interval a writer accepts.
 *
 * Past hibernation a firing buys adoption only when the next instance lands in the same isolate
 * (placement first): on 12 paid workers rotated through every interval, 30 s adopted 36% of idle
 * visits, 60/90/120 s 14-15%, and four workers adopted at none.
 */
export const WARM_INTERVAL_MAX_MS = 600_000;

/**
 * Whether warming is forced, off, or left to the thermal policy.
 *
 * An explicit `SITE_WARM` wins. Unset on paid it warms (10,800 firings a day sit inside included
 * requests and rows). Unset on free it is the thermal policy: the same firings are 10.8% of free's
 * daily row and request budgets, which is the operator's trade.
 */
export function warmForced(env?: CronEnv, paid = false): boolean | undefined {
	const set = env?.SITE_WARM;
	if (set !== undefined && String(set) !== '') return String(set) === '1';
	return paid ? true : undefined;
}

/**
 * The same value, or undefined when nobody stated one.
 *
 * `warmIntervalMs()` folds the default in; an explicit interval is a decision the solver must not
 * overrule, while an unset one is what the solver is for.
 */
export function warmIntervalConfigured(env?: CronEnv): number | undefined {
	const set = env?.WARM_INTERVAL_MS;
	if (set === undefined || String(set) === '') return undefined;
	const n = Number(set);
	return Number.isFinite(n) && n >= 1 ? warmIntervalMs(env) : undefined;
}

/**
 * Whether this site re-arms fast enough to stay resident.
 *
 * On by default on both plans: for one site warming costs 10.8% of free's two daily meters and $0
 * marginal on paid, and removes the 1,398 ms cold boot from every page that renders (the
 * authenticated tier). Fleet arithmetic is the wrong lever for a default; {@link idleRearmMs}'s
 * headroom check handles an account running out.
 */
export function siteWarmEnabled(env?: CronEnv): boolean {
	const set = env?.SITE_WARM;
	if (set !== undefined && String(set) !== '') return String(set) === '1';
	return true;
}

/**
 * The idle re-arm a site should use.
 *
 * @param hasHeadroom whether the quota ladder still permits background work. False drops to the
 *   slow re-arm, protecting account-wide meters (on free, ten warm sites would spend 108% of the
 *   daily rows staying warm). A degraded site un-warms itself and recovers at midnight UTC.
 */
export function idleRearmMs(env?: CronEnv, hasHeadroom = true): number {
	return hasHeadroom && siteWarmEnabled(env) ? warmIntervalMs(env) : keepWarmMs(env);
}

/** a missing table is nothing to do; anything else is a failure */
const MISSING_TABLE = /no such table/i;

/** workerd returns a TEXT column as a string but a real BLOB as binary */
function asText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
	if (value && typeof value === 'object' && 'byteLength' in value) {
		return new TextDecoder().decode(value as ArrayBufferView);
	}
	return value === null || value === undefined ? '' : String(value);
}

/**
 * Reads one integer out of a PHP-serialized array, without unserializing it.
 *
 * Not a general unserializer: it finds `s:9:"row_limit";i:<n>;` in `dblog.settings`. The length
 * prefix and the preceding `;`, `{` or `}` stop a key name inside another key's string value from
 * matching; a value holding the exact serialized bytes could still fool it, so every caller has a
 * fallback and an env override.
 *
 * @param blob the serialized array
 * @param key top-level key to read
 * @returns the integer, or undefined if it is absent or not an integer
 */
export function serializedInt(blob: unknown, key: string): number | undefined {
	const text = asText(blob);
	if (typeof text !== 'string' || text.length === 0) return undefined;
	const needle = `s:${key.length}:"${key}";i:`;
	let at = text.indexOf(needle);
	while (at >= 0) {
		const before = at === 0 ? '{' : text[at - 1];
		if (before === ';' || before === '{' || before === '}') {
			const m = /^(-?\d+);/.exec(text.slice(at + needle.length));
			if (m) return Number(m[1]);
			return undefined;
		}
		at = text.indexOf(needle, at + 1);
	}
	return undefined;
}

/** the serialized form Drupal's state store expects for an integer */
export function serializeInt(value: unknown): string {
	return `i:${Math.trunc(Number(value))};`;
}

/** a fresh accounting record */
function ledger(pass: string): Ledger {
	return {
		pass,
		tables: {},
		rowsDeleted: 0,
		rowsWritten: 0,
		rowsRead: 0,
		statements: 0,
		missing: [],
		errors: [],
		t0: Date.now()
	};
}

/** the ledger's per-table entry, created on first use */
function bucket(led: Ledger, table: string): TableLedger {
	if (!led.tables[table]) {
		led.tables[table] = { rowsDeleted: 0, rowsWritten: 0, statements: 0 };
	}
	return led.tables[table] as TableLedger;
}

/**
 * Runs one statement and folds its cost into the ledger.
 *
 * Errors are recorded, not thrown: this runs on an unattended alarm and one broken table must not
 * cost the others their collection. A missing table is not an error.
 */
function exec(
	sql: CronSql,
	led: Ledger,
	table: string | null,
	text: string,
	params: unknown[] = []
): ExecResult {
	led.statements++;
	if (table) bucket(led, table).statements++;
	try {
		const cursor = sql.exec(text, ...params);
		const rows = cursor.toArray();
		const rowsWritten = Number(cursor.rowsWritten ?? 0);
		const rowsRead = Number(cursor.rowsRead ?? 0);
		led.rowsWritten += rowsWritten;
		led.rowsRead += rowsRead;
		if (table) bucket(led, table).rowsWritten += rowsWritten;
		return { rows, rowsWritten, rowsRead };
	} catch (e) {
		const message = errorMessage(e);
		if (MISSING_TABLE.test(message)) {
			if (table && !led.missing.includes(table)) led.missing.push(table);
			return { rows: [], rowsWritten: 0, rowsRead: 0, missing: true };
		}
		led.errors.push({ table: table ?? null, error: message });
		return { rows: [], rowsWritten: 0, rowsRead: 0, error: message };
	}
}

/**
 * SQLite's own affected-row count.
 *
 * `changes()` is how many rows the `DELETE` removed; `rowsWritten` is what Cloudflare bills, one
 * more per index touched. The ratio is reported as the edge's real amplification.
 */
function changes(sql: CronSql, led: Ledger, table: string | null): number {
	const r = exec(sql, led, table, 'SELECT changes() AS c');
	const n = Number(r.rows[0]?.c ?? 0);
	if (table) bucket(led, table).rowsDeleted += n;
	led.rowsDeleted += n;
	return n;
}

/**
 * Trims watchdog to the configured row limit, oldest first.
 *
 * The pivot-then-delete shape is `DblogHooks::cron()`'s: counting the most recent N rows survives
 * a sequence that does not start at 1 and rows deleted underneath it, which `wid < max - limit`
 * does not. Under the limit it issues one statement and writes nothing.
 */
export function gcWatchdog(sql: CronSql, options: CronOptions = {}): Ledger {
	const led = ledger('watchdog');
	let limit = options.rowLimit;
	if (limit === undefined) {
		const row = exec(sql, led, 'config', 'SELECT data FROM config WHERE name = ?', [
			'dblog.settings'
		]).rows[0];
		limit = serializedInt(row?.data, 'row_limit');
		if (limit === undefined) limit = WATCHDOG_DEFAULT_ROW_LIMIT;
	}
	led.rowLimit = limit;

	// 0 is Drupal's "All" setting, not a request to empty the table
	if (!(limit > 0)) {
		led.skipped = 'row_limit is 0 (keep all)';
		return finish(led);
	}

	const pivot = exec(
		sql,
		led,
		'watchdog',
		'SELECT wid FROM watchdog ORDER BY wid DESC LIMIT 1 OFFSET ?',
		[limit - 1]
	).rows[0];
	const minWid = pivot === undefined ? null : Number(pivot.wid);
	if (minWid === null || !Number.isFinite(minWid)) {
		led.underLimit = true;
		return finish(led);
	}

	exec(sql, led, 'watchdog', 'DELETE FROM watchdog WHERE wid < ?', [minWid]);
	changes(sql, led, 'watchdog');
	return finish(led);
}

/**
 * Enforces a row cap on cache_data, then clears anything expired.
 *
 * Only the row cap works: all 144 `cache_data` rows on the reference site have `expire = -1`, so an
 * expire sweep removes none. 70 are `RouteProvider`'s per-URL route cache (`CACHE_PERMANENT`), so
 * every distinct URL a scanner probes adds a permanent row.
 *
 * The cap is Drupal's own (`getMaxRows()` is 5000, from `DatabaseBackend::DEFAULT_MAX_ROWS`),
 * enforced by `garbageCollection()`, which only `SystemHooks::cron()` calls and this runtime
 * cannot. It orders by `created, cid` rather than core's `created <= pivot`: `created` is a
 * millisecond float and one request writes several rows, so ties over-delete under core's form.
 */
export function gcCacheData(sql: CronSql, options: CronOptions = {}): Ledger {
	return gcCacheBin('cache_data', 'cachedata', sql, options);
}

/**
 * Collects `cache_dynamic_page_cache`, which had no collector at all.
 *
 * Its entries are `expire = -1` and core's GC runs only from `SystemHooks::cron()`, which this
 * runtime never calls; emptying it on every fill was the only bound.
 */
export function gcDynamicPageCache(sql: CronSql, options: CronOptions = {}): Ledger {
	return gcCacheBin('cache_dynamic_page_cache', 'dynamicpagecache', sql, options);
}

/** oldest-first eviction down to a row cap, then rows with a real expiry */
function gcCacheBin(table: string, name: string, sql: CronSql, options: CronOptions): Ledger {
	const led = ledger(name);
	const cap = options.maxRows ?? CACHE_DATA_DEFAULT_MAX_ROWS;
	const nowS = Math.floor((options.nowMs ?? Date.now()) / 1000);
	led.maxRows = cap;

	const count = Number(
		exec(sql, led, table, `SELECT COUNT(*) AS c FROM ${table}`).rows[0]?.c ?? 0
	);
	led.rowsBefore = count;
	const over = cap > 0 ? count - cap : 0;
	led.overCap = over > 0 ? over : 0;

	// under the cap (the common case) is one read and no writes
	if (over > 0) {
		exec(
			sql,
			led,
			table,
			`DELETE FROM ${table} WHERE rowid IN (
         SELECT rowid FROM ${table} ORDER BY created ASC, cid ASC LIMIT ?
       )`,
			[over]
		);
		changes(sql, led, table);
	}

	// other writers into this bin do set an expiry
	exec(sql, led, table, `DELETE FROM ${table} WHERE expire <> -1 AND expire < ?`, [nowS]);
	changes(sql, led, table);

	return finish(led);
}

/**
 * Clears expired rows from the tables Drupal creates lazily.
 *
 * Guarded per table, so a site missing one collects the rest.
 */
export function gcExpired(sql: CronSql, options: CronOptions = {}): Ledger {
	const led = ledger('expired');
	const nowS = Math.floor((options.nowMs ?? Date.now()) / 1000);
	const only = Array.isArray(options.tables) ? options.tables : null;

	for (const rule of EXPIRED_ROW_RULES) {
		if (only && !only.includes(rule.table)) continue;
		// the name is interpolated (SQLite cannot bind an identifier), so it is checked
		if (!/^[a-z_][a-z0-9_]*$/.test(rule.table)) {
			led.errors.push({ table: rule.table, error: 'refused table name' });
			continue;
		}
		const r = exec(sql, led, rule.table, `DELETE FROM ${rule.table} WHERE ${rule.where}`, [
			nowS - rule.ageS
		]);
		if (r.missing) continue;
		changes(sql, led, rule.table);
	}

	// releases abandoned leases as `DatabaseQueue::garbageCollection()` does (an `UPDATE`, counted
	// as `rowsReleased` not deleted)
	if (!only || only.includes('queue')) {
		const r = exec(
			sql,
			led,
			'queue',
			'UPDATE queue SET expire = 0 WHERE expire <> 0 AND expire < ?',
			[nowS]
		);
		if (!r.missing) {
			const released = Number(
				exec(sql, led, 'queue', 'SELECT changes() AS c').rows[0]?.c ?? 0
			);
			led.rowsReleased = released;
			bucket(led, 'queue').rowsReleased = released;
		}
	}

	return finish(led);
}

/**
 * Records that cron ran, as `Cron::setCronLastTime()` would.
 *
 * It is one serialized integer in `key_value`, so it needs no PHP. Its absence made
 * `AutomatedCron` run `drupal_cron()` inline on the first request, which killed the render with an
 * Asyncify throw.
 *
 * The row alone is inert: `State` is a `CacheCollector` over `cache.bootstrap` (cid `state`), so
 * `\Drupal::state()->get('system.cron_last')` never sees a `key_value`-only write and the status
 * report keeps saying "Cron has not run recently". The `cache_bootstrap` delete makes it visible
 * (`module-converge.spec.ts` fails without it).
 */
export function setCronLast(sql: CronSql, options: CronOptions = {}): Ledger {
	const led = ledger('cron_last');
	const nowS = Math.floor((options.nowMs ?? Date.now()) / 1000);
	exec(
		sql,
		led,
		'key_value',
		`INSERT INTO key_value (collection, name, value) VALUES ('state', 'system.cron_last', ?)
     ON CONFLICT(collection, name) DO UPDATE SET value = excluded.value`,
		[serializeInt(nowS)]
	);
	// the whole entry (one serialized array); the next state read rebuilds it from `key_value`
	exec(sql, led, 'cache_bootstrap', `DELETE FROM cache_bootstrap WHERE cid = 'state'`, []);
	led.cronLast = nowS;
	return finish(led);
}

/** seals a ledger: adds wall time and the observed index amplification */
function finish(led: Ledger): Ledger {
	led.ms = Date.now() - (led.t0 as number);
	delete led.t0;
	led.amplification =
		led.rowsDeleted > 0 ? Math.round((led.rowsWritten / led.rowsDeleted) * 100) / 100 : null;
	return led;
}

/** folds one ledger into another, so `all` reports the same shape as a single pass */
function merge(into: Ledger, from: Ledger): Ledger {
	into.rowsDeleted += from.rowsDeleted;
	into.rowsWritten += from.rowsWritten;
	into.rowsRead += from.rowsRead;
	into.statements += from.statements;
	for (const t of from.missing) if (!into.missing.includes(t)) into.missing.push(t);
	into.errors.push(...from.errors);
	if (from.rowsReleased !== undefined) {
		into.rowsReleased = (into.rowsReleased ?? 0) + from.rowsReleased;
	}
	for (const [name, b] of Object.entries(from.tables)) {
		const target = bucket(into, name);
		target.rowsDeleted += b.rowsDeleted;
		target.rowsWritten += b.rowsWritten;
		target.statements += b.statements;
		if (b.rowsReleased !== undefined) {
			target.rowsReleased = (target.rowsReleased ?? 0) + b.rowsReleased;
		}
	}
	return into;
}

/** every pass name `gcPass()` accepts, in the order `all` runs them */
export const GC_PASSES = ['watchdog', 'cachedata', 'dynamicpagecache', 'expired'];

/**
 * Runs one garbage-collection pass, or all of them, and reports what it cost.
 *
 * `passes` on the returned ledger is present only for `pass: 'all'`; `rowsReleased` only for the
 * queue-lease `UPDATE`, which writes rows and reclaims no storage.
 */
export function gcPass(sql: CronSql, options: CronOptions = {}): Ledger {
	const pass = options.pass ?? 'all';
	if (pass === 'watchdog') return gcWatchdog(sql, options);
	if (pass === 'cachedata') return gcCacheData(sql, options);
	if (pass === 'dynamicpagecache') return gcDynamicPageCache(sql, options);
	if (pass === 'expired') return gcExpired(sql, options);
	if (pass === 'cron_last') return setCronLast(sql, options);
	if (pass !== 'all') {
		const led = ledger(pass);
		led.errors.push({ table: null, error: `unknown pass: ${pass}` });
		return finish(led);
	}

	const all = ledger('all');
	const parts: Record<string, Ledger> = {};
	for (const name of GC_PASSES) {
		const part = gcPass(sql, { ...options, pass: name });
		parts[name] = part;
		merge(all, part);
	}
	all.passes = parts;
	return finish(all);
}

/**
 * The ordered list of units the alarm chain walks, one per invocation.
 *
 * `hooks` is the discovered list when `cronHookList()` has run, else `KNOWN_CRON_HOOKS`. A module
 * with no policy entry is unreviewed and runs, flagged, so a new contrib module's cron still
 * fires. `module` is set only on hook units, which tells them from pure-SQL passes.
 */
export function cronUnits(options: CronOptions = {}): CronUnit[] {
	const hooks = Array.isArray(options.hooks) ? options.hooks : KNOWN_CRON_HOOKS;
	const policy = { ...CRON_HOOKS, ...(options.hookPolicy ?? {}) };
	const units: CronUnit[] = [
		{ id: 'gc:watchdog', kind: 'sql', pass: 'watchdog' },
		{ id: 'gc:cachedata', kind: 'sql', pass: 'cachedata' },
		{ id: 'gc:expired', kind: 'sql', pass: 'expired' }
	];
	for (const module of hooks) {
		const entry = policy[module];
		if (entry && entry.run === false) continue;
		units.push({
			id: `hook:${module}`,
			kind: 'php',
			module,
			unreviewed: entry === undefined
		});
	}
	// fetch_reopen then advisories follow the hooks (they read `update`'s output); own units, since
	// a `#[Hook]` added after the bake is not in the shipped container
	if (options.includeFetchReopen !== false) {
		units.push({ id: 'fetch_reopen', kind: 'php' });
	}
	if (options.includeAdvisories !== false) {
		units.push({ id: 'advisories', kind: 'php' });
	}
	// the PHP health layer is its own unit for the same reason; it goes before the queue, which
	// holds the cursor and repeats while progressing, so a later unit would wait out every repeat
	if (options.includeHealth !== false) {
		units.push({ id: 'health', kind: 'php' });
	}
	if (options.includeQueue !== false) {
		units.push({ id: 'queue', kind: 'php' });
	}
	if (options.includeCronLast !== false) {
		units.push({ id: 'cron_last', kind: 'sql', pass: 'cron_last' });
	}
	return units;
}

/**
 * The hooks configured not to run, mapped to the reason, for reporting.
 */
export function skippedCronHooks(options: CronOptions = {}): Record<string, string> {
	const hooks = Array.isArray(options.hooks) ? options.hooks : KNOWN_CRON_HOOKS;
	const policy = { ...CRON_HOOKS, ...(options.hookPolicy ?? {}) };
	const out: Record<string, string> = {};
	for (const module of hooks) {
		const entry = policy[module];
		if (entry && entry.run === false) out[module] = entry.reason ?? 'configured off';
	}
	return out;
}

/**
 * Rebuilds a usable cursor from whatever came back out of storage.
 *
 * Total: null, a string, a truncated object and an index past the end all resolve to the start of
 * the chain. The last matters most: the unit list derives from configuration on every invocation,
 * so a redeploy that removes a hook leaves a stored `i` past the end.
 */
export function readCursor(raw: CursorInput, unitCount = 1): StoredCursor {
	// widened once; the guard below makes it safe
	let c = raw as Record<string, unknown> | null;
	if (typeof raw === 'string') {
		try {
			c = JSON.parse(raw);
		} catch {
			c = null;
		}
	}
	if (!c || typeof c !== 'object' || Array.isArray(c)) c = {};
	const i = Number(c.i);
	const round = Number(c.round);
	const repeats = Number(c.queueRepeats);
	return {
		v: 1,
		i: Number.isInteger(i) && i >= 0 && i < unitCount ? i : 0,
		round: Number.isInteger(round) && round >= 0 ? round : 0,
		queueRepeats: Number.isInteger(repeats) && repeats >= 0 ? repeats : 0,
		rowsWritten: Number.isFinite(Number(c.rowsWritten)) ? Number(c.rowsWritten) : 0,
		lastUnit: typeof c.lastUnit === 'string' ? c.lastUnit : null,
		lastQueue: typeof c.lastQueue === 'string' ? c.lastQueue : null,
		lastAt: Number.isFinite(Number(c.lastAt)) ? Number(c.lastAt) : 0
	};
}

/** the cursor as the caller should store it */
export function writeCursor(cursor: StoredCursor): string {
	return JSON.stringify(cursor);
}

/**
 * Moves the cursor on one unit, wrapping at the end of the list.
 *
 * `wrapped` tells the caller a round finished (stop chaining at +1 ms, return to the idle
 * interval). It is on the return value only, never a stored cursor.
 */
export function advanceCursor(
	cursor: StoredCursor,
	unitCount: number,
	patch: Partial<StoredCursor> = {}
): AdvancedCursor {
	const next = cursor.i + 1;
	const wrapped = next >= unitCount;
	return {
		...cursor,
		...patch,
		i: wrapped ? 0 : next,
		round: wrapped ? cursor.round + 1 : cursor.round,
		wrapped
	};
}

/**
 * Does one unit of cron work and returns the next cursor.
 *
 * It is a function of (cursor, deps) so the caller owns persistence and the chain is testable
 * without a Durable Object. `mayContinue` is the CPU constraint as data: a `sql` unit costs
 * microseconds so the caller may run another in the same invocation, while a `php` unit enters the
 * interpreter and must be last (as `fillBatchSize()` never batches across a render).
 *
 * `result` is the unit's own ledger or reply, typed as an index signature (a bare `object` makes
 * its fields unreadable).
 *
 * @param rawCursor whatever storage returned; `undefined` is real (an evicted object has nothing)
 * @param deps the transport and clock, injected so the chain owns neither
 * @param options passed through to `cronUnits()` and the GC passes
 */
export async function cronStep(
	rawCursor: CursorInput,
	deps: CronDeps,
	options: CronOptions = {}
): Promise<CronStep> {
	const units = cronUnits(options);
	const cursor = readCursor(rawCursor, units.length);
	// the list is never empty, so one of the two is always a unit
	const unit = (units[cursor.i] ?? units[0]) as CronUnit;
	const now = deps.nowMs ? deps.nowMs() : Date.now();
	const t0 = Date.now();

	let result: Record<string, unknown>;
	let rowsWritten = 0;
	let stay = false;
	let servedQueue: string | undefined;

	if (unit.kind === 'sql') {
		result = gcPass(deps.sql, { ...options, pass: unit.pass, nowMs: now });
		rowsWritten = result.rowsWritten as number;
	} else if (unit.id === 'queue') {
		// discover in SQL (an empty queue costs one read, no interpreter); rotate off the last
		// queue so a deep one cannot starve others, unless mid-drain
		const draining = cursor.queueRepeats > 0;
		const pending = queuePending(deps.sql, {
			prefer: draining ? (cursor.lastQueue ?? undefined) : undefined,
			exclude: draining ? undefined : (cursor.lastQueue ?? undefined)
		});
		if (pending.name === null) {
			result = { skipped: pending.reason, queues: pending.queues };
		} else {
			servedQueue = pending.name;
			result = await deps.runJson(
				runCronQueue(pending.name, options.queueBatchSize ?? 5, options.origin)
			);
			const remaining = Number(result?.remaining ?? 0);
			const progressed = Number(result?.processed ?? 0) > 0;
			const repeats = cursor.queueRepeats + 1;
			// repeat while progressing, but bounded (a failing worker would chain at +1 ms forever)
			stay =
				remaining > 0 &&
				progressed &&
				!result?.suspended &&
				repeats < (options.maxQueueRepeats ?? 20);
			result.repeats = repeats;
		}
	} else if (unit.id === 'advisories') {
		result = await deps.runJson(runAdvisoryScan(options.origin));
	} else if (unit.id === 'health') {
		// the observation is the host's (bridge, absent capabilities, migration cursor,
		// generations), which keeps this unit free of a kernel boot
		result = await deps.runJson(runHealthSelfTest(options.healthObservation ?? {}));
	} else if (unit.id === 'fetch_reopen') {
		result = await deps.runJson(runFetchReopen(options.origin));
	} else {
		// the module-less php units (`queue`, `advisories`, `health`, `fetch_reopen`) are above
		result = await deps.runJson(runCronHook(unit.module as string, options.origin));
	}

	const ms = Date.now() - t0;
	const patch = {
		lastUnit: unit.id,
		lastAt: now,
		rowsWritten: cursor.rowsWritten + rowsWritten,
		queueRepeats: unit.id === 'queue' && stay ? cursor.queueRepeats + 1 : 0,
		// kept when the unit advances (the next round rotates away from it)
		lastQueue: servedQueue ?? cursor.lastQueue
	};
	const next = stay
		? { ...cursor, ...patch, wrapped: false }
		: advanceCursor(cursor, units.length, patch);

	return {
		unit: unit.id,
		kind: unit.kind,
		module: unit.module ?? null,
		unreviewed: unit.unreviewed === true,
		result,
		cursor: next,
		units: units.length,
		// a round is over when the cursor wrapped and nothing asked to be repeated
		more: stay || !next.wrapped,
		// sql units are microseconds; php units hold the interpreter
		mayContinue: unit.kind === 'sql' || result?.skipped !== undefined,
		rowsWritten,
		ms
	};
}

/**
 * The queue with the most items waiting, or null with the reason why not.
 *
 * Pure SQL: asking PHP which queues have work costs a kernel boot to be told "none". `expire = 0`
 * is the unclaimed condition, so an item under another invocation's lease is not waiting.
 *
 * `exclude` stops the deepest queue starving the others; `prefer` keeps a repeating (mid-drain)
 * unit on the queue it started.
 */
export function queuePending(
	sql: CronSql,
	options: { exclude?: string; prefer?: string } = {}
): QueuePending {
	try {
		const rows = sql
			.exec(
				`SELECT name, COUNT(*) AS c FROM queue
         WHERE expire = 0 GROUP BY name ORDER BY c DESC, name ASC`
			)
			.toArray();
		if (rows.length === 0) return { name: null, reason: 'queue is empty', queues: {} };
		const queues: Record<string, number> = {};
		for (const r of rows) queues[String(r.name)] = Number(r.c);
		const { exclude, prefer } = options;
		let pick = rows[0] as Record<string, unknown>;
		if (prefer !== undefined) {
			pick =
				rows.find((r) => String(r.name) === prefer) ?? (rows[0] as Record<string, unknown>);
		} else if (exclude !== undefined && rows.length > 1) {
			pick =
				rows.find((r) => String(r.name) !== exclude) ??
				(rows[0] as Record<string, unknown>);
		}
		return { name: String(pick.name), pending: Number(pick.c), queues };
	} catch (e) {
		const message = errorMessage(e);
		if (MISSING_TABLE.test(message)) {
			return { name: null, reason: 'no queue table', queues: {} };
		}
		return { name: null, reason: message, queues: {} };
	}
}

/**
 * When the next alarm should fire.
 *
 * +1 ms while the chain has work (a fresh invocation is a fresh CPU budget, which lets a chain of
 * 10 ms units do what no single invocation could); otherwise the idle interval.
 */
export function cronAlarmDelayMs(step?: { more?: boolean }, options: CronOptions = {}): number {
	if (step?.more) return options.chainMs ?? 1;
	return options.idleMs ?? 240000;
}

export {
	cronHookList,
	runAdvisoryScan,
	runCronHook,
	runCronQueue,
	runFetchReopen,
	runHealthSelfTest
};
