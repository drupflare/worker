/**
 * Whether to keep an object resident, decided from arrivals rather than from a constant.
 *
 * Warm when `P(next render within T) x C_cold > C_warm`, with arrivals modelled as a Poisson
 * process (`P = 1 - exp(-r x T)`). That is an assumption, not a measurement; bursty traffic errs
 * toward warming a site that would have idled, as the flat 8 s interval does unconditionally.
 * The warming band runs from about 505 renders/day (below it the alarms cost more than the boots
 * they save) to about 8,640 (above it the site never idles). This module solves only below the
 * 10 s hibernation threshold.
 * @module
 */

/** what one arrival window records; `at` is ms and the ring is bounded by the caller */
export type Arrival = { at: number; rendered: boolean };

/** how far back a rate estimate looks, in ms */
export const RATE_WINDOW_MS = 900_000;

/** arrivals kept; a ring rather than a table, so this costs no rows */
export const ARRIVAL_RING = 64;

/**
 * What a cold boot costs, in ms of billed wall clock.
 *
 * Measured on a deployed worker: 1,398 ms for the interpreter, mount and kernel; the only reason
 * to pay for a firing.
 */
export const COLD_BOOT_MS = 1398;

/**
 * How long an authenticated request keeps the object warm on its own, in ms.
 *
 * Thirty minutes: long enough that a pause to read a page does not drop the object; longer pays
 * for sessions that ended.
 */
export const AUTH_WARM_WINDOW_MS = 1_800_000;

/**
 * What one warming firing costs, in the same units as `COLD_BOOT_MS`.
 *
 * Not a duration (an idle object waiting on an alarm is not billed for duration); a firing spends a
 * request and a row. Derived from the measured ~505 renders/day crossing: `P(render within 10 s)`
 * there is 0.05678, and break-even `P x COLD_BOOT_MS = C_warm` gives 79.
 */
export const WARM_FIRING_COST_MS = 79;

/** the crossing the constant above reproduces, kept so the derivation is checkable */
export const BREAK_EVEN_RENDERS_PER_DAY = 505;

/**
 * The re-arm measured to hold an object resident, and the one to retreat to.
 *
 * One incarnation survived 71 consecutive firings at 8,000 ms and 12,000 lost the isolate on every
 * probe; nothing between was driven, so this is the largest interval with evidence, not the
 * largest that works.
 */
export const WARM_INTERVAL_VERIFIED_MS = 8_000;

/**
 * The margin below the hibernation threshold; the one free parameter in the model.
 *
 * Any interval under the threshold prevents every cold boot equally, so the optimum is the largest
 * safe one (9,500 fires 9,094 times a day against 10,800). How late an alarm may fire is
 * unmeasured, so 9,500 is a ceiling {@link solveWarmInterval} climbs toward, not a default.
 */
export const WARM_MARGIN_MIN_MS = 500;

/**
 * The hibernation threshold this module solves against, mirroring `HIBERNATION_IDLE_MS`.
 *
 * Restated, not imported, to keep `cron.ts` and the PHP fragments out of a thermal spec's import
 * graph; pinned against the original in `tests/unit/ops/cron-step.spec.ts`.
 */
export const HIBERNATION_ASSUMED_MS = 10_000;

/** one probe step, which is 1.5 hours from the verified interval to the ceiling */
export const WARM_INTERVAL_STEP_MS = 500;

/** clean windows before a climb; two, so one lucky window cannot move the interval */
export const WARM_CLEAN_WINDOWS = 2;

/** what a window carries before anything has been solved */
const ZERO_SOLVED = { intervalMs: WARM_INTERVAL_VERIFIED_MS, clean: 0 };

/** the feasible band, which a stored value is forced back into on every read */
export function clampWarmInterval(ms: number, thresholdMs = HIBERNATION_ASSUMED_MS): number {
	const ceiling = Math.max(1, thresholdMs - WARM_MARGIN_MIN_MS);
	return Math.min(ceiling, Math.max(1, Math.round(ms)));
}

/**
 * The next warm interval, from whether the last window's warming chain actually held.
 *
 * The band above the verified interval is worth 1,706 rows a day and nobody knows whether it is
 * safe, so each object finds out and pays for being wrong once.
 *
 * Climbs one step after {@link WARM_CLEAN_WINDOWS} windows one incarnation spanned, and retreats
 * all the way to {@link WARM_INTERVAL_VERIFIED_MS} on a window it did not (the next-lower step has
 * no more evidence than the one that failed).
 *
 * @param survived whether a single incarnation spanned the closing window; a re-created object
 *   cannot have stayed resident, so this is the observation, not a proxy
 */
export function solveWarmInterval(
	state: { intervalMs: number; clean: number },
	survived: boolean,
	thresholdMs = HIBERNATION_ASSUMED_MS
): { intervalMs: number; clean: number } {
	const current = clampWarmInterval(state.intervalMs, thresholdMs);
	if (!survived) return { intervalMs: WARM_INTERVAL_VERIFIED_MS, clean: 0 };
	const clean = state.clean + 1;
	if (clean < WARM_CLEAN_WINDOWS) return { intervalMs: current, clean };
	return {
		intervalMs: clampWarmInterval(current + WARM_INTERVAL_STEP_MS, thresholdMs),
		clean: 0
	};
}

/** the verdict of {@link warmDecision} with the figures behind it */
export type WarmDecision = {
	warm: boolean;
	/** renders per second over the window, which is what the model is driven by */
	rate: number;
	/** P(at least one render within the hibernation threshold) */
	probability: number;
	/** expected saving in ms; positive is why it warms */
	expected: number;
	reason: string;
};

/** renders per second over the trailing window, from the ring */
export function renderRate(
	arrivals: readonly Arrival[],
	nowMs: number,
	windowMs = RATE_WINDOW_MS
): number {
	const since = nowMs - windowMs;
	const renders = arrivals.filter((a) => a.rendered && a.at >= since).length;
	if (renders === 0) return 0;
	// the window is the denominator even when the ring is shorter: dividing by the arrival span
	// reads a burst as a sustained rate
	return renders / (windowMs / 1000);
}

/**
 * The render count that survives hibernation: the arrival ring is in memory and dies with the
 * incarnation, so between 505 and 8,640 renders/day every wake would read rate 0.
 *
 * One `cfw_meta` row (counter plus window start), flushed on the 15-minute window boundary rather
 * than every tick, which caps it at 96 rows/day (a write per idle tick was 32.4% of free's budget).
 */
export type RenderWindow = {
	startedAt: number;
	renders: number;
	/** the warm re-arm this object has converged on; see {@link solveWarmInterval} */
	intervalMs: number;
	/** consecutive whole windows the warming chain survived without a re-creation */
	clean: number;
};

/**
 * Parses the packed meta value; undefined for anything malformed.
 *
 * Two fields or four; the two-field form is still read so a deploy does not reset every warmed
 * object's rate estimate.
 */
export function readRenderWindow(value: string | null | undefined): RenderWindow | undefined {
	const parts = String(value ?? '').split(':');
	if (parts.length !== 2 && parts.length !== 4) return undefined;
	const startedAt = Number(parts[0]);
	const renders = Number(parts[1]);
	if (!Number.isFinite(startedAt) || !Number.isFinite(renders)) return undefined;
	if (startedAt <= 0 || renders < 0) return undefined;
	const solved = parts.length === 4 ? readSolvedInterval(parts[2], parts[3]) : undefined;
	return { startedAt, renders, ...(solved ?? ZERO_SOLVED) };
}

/** parses the solved-interval half of the packed value; undefined when malformed */
function readSolvedInterval(
	rawInterval: string | undefined,
	rawClean: string | undefined
): { intervalMs: number; clean: number } | undefined {
	const intervalMs = Number(rawInterval);
	const clean = Number(rawClean);
	if (!Number.isFinite(intervalMs) || !Number.isFinite(clean)) return undefined;
	if (intervalMs <= 0 || clean < 0) return undefined;
	return { intervalMs: clampWarmInterval(intervalMs), clean: Math.round(clean) };
}

/** packs a window as `startedAt:renders:intervalMs:clean` for the meta row */
export function writeRenderWindow(window: RenderWindow): string {
	return [
		Math.round(window.startedAt),
		Math.round(window.renders),
		Math.round(window.intervalMs),
		Math.round(window.clean)
	].join(':');
}

/**
 * Folds pending renders into the stored window, rolling it over when it has aged out.
 *
 * Rolls rather than accumulates, so a site that was busy last month cannot keep itself warm on it.
 */
export function foldRenderWindow(
	stored: RenderWindow | undefined,
	pending: number,
	nowMs: number,
	windowMs = RATE_WINDOW_MS,
	/** whether ONE incarnation spanned the window that is closing; see {@link solveWarmInterval} */
	survived = false
): RenderWindow {
	if (stored === undefined || nowMs - stored.startedAt >= windowMs) {
		const carried = stored ?? ZERO_SOLVED;
		return {
			startedAt: nowMs,
			renders: pending,
			...(stored === undefined
				? ZERO_SOLVED
				: solveWarmInterval(
						{ intervalMs: carried.intervalMs, clean: carried.clean },
						survived
					))
		};
	}
	return {
		startedAt: stored.startedAt,
		renders: stored.renders + pending,
		intervalMs: stored.intervalMs,
		clean: stored.clean
	};
}

/**
 * Renders per second from the stored window.
 *
 * Divides by the window, not the elapsed span, as `renderRate()` does (a three-second-old window
 * holding two renders is not 0.67/s).
 */
export function windowRate(
	stored: RenderWindow | undefined,
	nowMs: number,
	windowMs = RATE_WINDOW_MS
): number {
	if (stored === undefined || stored.renders <= 0) return 0;
	if (nowMs - stored.startedAt >= windowMs) return 0;
	return stored.renders / (windowMs / 1000);
}

/** P(at least one arrival within `withinMs`) for a Poisson process at `rate` per second */
export function arrivalProbability(rate: number, withinMs: number): number {
	if (rate <= 0) return 0;
	return 1 - Math.exp(-rate * (withinMs / 1000));
}

/**
 * Whether to re-arm, and why.
 *
 * `forced` is the operator's own `SITE_WARM`, which this never overrides in either direction.
 */
export function warmDecision(
	arrivals: readonly Arrival[],
	nowMs: number,
	opts: {
		thresholdMs: number;
		forced?: boolean;
		windowMs?: number;
		lastAuthenticatedAt?: number;
		/** what survived the last hibernation; without it the ring is empty on every wake */
		stored?: RenderWindow;
	} = {
		thresholdMs: HIBERNATION_ASSUMED_MS
	}
): WarmDecision {
	const windowMs = opts.windowMs ?? RATE_WINDOW_MS;
	// the higher of the two: the ring is exact but empty after a wake, the stored window is coarse
	// but survives one
	const rate = Math.max(
		renderRate(arrivals, nowMs, windowMs),
		windowRate(opts.stored, nowMs, windowMs)
	);
	const probability = arrivalProbability(rate, opts.thresholdMs);
	const expected = probability * COLD_BOOT_MS - WARM_FIRING_COST_MS;

	if (opts.forced === true) {
		return { warm: true, rate, probability, expected, reason: 'SITE_WARM=1' };
	}
	if (opts.forced === false) {
		return { warm: false, rate, probability, expected, reason: 'SITE_WARM=0' };
	}

	// an active session beats the rate estimate (an anonymous-traffic measure): an editor on a
	// quiet site hurts most cold (31 ms warm against 513 ms); the window stops an ended session
	const since = opts.lastAuthenticatedAt;
	if (since !== undefined && nowMs - since < AUTH_WARM_WINDOW_MS) {
		return {
			warm: true,
			rate,
			probability,
			expected,
			reason: `an authenticated request ${Math.round((nowMs - since) / 1000)} s ago; a session is active`
		};
	}

	if (rate === 0) {
		return {
			warm: false,
			rate,
			probability,
			expected,
			reason: 'no render in the window, so a firing saves nothing'
		};
	}
	return {
		warm: expected > 0,
		rate,
		probability,
		expected,
		reason:
			expected > 0
				? `P(render within ${opts.thresholdMs} ms) ${probability.toFixed(4)} x ${COLD_BOOT_MS} ms beats ${WARM_FIRING_COST_MS}`
				: `P(render within ${opts.thresholdMs} ms) ${probability.toFixed(4)} does not pay for a firing`
	};
}

/** appends to the ring, dropping the oldest; returns the ring so a caller can assign it */
export function recordArrival(
	arrivals: readonly Arrival[],
	arrival: Arrival,
	cap = ARRIVAL_RING
): Arrival[] {
	const next = [...arrivals, arrival];
	return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * The route families a save should prewarm, from the paths it invalidated.
 *
 * Prewarms a family, not a URL: the page cache is keyed on the URL but the object is what is cold,
 * so one render of any member (the first path segment) warms the interpreter for the rest.
 * Returns one representative per family.
 */
export function routeFamilies(paths: readonly string[], limit = 4): string[] {
	const byFamily = new Map<string, string>();
	for (const path of paths) {
		const clean = String(path).split('?')[0] ?? '';
		if (!clean.startsWith('/')) continue;
		const family = `/${clean.split('/')[1] ?? ''}`;
		if (!byFamily.has(family)) byFamily.set(family, clean);
	}
	return [...byFamily.values()].slice(0, limit);
}
