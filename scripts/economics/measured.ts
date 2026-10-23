// --- render, by workload ---------------------------------------------------------------------

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
 *
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

/** a freshly provisioned site's database, 4,726,784 bytes, in the GB the storage meters bill */
export const SITE_GB = 4.726784 / 1000.0;

// --- what a site that stays resident, or wakes cold, costs --------------------------------------

/** cpuTime of a cold interpreter boot, median of four fresh objects on a deployed paid worker, 2026-09-09 */
export const COLD_BOOT_MS = 1264.0;

/** billed wall time of one warming firing, n=116 across two deployed objects; CPU time was not read */
export const WARM_FIRING_WALL_MS = 23.3;

/** what one object may hold before the platform resets it, ramped on a paid object 2026-09-25 */
export const OBJECT_MEMORY_MIB = 195;

/**
 * what the platform meters for an object holding a booted interpreter, the midpoint of 165-175 MiB
 * from the same ramp, taken against the 80 MiB-start binary; the 64 MiB start since 2026-09-30 is lower
 */
export const BOOTED_FOOTPRINT_MIB = 170;

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

// --- the J/view run ---------------------------------------------------------------------------

/**
 * CPU milliseconds per view, from each arm's cgroup, median of the valid class windows.
 *
 * `measured` on `paisley-park`, 2026-10-01, `scripts/measure/jview-energy.ts`, n=6-7 rounds per cell.
 * `vps` is nginx with its cache plus php-fpm, `vpsFpm` is php-fpm with Drupal's page cache alone,
 * and `bastion` is drupflare on a self-hosted node. The 3 CPUs are the cgroup cap of each arm.
 */
export const JVIEW_CPU_MS = {
	vps: {
		anonCached: 0.391,
		anonMiss: 19.644,
		authFront: 10.245,
		authAdmin: 20.636,
		authAccount: 12.885
	},
	vpsFpm: { anonCached: 2.265 },
	bastion: {
		anonCached: 1.105,
		anonMiss: 32.51,
		authFront: 2.867,
		authAdmin: 2.92,
		authAccount: 30.325
	}
};

// --- the repeat-view run ------------------------------------------------------------------------

/**
 * One repeat navigation of the demo's four pages in a browser, with the static-asset cache headers
 * the product ships.
 *
 * `measured` on `paisley-park`, 2026-10-19: RAPL package-0, idle subtracted per round, n=8 rounds of
 * 300 navigations, arm order rotated, headless Chromium with a 40 ms emulated round trip against a
 * co-located static mirror. A desktop CPU reading: the origin's CPU (0.33 ms a navigation) is inside
 * the package figure and display, radio and network gear are outside it. Every non-HTML file carried
 * a lifetime far longer than the run, so each navigation found its assets fresh. The three requests
 * are the HTML and two analytics beacons.
 */
export const REPEAT_NAV = {
	joules: 1.453,
	joulesRange: [1.355, 1.507],
	requests: 3.0,
	wallMs: 49.9,
	rounds: 8
} as const;

/**
 * The same navigation against a deployed worker, `measured` on `paisley-park` 2026-10-19 over its Wi-Fi
 * to a free-account workers.dev site, 16 ms round trip: n=8 rounds of 300 navigations, idle subtracted
 * per round, desktop CPU package only. A fresh site references 19 to 20 assets a page and workers.dev
 * carries no analytics beacon, so the one request is the HTML.
 */
export const REPEAT_NAV_DEPLOYED = {
	joules: 1.312,
	joulesRange: [1.229, 1.407],
	requests: 1,
	wallMs: 48.7,
	rounds: 8
} as const;

// --- spool --------------------------------------------------------------------------------------

/**
 * Worker requests of a site that runs spool against the same site with it off, counted at the
 * Worker.
 *
 * `measured` on two deployed paid-account workers, 2026-10-23, from the Workers Observability events
 * of the whole rig window (04:40 to 06:40 UTC). The on worker answered 1,751 front worker
 * invocations and the off worker 4,196 for the same drive. A new device asked the on worker for
 * `/spool-sw.js` 482 times and for `/.spool/*` 507 times, over about 500 new devices (480 cold
 * navigations in the energy runs, 12 in the count run and the repeat contexts), so a new device
 * costs about two Worker requests beyond its page: `fixedPerDevice` is that figure, `derived` from
 * the two counts and the device count. Every one of 48 repeat navigations on the on worker made
 * zero network requests, against one to six on the off worker.
 *
 * The first reading of this figure was four, `measured` on the laptop (`wrangler dev --local`, five
 * runs, no spread): `/.spool/0.2.0/client.js`, `/spool-sw.js` and two `/.spool/artifact`. A
 * deployed worker did not show the two artifact requests, and the deployed figure replaces it. The
 * local run answered 3 of 12 navigations on the Worker, one repeat arriving before the worker took
 * control, so `pageRequestsOn` stays a local reading.
 */
export const SPOOL_REQUESTS = {
	navigations: 12,
	off: 12,
	on: 7,
	pageRequestsOn: 3,
	fixedPerDevice: 2,
	runs: 5
} as const;

/**
 * Spool's own cost and gain on a visitor's device and on the Worker, `measured` on the same two
 * deployed workers and a desktop CPU (paisley-park, RAPL package joules, idle subtracted per
 * navigation, six rounds per cold experiment and eight per repeat, Chromium 1.62 in a container).
 *
 * `onJ` and `offJ` are medians of joules per navigation; `ratio` is off over on per round, so above
 * one the visitor's device spends less with spool. A cold navigation is a fresh browser context, a
 * new device. The plain-page cold ratio and the image and video ratios sit inside their own spread
 * and are not savings; the embed and the all-media pages are.
 *
 * `workerCpu` is the platform's `cpuTime` for the front worker, whole milliseconds, per request
 * class on the on worker (page decoration, image conversion) against the off worker.
 */
export const SPOOL_DEVICE = {
	repeat: { onJ: 0.527, offJ: 1.292, ratio: 2.468, control: 1.004, rounds: 8 },
	coldPlain: { onJ: 10.034, offJ: 8.943, ratio: 0.835, rounds: 6 },
	coldAll: { onJ: 12.883, offJ: 32.84, ratio: 2.651, rounds: 6 },
	coldImage: { onJ: 9.829, offJ: 9.652, ratio: 0.937, rounds: 6 },
	coldVideo: { onJ: 10.88, offJ: 10.857, ratio: 1.019, rounds: 6 },
	coldEmbed: { onJ: 12.01, offJ: 34.106, ratio: 2.888, rounds: 5 },
	coldAllBytes: { on: 195_715, off: 1_367_951 },
	workerCpu: {
		pageOn: { median: 6, p90: 16, max: 38, n: 544 },
		pageOff: { median: 1, p90: 4, max: 23, n: 3785 },
		imageOn: { median: 2, p90: 96, max: 187, n: 182 },
		imageOff: { median: 1, p90: 3, max: 9, n: 185 }
	}
} as const;

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
