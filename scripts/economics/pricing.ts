/**
 * Per-site cost on Workers for Platforms, and what the three plans should charge.
 *
 * Prices come from rates.ts with their retrieval dates. Only a site on its own domain uses a SaaS
 * hostname. Measured figures come from measured.ts with their provenance and workload attached.
 */
import {
	DO_GB_ALLOCATED,
	ROWS_PER_FILL_MEMORY_BINS,
	SECONDS_PER,
	STEADY_STATE_WARMTH,
	rowsForWarmthMix
} from '../measure/free-envelope.js';
import { pageStoreFraction } from '../measure/render-fraction.js';
import { f, fr, n, nr, pctr, r } from './fmt.js';
import {
	CACHED_SERVE_TOTAL_MS as CPU_CACHED,
	RENDER_WARM_BIN_MS as CPU_RENDER,
	SITE_GB,
	renderMsFor
} from './measured.js';
import { CLOUDFLARE_FOR_SAAS, DURABLE_OBJECTS, WORKERS_FOR_PLATFORMS } from './rates.js';

export const WFP_BASE = WORKERS_FOR_PLATFORMS.usdPerMonth;
const WFP_REQ_INC = WORKERS_FOR_PLATFORMS.requestsIncluded;
const WFP_CPU_INC = WORKERS_FOR_PLATFORMS.cpuMsIncluded;
const WFP_SCRIPTS_INC = WORKERS_FOR_PLATFORMS.scriptsIncluded;
const WFP_REQ_RATE = WORKERS_FOR_PLATFORMS.usdPerMillionRequests;
const WFP_CPU_RATE = WORKERS_FOR_PLATFORMS.usdPerMillionCpuMs;
const WFP_SCRIPT_RATE = WORKERS_FOR_PLATFORMS.usdPerScript;
export const DO_REQ_RATE = DURABLE_OBJECTS.usdPerMillionRequests;
const DO_GBS_RATE = DURABLE_OBJECTS.usdPerMillionGbS;
const DO_ROWW_RATE = DURABLE_OBJECTS.usdPerMillionRowsWritten;
export const DO_STORE_RATE = DURABLE_OBJECTS.usdPerGbMonth;
const DO_ROWW_INC = DURABLE_OBJECTS.rowsWrittenIncluded;
const HOSTNAMES_INC = CLOUDFLARE_FOR_SAAS.hostnamesIncluded;
const HOSTNAME_RATE = CLOUDFLARE_FOR_SAAS.usdPerHostnameMonth;
const ROWS_PER_VIEW_FILL = rowsForWarmthMix(STEADY_STATE_WARMTH, ROWS_PER_FILL_MEMORY_BINS);

/**
 * `doHitFrac` is the share of views that reach the Durable Object at all. Measured: 71.5% of one
 * authenticated arm was answered by the compiled plan in the front worker, and anon-cached is
 * answered by `caches.default`, so most views never reach an object.
 *
 * `hostnames` is how many of the sites sit on their own domain through Cloudflare for SaaS.
 */
export function month(
	sites: number,
	views: number,
	renderFrac = pageStoreFraction(views),
	cpuRender = CPU_RENDER,
	doHitFrac = 0.18,
	hostnames = 0
): [number, Record<string, number>] {
	const v = sites * views;
	const cpuMs = v * ((1 - renderFrac) * CPU_CACHED + renderFrac * cpuRender);
	const req = v; // one billed request per view, whole chain
	const doReq = v * doHitFrac;
	const rowsW = v * renderFrac * ROWS_PER_VIEW_FILL;
	// wall clock: a hit holds the object for an indexed read, a render for the whole render
	const gbs =
		(doReq * SECONDS_PER.doHit + v * renderFrac * SECONDS_PER.warmRender) * DO_GB_ALLOCATED;

	const cReq = (Math.max(0.0, req - WFP_REQ_INC) / 1e6) * WFP_REQ_RATE;
	const cCpu = (Math.max(0.0, cpuMs - WFP_CPU_INC) / 1e6) * WFP_CPU_RATE;
	const cScripts = Math.max(0, sites - WFP_SCRIPTS_INC) * WFP_SCRIPT_RATE;
	// over the paid plan's allowances, rounded up to the next million as Cloudflare bills them
	const cDoReq =
		Math.ceil(Math.max(0, doReq - DURABLE_OBJECTS.requestsIncluded) / 1e6) * DO_REQ_RATE;
	const cDoGbs = Math.ceil(Math.max(0, gbs - DURABLE_OBJECTS.gbSIncluded) / 1e6) * DO_GBS_RATE;
	const cRoww = (Math.max(0.0, rowsW - DO_ROWW_INC) / 1e6) * DO_ROWW_RATE;
	const cStore = sites * SITE_GB * DO_STORE_RATE;
	const cHost = Math.max(0, hostnames - HOSTNAMES_INC) * HOSTNAME_RATE;
	const total = WFP_BASE + cReq + cCpu + cScripts + cDoReq + cDoGbs + cRoww + cStore + cHost;
	return [
		total,
		{
			base: WFP_BASE,
			req: cReq,
			cpu: cCpu,
			scripts: cScripts,
			do_req: cDoReq,
			do_gbs: cDoGbs,
			rows: cRoww,
			storage: cStore,
			hostnames: cHost
		}
	];
}

if (import.meta.main) {
	console.log('monthly platform cost, renders from 5 saves a day per site\n');
	console.log(
		`${r('sites', 7)} ${r('views/site', 11)} ${r('total/mo', 10)} ${r('per site', 10)} ${r('own domains', 12)}`
	);
	for (const sites of [100, 1_000, 10_000]) {
		for (const views of [10_000, 100_000]) {
			const [t] = month(sites, views);
			const [td] = month(sites, views, undefined, undefined, undefined, sites);
			console.log(
				`${nr(sites, 7)} ${nr(views, 11)} ${nr(t, 10, 2)} ${fr(t / sites, 10, 4)} ${nr(td, 12, 2)}`
			);
		}
	}

	console.log('\nbreakdown, 1,000 sites at 10,000 views/mo:');
	const [t, parts] = month(1_000, 10_000);
	for (const [k, v] of Object.entries(parts).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${r(k, 9)} ${fr(v, 9, 3)}  ${pctr(v / t, 6, 1)}`);
	}
	console.log(`  ${r('TOTAL', 9)} ${fr(t, 9, 3)}   per site ${f(t / 1000, 4)}`);

	// the cold-bins render priced at a COLD-PATH frequency; asking for it at 1% throws
	const COLD_FRAC = 0.002;
	const [t2] = month(1_000, 10_000, COLD_FRAC, renderMsFor('cold-bins', COLD_FRAC));
	console.log('\nthe cold-bins render at a cold-path frequency, not a steady-state one');
	console.log(
		`  1,000 sites @10k views: ${n(t2, 2)}/mo, per site ${f(t2 / 1000, 4)}  (vs ${f(t / 1000, 4)})`
	);

	console.log('\nwhat a plan must clear to be viable, per site per month:');
	for (const [sites, views] of [
		[1_000, 10_000],
		[1_000, 100_000],
		[10_000, 10_000]
	] as const) {
		const [tt] = month(sites, views);
		console.log(
			`  ${nr(sites, 6)} sites @ ${nr(views, 7)} views: cost ${f(tt / sites, 4)}  ` +
				`3x margin ${f((tt / sites) * 3, 3)}  10x ${f((tt / sites) * 10, 2)}`
		);
	}
}
