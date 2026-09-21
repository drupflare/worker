/**
 * Every measured input the economic models take, with its provenance and its WORKLOAD.
 *
 * A RENDER COST IS NOT ONE NUMBER. Which figure applies depends on which cache bins were cold when
 * it was taken, and spending the wrong one is how a cold-path measurement gets charged at
 * steady-state frequency. That is not hypothetical: the 2,127 ms figure was carried as a live
 * sensitivity arm in three places while the roadmap's own text said "do not let 2,127 into an
 * economic model", because the quarantine was a comment and a comment does not stop arithmetic.
 *
 * {@link renderMsFor} is the constraint that replaces the comment. It refuses a cold-path figure
 * where an invalidation-path figure belongs.
 */

// --- render, by workload ---------------------------------------------------------------------

/**
 * THE PRODUCTION RENDER. Durable Object cpuTime on a deployed paid worker, 35 renders on novel
 * keys with a warm `render` bin, every one confirmed `x-cfw-cache: RENDER` and
 * `x-cfw-php-booted: 1`, GraphQL filtered to the worker's own namespace. 2026-09-21.
 *
 * This is the workload a content change produces: `bumpGeneration()` leaves `dynamic_page_cache`
 * alone on the `cachetags` reason, so an invalidated page re-renders against warm bins.
 */
export const RENDER_WARM_BIN_MS = 60.2;

/**
 * A COLD PATH, and 35x the warm-bin render ON THE SAME INSTRUMENT. Edge cpuTime, both bins
 * emptied, n=10, 1,982-2,579. Reachable on a first fill, a cold boot or a container rebuild, not
 * on the invalidation path. Never multiply this by an invalidation frequency.
 */
export const RENDER_COLD_BINS_MS = 2127.0;

/**
 * The same cold workload measured locally. Kept for the local-versus-edge comparison; the 47x once
 * called unattributed is now attributed, and it was the WORKLOAD rather than the instrument.
 */
export const RENDER_COLD_BINS_LOCAL_MS = 45.0;

// --- serve -----------------------------------------------------------------------------------

/** Durable Object cpuTime, 60 cached serves, namespace-filtered, deployed paid. 2026-09-21. */
export const CACHED_SERVE_DO_MS = 0.42;
/** front worker plus object, the figure the models charge a cached view */
export const CACHED_SERVE_TOTAL_MS = 1.8;
/** previous generation out of PAGE_KV, p50 n=29, and zero Durable Object invocations */
export const STALE_SERVE_MS = 12.0;

// --- paths that are not a plain serve ----------------------------------------------------------

/**
 * A re-drive performs a SECOND full renderPage(); ~1,745 ms and it doubles rows written for that
 * request, 12 -> 24. Bimodal, so the mean is the figure to quote rather than the median.
 */
export const REDRIVE_MS = 1745.0;

/**
 * The park wrapper's cost on renders that never yield, n=60 per arm, two interleaved rounds. Wide
 * interval. A render that DOES park is 106 ms cheaper than the same render deferring.
 */
export const PARK_TAX_MS = 11.0;

// --- energy, measured on bare metal -------------------------------------------------------------

/** RAPL package, 2-CPU VPS arm, idle subtracted, n=7. A FLOOR: PSU, fans, drives and DRAM are out. */
export const MJ_RENDER_VPS = 368.96;
export const MJ_CACHED_VPS = 55.07;
export const IDLE_W_VPS_ARM = 18.85;

// --- the constraint -------------------------------------------------------------------------

/** above this share of views a cold-path measurement is the wrong input */
export const COLD_PATH_MAX_FRAC = 0.005;

export type Workload = 'invalidation' | 'cold-bins' | 'cold-bins-local';

/**
 * The render cost for a named workload, refusing the cold figure where it does not belong.
 *
 * Passing `cold-bins` above {@link COLD_PATH_MAX_FRAC} throws, because that is the error this
 * module exists to make unrepresentable: a both-bins-emptied render multiplied by the frequency of
 * an invalidation-driven one.
 */
export function renderMsFor(workload: Workload, renderFrac = 0): number {
	if (workload === 'invalidation') return RENDER_WARM_BIN_MS;
	if (workload === 'cold-bins-local') return RENDER_COLD_BINS_LOCAL_MS;
	if (workload === 'cold-bins') {
		if (renderFrac > COLD_PATH_MAX_FRAC) {
			throw new Error(
				// `.toFixed(1)` because Python's float repr prints `2127.0` and the ported output is
				// diffed against it byte for byte
				`refusing a cold-bins render cost (${RENDER_COLD_BINS_MS.toFixed(1)} ms) at a render fraction ` +
					`of ${(renderFrac * 100).toFixed(4)}%. That figure is a first fill, a cold boot or a ` +
					`container rebuild, and charging it at invalidation frequency overstates CPU by ` +
					`${Math.round(RENDER_COLD_BINS_MS / RENDER_WARM_BIN_MS)}x. Use 'invalidation' ` +
					`(${RENDER_WARM_BIN_MS} ms), or state a cold-path frequency below ` +
					`${(COLD_PATH_MAX_FRAC * 100).toFixed(1)}%.`
			);
		}
		return RENDER_COLD_BINS_MS;
	}
	throw new Error(`unknown workload ${workload}`);
}
