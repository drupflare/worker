/** one fixture as the daily planner sees it */
export type Candidate = {
	id: string;
	/** the date of its latest run, `YYYY-MM-DD`; absent when it has never run */
	lastRun?: string;
	/** whether that run passed every row; a first failure is retried first */
	lastPassed?: boolean;
	/** how many of its newest runs in a row failed; a repeated failure rotates like any other */
	failedRuns?: number;
	/** the rows one deployed run is expected to write */
	cost: number;
};

/** days the whole pool is covered within, unless the workflow input says otherwise */
export const WINDOW_DAYS = 7;

/** how many fixtures a day certifies for a pool of `n`: at least two, and the window covers the pool */
export const runsPerDay = (n: number, windowDays = WINDOW_DAYS): number =>
	Math.max(2, Math.ceil(n / windowDays));

/** days until every fixture in a pool of `n` has run once, never more than the window */
export const rotationPeriodDays = (n: number, windowDays = WINDOW_DAYS): number =>
	n <= 0 ? 0 : Math.min(windowDays, n / runsPerDay(n, windowDays));

/** days with no passing run after which a Certified fixture drops to Deployed */
export const staleDays = (windowDays = WINDOW_DAYS): number => 2 * windowDays;

/** what one day's plan decided, and whether the budget cut it below the pool's cap */
export type DayPlan = { ids: string[]; cap: number; loweredByBudget: boolean };

/**
 * The fixtures one day's run certifies: one that failed once first so it is retried the next day,
 * then one never run, then the least recently run, up to `runsPerDay` of the pool. A fixture that
 * failed twice in a row is a defect and not a blip, so it goes back to rotating by its last run and
 * cannot hold a slot every day. The row budget can lower the count, and the plan then says so; the
 * first pick is always taken so nothing starves.
 */
export function planDay(
	candidates: readonly Candidate[],
	budget: number,
	windowDays = WINDOW_DAYS
): DayPlan {
	const cap = Math.min(runsPerDay(candidates.length, windowDays), candidates.length);
	const retry = (c: Candidate) => c.lastPassed === false && (c.failedRuns ?? 1) <= 1;
	const rank = (c: Candidate) => (c.lastRun === undefined ? 1 : retry(c) ? 0 : 2);
	const order = [...candidates].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			Date.parse(a.lastRun ?? '1970-01-01') - Date.parse(b.lastRun ?? '1970-01-01') ||
			a.id.localeCompare(b.id)
	);
	const ids: string[] = [];
	let spent = 0;
	for (const c of order) {
		if (ids.length >= cap) break;
		if (ids.length > 0 && spent + c.cost > budget) continue;
		ids.push(c.id);
		spent += c.cost;
	}
	return { ids, cap, loweredByBudget: ids.length < cap };
}

/** what sizes a day: the free row bound, the share held back, and what one run is expected to write */
export type RotationConfig = {
	rowsPerDay: number;
	reserve: number;
	margin: number;
	baseRows: number;
	defaultDelivery: number;
	delivery: Record<string, number>;
};

/** the rows a day's certification may spend, after the reserve */
export const dayBudget = (cfg: RotationConfig): number => cfg.rowsPerDay * (1 - cfg.reserve);

/** the rows one deployed run of a fixture is expected to write, with the safety margin */
export const runCost = (cfg: RotationConfig, id: string): number =>
	Math.ceil((cfg.baseRows + (cfg.delivery[id] ?? cfg.defaultDelivery)) * cfg.margin);
