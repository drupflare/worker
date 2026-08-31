import { cronHookList, runCronHook, runCronQueue } from '../drupal/cron-php.js';

/**
 * Garbage collection and the decomposed cron chain.
 */

/** The cursor `exec()` hands back, narrowed to the three things a ledger reads off it. */
export interface CronCursor {
	toArray(): Record<string, unknown>[];
	rowsWritten: number;
	rowsRead: number;
}

/** `ctx.storage.sql`, or anything with the same exec()/cursor shape. */
export interface CronSql {
	exec(text: string, ...params: unknown[]): CronCursor;
}

/** Whether one module's `hook_cron` runs, and the reason when it does not. */
export interface CronHookPolicy {
	run: boolean;
	reason?: string;
}

/** One table's share of a pass. `rowsReleased` is the queue-lease UPDATE only. */
export type TableLedger = {
	rowsDeleted: number;
	rowsWritten: number;
	statements: number;
	rowsReleased?: number;
};

/**
 * A pass's accounting record.
 *
 * A `type` rather than an `interface`: an object type alias carries an implicit index
 * signature, which is what lets a ledger be returned as `cronStep()`'s `result` alongside a PHP
 * reply. An interface would not be assignable there.
 *
 * `t0` exists only until `finish()` seals the record and deletes it; everything from `rowLimit`
 * down is set by the one pass that computes it, which is why they are optional rather than a
 * union of five shapes.
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

/** One statement's rows and cost; `missing` and `error` are the two guarded outcomes. */
export interface ExecResult {
	rows: Record<string, unknown>[];
	rowsWritten: number;
	rowsRead: number;
	missing?: boolean;
	error?: string;
}

/** Every knob the GC passes and the chain accept; each one reads only what it needs. */
export interface CronOptions {
	pass?: string;
	nowMs?: number;
	rowLimit?: number | null;
	maxRows?: number;
	tables?: string[];
	queueBatchSize?: number;
	maxQueueRepeats?: number;
	idleMs?: number;
	chainMs?: number;
	hooks?: string[];
	hookPolicy?: Record<string, CronHookPolicy>;
	includeQueue?: boolean;
	includeCronLast?: boolean;
	/**
	 * the `scheme://host[:port]` a cron fragment boots Drupal against.
	 *
	 * Cron is where mail is sent, and `user_pass_reset_url()` builds an absolute link from the
	 * request -- so booted against the default, every link Drupal mails points the recipient at
	 * their own machine. Empty leaves the old behaviour, which is correct for a probe.
	 */
	origin?: string;
}

/** One unit of the chain. `module` is set only on the hook units. */
export interface CronUnit {
	id: string;
	kind: string;
	pass?: string;
	module?: string;
	unreviewed?: boolean;
}

/** The cursor as it is stored; `wrapped` is not part of it. */
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

/** What `advanceCursor()` returns: a stored cursor plus the end-of-round signal. */
export type AdvancedCursor = StoredCursor & { wrapped: boolean };

/** Whatever storage handed back. `undefined` is a real input: an evicted object has nothing. */
export type CursorInput = Record<string, unknown> | string | null | undefined;

/** The queue with work, or null plus the reason why not. */
export interface QueuePending {
	name: string | null;
	reason?: string;
	pending?: number;
	queues: Record<string, number>;
}

/** What a cron PHP fragment prints back; the shape depends on which fragment ran. */
export interface CronPhpReply {
	skipped?: string;
	remaining?: number;
	processed?: number;
	suspended?: boolean;
	repeats?: number;
	[key: string]: unknown;
}

/** The dependency bag `cronStep()` takes; it owns no transport, alarm or env of its own. */
export interface CronDeps {
	sql: CronSql;
	runJson: (code: string) => Promise<Record<string, unknown>>;
	nowMs?: () => number;
}

/** One unit of cron work, done. */
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

/** Drupal's own default when dblog.settings has no row_limit */
export const WATCHDOG_DEFAULT_ROW_LIMIT = 1000;

/** DatabaseBackend::DEFAULT_MAX_ROWS, the cap Drupal already sets on every bin */
export const CACHE_DATA_DEFAULT_MAX_ROWS = 5000;

/** session.gc_maxlifetime as shipped in default.services.yml */
export const SESSION_DEFAULT_MAX_AGE_S = 200000;

/** BatchStorage::cleanup() and DatabaseQueue::garbageCollection() both use 10 days */
export const BATCH_MAX_AGE_S = 864000;

/**
 * Tables Drupal creates lazily, and the expiry condition each one needs.
 *
 * Every entry is guarded, because none of these tables is guaranteed to exist:
 * `sessions`, `flood`, `key_value_expire`, `batch`, `queue` and `semaphore` are
 * all created on first write by an ensureTableExists() call in their own backend,
 * so a site that has never had an anonymous session has no `sessions` table and a
 * DELETE against it is a hard error rather than a no-op.
 *
 * Each condition is copied from the Drupal service that owns the table, so this
 * is Drupal's policy executed by a different caller, not a new policy:
 * SessionHandler::gc(), Flood\DatabaseBackend::garbageCollection(),
 * KeyValueDatabaseExpirableFactory::garbageCollection(), BatchStorage::cleanup()
 * and DatabaseQueue::garbageCollection().
 *
 * `batch` is the one with nothing behind it at all. BatchStorage::cleanup() has NO
 * CALLER anywhere in Drupal 11.4.5 -- grepped across core/lib, core/modules and
 * core/includes, the only hits are its own declaration, the interface, and the
 * lazy-loading ProxyClass that delegates to it -- so it is dead code upstream and
 * batch GC is ours or nobody's.
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
	// src/site-do's alarm() already runs this one inline; once gcPass is wired in,
	// that line is a duplicate statement and should go
	{ table: 'semaphore', where: 'expire < ?', ageS: 0 }
];

/**
 * Which cron implementations run, and why the one that does not is skipped.
 *
 * The six here are the measured set on this install, taken from
 * invokeAllWith('cron') against the real site rather than from the module list:
 * announcements_feed, dblog, file, layout_builder, system, update. A module added
 * later shows up in cronHookList() and gets the unreviewed default, which is to
 * RUN it -- a hook that reaches for a socket fails into a caught error because
 * src/worker-shim.js stubs Asyncify, so running an unknown hook costs an
 * invocation rather than the interpreter.
 *
 * A `run: false` here is load-bearing in a way a skipped test is not: the hook is absent from every
 * site rather than merely unverified, and nothing reports it. Three of these entries outlived the
 * limit that justified them. Before adding one, check the limit still holds.
 */
export const CRON_HOOKS: Record<string, CronHookPolicy> = {
	// all three of these were `run: false` for "outbound HTTPS; there is no socket", which was true
	// when it was written and stopped being true once the stream wrapper and CachedFetchHandler's
	// defer-and-answer-next-drain landed. Nothing re-read the reason, so `hook_cron` for `update`
	// never fired on any site: the fetch queue was only ever drained by a human clicking Check
	// manually, and `system` being off is why security advisories were never wired at all
	update: { run: true },
	announcements_feed: { run: true },
	system: { run: true },
	// DblogHooks::cron() is one SELECT and one DELETE against watchdog; gc:watchdog
	// is the same two statements for no kernel boot
	dblog: { run: false, reason: 'superseded by the gc:watchdog SQL pass' },
	file: { run: true },
	layout_builder: { run: true },
	// last in KNOWN_CRON_HOOKS as well, because its Order::Last only orders hooks within one
	// drupal_cron() and this chain gives each its own firing
	drupflare: { run: true }
};

/** The four knobs the GC passes and the chain read from env; all arrive as strings. */
export interface CronEnv {
	CRON_QUEUE_BATCH_SIZE?: string | number;
	CACHE_DATA_MAX_ROWS?: string | number;
	WATCHDOG_ROW_LIMIT?: string | number;
	KEEP_WARM_MS?: string | number;
	WARM_INTERVAL_MS?: string | number;
	SITE_WARM?: string | number;
}

/** the cron hook modules this site has, measured, for when discovery has not run */
export const KNOWN_CRON_HOOKS = [
	'announcements_feed',
	'dblog',
	'file',
	'layout_builder',
	'system',
	'update',
	// after `update`, whose deferral it corrects
	'drupflare'
];

/** a discovered hook list and the enabled-module set it was discovered against */
export type CronHookCache = { at: string; hooks: string[] };

/**
 * Module names out of a {@link cronHookList} payload.
 *
 * Null rather than an empty list when the run failed or reported nothing, so a caller keeps the
 * list it already had instead of scheduling no hooks at all.
 */
export function cronHooksFromList(payload: unknown): string[] | null {
	const body = payload as { ok?: unknown; shapes?: unknown } | null;
	if (body === null || typeof body !== 'object' || body.ok !== true) return null;
	const shapes = body.shapes;
	if (shapes === null || typeof shapes !== 'object') return null;
	const names = Object.keys(shapes as Record<string, unknown>).filter((name) => name !== '');
	return names.length > 0 ? names.sort() : null;
}

/**
 * The hooks to schedule, and whether the cache still describes this site.
 *
 * `KNOWN_CRON_HOOKS` is the list measured on the shipped install, so a customer-installed module's
 * `hook_cron` was never scheduled on any site. Keyed on the enabled-module set rather than on the
 * generation, which moves on every content save and would re-boot the kernel for each one.
 */
export function cronHooksFor(
	cache: CronHookCache | null,
	fingerprint: string
): { hooks: string[]; stale: boolean } {
	if (cache === null || !Array.isArray(cache.hooks) || cache.hooks.length === 0) {
		return { hooks: [...KNOWN_CRON_HOOKS], stale: true };
	}
	return { hooks: cache.hooks, stale: cache.at !== fingerprint };
}

/** how many queue items one invocation may process */
export function queueBatchSize(env?: CronEnv | null): number {
	const n = Number(env?.CRON_QUEUE_BATCH_SIZE ?? 5);
	return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 50) : 5;
}

/** row cap for cache_data; Drupal's own bin default is 5000 */
export function cacheDataMaxRows(env?: CronEnv | null): number {
	const n = Number(env?.CACHE_DATA_MAX_ROWS ?? CACHE_DATA_DEFAULT_MAX_ROWS);
	return Number.isFinite(n) && n >= 1
		? Math.min(Math.floor(n), 1000000)
		: CACHE_DATA_DEFAULT_MAX_ROWS;
}

/** row cap for watchdog, or null to read dblog.settings from the database */
export function watchdogRowLimitOverride(env?: CronEnv | null): number | null {
	if (env?.WATCHDOG_ROW_LIMIT === undefined) return null;
	const n = Number(env.WATCHDOG_ROW_LIMIT);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Everything gcPass() and cronStep() need, read from env in one call.
 *
 * The default path: `cronStep(cursor, deps, cronOptions(env))`. Every field stays
 * overridable, because the options object is plain data and the caller can spread
 * over it.
 */
export function cronOptions(env?: CronEnv | null): CronOptions {
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
 * A throwaway object minted an id in its constructor and held a 32 MB allocation, so a changed id
 * IS a lost isolate rather than a proxy for one. Re-arming its alarm every 8 s held ONE incarnation
 * across 71 consecutive firings; at 12, 20, 30 and 45 s the id changed on every probe and
 * `alarmsSeen` never passed 1, so those firings were paid for and warmed nothing. With no alarm the
 * id changed across a 20 s gap, the shortest measured.
 *
 * The consequence for the name below: `KEEP_WARM_MS` shipped at 240,000, which is 24x this, so
 * nothing it governed was ever kept warm. It is an idle RE-ARM and that is all it is.
 */
export const HIBERNATION_IDLE_MS = 10_000;

/** the idle re-arm; NOT a keep-warm, see {@link HIBERNATION_IDLE_MS} */
export function keepWarmMs(env?: CronEnv | null): number {
	const n = Number(env?.KEEP_WARM_MS ?? 240000);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 240000;
}

/**
 * The re-arm that actually holds an object resident, for a site designated warm.
 *
 * Clamped below the threshold rather than trusted: a value above it buys nothing and still spends
 * an object request and an alarm row per firing, which is the worst of both.
 */
export function warmIntervalMs(env?: CronEnv | null): number {
	const n = Number(env?.WARM_INTERVAL_MS ?? 8000);
	const ms = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 8000;
	return Math.min(ms, HIBERNATION_IDLE_MS - 2000);
}

/**
 * Whether this site re-arms fast enough to stay resident.
 *
 * On by default on both plans. One site is the case to price, and there warming costs 10.8% of
 * free's two daily meters and $0 marginal on paid. What it removes is the 1,398 ms cold boot from
 * every page that renders, which is the authenticated tier.
 *
 * The figure that argued against it was a fleet figure, and fleet arithmetic is the wrong lever for
 * a default: past a hundred or so warm sites the answer is another account rather than a worse
 * default for the one site anybody has. {@link idleRearmMs}'s headroom argument is what handles an
 * account running out.
 */
export function siteWarmEnabled(env?: CronEnv | null): boolean {
	const set = env?.SITE_WARM;
	if (set !== undefined && set !== null && String(set) !== '') return String(set) === '1';
	return true;
}

/**
 * The idle re-arm a site should use.
 *
 * @param hasHeadroom whether the quota ladder still permits background work. FALSE drops back to the
 *   slow re-arm, which is what keeps an account-wide meter safe from several warm sites at once: on
 *   free the quotas are shared, so ten warm sites would spend 108% of the daily rows on staying warm
 *   and leave nothing to regenerate with. A degraded site un-warms itself and recovers at midnight
 *   UTC rather than needing anybody to notice.
 */
export function idleRearmMs(env?: CronEnv | null, hasHeadroom = true): number {
	return hasHeadroom && siteWarmEnabled(env) ? warmIntervalMs(env) : keepWarmMs(env);
}

/** a missing table is "nothing to do"; anything else is a real failure */
const MISSING_TABLE = /no such table/i;

/** workerd hands a TEXT column back as a string, but a real BLOB comes back binary */
function asText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
	if (value && typeof value === 'object' && 'byteLength' in value) {
		// the `byteLength` test above is the duck check; workerd hands back a real view
		return new TextDecoder().decode(value as ArrayBufferView);
	}
	return value === null || value === undefined ? '' : String(value);
}

/**
 * Reads one integer out of a PHP-serialized array, without unserializing it.
 *
 * NOT a general unserializer. Drupal stores config as
 * `serialize($array)` and the only value read here is dblog.settings row_limit, so
 * the whole job is finding `s:9:"row_limit";i:<n>;`. The length prefix and the
 * requirement that the match follow a `;`, `{` or `}` are what stop a key name
 * appearing inside some other key's string VALUE from matching -- a string value
 * that itself contains the exact serialized bytes could still fool it, which is
 * why every caller has a fallback and an env override.
 *
 * @param blob the serialized array
 * @param key top-level key to read
 * @returns the integer, or null if it is absent or not an integer
 */
export function serializedInt(blob: unknown, key: string): number | null {
	const text = asText(blob);
	if (typeof text !== 'string' || text.length === 0) return null;
	const needle = `s:${key.length}:"${key}";i:`;
	let at = text.indexOf(needle);
	while (at >= 0) {
		const before = at === 0 ? '{' : text[at - 1];
		if (before === ';' || before === '{' || before === '}') {
			const m = /^(-?\d+);/.exec(text.slice(at + needle.length));
			if (m) return Number(m[1]);
			return null;
		}
		at = text.indexOf(needle, at + 1);
	}
	return null;
}

/** the serialized form Drupal's state store expects for an integer */
export function serializeInt(value: unknown): string {
	return `i:${Math.trunc(Number(value))};`;
}

/** a fresh accounting record; every field is reported, none is inferred */
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

function bucket(led: Ledger, table: string): TableLedger {
	if (!led.tables[table]) {
		led.tables[table] = { rowsDeleted: 0, rowsWritten: 0, statements: 0 };
	}
	// created on the line above when it was absent
	return led.tables[table] as TableLedger;
}

/**
 * Runs one statement and folds its cost into the ledger.
 *
 * Errors are recorded and execution continues rather than throwing: this runs on
 * an unattended alarm, and one broken table must not cost the other five their
 * collection. A missing table is not recorded as an error at all.
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
	} catch (e: any) {
		const message = String(e?.message ?? e);
		if (MISSING_TABLE.test(message)) {
			if (table && !led.missing.includes(table)) led.missing.push(table);
			return { rows: [], rowsWritten: 0, rowsRead: 0, missing: true };
		}
		led.errors.push({ table: table ?? null, error: message });
		return { rows: [], rowsWritten: 0, rowsRead: 0, error: message };
	}
}

/**
 * SQLite's own affected-row count, the way src/do-sqlite.js reads it.
 *
 * Needed separately from rowsWritten because they answer different questions:
 * changes() is how many rows the DELETE removed, rowsWritten is how many rows
 * Cloudflare bills for it, and the two differ by one write per index touched
 * (D1/DO pricing, footnote 6: "Indexes will add an additional written row"). The
 * ratio is reported, so the real amplification on the edge arrives as a
 * measurement on the first run.
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
 * The pivot-then-delete shape is copied from DblogHooks::cron() rather than
 * improved on, and core's own comment says why: counting the most recent N rows
 * survives an AUTOINCREMENT sequence that does not start at 1 and rows deleted
 * out from under it, which an arithmetic `wid < max - limit` does not.
 *
 * Under the limit it issues ONE statement, finds no pivot, and writes nothing.
 */
export function gcWatchdog(sql: CronSql, options: CronOptions = {}): Ledger {
	const led = ledger('watchdog');
	let limit: number | null = options.rowLimit ?? null;
	if (limit === null || limit === undefined) {
		const row = exec(sql, led, 'config', 'SELECT data FROM config WHERE name = ?', [
			'dblog.settings'
		]).rows[0];
		limit = serializedInt(row?.data, 'row_limit');
		if (limit === null) limit = WATCHDOG_DEFAULT_ROW_LIMIT;
	}
	led.rowLimit = limit;

	// 0 is Drupal's "All" setting in the logging form, not a request to empty it
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
 * The row cap is the only thing that works here, and it is measured: all 144
 * cache_data rows on the reference site have `expire = -1`, so an expire-based
 * sweep removes exactly zero of them. 70 are RouteProvider's per-URL route cache
 * -- cid `route:[language]=en:[query_parameters]=<qs>:<path>`, written at
 * RouteProvider.php:222 with CACHE_PERMANENT -- so every distinct URL a scanner
 * probes adds a permanent row. (The mechanism is RouteProvider, not PageCache;
 * both write into the `data` bin but only the route cache is keyed per URL.)
 *
 * The cap is Drupal's own: cache.data reports getMaxRows() === 5000, set by
 * DatabaseBackend::DEFAULT_MAX_ROWS, enforced by DatabaseBackend
 * ::garbageCollection() -- which only ever runs from SystemHooks::cron(), the one
 * hook this runtime cannot call. So the policy was always there and the caller
 * never was.
 *
 * Ordering by `created, cid` rather than core's `created <= pivot`:
 * `created` is a float with millisecond resolution and a single request writes
 * several rows, so ties are ordinary and core's condition over-deletes them.
 */
export function gcCacheData(sql: CronSql, options: CronOptions = {}): Ledger {
	return gcCacheBin('cache_data', 'cachedata', sql, options);
}

/**
 * Collects `cache_dynamic_page_cache`, which had no collector at all.
 *
 * Its entries are written `expire = -1` and core's own GC runs from `SystemHooks::cron()`, which
 * this runtime never calls. Emptying it on every fill was the only thing bounding it, so a fill that
 * stops doing that leaves the bin growing forever.
 */
export function gcDynamicPageCache(sql: CronSql, options: CronOptions = {}): Ledger {
	return gcCacheBin('cache_dynamic_page_cache', 'dynamicpagecache', sql, options);
}

/** oldest-first eviction down to a row cap, then whatever set a real expiry */
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

	// the common case: under the cap, so one read and no writes at all
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

	// still worth issuing: other writers into this bin do set an expiry
	exec(sql, led, table, `DELETE FROM ${table} WHERE expire <> -1 AND expire < ?`, [nowS]);
	changes(sql, led, table);

	return finish(led);
}

/**
 * Clears expired rows from the tables Drupal creates lazily.
 *
 * Guarded per table, so a site that has never written a session, a flood entry or
 * a batch collects the other five instead of failing on the first missing one.
 */
export function gcExpired(sql: CronSql, options: CronOptions = {}): Ledger {
	const led = ledger('expired');
	const nowS = Math.floor((options.nowMs ?? Date.now()) / 1000);
	const only = Array.isArray(options.tables) ? options.tables : null;

	for (const rule of EXPIRED_ROW_RULES) {
		if (only && !only.includes(rule.table)) continue;
		// the table name is interpolated rather than bound, so it is checked; a
		// parameter cannot stand in for an identifier in SQLite
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

	// Releases leases nobody will ever come back for, per
	// DatabaseQueue::garbageCollection(). An UPDATE, so it writes rows and reclaims
	// no storage; it is correctness, and it is counted as `rowsReleased` rather than
	// deleted so the two are not confused in the total.
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
 * Records that cron ran, as Drupal\Core\Cron::setCronLastTime() would.
 *
 * One serialized integer in key_value, so it needs no PHP. Not cosmetic: its
 * absence from the pack is why AutomatedCron's elapsed check passed on the very
 * first request and ran drupal_cron() inline, which is the failure TECHNICAL_REPORT.md
 * records as killing every render with an Asyncify throw.
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
	led.cronLast = nowS;
	return finish(led);
}

/** seals a ledger: adds wall time and the observed index amplification */
function finish(led: Ledger): Ledger {
	// set by ledger(), and this is the only place it is removed
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

/** every pass name gcPass() accepts, in the order `all` runs them */
export const GC_PASSES = ['watchdog', 'cachedata', 'dynamicpagecache', 'expired'];

/**
 * Runs one garbage-collection pass, or all of them, and reports what it cost.
 *
 * `passes` on the returned ledger is present only for `pass: 'all'`, which is where the per-pass
 * ledgers are kept; `rowsReleased` only for the queue-lease UPDATE, which writes rows and
 * reclaims no storage. Both were missing from this signature and a typed caller could not read
 * them.
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
 * `hooks` is the discovered list when cronHookList() has run and KNOWN_CRON_HOOKS
 * otherwise. A module with no policy entry is unreviewed and RUNS, flagged, so
 * adding a contrib module does not silently mean its cron never fires.
 *
 * `module` is set only on the hook units, which is how a caller tells a cron hook apart from a
 * pure-SQL pass; it was missing from this signature, so a typed caller could not filter on it.
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
	if (options.includeQueue !== false) {
		units.push({ id: 'queue', kind: 'php' });
	}
	if (options.includeCronLast !== false) {
		units.push({ id: 'cron_last', kind: 'sql', pass: 'cron_last' });
	}
	return units;
}

/** the units that are configured OUT, with the reason, for reporting */
/**
 * The hooks that will NOT run, mapped to the reason.
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
 * Total: null, a string, a truncated object and an index that no longer addresses
 * a unit all resolve to the start of the chain rather than to an exception. That
 * last case is the one that matters in practice -- the unit list is derived from
 * configuration on every invocation, so a redeploy that removes a hook leaves a
 * stored `i` pointing past the end.
 */
export function readCursor(raw: CursorInput, unitCount = 1): StoredCursor {
	// widened once here rather than at eight reads; the guard below makes it good
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
 * `wrapped` is what tells the caller a full round finished, which is the signal to
 * stop chaining at +1 ms and go back to the idle interval. It is on the RETURN value only,
 * never on a stored cursor, which is why it has to be declared here for a typed caller.
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
 * Does ONE unit of cron work and hands back the next cursor.
 *
 * Shaped as a pure-ish function of (cursor, deps) so the caller keeps ownership of
 * persistence: the cursor goes to `cfw_meta` or `ctx.storage.put()`, whichever the
 * Durable Object already uses, and neither choice leaks in here. That is also what
 * makes the chain testable without a Durable Object at all.
 *
 * `mayContinue` is the CPU constraint expressed as data. A `sql` unit costs
 * microseconds, so the caller may run another in the same invocation; a `php` unit
 * enters the interpreter and must be the last thing that invocation does. This is
 * the same trade fillBatchSize()/fillBatchWallMs() make in src/site-do.js -- batch
 * to amortise the setAlarm() row write, but never batch across a render.
 *
 * `result` is the unit's own ledger or reply and its shape depends on the unit, so it is
 * declared as an index signature rather than `object` -- a bare `object` makes every field
 * unreadable to a typed caller, which is what the ported specs hit.
 *
 * @param rawCursor whatever storage returned. `undefined` is a real input, not a defensive
 *   allowance: an evicted Durable Object comes back with nothing, and that case is tested
 * @param deps the transport and clock, injected so the chain owns neither
 * @param options passed through to cronUnits() and the GC passes
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

	let result: Record<string, unknown> | null = null;
	let rowsWritten = 0;
	let stay = false;
	let servedQueue: string | null = null;

	if (unit.kind === 'sql') {
		result = gcPass(deps.sql, { ...options, pass: unit.pass, nowMs: now });
		rowsWritten = result.rowsWritten as number;
	} else if (unit.id === 'queue') {
		// Discovery in SQL first, so an empty queue costs one read and no interpreter.
		// The queue table is created lazily, so a site that has never queued anything
		// has no table and this has to be a skip rather than an error.
		// rotate off the queue this cursor served last, so a deep queue cannot starve
		// a shallow one; a repeating unit keeps its queue because it is mid-drain
		const draining = cursor.queueRepeats > 0;
		const pending = queuePending(deps.sql, {
			prefer: draining ? cursor.lastQueue : null,
			exclude: draining ? null : cursor.lastQueue
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
			// repeat the unit while it is making progress, but never forever: a worker
			// that always fails would otherwise chain alarms at +1 ms indefinitely
			stay =
				remaining > 0 &&
				progressed &&
				!result?.suspended &&
				repeats < (options.maxQueueRepeats ?? 20);
			result.repeats = repeats;
		}
	} else {
		// the only module-less php unit is `queue`, handled by the branch above
		result = await deps.runJson(runCronHook(unit.module as string, options.origin));
	}

	const ms = Date.now() - t0;
	const patch = {
		lastUnit: unit.id,
		lastAt: now,
		rowsWritten: cursor.rowsWritten + rowsWritten,
		queueRepeats: unit.id === 'queue' && stay ? cursor.queueRepeats + 1 : 0,
		// remembered even when the unit advances, because that is what the next round
		// rotates away from
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
 * Pure SQL: the only cron queue this site defines is
 * media_entity_thumbnail, and asking PHP which queues have work would cost a
 * kernel boot to be told "none", which is the answer every time until something
 * queues a thumbnail. `expire = 0` is the unclaimed condition, so an item another
 * invocation still holds a lease on is not counted as waiting.
 *
 * `exclude` is what stops the deepest queue starving the others: without it a
 * queue with a thousand items would be picked every round forever, and a second
 * queue would never be reached. `prefer` is the other direction -- a unit that is
 * repeating itself is mid-drain and must stay on the queue it started.
 */
export function queuePending(
	sql: CronSql,
	options: { exclude?: string | null; prefer?: string | null } = {}
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
		const exclude = options.exclude ?? null;
		const prefer = options.prefer ?? null;
		// `rows.length === 0` returned above, so index 0 is a row
		let pick = rows[0] as Record<string, unknown>;
		if (prefer !== null) {
			pick =
				rows.find((r) => String(r.name) === prefer) ?? (rows[0] as Record<string, unknown>);
		} else if (exclude !== null && rows.length > 1) {
			pick =
				rows.find((r) => String(r.name) !== exclude) ??
				(rows[0] as Record<string, unknown>);
		}
		return { name: String(pick.name), pending: Number(pick.c), queues };
	} catch (e: any) {
		const message = String(e?.message ?? e);
		if (MISSING_TABLE.test(message)) {
			return { name: null, reason: 'no queue table', queues: {} };
		}
		return { name: null, reason: message, queues: {} };
	}
}

/**
 * When the next alarm should fire.
 *
 * +1 ms while the chain has work, matching src/site-do.js: a fresh invocation is
 * a fresh CPU budget, and that is what makes a chain of 10 ms units able to do
 * work no single invocation could. The idle value matches the keep-warm interval
 * already in src/do-sqlite.js.
 */
export function cronAlarmDelayMs(
	step?: { more?: boolean } | null,
	options: CronOptions = {}
): number {
	if (step?.more) return options.chainMs ?? 1;
	return options.idleMs ?? 240000;
}

export { cronHookList, runCronHook, runCronQueue };
