/**
 * The addressable sweep: pre-renders the site's tail on a declared budget, not on a visitor.
 * It only queues `cfw_fill_queue` rows; the alarm fill batch drains them under `oversized()`.
 * @module
 */
import { firstRow } from '../util/sql';
import { DEFAULT_AUTH_ROWS_FRACTION, utcDayKey } from './auth-budget';
import { cronDue } from './cron-drive';
import { REDUCE_AT } from './degrade';
import { staleAllowed } from './page-store';

/** the reads and writes a sweep needs, narrowed so it is drivable over a stand-in */
export interface SweepSql {
	exec(sql: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** where a candidate came from, so a coverage report can say what class is uncovered */
export type SweepSource = 'router' | 'node' | 'term' | 'user';

/** one URL a sweep may queue */
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
 * Rows one swept page charges the fill chain (`ROWS_PER_FILL.firstEverForPath` in the envelope
 * script). Copied: importing that script drags its `process.argv` block into the bundle.
 */
export const SWEEP_ROWS_PER_FILL = 14;

/** the queue insert and delete rows the audit arm never charged (it calls `fillOne()` directly) */
export const SWEEP_QUEUE_ROWS = 2;

/** rows one swept page costs, fill plus queue */
export const SWEEP_ROWS_PER_PAGE = SWEEP_ROWS_PER_FILL + SWEEP_QUEUE_ROWS;

/** `FREE_QUOTAS.rowsPerAlarmArm`, measured and pinned by `warm-alarm-cost.spec.ts` */
export const SWEEP_ROWS_PER_ALARM_ARM = 1;

/**
 * The fraction of either daily meter at which a sweep refuses to start.
 * `REDUCE_AT`, where the quota ladder already stops cron, the queue and image regeneration.
 */
export const SWEEP_START_FLOOR = REDUCE_AT;

/**
 * What share of the day's rows a sweep may spend: the default 25% split, which leaves demand
 * fills 5.5x the need at 3,000,000 visits a month (`free-envelope.ts`; the spec recomputes it).
 */
export const SWEEP_ROWS_FRACTION = DEFAULT_AUTH_ROWS_FRACTION;

/** the same share of the DO-request meter; the two quotas are equal, so one fraction fits both */
export const SWEEP_DO_FRACTION = DEFAULT_AUTH_ROWS_FRACTION;

/** below this a sweep never finishes a page; keeps a bad var from disabling it silently */
export const SWEEP_MIN_FRACTION = 0.01;

/**
 * The largest share an operator may declare; at 0.5 demand fills still get ~3.1x the
 * 1,000-a-day need, past that a sweep competes with visitors for the meter.
 */
export const SWEEP_MAX_FRACTION = 0.5;

/**
 * How often a sweep step may run: 25% of 100,000 rows is 1,562 pages a day, so 48 steps of one
 * 50-page batch cover it, at under 10% of free's 5,000,000 daily reads for enumeration.
 */
export const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** entity rows one enumeration reads per kind, about three days of sweeping at 1,562 pages a day */
export const SWEEP_MAX_PER_KIND = 5_000;

/** the `cfw_meta` key the cursor lives under */
export const SWEEP_CURSOR_KEY = 'sweep_cursor';

// #endregion

/** paths a sweep refuses beyond `staleAllowed()` (anonymous renders are a 403 or a dead form) */
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

/** characters that mean a path is not nameable: pager and facet queries, unfilled `{` routes */
const SWEEP_REFUSED_CHARS = /[?#&{}*\\]/;

/** whether a path is worth queueing and safe to render anonymously */
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

/** whether `name` exists as a table */
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
 * Every URL the site can be asked for, from the router and entity tables, never its links (a
 * crawl walks the pager space). A `path_alias` wins: alias and system path are separate pages.
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
		// filtered in JS, not `LIKE` (platform pattern ceiling; the router is a few hundred rows)
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
			// Drupal stores these clocks in seconds
			add(`${kind.prefix}${Number(row.id)}`, kind.source, Number(row.clock ?? 0) * 1000);
		}
	}
	return out;
}

/**
 * Orders candidates by what a partial sweep should have covered: views, then recency, then depth.
 * Views come from the in-memory map on the fast serve lane (zero rows); losing it leaves recency.
 */
export function orderCandidates(
	candidates: readonly SweepCandidate[],
	hits: ReadonlyMap<string, number> | undefined
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

/** the paths the site already holds stored or queued; also the coverage denominator */
export type SweepCovered = { stored: Set<string>; queued: Set<string> };

/** reads the stored and queued path sets */
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
 * What is left to sweep (stored and queued paths dropped, so a resume cannot repeat work).
 * `isUnstorable` terminates retries: a `no-store` page never reaches `cfw_page` and would requeue.
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

/** how much of the addressable space has a stored page */
export type SweepCoverage = {
	addressable: number;
	covered: number;
	pending: number;
	/** 1 when nothing is addressable (no pages counts as covered) */
	fraction: number;
};

/** the coverage of `candidates` by `stored` pages; the outcome the sweep exists to move */
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
 * What queueing `pages` costs against both daily meters: per page, per firing (the `setAlarm` row
 * and invocation, divided by the batch) and one cursor row per step. Keep the terms separate.
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

/** the persisted spend and progress of the sweep */
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

/** a zeroed cursor for today at `generation` */
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
 * Reads the cursor, discarding spend from another UTC day (quotas refill at midnight) and `done`
 * from another generation (the addressable space moved).
 */
export function readSweepCursor(sql: SweepSql, nowMs: number, generation = 0): SweepCursor {
	const fresh = freshCursor(nowMs, generation);
	if (!hasTable(sql, 'cfw_meta')) return fresh;
	const row = firstRow(sql.exec('SELECT v FROM cfw_meta WHERE k = ?', SWEEP_CURSOR_KEY));
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

/** upserts the cursor into `cfw_meta` */
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

/** the verdict of one `planSweep()` call */
export type SweepPlan = {
	ok: boolean;
	pages: number;
	cost: { rows: number; doRequests: number };
	boundBy: SweepBound;
	reason: string;
};

/** clamps a declared share into the derived range, or returns `fallback` when unusable */
function clampFraction(raw: unknown, fallback: number): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(SWEEP_MAX_FRACTION, Math.max(SWEEP_MIN_FRACTION, n));
}

/**
 * How many pages this step may queue and which bound stopped more: the floor, the daily cap and
 * the batch (so the queue never outgrows one firing; cron yields on `queueDepth() === 0`).
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

	// the day's share and the step's share of what is left are different bounds
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
 * Queues paths for the fill batch; a conflict does nothing so a queued path keeps its drain order.
 * Returns the count offered, which equals the count queued unless something raced.
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

/** the vars that switch the sweep and size its share */
export type SweepEnv = {
	SWEEP?: string;
	SWEEP_ROWS_FRACTION?: string | number;
};

/**
 * On by default at a fleet-safe share (`SWEEP=0` turns it off): quotas are account-wide but
 * `dailyRows()` counts one object, so an unasked sweep takes only `UNASKED_ROWS_FRACTION`.
 * Defaulted on because an unvisited path cannot render competitively (474 ms deployed against a
 * VPS's 78 ms) and a swept one is a ~1 ms HIT.
 */
export function sweepEnabled(env?: SweepEnv): boolean {
	const raw = env?.SWEEP;
	if (raw === undefined || String(raw) === '') return true;
	return String(raw) !== '0';
}

/** whether this site's sweep runs on the default rather than on an operator's request */
export function sweepUnasked(env?: SweepEnv): boolean {
	const raw = env?.SWEEP;
	return raw === undefined || String(raw) === '';
}

/**
 * The share an unasked sweep may spend, against 0.25 for one an operator turned on.
 * 0.05 is ~555 pages a day per site, enough for an ordinary site without a fleet inventory.
 */
export const UNASKED_ROWS_FRACTION = 0.05;

/**
 * The day's share this site declares for its sweep, clamped to its derived range.
 * An explicit `SWEEP_ROWS_FRACTION` wins; otherwise 25% when asked, `UNASKED_ROWS_FRACTION` if not.
 */
export function sweepRowsFraction(env?: SweepEnv): number {
	const fallback = sweepUnasked(env) ? UNASKED_ROWS_FRACTION : SWEEP_ROWS_FRACTION;
	return clampFraction(env?.SWEEP_ROWS_FRACTION, fallback);
}

/** what `sweepStep()` reads from the object */
export type SweepDeps = {
	sql: SweepSql;
	meters: SweepMeters;
	/** the per-path view counts the object keeps in memory; undefined when it has none yet */
	hits: ReadonlyMap<string, number> | undefined;
	/** `this.isUnstorable`, so the terminating observation is read rather than re-derived */
	isUnstorable: (path: string) => boolean;
	/** `fillBatchSize(env)`; one step queues at most one batch */
	batch: number;
	generation: number;
	nowMs: number;
	rowsFraction?: number;
	maxPerKind?: number;
};

/** what `sweepStep()` did and why */
export type SweepReport = {
	ok: boolean;
	queued: number;
	boundBy: SweepBound;
	reason: string;
	cost: { rows: number; doRequests: number };
	coverage: SweepCoverage;
	cursor: SweepCursor;
};

/** whether enough time has passed since the last step; a never-run cursor is always due */
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
 * Writes the cursor only when it queued, so a refusal never spends rows recording itself.
 */
export function sweepStep(deps: SweepDeps): SweepReport {
	const cursor = readSweepCursor(deps.sql, deps.nowMs, deps.generation);
	const covered = readCovered(deps.sql);
	const empty: SweepCoverage = { addressable: 0, covered: 0, pending: 0, fraction: 1 };

	// yields to a fill backlog like cron: a waiting visitor outranks a page nobody asked for
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
