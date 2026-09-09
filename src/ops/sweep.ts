import { DEFAULT_AUTH_ROWS_FRACTION, utcDayKey } from './auth-budget.js';
import { cronDue } from './cron-drive.js';
import { REDUCE_AT } from './degrade.js';
import { staleAllowed } from './page-store.js';

/**
 * The addressable sweep: pre-render the tail on a declared budget instead of billing a visitor for it.
 *
 * Page coverage is demand-driven today. A URL renders when somebody asks, that visitor waits, and
 * nothing knows what fraction of the site is covered or bounds what a crawler can make the site
 * spend. Two renders of one anonymous entity page are byte-identical, so the question is never HOW
 * the tail is produced -- only WHEN it is paid for and who waits.
 *
 * THE SWEEP QUEUES, IT NEVER RENDERS. Everything here writes `cfw_fill_queue` rows and stops; the
 * existing alarm fill batch drains them under the `oversized()` guard it already has. That is what
 * makes the isolate failure structurally impossible rather than bounded by a constant: a sweep adds
 * no workload to any invocation, so it cannot be the batch that crosses 128 MiB.
 *
 * THE GOVERNOR IS THE FEATURE. Three bounds, each against a different failure: a floor it will not
 * start below, a share of the DAY it may spend, and a share of what is LEFT it may take at once.
 */

/** the reads and writes a sweep needs, narrowed so it is drivable over a stand-in */
export interface SweepSql {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** where a candidate came from, so a coverage report can say what class is uncovered */
export type SweepSource = 'router' | 'node' | 'term' | 'user';

export type SweepCandidate = {
	/** the URL a visitor requests: the alias when one exists, the system path otherwise */
	path: string;
	source: SweepSource;
	/** the entity's own clock in ms; 0 for a static route, which has no recency */
	changedMs: number;
	/** non-empty segments, so the front page is 0 */
	depth: number;
};

// #region constants, each derived from a measured input

/**
 * Rows one swept page charges the fill chain.
 *
 * `ROWS_PER_FILL.firstEverForPath` in `scripts/measure/free-envelope.ts`, re-measured n=3 with zero
 * spread by `tests/integration/rows-per-fill-audit.spec.ts`. That class is the sweep by definition:
 * a path never routed on this object, on an object whose shared bins are already warm.
 *
 * Copied rather than imported for the reason `auth-budget.ts` copies its two -- `free-envelope.ts`
 * carries an `import.meta.main` block reading `process.argv`, so importing it drags a script into
 * the Worker bundle. `tests/unit/ops/sweep.spec.ts` asserts it against the script's own export.
 */
export const SWEEP_ROWS_PER_FILL = 14;

/**
 * The two queue rows the audit's arm never charged.
 *
 * It calls `fillOne(path)` directly, so it inserts no `cfw_fill_queue` row and the fill's DELETE
 * matches nothing. A sweep queues instead, so it pays the INSERT and the fill pays the DELETE.
 * Counted rather than assumed away; over-stating a cost is the safe direction for a governor.
 */
export const SWEEP_QUEUE_ROWS = 2;

export const SWEEP_ROWS_PER_PAGE = SWEEP_ROWS_PER_FILL + SWEEP_QUEUE_ROWS;

/** `FREE_QUOTAS.rowsPerAlarmArm`, measured and pinned by `tests/integration/warm-alarm-cost.spec.ts` */
export const SWEEP_ROWS_PER_ALARM_ARM = 1;

/**
 * The fraction of either daily meter at which a sweep refuses to start.
 *
 * `REDUCE_AT` rather than a number of its own: that is where the quota ladder already stops cron,
 * the queue, watchdog writes and image regeneration. A sweep is discretionary regeneration, so
 * starting one where its peers have stopped would be the ladder disagreeing with itself.
 */
export const SWEEP_START_FLOOR = REDUCE_AT;

/**
 * What share of the day's rows a sweep may spend.
 *
 * `DEFAULT_AUTH_ROWS_FRACTION`, the one fraction here chosen against a measurement:
 * `free-envelope.ts --visits=3000000 --dynamic=0.01` splits 100,000 rows/day 25/75 and leaves the
 * anonymous side 8.15x headroom over the 1,000 regenerations/day that workload needs. A sweep taking
 * the same 25% leaves 50,000 rows for demand-driven fills, 5,555 at `realRender`'s 9, still 5.5x
 * that need. The spec recomputes both figures rather than quoting them.
 */
export const SWEEP_ROWS_FRACTION = DEFAULT_AUTH_ROWS_FRACTION;

/** the same share of the DO-request meter; the two quotas are equal, so one fraction fits both */
export const SWEEP_DO_FRACTION = DEFAULT_AUTH_ROWS_FRACTION;

/** below this a sweep would never finish a page; the floor exists so a bad var cannot disable it silently */
export const SWEEP_MIN_FRACTION = 0.01;

/**
 * The largest share an operator may declare.
 *
 * At 0.5 the demand-driven anonymous slice is 25,000 rows, 2,777 `realRender` fills against the
 * measured 1,000/day need -- 2.7x. Past that a sweep is competing with visitors for the meter
 * rather than using its slack.
 */
export const SWEEP_MAX_FRACTION = 0.5;

/**
 * How often a sweep step may run.
 *
 * Derived from the allowance rather than picked. 25% of 100,000 rows at {@link SWEEP_ROWS_PER_PAGE}
 * is 1,562 pages/day, and one step queues at most one fill batch (50 by default), so 32 steps a day
 * spend the whole allowance. 48 steps leaves margin and costs ~480,000 reads/day of enumeration
 * against free's 5,000,000 read quota, under 10%.
 */
export const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Entity rows one enumeration reads per kind.
 *
 * Three days of sweeping at the 1,562 pages/day the row allowance buys, so a walk survives a couple
 * of quiet days without re-reading, and the array stays small inside a 128 MiB isolate. Raising it
 * enumerates more than any day can spend.
 */
export const SWEEP_MAX_PER_KIND = 5_000;

/** the `cfw_meta` key the cursor lives under */
export const SWEEP_CURSOR_KEY = 'sweep_cursor';

// #endregion

/**
 * Paths a sweep refuses to enumerate, on top of `staleAllowed()`.
 *
 * That list is reused rather than restated: it already denies the pages a visitor ACTS on
 * (`/user/login`, `/user/password`, `/cart`, `/checkout`), which is the same direction a sweep
 * needs. These are the ones it does not carry, because they are about rendering rather than
 * staleness -- an anonymous render of any of them is a 403 or a form nobody can submit.
 */
const SWEEP_DENY_PREFIX = [
	'/admin',
	'/user/reset',
	'/node/add',
	'/comment/reply',
	'/system/',
	'/batch',
	'/core/',
	'/update.php',
	'/install.php'
];

/** entity operations, which are authenticated on every site that has not been misconfigured */
const SWEEP_DENY_SUFFIX = ['/edit', '/delete', '/revisions', '/translations'];

/**
 * Characters that mean this is not a page a sweep may name.
 *
 * `?` and `&` are the pager and facet guard and the reason the enumeration reads the router rather
 * than the site's own links: `?page=2` and `?f[0]=` are the URLs a crawl finds and nobody requests.
 * `{` is an unfilled route placeholder, which would queue a path that cannot route.
 */
const SWEEP_REFUSED_CHARS = /[?#&{}*\\]/;

/** Whether a path is worth queueing and safe to render anonymously. */
export function isSweepable(path: string): boolean {
	if (typeof path !== 'string' || !path.startsWith('/')) return false;
	if (SWEEP_REFUSED_CHARS.test(path)) return false;
	if (path.length > 255) return false;
	if (!staleAllowed(path)) return false;
	const denied = SWEEP_DENY_PREFIX.some((p) =>
		p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)
	);
	if (denied) return false;
	return !SWEEP_DENY_SUFFIX.some((s) => path.endsWith(s));
}

/** non-empty segments; `/` is 0, so the front page sorts first among equals */
function pathDepth(path: string): number {
	return path.split('/').filter((s) => s !== '').length;
}

function hasTable(sql: SweepSql, name: string): boolean {
	return (
		sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray()
			.length > 0
	);
}

/** the entity tables a canonical URL can be built from, and the column that dates each one */
const ENTITY_KINDS: Array<{
	source: SweepSource;
	table: string;
	id: string;
	clock: string;
	prefix: string;
	extra: string;
}> = [
	{
		source: 'node',
		table: 'node_field_data',
		id: 'nid',
		clock: 'changed',
		prefix: '/node/',
		extra: ''
	},
	{
		source: 'term',
		table: 'taxonomy_term_field_data',
		id: 'tid',
		clock: 'changed',
		prefix: '/taxonomy/term/',
		extra: ''
	},
	// uid 0 is the anonymous user and has no profile page
	{
		source: 'user',
		table: 'users_field_data',
		id: 'uid',
		clock: 'changed',
		prefix: '/user/',
		extra: 'AND uid > 0'
	}
];

/**
 * Every URL the site can be asked for, from the `router` table plus the entity tables.
 *
 * NEVER from the site's own links. A link crawl walks the pager and facet space, which is unbounded
 * and is exactly the traffic the page cache should be absorbing rather than the sweep generating.
 *
 * A `path_alias` row wins over the system path, because the alias is the URL a visitor requests and
 * the two are separate `cfw_page` rows -- sweeping `/node/12` warms nothing for a visitor asking for
 * `/about`.
 */
export function enumerateAddressable(
	sql: SweepSql,
	opts: { maxPerKind?: number } = {}
): SweepCandidate[] {
	const limit = Math.max(1, Math.floor(opts.maxPerKind ?? SWEEP_MAX_PER_KIND));
	const aliases = new Map<string, string>();
	if (hasTable(sql, 'path_alias')) {
		for (const row of sql
			.exec('SELECT path, alias FROM path_alias WHERE status = 1')
			.toArray()) {
			aliases.set(String(row.path), String(row.alias));
		}
	}

	const out: SweepCandidate[] = [];
	const seen = new Set<string>();
	const add = (systemPath: string, source: SweepSource, changedMs: number) => {
		const path = aliases.get(systemPath) ?? systemPath;
		if (!isSweepable(path) || seen.has(path)) return;
		seen.add(path);
		out.push({ path, source, changedMs, depth: pathDepth(path) });
	};

	if (hasTable(sql, 'router')) {
		// filtered in JS rather than by a LIKE: the router is a few hundred rows, and this platform
		// has a measured ceiling on LIKE patterns that a literal avoids entirely
		for (const row of sql.exec('SELECT path FROM router').toArray()) {
			const path = String(row.path ?? '');
			if (path === '' || path.includes('{')) continue;
			add(path, 'router', 0);
		}
	}

	for (const kind of ENTITY_KINDS) {
		if (!hasTable(sql, kind.table)) continue;
		const rows = sql
			.exec(
				`SELECT ${kind.id} AS id, ${kind.clock} AS clock FROM ${kind.table}
				 WHERE status = 1 AND default_langcode = 1 ${kind.extra}
				 ORDER BY ${kind.clock} DESC LIMIT ?`,
				limit
			)
			.toArray();
		for (const row of rows) {
			// Drupal stores these clocks in SECONDS; a raw value would read as 1970 beside a ms one
			add(`${kind.prefix}${Number(row.id)}`, kind.source, Number(row.clock ?? 0) * 1000);
		}
	}
	return out;
}

/**
 * Orders candidates by what a PARTIAL sweep should have covered when it stops.
 *
 * Observed views first, then entity recency, then depth. Every sweep is partial, so the ordering is
 * the whole of what makes one worth running: a budget spent on the tail of the tail buys nothing.
 *
 * The counts come from the in-memory map the object already keeps on the fast serve lane, which
 * costs zero rows -- the same source `orderByViews()` uses for the R2 mirror. Losing them on
 * eviction leaves the sweep ordered by recency, which is warm rather than wrong.
 */
export function orderCandidates(
	candidates: readonly SweepCandidate[],
	hits: ReadonlyMap<string, number> | null
): SweepCandidate[] {
	const views = (c: SweepCandidate) => hits?.get(c.path) ?? 0;
	return [...candidates].sort(
		(a, b) =>
			views(b) - views(a) ||
			b.changedMs - a.changedMs ||
			a.depth - b.depth ||
			(a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
	);
}

/** what the site already holds, which is both the non-repeat mechanism and the coverage denominator */
export type SweepCovered = { stored: Set<string>; queued: Set<string> };

export function readCovered(sql: SweepSql): SweepCovered {
	const read = (table: string) =>
		hasTable(sql, table)
			? new Set(
					sql
						.exec(`SELECT path FROM ${table}`)
						.toArray()
						.map((r) => String(r.path))
				)
			: new Set<string>();
	return { stored: read('cfw_page'), queued: read('cfw_fill_queue') };
}

/**
 * What is left to sweep.
 *
 * A stored or queued path is dropped, which is what makes a resumed sweep unable to repeat work
 * whatever the ordering did between firings -- an index into a list that re-sorts would both skip
 * and repeat.
 *
 * `isUnstorable` is the terminating observation. `/user/password` renders in 402 ms and Drupal marks
 * it `private, no-store`, so it never reaches `cfw_page` and a coverage filter alone would re-queue
 * it every interval forever. The object already records that verdict; this reads it.
 */
export function pendingCandidates(
	ordered: readonly SweepCandidate[],
	covered: SweepCovered,
	isUnstorable: (path: string) => boolean = () => false
): SweepCandidate[] {
	return ordered.filter(
		(c) => !covered.stored.has(c.path) && !covered.queued.has(c.path) && !isUnstorable(c.path)
	);
}

export type SweepCoverage = {
	addressable: number;
	covered: number;
	pending: number;
	/** 1 when there is nothing addressable, because "no pages" is covered rather than uncovered */
	fraction: number;
};

/** How much of the addressable space has a stored page. The measurable outcome the sweep exists for. */
export function sweepCoverage(
	candidates: readonly SweepCandidate[],
	stored: ReadonlySet<string>
): SweepCoverage {
	const addressable = candidates.length;
	const covered = candidates.filter((c) => stored.has(c.path)).length;
	return {
		addressable,
		covered,
		pending: addressable - covered,
		fraction: addressable === 0 ? 1 : Number((covered / addressable).toFixed(4))
	};
}

/**
 * What queueing `pages` costs, against both daily meters.
 *
 * Three terms with three clocks. The pages are per page; the `setAlarm` row and the alarm invocation
 * are per FIRING, which is what the batch divides; and the cursor is one row per step whatever the
 * batch is. Folding any of them into a per-page constant makes the figure right only at the batch it
 * was derived at.
 */
export function sweepCost(pages: number, batch: number): { rows: number; doRequests: number } {
	const n = Math.max(0, Math.floor(pages));
	if (n === 0) return { rows: 0, doRequests: 0 };
	const firings = Math.ceil(n / Math.max(1, Math.floor(batch)));
	return {
		rows: n * SWEEP_ROWS_PER_PAGE + firings * SWEEP_ROWS_PER_ALARM_ARM + 1,
		doRequests: firings
	};
}

/** the largest page count whose {@link sweepCost} fits a rows budget */
export function pagesWithinRows(budget: number, batch: number): number {
	if (!Number.isFinite(budget) || budget <= 0) return 0;
	let n = Math.floor((budget - 1) / SWEEP_ROWS_PER_PAGE);
	while (n > 0 && sweepCost(n, batch).rows > budget) n--;
	return Math.max(0, n);
}

/** the two daily meters, as the object already keeps them; a limit of 0 means unmetered */
export type SweepMeters = {
	rowsToday: number;
	rowsLimit: number;
	doToday: number;
	doLimit: number;
};

export type SweepCursor = {
	/** the UTC day the spend belongs to; a different one is a fresh budget */
	day: string;
	rowsSpent: number;
	doSpent: number;
	pages: number;
	/** the content generation the walk was planned against; a bump means the tail moved */
	generation: number;
	lastRunMs: number;
	/** true once nothing addressable is left uncovered at this generation */
	done: boolean;
};

export function freshCursor(nowMs: number, generation = 0): SweepCursor {
	return {
		day: utcDayKey(nowMs),
		rowsSpent: 0,
		doSpent: 0,
		pages: 0,
		generation,
		lastRunMs: 0,
		done: false
	};
}

/**
 * Reads the cursor, discarding a record from another UTC day or another generation.
 *
 * The quotas refill at midnight, so carrying yesterday's spend forward would refuse a sweep against
 * a budget that has already been replaced. A generation bump invalidates `done` for the same reason:
 * the addressable space moved.
 */
export function readSweepCursor(sql: SweepSql, nowMs: number, generation = 0): SweepCursor {
	const fresh = freshCursor(nowMs, generation);
	if (!hasTable(sql, 'cfw_meta')) return fresh;
	const row = sql.exec('SELECT v FROM cfw_meta WHERE k = ?', SWEEP_CURSOR_KEY).toArray()[0];
	if (!row) return fresh;
	let held: Partial<SweepCursor>;
	try {
		held = JSON.parse(String(row.v)) as Partial<SweepCursor>;
	} catch {
		return fresh;
	}
	const sameDay = held.day === fresh.day;
	const sameGeneration = Number(held.generation ?? 0) === generation;
	return {
		day: fresh.day,
		rowsSpent: sameDay ? Math.max(0, Number(held.rowsSpent ?? 0)) : 0,
		doSpent: sameDay ? Math.max(0, Number(held.doSpent ?? 0)) : 0,
		pages: sameDay ? Math.max(0, Number(held.pages ?? 0)) : 0,
		generation,
		lastRunMs: Math.max(0, Number(held.lastRunMs ?? 0)),
		done: sameGeneration ? Boolean(held.done) : false
	};
}

export function writeSweepCursor(sql: SweepSql, cursor: SweepCursor): void {
	sql.exec(
		'INSERT INTO cfw_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
		SWEEP_CURSOR_KEY,
		JSON.stringify(cursor)
	);
}

/** which bound stopped the sweep, so an operator knows which number to act on */
export type SweepBound =
	/** a daily meter is already past {@link SWEEP_START_FLOOR} */
	| 'floor'
	/** the sweep's own share of the day is spent; it resumes at 00:00 UTC */
	| 'daily-cap'
	/** the share of what is LEFT, which is what bounds one step rather than the day */
	| 'remaining'
	/** one step queues at most one fill batch */
	| 'batch'
	/** the fill queue still has work, so the sweep yields to it */
	| 'backlog'
	/** everything addressable is stored or queued */
	| 'covered';

export type SweepPlan = {
	ok: boolean;
	pages: number;
	cost: { rows: number; doRequests: number };
	boundBy: SweepBound;
	reason: string;
};

function clampFraction(raw: unknown, fallback: number): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(SWEEP_MAX_FRACTION, Math.max(SWEEP_MIN_FRACTION, n));
}

/**
 * How many pages this step may queue, and why not more.
 *
 * Three bounds, each against a different failure this project has already shipped:
 *
 * - the FLOOR, against a QA day that wrote 104,451 rows and put a site read-only at 104% of quota
 *   with nothing on any admin page saying so. A sweep will not start where the ladder has already
 *   stopped cron.
 * - the DAILY cap, against the sweep pushing the site to the floor by taking a share of a shrinking
 *   remainder forever. The share of what is left bounds one step; this bounds the day.
 * - the BATCH, so `cfw_fill_queue` never grows past what the next firing drains, which is what the
 *   cron branch's `queueDepth() === 0` yield depends on being true.
 *
 * The isolate limit is absent from that list on purpose: this queues rather than renders, so it adds
 * no workload to any invocation and the existing `oversized()` break in the fill batch is what still
 * bounds memory.
 */
export function planSweep(
	pending: readonly SweepCandidate[],
	meters: SweepMeters,
	cursor: SweepCursor,
	opts: { batch: number; rowsFraction?: number; doFraction?: number }
): SweepPlan {
	const batch = Math.max(1, Math.floor(opts.batch));
	const nothing = { rows: 0, doRequests: 0 };
	if (pending.length === 0) {
		return {
			ok: false,
			pages: 0,
			cost: nothing,
			boundBy: 'covered',
			reason: 'every addressable path is stored, queued or proven unstorable'
		};
	}

	const rowsFraction = clampFraction(opts.rowsFraction, SWEEP_ROWS_FRACTION);
	const doFraction = clampFraction(opts.doFraction, SWEEP_DO_FRACTION);
	const metered = meters.rowsLimit > 0 || meters.doLimit > 0;

	if (metered) {
		const rowsAt = meters.rowsLimit > 0 ? meters.rowsToday / meters.rowsLimit : 0;
		const doAt = meters.doLimit > 0 ? meters.doToday / meters.doLimit : 0;
		const worst = Math.max(rowsAt, doAt);
		if (worst >= SWEEP_START_FLOOR) {
			return {
				ok: false,
				pages: 0,
				cost: nothing,
				boundBy: 'floor',
				reason:
					`${rowsAt >= doAt ? 'rows' : 'do'} at ${(worst * 100).toFixed(1)}% of today's quota, ` +
					`at or past the ${(SWEEP_START_FLOOR * 100).toFixed(0)}% floor`
			};
		}
	}

	// the day's share and the step's share of what is LEFT, which are different bounds with
	// different jobs; `rowsToday` already carries this sweep's own spend, so the second shrinks
	const rowsCap =
		meters.rowsLimit > 0
			? Math.floor(meters.rowsLimit * rowsFraction) - cursor.rowsSpent
			: Infinity;
	const rowsLeft =
		meters.rowsLimit > 0
			? Math.floor(Math.max(0, meters.rowsLimit - meters.rowsToday) * rowsFraction)
			: Infinity;
	const doCap =
		meters.doLimit > 0 ? Math.floor(meters.doLimit * doFraction) - cursor.doSpent : Infinity;
	const doLeft =
		meters.doLimit > 0
			? Math.floor(Math.max(0, meters.doLimit - meters.doToday) * doFraction)
			: Infinity;

	const rowsBudget = Math.min(rowsCap, rowsLeft);
	const doBudget = Math.min(doCap, doLeft);
	const byRows = Number.isFinite(rowsBudget) ? pagesWithinRows(rowsBudget, batch) : Infinity;
	const byDo = Number.isFinite(doBudget) ? Math.max(0, doBudget) * batch : Infinity;
	const pages = Math.min(byRows, byDo, batch, pending.length);

	if (pages <= 0) {
		const capped = rowsCap <= rowsLeft && doCap <= doLeft;
		return {
			ok: false,
			pages: 0,
			cost: nothing,
			boundBy: capped ? 'daily-cap' : 'remaining',
			reason: capped
				? `the sweep's ${(rowsFraction * 100).toFixed(0)}% share of today is spent (${cursor.rowsSpent} rows over ${cursor.pages} pages); resumes at 00:00 UTC`
				: `only ${Math.max(0, rowsBudget)} rows of headroom left this step; resumes on the next interval`
		};
	}

	return {
		ok: true,
		pages,
		cost: sweepCost(pages, batch),
		boundBy:
			pages === pending.length
				? 'covered'
				: pages === batch
					? 'batch'
					: rowsCap <= rowsLeft
						? 'daily-cap'
						: 'remaining',
		reason: `queueing ${pages} of ${pending.length} pending paths`
	};
}

/**
 * Queues paths for the existing fill batch, which is the whole of what a sweep does.
 *
 * `DO NOTHING` on a conflict, so a path already queued keeps the timestamp it was queued under and
 * does not jump the drain order. The count returned is what was offered; the caller has already
 * filtered against the queue, so the two agree unless something raced.
 */
export function enqueueSweep(sql: SweepSql, paths: readonly string[], nowMs: number): number {
	let queued = 0;
	for (const path of paths) {
		sql.exec(
			'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING',
			path,
			Math.floor(nowMs)
		);
		queued += 1;
	}
	return queued;
}

/** whether the sweep is switched on; see {@link sweepStep} for why the default is off */
export type SweepEnv = {
	SWEEP?: string | null;
	SWEEP_ROWS_FRACTION?: string | number | null;
};

/**
 * OFF unless asked for, and the reason is a meter rather than caution.
 *
 * The row and DO quotas are ACCOUNT-WIDE while `dailyRows()` counts one object, so the governor
 * cannot see what the rest of the fleet has spent. At 25% of 100,000 rows per site, four sweeping
 * sites saturate the account and each one reads its own meter as healthy. The objective survives the
 * refusal: `src/ops/fleet.ts` is the inventory that would let a fleet-aware share be safe by
 * default, and nothing here forecloses it.
 */
export function sweepEnabled(env?: SweepEnv | null): boolean {
	const raw = env?.SWEEP;
	if (raw === undefined || raw === null || String(raw) === '') return false;
	return String(raw) !== '0';
}

/** the share of the day this site declares for its sweep, clamped to the range its derivation covers */
export function sweepRowsFraction(env?: SweepEnv | null): number {
	return clampFraction(env?.SWEEP_ROWS_FRACTION, SWEEP_ROWS_FRACTION);
}

export type SweepDeps = {
	sql: SweepSql;
	meters: SweepMeters;
	/** the per-path view counts the object keeps in memory; null when it has none yet */
	hits: ReadonlyMap<string, number> | null;
	/** `this.isUnstorable`, so the terminating observation is read rather than re-derived */
	isUnstorable: (path: string) => boolean;
	/** `fillBatchSize(env)`; one step queues at most one batch */
	batch: number;
	generation: number;
	nowMs: number;
	rowsFraction?: number;
	maxPerKind?: number;
};

export type SweepReport = {
	ok: boolean;
	queued: number;
	boundBy: SweepBound;
	reason: string;
	cost: { rows: number; doRequests: number };
	coverage: SweepCoverage;
	cursor: SweepCursor;
};

/** Whether enough time has passed since the last step; `cronDue()`'s never-run rule applies here too. */
export function sweepDue(
	cursor: SweepCursor,
	nowMs: number,
	intervalMs = SWEEP_INTERVAL_MS
): boolean {
	if (cursor.lastRunMs === 0) return true;
	return cronDue(cursor.lastRunMs, nowMs, intervalMs);
}

/**
 * One sweep step: enumerate, order, govern, queue.
 *
 * Writes the cursor only when it queued something. A refused step that recorded its own refusal
 * would be a counter that mostly counts itself, which is how an idle warming tick came to spend
 * 32.4% of free's row budget.
 */
export function sweepStep(deps: SweepDeps): SweepReport {
	const cursor = readSweepCursor(deps.sql, deps.nowMs, deps.generation);
	const covered = readCovered(deps.sql);
	const empty: SweepCoverage = { addressable: 0, covered: 0, pending: 0, fraction: 1 };

	// yields to a fill backlog for the reason cron does: a visitor waiting on a page outranks a page
	// nobody has asked for, and the queue is the only evidence of that available here
	if (covered.queued.size > 0) {
		return {
			ok: false,
			queued: 0,
			boundBy: 'backlog',
			reason: `${covered.queued.size} paths already queued; the sweep yields to the fill batch`,
			cost: { rows: 0, doRequests: 0 },
			coverage: empty,
			cursor
		};
	}

	const candidates = enumerateAddressable(deps.sql, { maxPerKind: deps.maxPerKind });
	const coverage = sweepCoverage(candidates, covered.stored);
	const pending = pendingCandidates(
		orderCandidates(candidates, deps.hits),
		covered,
		deps.isUnstorable
	);
	const plan = planSweep(pending, deps.meters, cursor, {
		batch: deps.batch,
		rowsFraction: deps.rowsFraction
	});

	if (!plan.ok || plan.pages === 0) {
		return {
			ok: false,
			queued: 0,
			boundBy: plan.boundBy,
			reason: plan.reason,
			cost: plan.cost,
			coverage,
			cursor: { ...cursor, done: pending.length === 0 }
		};
	}

	const queued = enqueueSweep(
		deps.sql,
		pending.slice(0, plan.pages).map((c) => c.path),
		deps.nowMs
	);
	const next: SweepCursor = {
		...cursor,
		rowsSpent: cursor.rowsSpent + plan.cost.rows,
		doSpent: cursor.doSpent + plan.cost.doRequests,
		pages: cursor.pages + queued,
		lastRunMs: deps.nowMs,
		done: pending.length === queued
	};
	writeSweepCursor(deps.sql, next);
	return {
		ok: true,
		queued,
		boundBy: plan.boundBy,
		reason: plan.reason,
		cost: plan.cost,
		coverage,
		cursor: next
	};
}
