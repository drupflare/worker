/**
 * Decides when a site grows itself a replica lane; a pool only helps requests that queue.
 * @module
 */

/** one window's worth of observed contention on the primary */
export type DemandWindow = {
	peakInflight: number;
	at: number;
	/**
	 * Requests that waited for the gate in this window.
	 * Replicas remove queueing, not service time; `peakInflight` is only a proxy, used when absent.
	 */
	queued?: number;
	/** ms the queued requests waited, summed; a long single wait is not two short ones */
	waitedMs?: number;
};

/** windows that must all be contended before a lane is provisioned */
export const SUSTAIN_WINDOWS = 3;

/** how many windows of history are kept; older ones cannot influence a decision */
export const DEMAND_HISTORY = 6;

/**
 * Lanes autoscaling may create on its own, before an operator's `REPLICA_COUNT` is considered.
 * No throughput knee (efficiency 100/95/90/85% at 8/16/32/48), so this only clamps routing.
 */
export const DEFAULT_MAX_LANES = 32;

/** the replica vars autoscaling reads */
export type DemandEnv = {
	REPLICA_AUTOSCALE?: string;
	REPLICA_MAX_LANES?: string;
	REPLICA_COUNT?: string;
};

/** on unless `0` */
export function autoScaleEnabled(env?: DemandEnv): boolean {
	return String(env?.REPLICA_AUTOSCALE ?? '1') !== '0';
}

/**
 * The ceiling autoscaling will not grow past, clamped at 32 like `replicaCount()`; `0` is off.
 * A lane costs N+1 rows per change and sizing ignores the write rate, so bound it by hand.
 */
export function maxLanes(env?: DemandEnv): number {
	// `Number('')` is 0 and finite, so an unset var read as a cap of zero and autoscaling never ran
	const text = String(env?.REPLICA_MAX_LANES ?? '').trim();
	if (text === '') return DEFAULT_MAX_LANES;
	const raw = Number(text);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_LANES;
	return Math.min(Math.floor(raw), 32);
}

/**
 * How many lanes the observed demand justifies: the minimum over the last {@link SUSTAIN_WINDOWS}.
 * Returns 0 on short history; no floor of two, since one lane only loses below saturation.
 */
export function laneTarget(windows: readonly DemandWindow[], cap: number): number {
	const ceiling = Math.max(0, Math.floor(cap));
	if (ceiling === 0) return 0;
	if (windows.length < SUSTAIN_WINDOWS) return 0;
	const recent = windows.slice(-SUSTAIN_WINDOWS);

	// queueing first: inflight peak counts cached concurrency nobody waited on
	const measured = recent.every((w) => typeof w?.queued === 'number');
	if (measured) {
		let sustainedQueue = Infinity;
		for (const w of recent) {
			const queued = Number(w.queued);
			if (!Number.isFinite(queued)) return 0;
			sustainedQueue = Math.min(sustainedQueue, queued);
		}
		// a lane per sustained waiter (no `-1`: a queue depth of 1 already means somebody waited)
		return Math.max(0, Math.min(ceiling, Math.floor(sustainedQueue)));
	}

	let sustained = Infinity;
	for (const w of recent) {
		const peak = Number(w?.peakInflight);
		if (!Number.isFinite(peak)) return 0;
		sustained = Math.min(sustained, peak);
	}
	// one request in flight is the uncontended case and needs no lane
	return Math.max(0, Math.min(ceiling, Math.floor(sustained) - 1));
}

/** the mean wait a queued request saw, in ms, or undefined when nothing queued; reported only */
export function meanWaitMs(windows: readonly DemandWindow[]): number | undefined {
	let queued = 0;
	let waited = 0;
	for (const w of windows) {
		queued += Number(w?.queued ?? 0);
		waited += Number(w?.waitedMs ?? 0);
	}
	return queued > 0 ? waited / queued : undefined;
}

/** keeps the history bounded, newest last */
export function recordWindow(windows: readonly DemandWindow[], next: DemandWindow): DemandWindow[] {
	return [...windows, next].slice(-DEMAND_HISTORY);
}

/**
 * The next lane to provision, or undefined when nothing should be.
 * An explicit `REPLICA_COUNT` is a floor; `REPLICA_AUTOSCALE=0` pins the number instead.
 */
export function nextLaneToProvision(input: {
	windows: readonly DemandWindow[];
	provisioned: number;
	env?: DemandEnv;
	rows?: RowBudget;
}): number | undefined {
	const have = Math.max(0, Math.floor(input.provisioned));
	if (!autoScaleEnabled(input.env)) return undefined;
	const target = laneTarget(input.windows, maxLanes(input.env));
	if (target <= have) return undefined;
	if (input.rows && !laneFitsRows(input.rows, have + 1)) return undefined;
	return have + 1;
}

/** the day's rows against the plan's daily cap; `limit` 0 means no cap */
export type RowBudget = {
	/** every row the primary has written today, one-off provisioning included */
	today: number;
	/** the rows the primary has sealed for replication today, which each lane writes again */
	replicatedToday: number;
	limit: number;
	/** how much of the UTC day has passed, 0..1 */
	dayFraction: number;
};

/**
 * Whether `lanes` lanes keep the day under the reduce fraction; each rewrites every replicated row.
 * Only the replicated stream is projected, over at least an hour so a midnight burst is no day.
 */
export function laneFitsRows(budget: RowBudget, lanes: number, reduceAt = 0.8): boolean {
	if (!(budget.limit > 0)) return true;
	const elapsed = Math.max(budget.dayFraction, 1 / 24);
	const perLane = Math.max(0, budget.replicatedToday) / elapsed;
	return Math.max(0, budget.today) + lanes * perLane <= budget.limit * reduceAt;
}
