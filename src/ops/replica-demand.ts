/**
 * When a site should grow itself a replica lane, and how many.
 *
 * A pool only helps a site whose requests QUEUE. A Durable Object runs one request at a time and a
 * PHP render holds it for the whole render, so contention shows up as requests in flight waiting
 * their turn. That is the signal: peak concurrent in-flight requests on the primary.
 *
 * Raising `REPLICA_COUNT` by hand only tells the ROUTER lanes exist. Nothing created them, so the
 * lanes it routes to hold no data and fence-refuse until somebody drives the provisioning loop. This
 * is the missing half -- the site notices it is contended and starts the copy itself.
 */

/** one window's worth of observed contention on the primary */
export type DemandWindow = {
	peakInflight: number;
	at: number;
	/**
	 * requests that WAITED for the gate in this window, and how long, when it was observed.
	 *
	 * Replicas remove QUEUEING, not service time -- that is the fact the replica work established
	 * and the fact `peakInflight` is only a proxy for. A site with 100 req/s of cached traffic
	 * queues nothing and needs no lane; a site with 20 req/s of authenticated renders may need
	 * several. Optional because a window recorded before this existed is still a window, and
	 * {@link laneTarget} falls back to the proxy rather than discarding it.
	 */
	queued?: number;
	/** ms the queued requests waited, summed; a long single wait is not two short ones */
	waitedMs?: number;
};

/** windows that must ALL be contended before a lane is provisioned */
export const SUSTAIN_WINDOWS = 3;

/** how many windows of history are kept; older ones cannot influence a decision */
export const DEMAND_HISTORY = 6;

/**
 * Lanes autoscaling may create on its own, before an operator's `REPLICA_COUNT` is considered.
 *
 * **THE OLD CAP OF 3 WAS STANDING IN FOR A WARMING BUG.** Warming is per OBJECT, so a warmed pool
 * multiplied it and 32 idle lanes would have re-armed every 8 s for 345,600 rows a day serving
 * nothing. `laneIsIdle()` lets a lane nobody routes to hibernate, so an unused lane now costs
 * storage and replication catch-up rather than a warming chain.
 *
 * **Throughput gives no reason to cap.** Measured on deployed workers at 8 / 16 / 32 / 48 replicas:
 * efficiency against perfect scaling is 100 / 95 / 90 / 85%, a flat ~5 points per doubling with no
 * knee, and saturation was checked rather than assumed (N=32 returned 183.2 req/s at 128 offered
 * clients against 183.4 at 64). A linear decline never crosses zero, so there is no payoff point to
 * calculate and any number here would be arbitrary.
 *
 * So this is the ROUTING clamp, and the bound that actually matters is per-lane idle cost --
 * storage plus catch-up -- which is not measured. Lower it with `REPLICA_MAX_LANES` on a site that
 * would rather spend its budget elsewhere; `0` and `REPLICA_AUTOSCALE=0` both switch it off.
 */
export const DEFAULT_MAX_LANES = 32;

export type DemandEnv = {
	REPLICA_AUTOSCALE?: string | null;
	REPLICA_MAX_LANES?: string | null;
	REPLICA_COUNT?: string | null;
};

/** ON unless explicitly `0` */
export function autoScaleEnabled(env?: DemandEnv | null): boolean {
	return String(env?.REPLICA_AUTOSCALE ?? '1') !== '0';
}

/**
 * The ceiling autoscaling will not grow past. `0` turns it off; the default is three.
 *
 * Clamped at 32 because that is where `replicaCount()` clamps, and a cap the router would not honour
 * is a cap that lies. **The MEASURED range is narrower than the clamp**: the scaling curve covers
 * 1 / 2 / 4 / 8 replicas at 1.00 / 2.05 / 3.16 / 5.72x, and it was taken on independent objects with
 * a synthetic burn rather than on a replicating pool. Past 8 nothing is measured, and where the
 * curve stops paying is not established at any size.
 */
export function maxLanes(env?: DemandEnv | null): number {
	// `Number('')` is 0 and finite, so an unset var read as a cap of ZERO and autoscaling never ran
	const text = String(env?.REPLICA_MAX_LANES ?? '').trim();
	if (text === '') return DEFAULT_MAX_LANES;
	const raw = Number(text);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_LANES;
	return Math.min(Math.floor(raw), 32);
}

/**
 * How many lanes the observed demand justifies.
 *
 * Takes the MINIMUM peak across the last {@link SUSTAIN_WINDOWS} windows, so one burst cannot
 * provision a lane that then sits warm forever. A site that sustained 3 concurrent requests through
 * every one of those windows wanted 2 more objects to run them on.
 *
 * Returns 0 when the history is too short to be sustained, which is what a quiet site always sees.
 */
export function laneTarget(windows: readonly DemandWindow[], cap: number): number {
	const ceiling = Math.max(0, Math.floor(cap));
	if (ceiling === 0) return 0;
	if (windows.length < SUSTAIN_WINDOWS) return 0;
	const recent = windows.slice(-SUSTAIN_WINDOWS);

	// QUEUEING FIRST, when the windows carry it. Inflight peak counts requests that were in the
	// object at once, which on a cached site is concurrency a single object serves without anybody
	// waiting -- so it provisions lanes for load that never queued. `queued` counts the requests
	// that actually WAITED, which is the thing a lane removes.
	const measured = recent.every((w) => typeof w?.queued === 'number');
	if (measured) {
		let sustainedQueue = Infinity;
		for (const w of recent) {
			const queued = Number(w.queued);
			if (!Number.isFinite(queued)) return 0;
			sustainedQueue = Math.min(sustainedQueue, queued);
		}
		// a lane per sustained waiter, because that is what each one removes. No `-1` here: unlike
		// inflight, a queue depth of 1 already means somebody waited
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

/**
 * The mean wait a queued request saw, in ms, or null when nothing queued.
 *
 * Reported rather than acted on: a lane removes waiting, and how MUCH waiting it removes is what
 * says whether the lane was worth its idle cost. Acting on it as well would be two policies for one
 * decision.
 */
export function meanWaitMs(windows: readonly DemandWindow[]): number | null {
	let queued = 0;
	let waited = 0;
	for (const w of windows) {
		queued += Number(w?.queued ?? 0);
		waited += Number(w?.waitedMs ?? 0);
	}
	return queued > 0 ? waited / queued : null;
}

/** keeps the history bounded, newest last */
export function recordWindow(windows: readonly DemandWindow[], next: DemandWindow): DemandWindow[] {
	return [...windows, next].slice(-DEMAND_HISTORY);
}

/**
 * The next lane to provision, or null when nothing should be.
 *
 * An operator's explicit `REPLICA_COUNT` is a floor rather than a ceiling: a site told to run 2
 * lanes runs at least 2, and autoscaling may still grow it to `REPLICA_MAX_LANES`. Setting
 * `REPLICA_AUTOSCALE=0` is how an operator pins the number instead.
 */
export function nextLaneToProvision(input: {
	windows: readonly DemandWindow[];
	provisioned: number;
	env?: DemandEnv | null;
}): number | null {
	const have = Math.max(0, Math.floor(input.provisioned));
	if (!autoScaleEnabled(input.env)) return null;
	const target = laneTarget(input.windows, maxLanes(input.env));
	if (target <= have) return null;
	return have + 1;
}
