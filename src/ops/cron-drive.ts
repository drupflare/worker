/**
 * The alarm-side budget for Drupal's own cron: how much of `cronStep()` to run per firing.
 *
 * Owns no transport, alarm or env, so a spec can drive it. A firing stops at the first of
 * `maxUnits`, `maxRows` (rows written is the meter that binds regeneration) and `maxMs`
 * (a wall-clock loop bound, not a CPU figure). At most one PHP unit runs per firing: `mayContinue`
 * is true only for a SQL unit or a skip, so cron never holds the isolate while a visitor waits.
 * @module
 */
import { errorMessage } from '../util/errors';
import {
	cronStep,
	type CronDeps,
	type CronOptions,
	type CronStep,
	type StoredCursor
} from './cron';

/** what a firing is allowed to spend */
export interface CronBudget {
	/** units per firing; a unit is one hook, one queue batch, or one SQL pass */
	maxUnits: number;
	/** rows written per firing, checked after each unit rather than predicted before it */
	maxRows: number;
	/** wall-clock bound on the loop; a guard, not a measurement */
	maxMs: number;
}

/**
 * Six units covers the SQL passes with room for one PHP unit; 500 rows is under 0.5% of the free
 * daily budget.
 */
export const DEFAULT_CRON_BUDGET: CronBudget = { maxUnits: 6, maxRows: 500, maxMs: 500 };

/**
 * Minimum gap between cron firings; without it the per-firing budget bounds nothing.
 *
 * The alarm re-arms at +1 ms while a fill drains, so "once per alarm" is once per page. 15 minutes
 * caps the worst case at 96 firings/day: 48,000 of the 100,000 daily rows if all hit `maxRows`.
 */
export const DEFAULT_CRON_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long after a claim cron first becomes due.
 *
 * `/firstrun` backdates `cronLastRunMs` by `DEFAULT_CRON_INTERVAL_MS - CRON_CLAIM_GRACE_MS`. Not
 * zero: the alarm right after a claim is the busiest the site will have (migration, fills, render).
 */
export const CRON_CLAIM_GRACE_MS = 60 * 1000;

/** the gap a site actually uses */
export function cronIntervalMs(env?: CronDriveEnv): number {
	const n = Number(env?.CRON_INTERVAL_MS);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CRON_INTERVAL_MS;
}

/**
 * Whether enough time has passed since the last firing.
 *
 * @param lastRunMs when cron last ran; undefined (never run) is not due, and the caller stamps the
 *   clock instead so the first pass lands one interval after boot.
 */
export function cronDue(lastRunMs: number | undefined, nowMs: number, intervalMs: number): boolean {
	if (lastRunMs === undefined || !Number.isFinite(lastRunMs)) return false;
	// a clock that moved backwards must not lock cron out until it catches up
	if (nowMs < lastRunMs) return true;
	return nowMs - lastRunMs >= intervalMs;
}

/** the levers cron reads from the environment */
export interface CronDriveEnv {
	/** on by default; `0` turns it off for a site that wants nothing running in the background */
	DRUPAL_CRON?: string | number;
	/** minimum gap between cron firings; see {@link DEFAULT_CRON_INTERVAL_MS} */
	CRON_INTERVAL_MS?: string | number;
	/** overrides `maxUnits` */
	CRON_MAX_UNITS?: string | number;
	/** overrides `maxRows` */
	CRON_MAX_ROWS?: string | number;
	/** overrides `maxMs` */
	CRON_MAX_MS?: string | number;
}

const num = (value: unknown, fallback: number): number => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** whether Drupal cron runs on this site; absent means yes (modules that need it fail silently) */
export function drupalCronEnabled(env?: CronDriveEnv): boolean {
	const raw = env?.DRUPAL_CRON;
	if (raw === undefined || raw === '') return true;
	return !(raw === '0' || raw === 0 || raw === 'false');
}

/** the budget a site uses: `DEFAULT_CRON_BUDGET` with the `CRON_MAX_*` levers applied */
export function cronBudget(env?: CronDriveEnv): CronBudget {
	return {
		maxUnits: num(env?.CRON_MAX_UNITS, DEFAULT_CRON_BUDGET.maxUnits),
		maxRows: num(env?.CRON_MAX_ROWS, DEFAULT_CRON_BUDGET.maxRows),
		maxMs: num(env?.CRON_MAX_MS, DEFAULT_CRON_BUDGET.maxMs)
	};
}

/** what one cron firing did and where the caller resumes */
export interface CronDriveResult {
	/** units actually run this firing */
	units: number;
	/** rows written across the units */
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
 * Runs cron units until a budget is spent; never throws (the alarm also drains fills and mirrors).
 * A thrown unit ends the firing with `stoppedBy: 'php'` and the cursor not advanced.
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
			// no new cursor exists when `cronStep` throws, so the next firing retries the same unit
			return {
				units,
				rowsWritten,
				cursor: cursor as StoredCursor,
				more: true,
				stoppedBy: 'php',
				ran: [...ran, `error:${errorMessage(e).slice(0, 80)}`],
				last
			};
		}

		units++;
		rowsWritten += step.rowsWritten;
		cursor = step.cursor;
		more = step.more;
		last = step;
		ran.push(step.unit);

		// a unit that entered the interpreter ends the firing (a visitor may be waiting)
		if (!step.mayContinue) return done('php');
		if (!step.more) return done('ring');
	}

	function done(stoppedBy: CronDriveResult['stoppedBy']): CronDriveResult {
		return { units, rowsWritten, cursor: cursor as StoredCursor, more, stoppedBy, ran, last };
	}
}
