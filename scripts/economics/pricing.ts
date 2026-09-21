/**
 * Per-site cost on Workers for Platforms, and what the three plans should charge.
 *
 * PUBLISHED, retrieved 2026-09-20 from developers.cloudflare.com:
 *   WfP        $25/mo, includes 20M requests, 60M CPU-ms, 1000 scripts
 *              +$0.30/M requests, +$0.02/M CPU-ms, +$0.02/script
 *              subrequests are NOT billed; the dispatch+user+outbound chain is ONE request
 *   Durable Objects  $0.15/M requests, $12.50/M GB-s, rows written $1.00/M over 50M,
 *              storage $0.20/GB-month
 *
 * Measured figures come from measured.ts with their provenance and workload attached.
 */
import { f, fr, n, nr, pctr, r } from './fmt.js';
import {
	CACHED_SERVE_TOTAL_MS as CPU_CACHED,
	RENDER_WARM_BIN_MS as CPU_RENDER,
	renderMsFor
} from './measured.js';

const WFP_BASE = 25.0;
const WFP_REQ_INC = 20e6;
const WFP_CPU_INC = 60e6;
const WFP_SCRIPTS_INC = 1000;
const WFP_REQ_RATE = 0.3;
const WFP_CPU_RATE = 0.02;
const WFP_SCRIPT_RATE = 0.02;
const DO_REQ_RATE = 0.15;
const DO_GBS_RATE = 12.5;
const DO_ROWW_RATE = 1.0;
const DO_STORE_RATE = 0.2;
const DO_ROWW_INC = 50e6;
const SITE_GB = 4.726784 / 1000.0; // measured: a fresh site is 4,726,784 bytes
const ROWS_PER_VIEW_FILL = 25.0; // mid of the measured 2-94 band

/**
 * `doHitFrac` is the share of views that reach the Durable Object at all. Measured: 71.5% of one
 * authenticated arm was answered by the compiled plan in the front worker, and anon-cached is
 * answered by `caches.default`, so most views never reach an object.
 */
export function month(
	sites: number,
	views: number,
	renderFrac = 0.01,
	cpuRender = CPU_RENDER,
	doHitFrac = 0.18
): [number, Record<string, number>] {
	const v = sites * views;
	const cpuMs = v * ((1 - renderFrac) * CPU_CACHED + renderFrac * cpuRender);
	const req = v; // one billed request per view, whole chain
	const doReq = v * doHitFrac;
	const rowsW = v * renderFrac * ROWS_PER_VIEW_FILL;
	const gbs = doReq * (CPU_CACHED / 1000.0) * 0.128; // 128 MB class, charged on wall time

	const cReq = (Math.max(0.0, req - WFP_REQ_INC) / 1e6) * WFP_REQ_RATE;
	const cCpu = (Math.max(0.0, cpuMs - WFP_CPU_INC) / 1e6) * WFP_CPU_RATE;
	const cScripts = Math.max(0, sites - WFP_SCRIPTS_INC) * WFP_SCRIPT_RATE;
	const cDoReq = (doReq / 1e6) * DO_REQ_RATE;
	const cDoGbs = (gbs / 1e6) * DO_GBS_RATE;
	const cRoww = (Math.max(0.0, rowsW - DO_ROWW_INC) / 1e6) * DO_ROWW_RATE;
	const cStore = sites * SITE_GB * DO_STORE_RATE;
	const total = WFP_BASE + cReq + cCpu + cScripts + cDoReq + cDoGbs + cRoww + cStore;
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
			storage: cStore
		}
	];
}

if (import.meta.main) {
	console.log('monthly platform cost, 1% of views render\n');
	console.log(
		`${r('sites', 7)} ${r('views/site', 11)} ${r('total/mo', 10)} ${r('per site', 10)}`
	);
	for (const sites of [100, 1_000, 10_000]) {
		for (const views of [10_000, 100_000]) {
			const [t] = month(sites, views);
			console.log(`${nr(sites, 7)} ${nr(views, 11)} ${nr(t, 10, 2)} ${fr(t / sites, 10, 4)}`);
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
