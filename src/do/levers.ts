import type { SiteEnv } from '../env';
import { planFlag } from '../ops/plan';
import { resolvePlanNumber } from '../ops/plan-profile';
import { leverInt } from '../util/lever';

/** how many pages one alarm firing may fill before re-arming; 5 on free, 25 on paid */
export function fillBatchSize(env?: SiteEnv): number {
	return Math.max(1, resolvePlanNumber(env?.FILL_BATCH_SIZE, 'fillBatchSize', 50, env));
}

/** asset directory holding manifest.json plus the numbered migration chunks */
export function sqlChunkPrefix(env?: SiteEnv): string {
	const p = String(env?.SQL_CHUNK_PREFIX ?? 'drupal-sql').replace(/^\/+|\/+$/g, '');
	return p || 'drupal-sql';
}

/** whether an alarm firing carries the migration forward itself (off lets a test drive chunks) */
export function migrationSelfDrives(env?: SiteEnv): boolean {
	return String(env?.MIGRATE_SELF_DRIVE ?? '1') !== '0';
}

/** whether `alarm()` drains the deferred outbound-HTTP queue (off so a test can assert on depth) */
export function httpDrainEnabled(env?: SiteEnv): boolean {
	return String(env?.HTTP_DRAIN_ON_ALARM ?? '1') !== '0';
}

/**
 * How many queued requests one alarm firing may fetch.
 *
 * Small: each fetch is one of the 50 subrequests an invocation gets and a fill in the same firing
 * has spent several. Capped at 25 by `drainHttpQueue()`; paid gets 15 (its ceiling is 1,000).
 */
export function httpDrainLimit(env?: SiteEnv): number {
	return Math.max(1, resolvePlanNumber(env?.HTTP_DRAIN_LIMIT, 'httpDrainLimit', 25, env));
}

/**
 * How long the refill after a save waits for the rest of a burst, in ms; 0 is off.
 *
 * A refill between two saves clears `bumpCoalesced`, so every page the second save reaches renders
 * twice. `armFillAlarm()` keeps a sooner alarm, so later saves never push it past the first save
 * plus this; a visitor's miss still arms at once.
 */
export function saveDebounceMs(env?: SiteEnv): number {
	const n = Number((env as { SAVE_DEBOUNCE_MS?: string } | undefined)?.SAVE_DEBOUNCE_MS ?? 2000);
	return Number.isFinite(n) && n >= 0 ? n : 2000;
}

/**
 * How long PHP may wait through the park in one invocation, in total.
 *
 * `SLEEP_BUDGET_MS` is the visitor allowance (2 s default, capped at 60 s); an alarm gets 15x
 * that because nobody waits on it and a wait bills wall time with no CPU. Past the allowance
 * a sleep returns at once and records how much it was short.
 */
export function sleepBudgetMs(env: SiteEnv | undefined, kind: 'request' | 'alarm'): number {
	const n = Number(env?.SLEEP_BUDGET_MS);
	const visitor = Number.isFinite(n) && n >= 0 ? Math.min(n, 60_000) : 2000;
	return kind === 'alarm' ? visitor * 15 : visitor;
}

/**
 * How long a freshly booted interpreter runs no background PHP: the alarm's fill batch, cron and
 * the fill window. `0` turns the hold off.
 *
 * 60 s default: on deployed farmOS every memory reset was on an isolate 0-10 s past a fresh boot
 * with an alarm rendering beside the editor. A held fill re-arms for the end of the hold; a
 * visitor's own render is never held.
 */
export function fillSettleMs(env?: SiteEnv): number {
	const raw = env?.FILL_SETTLE_MS;
	const n = Number(raw);
	if (raw !== undefined && String(raw) !== '' && Number.isFinite(n) && n >= 0) {
		return Math.min(Math.floor(n), 600_000);
	}
	return 60_000;
}

/** when background PHP may run on an interpreter booted at `bootedAt`; undefined when it may now */
export function backgroundPhpHold(
	bootedAt: number | undefined,
	nowMs: number,
	settleMs: number
): number | undefined {
	if (bootedAt === undefined || settleMs <= 0) return undefined;
	const until = bootedAt + settleMs;
	return nowMs < until ? until : undefined;
}

/**
 * How many files one alarm firing may push to R2.
 *
 * Same budget as the HTTP drain (a put is one of the 50 subrequests), kept lower than its default
 * because a put carries the whole file through memory.
 */
export function mirrorLimit(env?: SiteEnv): number {
	return Math.max(1, resolvePlanNumber(env?.MIRROR_LIMIT, 'mirrorLimit', 25, env));
}

/**
 * R2 write operations one site may spend in a calendar month (UTC) before both mirrors stop.
 *
 * R2 allows 1,000,000 Class A operations a month per account and bills every put past it; the
 * default stops at 90% for one site. Stopping degrades to serving from the object, which holds
 * every byte, so a spent budget costs requests and never a file. `0` turns both mirrors off.
 */
export function r2WriteBudget(env?: SiteEnv): number {
	const raw = (env as { R2_WRITES_PER_MONTH?: unknown } | undefined)?.R2_WRITES_PER_MONTH;
	return leverInt(raw) ?? 900_000;
}

/**
 * Whether `/migrate` seeds the serving table from `prefill.json` when nothing says otherwise.
 *
 * On for free, off for paid. A prefilled path is a HIT on its first request, which changes the
 * cold contract. Most specific wins: `?prefill=1|0` on the request, a `PREFILL` env override, then
 * the plan.
 */
export function prefillDefault(env?: SiteEnv): boolean {
	// paid can afford to render, and an operator asking for the cold contract should get it
	return planFlag(undefined, env?.PREFILL, false, env);
}

/**
 * Whether an authenticated GET may be answered from a stored shell.
 *
 * On for both plans; an explicit `SHELL_ASSEMBLY` wins and `KV_OVERRIDABLE` carries it.
 *
 * Safe because `assembleFor()` serves no visitor until their own uid passes `verifyShellFor()`
 * (a byte-for-byte re-harvest); the two-session harvest only authorises the store. The first
 * request per `(path, role set, uid)` costs 40-52 rows and breaks even after 4-13.
 */
export function shellAssemblyEnabled(env?: SiteEnv): boolean {
	const set = env?.SHELL_ASSEMBLY;
	if (set !== undefined && String(set) !== '') return String(set) === '1';
	return true;
}

/**
 * Whether the password service hashes with argon2id.
 *
 * Off unless an operator says `1`. Enabling it is a migration (`needsRehash()` is then true for
 * every bcrypt hash, upgraded at the owner's next login) and a 19 MiB two-pass hash is CPU a
 * free-plan login does not have. `KV_OVERRIDABLE` carries it.
 */
export function argon2Enabled(env?: SiteEnv): boolean {
	return String(env?.ARGON2 ?? '0') === '1';
}

/**
 * The bins held in memory when nobody says otherwise.
 *
 * A re-render charges 8 rows with the bin in SQL and 4 in memory, and 6 against 2 across an
 * interpreter drop; the price is a slower first render after a drop (cold reassemble 1,324 ms
 * against 1,073, n=10). `render` (2,696 ms against 1,450 cold) and `discovery` (12.4 MiB of heap)
 * are refused; both stay available through `MEMORY_CACHE_BINS`.
 */
export const DEFAULT_MEMORY_CACHE_BINS = ['dynamic_page_cache', 'menu'] as const;

/**
 * Cache bins the interpreter keeps in memory instead of in this tenant's SQLite.
 *
 * `MEMORY_CACHE_BINS=none` is the off switch (an unset and an empty variable are the same string in
 * a Worker env). Comma-separated bin names without the `cache_` prefix, filtered to `[a-z0-9_]`
 * because the value reaches generated PHP.
 */
export function memoryCacheBins(env?: SiteEnv): string[] {
	const stated = (env as { MEMORY_CACHE_BINS?: string } | undefined)?.MEMORY_CACHE_BINS;
	const raw = String(stated ?? '');
	// unset takes the default; `none` is the off switch
	if (raw.trim() === '') return [...DEFAULT_MEMORY_CACHE_BINS];
	if (raw.trim().toLowerCase() === 'none') return [];
	return raw
		.split(',')
		.map((bin) => bin.trim())
		.filter((bin) => bin !== '' && /^[a-z0-9_]{1,40}$/.test(bin));
}

/** entries one in-memory bin may hold; see `CfwMemoryBackend::DEFAULT_MAX_ITEMS` for the bound */
export function memoryCacheMaxItems(env?: SiteEnv): number {
	const n = Number(
		(env as { MEMORY_CACHE_MAX_ITEMS?: string } | undefined)?.MEMORY_CACHE_MAX_ITEMS ?? 0
	);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 64;
}

/**
 * A PHP array literal from a list of already-filtered names.
 *
 * The values are constrained to `[a-z0-9_]` by the filter above, so the quoting cannot be escaped;
 * keep that property if the filter is widened.
 */
export function phpStringList(values: readonly string[]): string {
	return `[${values.map((v) => `'${v}'`).join(', ')}]`;
}

/**
 * How long a superseded page may still be answered, in ms.
 *
 * A row is served while its age is below this, so 0 is a real off switch. 60 s bounds the drain
 * window rather than setting freshness: a page still aged after a minute means the refill chain
 * stopped, and that should be a 503. Tighter than the KV tier's {@link STALE_MAX_AGE_MS} (24 hours,
 * answered from a previous generation).
 */
export function agedServeMaxMs(env?: SiteEnv): number {
	const n = Number(env?.AGED_SERVE_MAX_MS ?? 60_000);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60_000;
}

/**
 * Whether a superseded page may be answered for this path.
 *
 * `staleAllowed()`'s deny-list is deliberately not applied (it is calibrated for 24-hour-old KV
 * answers and would keep the 503 this removes on `/user/login`); only the operator's own
 * `NEVER_STALE` entries count. Dangerous pages never reach this table: `fillOne()` refuses
 * anything Drupal marked `private, no-store`.
 */
export function agedServeAllowed(path: string, env?: SiteEnv): boolean {
	const denied = String(env?.NEVER_STALE ?? '')
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p !== '');
	return !denied.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** whether a generation bump re-queues the pages it just purged */
export function prefillOnSave(env?: SiteEnv): boolean {
	return String(env?.PREFILL_ON_SAVE ?? '1') !== '0';
}

/**
 * How many just-purged paths a bump may re-queue.
 *
 * Capped because rows written bind free (100k/day, roughly 8 rows per fill). The overflow is
 * reported as `droppedFromRequeue`; those paths still fill on demand (a 202 for the first visitor).
 */
export function prefillOnSaveLimit(env?: SiteEnv): number {
	const n = Number(env?.PREFILL_ON_SAVE_LIMIT ?? 25);
	return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 500) : 25;
}

/**
 * Which migration engine `/migrate` uses; `sql` (JavaScript) is the default and the only one that
 * fits the free plan.
 *
 * `php` (`?engine=php`) is the A side of the comparison (2,272 ms minimal / 3,467 ms standard of
 * edge cpuTime). It needs `pdo_sqlite`, which the shipping binary lacks, so it fails there.
 */
export function migrateEngine(url: URL | undefined, env?: SiteEnv): 'php' | 'sql' {
	const asked = url?.searchParams?.get('engine');
	if (asked === 'php' || asked === 'sql') return asked;
	return String(env?.MIGRATE_ENGINE ?? 'sql') === 'php' ? 'php' : 'sql';
}
