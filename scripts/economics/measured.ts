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

/**
 * MARGINAL RAPL package energy: what ONE more request costs a busy host.
 *
 * NOT the whole-window figure divided by the request count, and the difference is not small. A load
 * of any size lifts the package out of its idle C-states, and that step costs the same whether the
 * window carried 300 requests or 1,100 -- so a single-rate reading divides one fixed cost across
 * whatever throughput it reached. The same VPS arm reads 279, 202 and 131 mJ per cached request at
 * 29, 57 and 114 req/s. These are the slopes at the busy end of the ladder, which is the right input
 * for a host that serves continuously.
 *
 * SUPERSEDES 368.96 and 55.07, which were single-rate readings at 112 and 474 req/s. A FLOOR in
 * both cases: PSU loss, fans, drives and DRAM sit outside the RAPL domains.
 *
 * `scripts/measure/vps-energy.ts --ladder=2,4,8`, 3-CPU cgroup, generator off-box, n=5 per rung.
 */
export const MJ_RENDER_VPS = 219.3;
export const MJ_CACHED_VPS = 59.7;

/**
 * drupflare's own marginals are deliberately NOT exported, because this ladder cannot read them.
 *
 * Its top rung saturated: throughput moved 332 to 409 requests while energy moved 248.63 to 253.31 J,
 * so the slope there is a measurement of the ceiling rather than of a request. What IS clean is the
 * comparison at MATCHED request count, where the two runtimes land within 13% of each other on both
 * tiers over two independent runs. Use {@link DRUPFLARE_ENERGY_PARITY} for the relationship and the
 * VPS marginals above for the magnitude.
 */
export const DRUPFLARE_ENERGY_PARITY = 1.06;

export const IDLE_W_VPS_ARM = 18.17;

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
