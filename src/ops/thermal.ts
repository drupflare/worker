/**
 * Whether to keep an object resident, decided from arrivals rather than from a constant.
 *
 * ## What the flat interval costs and what it buys
 *
 * `WARM_INTERVAL_MS` is 8,000 because a Durable Object hibernates at 10 s of idle -- measured on a
 * throwaway: re-armed every 8 s one incarnation survived 71 consecutive alarms; at 12, 20, 30 and 45
 * the constructor ran again on every probe. So warming is 10,800 firings a day whatever the traffic,
 * one Worker request and one row each, and what it removes is the 1,398 ms cold boot from pages that
 * render. A cached page answers off `ctx.storage.sql` without booting PHP, so warming cannot make
 * one faster by any amount.
 *
 * ## The band, and why a constant sits in the wrong place inside it
 *
 * Below about 505 renders/day the alarms cost more than the boots they save. Above about 8,640 the
 * site never idles long enough to go cold, so the alarms are pure waste. A flat interval is only
 * right in the middle of that band, and it is charged at both ends.
 *
 * ## The decision
 *
 * `P(next render within T) x C_cold > C_warm`. Everything on the left is observable from arrivals
 * this object already counts, and everything on the right is measured. Modelled as a Poisson
 * process: for rate `r` renders per second, `P(at least one within T) = 1 - exp(-r x T)`.
 *
 * A POISSON MODEL IS AN ASSUMPTION, not a measurement, and it is the one thing here that is not
 * pinned. Real traffic is bursty, so the estimate is conservative in the direction that matters: a
 * burst raises the observed rate and warming turns ON, and the error case is warming a site that
 * would have idled -- the same thing the flat interval does unconditionally.
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
 * Measured on a deployed worker: 1,398 ms for the interpreter, mount and kernel. This is the
 * quantity warming exists to remove and the only reason to pay for a firing.
 */
export const COLD_BOOT_MS = 1398;

/**
 * How long an authenticated request keeps the object warm on its own, in ms.
 *
 * Thirty minutes, which is Drupal's own idea of a session's working window and long enough that a
 * pause to read a page does not drop the object. Shorter latches nothing useful; longer pays for
 * sessions that ended.
 */
export const AUTH_WARM_WINDOW_MS = 1_800_000;

/**
 * What one warming firing costs, expressed in the same units.
 *
 * NOT a duration -- an object waiting on an armed alarm is idle-eligible and not billed for
 * duration. What a firing spends is one Worker request and one row, and the comparison has to be
 * made in one currency.
 *
 * DERIVED FROM THE MEASURED BAND rather than chosen. The recorded crossing is ~505 renders/day:
 * below it the alarms cost more than the boots they save. At that rate `r = 505 / 86400 =
 * 0.005845/s`, so `P(render within 10 s) = 1 - exp(-0.05845) = 0.05678`, and break-even means
 * `P x COLD_BOOT_MS = C_warm` -- which puts `C_warm` at 79. A first version of this file carried
 * 130, invented, which moved the crossing to 845 renders/day and would have un-warmed a band the
 * project had already measured as worth warming.
 */
export const WARM_FIRING_COST_MS = 79;

/** the crossing the constant above reproduces, kept so the derivation is checkable */
export const BREAK_EVEN_RENDERS_PER_DAY = 505;

/**
 * The re-arm that is MEASURED to hold an object resident, and the one to retreat to.
 *
 * 8,000 against a 10,000 ms hibernation threshold: one incarnation survived 71 consecutive firings
 * at this interval, and 12,000 lost the isolate on every probe. Nothing between 8,000 and 12,000
 * was ever driven, so this is the largest interval with evidence behind it rather than the largest
 * that works.
 */
export const WARM_INTERVAL_VERIFIED_MS = 8_000;

/**
 * The top of the band, and the margin is the only free parameter in the whole model.
 *
 * Any interval below the threshold prevents every cold boot equally well, so the benefit does not
 * vary across the band and the cost is one firing per interval. That makes the optimum the LARGEST
 * safe interval, not a point somewhere inside: at 9,500 a warmed site fires 9,094 times a day
 * against 10,800, which is 1,706 rows returned.
 *
 * Whether 9,500 is safe is an empirical question about how late a Cloudflare alarm may fire, and
 * this project has not measured it. So it is a ceiling to climb toward on observed evidence rather
 * than a new default; {@link solveWarmInterval} is what does the climbing.
 */
export const WARM_MARGIN_MIN_MS = 500;

/**
 * The hibernation threshold this module solves against, mirroring `HIBERNATION_IDLE_MS`.
 *
 * Restated rather than imported so a thermal spec does not pull `cron.ts` and the PHP cron
 * fragments behind it into its import graph, which is 34% of the gate's lane-work. Pinned against
 * the original in `tests/unit/ops/cron-step.spec.ts`, which already imports both.
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
 * SOLVED RATHER THAN PICKED, which is the whole item: `thermalRearmMs()` chose between two
 * constants, and the one it chose when warming was the smallest interval anybody had evidence for.
 * The band above it is worth 1,706 rows a day and nothing in this repository knows whether it is
 * safe, so the object finds out for itself and pays for being wrong exactly once.
 *
 * Climbs one step after {@link WARM_CLEAN_WINDOWS} windows that ONE incarnation spanned, and
 * retreats all the way to {@link WARM_INTERVAL_VERIFIED_MS} on a window it did not. The retreat is
 * to the verified value rather than one step back because a broken chain says the current interval
 * is unsafe on this object and the next-lower step has no more evidence behind it than the one that
 * just failed.
 *
 * @param survived whether a single incarnation spanned the window that is closing. A re-created
 *   object cannot have stayed resident, so this is the observation and not a proxy for one.
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
	// the window is the DENOMINATOR even when the ring is shorter than it. Using the span between
	// the first and last arrival instead reads a burst as a sustained rate, which is how a
	// predictor talks itself into warming a site that had one visitor
	return renders / (windowMs / 1000);
}

/**
 * The render count that survives hibernation, so the rate branch can fire at all.
 *
 * THE RING IS IN MEMORY AND DIES WITH THE INCARNATION, which made the whole decision unreachable in
 * the band it was built for. Between 505 and 8,640 renders/day the object hibernates between
 * renders, so every wake read an empty ring, `renderRate()` answered 0, and `warmDecision()` took
 * its "no render in the window" branch every time. The branch could only ever fire on a site busy
 * enough not to need it.
 *
 * A counter and a window start, in one `cfw_meta` row. Flushed on the window boundary rather than
 * on the meter interval: the estimate only has to separate ~505/day from ~8,640/day, so a 15-minute
 * bucket is enough resolution and caps this at 96 rows/day. The daily meters learned the other
 * lesson the expensive way -- a counter written on every idle tick was 32.4% of free's row budget
 * recording its own bookkeeping.
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
 * Parses the packed meta value; null for anything malformed.
 *
 * Two fields or four. The two-field form is what shipped, and it is read rather than discarded
 * because discarding it would reset every warmed object's rate estimate on the deploy that added
 * the interval -- which is the one reading the thermal decision cannot do without.
 */
export function readRenderWindow(value: string | null | undefined): RenderWindow | null {
	const parts = String(value ?? '').split(':');
	if (parts.length !== 2 && parts.length !== 4) return null;
	const startedAt = Number(parts[0]);
	const renders = Number(parts[1]);
	if (!Number.isFinite(startedAt) || !Number.isFinite(renders)) return null;
	if (startedAt <= 0 || renders < 0) return null;
	const solved = parts.length === 4 ? readSolvedInterval(parts[2], parts[3]) : null;
	return { startedAt, renders, ...(solved ?? ZERO_SOLVED) };
}

function readSolvedInterval(
	rawInterval: string | undefined,
	rawClean: string | undefined
): { intervalMs: number; clean: number } | null {
	const intervalMs = Number(rawInterval);
	const clean = Number(rawClean);
	if (!Number.isFinite(intervalMs) || !Number.isFinite(clean)) return null;
	if (intervalMs <= 0 || clean < 0) return null;
	return { intervalMs: clampWarmInterval(intervalMs), clean: Math.round(clean) };
}

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
	stored: RenderWindow | null,
	pending: number,
	nowMs: number,
	windowMs = RATE_WINDOW_MS,
	/** whether ONE incarnation spanned the window that is closing; see {@link solveWarmInterval} */
	survived = false
): RenderWindow {
	if (stored === null || nowMs - stored.startedAt >= windowMs) {
		const carried = stored ?? ZERO_SOLVED;
		return {
			startedAt: nowMs,
			renders: pending,
			...(stored === null
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
 * Divides by the WINDOW rather than by the elapsed span, the same reason `renderRate()` does: a
 * window three seconds old holding two renders is not 0.67 renders/second.
 */
export function windowRate(
	stored: RenderWindow | null,
	nowMs: number,
	windowMs = RATE_WINDOW_MS
): number {
	if (stored === null || stored.renders <= 0) return 0;
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
 * `forced` is the operator's own `SITE_WARM`; a decision this makes must never override one a human
 * stated, in either direction.
 */
export function warmDecision(
	arrivals: readonly Arrival[],
	nowMs: number,
	opts: {
		thresholdMs: number;
		forced?: boolean | null;
		windowMs?: number;
		lastAuthenticatedAt?: number | null;
		/** what survived the last hibernation; without it the ring is empty on every wake */
		stored?: RenderWindow | null;
	} = {
		thresholdMs: HIBERNATION_ASSUMED_MS
	}
): WarmDecision {
	const windowMs = opts.windowMs ?? RATE_WINDOW_MS;
	// the higher of the two, because they measure the same quantity through different survivors: the
	// ring is exact within one incarnation and empty after a wake, the stored window is coarse and
	// outlives one. Taking the max means a cold wake reads the stored rate and a warm object that has
	// already served this window is not held down by a stale bucket
	const rate = Math.max(
		renderRate(arrivals, nowMs, windowMs),
		windowRate(opts.stored ?? null, nowMs, windowMs)
	);
	const probability = arrivalProbability(rate, opts.thresholdMs);
	const expected = probability * COLD_BOOT_MS - WARM_FIRING_COST_MS;

	if (opts.forced === true) {
		return { warm: true, rate, probability, expected, reason: 'SITE_WARM=1' };
	}
	if (opts.forced === false) {
		return { warm: false, rate, probability, expected, reason: 'SITE_WARM=0' };
	}

	// AN ACTIVE SESSION BEATS THE RATE ESTIMATE, and the rate estimate is the wrong predictor for it.
	// `renderRate` is a property of ANONYMOUS traffic: it is what decides whether a visitor is likely
	// to arrive. What decides whether an expensive DO-required render is imminent is whether somebody
	// is signed in and working, and an editor on a quiet site produces a rate far below the 505
	// renders/day crossing while producing exactly the requests a cold boot hurts most. Measured on
	// the comparison rig: an authenticated page costs 31 ms warm against 513 ms on a cold object.
	//
	// Bounded by a window rather than left latched, so a session that ended stops paying within one
	// window. At the 8 s re-arm a 30-minute window is 225 firings, 225 requests and 225 rows, once.
	const since = opts.lastAuthenticatedAt;
	if (since !== null && since !== undefined && nowMs - since < AUTH_WARM_WINDOW_MS) {
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
 * PREWARMING A FAMILY RATHER THAN A URL is the point. A visitor who arrives on `/node/41` after an
 * editorial save meets a cold object even though `/node/40` is warm, because the page cache is keyed
 * on the URL and the OBJECT is what was cold. The family is the first path segment, which is what
 * Drupal's own routes are grouped by, so warming one member warms the interpreter every other member
 * needs.
 *
 * Returns one representative per family rather than every path: the object is what is being warmed,
 * and it is warm after the first render.
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
