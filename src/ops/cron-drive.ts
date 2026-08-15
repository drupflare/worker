import {
	cronStep,
	type CronDeps,
	type CronOptions,
	type CronStep,
	type StoredCursor
} from './cron.js';

/**
 * The alarm-side budget for Drupal's own cron, which nothing drives today.
 *
 * The alarm's own comment explains why, and it was right when written: `drupal_cron()` is 187
 * queries and 227-275 ms natively to accomplish little but a watchdog trim, with hooks that reach
 * for sockets this runtime lacks. That justified replacing it with pure SQL. What changed since is
 * that `cronStep()` exists and does NOT run `drupal_cron()` -- it runs ONE hook, or one queue
 * batch, per firing. The objection was to the monolith, and the monolith is no longer the only
 * option.
 *
 * This file is the missing half: how much of that to do per alarm firing. It owns no transport, no
 * alarm and no env, exactly as `cronStep()` and `updbStep()` do, so it is drivable from a spec.
 *
 * **THREE BUDGETS, AND ROWS IS THE ONE THAT BINDS.** A firing stops on whichever comes first:
 *
 *   - `maxUnits`, so a quiet site does not spin through the whole ring every 5 seconds;
 *   - `maxRows`, because rows written is the meter that bounds regeneration and cron spends the
 *     same 100k/day the page fills do -- a cron pass that consumes the fill budget has made the
 *     site slower at the thing it exists to do;
 *   - `maxMs`, a wall-clock guard against a single pathological unit. NOT a CPU figure and never
 *     to be read as one: per RULE 0 an absolute CPU number comes only from `cpuTime` on a deployed
 *     worker, and this is a loop bound, not a measurement.
 *
 * **AT MOST ONE PHP UNIT PER FIRING, and that falls out of `cronStep` rather than being imposed
 * here.** `mayContinue` is true only for a SQL unit or a skip, so the loop below stops the moment
 * a unit actually enters the interpreter. That is what keeps cron from holding the isolate while a
 * visitor waits behind it.
 */

/** what a firing is allowed to spend */
export interface CronBudget {
	/** units per firing; a unit is one hook, one queue batch, or one SQL pass */
	maxUnits: number;
	/** rows written per firing, checked AFTER each unit rather than predicted before it */
	maxRows: number;
	/** wall-clock bound on the loop; a guard, not a measurement */
	maxMs: number;
}

/**
 * Deliberately small.
 *
 * Six units covers the SQL passes and leaves room for one PHP unit on most firings. 500 rows is
 * under 0.5% of the free daily budget, so a cron that ran every alarm all day could not consume
 * the regeneration ceiling by itself.
 */
export const DEFAULT_CRON_BUDGET: CronBudget = { maxUnits: 6, maxRows: 500, maxMs: 500 };

/**
 * Minimum gap between cron firings, and the reason cron can default to on.
 *
 * WITHOUT IT THE BUDGET IS NOT A BUDGET. The alarm is not a clock -- it re-arms at +1 ms while a
 * fill queue is draining -- so "once per alarm" during an active fill is once per page, each one
 * costing an interpreter unit and up to `maxRows` writes. The per-firing budget bounds a firing; it
 * says nothing about how many firings there are, and rows written is the meter that binds
 * regeneration.
 *
 * 15 minutes puts the worst case at 96 firings/day, so even a site that hit `maxRows` every single
 * time spends 48,000 of the 100,000 daily rows -- and a quiet ring writes nothing at all. Drupal's
 * own `automated_cron` default is 3 hours, which is far too coarse for Scheduler.
 */
export const DEFAULT_CRON_INTERVAL_MS = 15 * 60 * 1000;

/** the gap a site actually uses */
export function cronIntervalMs(env?: CronDriveEnv | null): number {
	const n = Number(env?.CRON_INTERVAL_MS);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CRON_INTERVAL_MS;
}

/**
 * Whether enough time has passed since the last firing.
 *
 * @param lastRunMs when cron last ran, or null if it never has. NEVER RUN IS NOT DUE: the first
 *   alarm on a fresh site is the busiest one it will ever have -- migration, the first fills, the
 *   first render -- and adding an interpreter unit to it buys nothing, because a site with no
 *   content has nothing to schedule, index or expire. The caller stamps the clock instead, so the
 *   first pass lands one interval after boot.
 */
export function cronDue(lastRunMs: number | null, nowMs: number, intervalMs: number): boolean {
	if (lastRunMs === null || !Number.isFinite(lastRunMs)) return false;
	// a clock that moved backwards must not lock cron out until it catches up
	if (nowMs < lastRunMs) return true;
	return nowMs - lastRunMs >= intervalMs;
}

export interface CronDriveEnv {
	/** on by default; `0` turns it off for a site that wants nothing running in the background */
	DRUPAL_CRON?: string | number | null;
	/** minimum gap between cron firings; see {@link DEFAULT_CRON_INTERVAL_MS} */
	CRON_INTERVAL_MS?: string | number | null;
	CRON_MAX_UNITS?: string | number | null;
	CRON_MAX_ROWS?: string | number | null;
	CRON_MAX_MS?: string | number | null;
}

const num = (value: unknown, fallback: number): number => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Whether Drupal cron runs on this site. Absent means YES.
 *
 * It defaulted to no, and that is why six of the twenty-five surveyed contrib modules were
 * classified `needs-cron`: the capability was built and wired into the alarm, and nothing turned it
 * on. A module that depends on cron does not fail when cron never runs, it silently does nothing,
 * which is the worst of the available failure modes.
 */
export function drupalCronEnabled(env?: CronDriveEnv | null): boolean {
	const raw = env?.DRUPAL_CRON;
	if (raw === undefined || raw === null || raw === '') return true;
	return !(raw === '0' || raw === 0 || raw === 'false');
}

export function cronBudget(env?: CronDriveEnv | null): CronBudget {
	return {
		maxUnits: num(env?.CRON_MAX_UNITS, DEFAULT_CRON_BUDGET.maxUnits),
		maxRows: num(env?.CRON_MAX_ROWS, DEFAULT_CRON_BUDGET.maxRows),
		maxMs: num(env?.CRON_MAX_MS, DEFAULT_CRON_BUDGET.maxMs)
	};
}

export interface CronDriveResult {
	/** units actually run this firing */
	units: number;
	rowsWritten: number;
	/** the cursor to persist; the caller owns storage */
	cursor: StoredCursor;
	/** whether the ring has more to do, so the caller can re-arm */
	more: boolean;
	/** which budget ended the firing, or `ring` when the round simply finished */
	stoppedBy: 'units' | 'rows' | 'ms' | 'php' | 'ring';
	/** every unit id run, in order, for the audit trail an operator reads */
	ran: string[];
	/** the last step's raw result, so a failure is visible rather than swallowed */
	last: CronStep | null;
}

/**
 * Runs cron units until a budget is spent.
 *
 * Never throws: a cron failure must not take down an alarm that also drains the fill queue, the
 * HTTP queue and the R2 mirror. A thrown unit ends the firing with `stoppedBy: 'php'` and the
 * cursor already advanced past it, so one poisonous hook cannot wedge the ring forever.
 */
export async function driveCron(
	rawCursor: unknown,
	deps: CronDeps,
	options: CronOptions = {},
	budget: CronBudget = DEFAULT_CRON_BUDGET,
	nowMs: () => number = Date.now
): Promise<CronDriveResult> {
	const startedAt = nowMs();
	let cursor: unknown = rawCursor;
	let units = 0;
	let rowsWritten = 0;
	let more = true;
	let last: CronStep | null = null;
	const ran: string[] = [];

	for (;;) {
		if (units >= budget.maxUnits) return done('units');
		if (rowsWritten >= budget.maxRows) return done('rows');
		if (nowMs() - startedAt >= budget.maxMs) return done('ms');

		let step: CronStep;
		try {
			step = await cronStep(cursor as never, deps, options);
		} catch (e) {
			// the cursor is NOT advanced here, because `cronStep` throwing means it never returned
			// one. The caller persists what it has, and the next firing retries the same unit --
			// which is correct for a transient failure and visible for a permanent one
			return {
				units,
				rowsWritten,
				cursor: cursor as StoredCursor,
				more: true,
				stoppedBy: 'php',
				ran: [...ran, `error:${String((e as Error)?.message ?? e).slice(0, 80)}`],
				last
			};
		}

		units++;
		rowsWritten += step.rowsWritten;
		cursor = step.cursor;
		more = step.more;
		last = step;
		ran.push(step.unit);

		// a unit that entered the interpreter ends the firing: it already holds the isolate, and
		// the next thing waiting is a visitor
		if (!step.mayContinue) return done('php');
		if (!step.more) return done('ring');
	}

	function done(stoppedBy: CronDriveResult['stoppedBy']): CronDriveResult {
		return { units, rowsWritten, cursor: cursor as StoredCursor, more, stoppedBy, ran, last };
	}
}
