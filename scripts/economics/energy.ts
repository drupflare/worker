/**
 * Energy and carbon model: one small Drupal site, VPS against drupflare.
 *
 * Every input is sourced. Where a range exists the model takes the value that is GENEROUS TO THE
 * VPS, so the result is a floor on the saving rather than a headline.
 */
import { pageStoreFraction } from '../measure/render-fraction';
import { num, sweep } from './args';
import { fr, nr, pctr, r } from './fmt';

const VIEWS = sweep('views', [10_000, 100_000, 1_000_000]);
// every figure and its provenance lives in measured.ts, which also carries the constraint that
// stops a cold-path render being charged at invalidation frequency
import {
	CACHED_SERVE_TOTAL_MS as CPU_MS_CACHED,
	RENDER_WARM_BIN_MS as CPU_MS_RENDER,
	renderMsFor
} from './measured';

// --- sourced inputs -------------------------------------------------------
// SPECpower_ssj2008 result power_ssj2008-20251021-01543, Dell PowerEdge R6725, AMD EPYC 9845 at
// 2.10 GHz: 2 chips, 320 cores, 640 hardware threads, 135 W active idle, 711 W at 100% target load
// https://www.spec.org/power_ssj2008/results/res2025q4/power_ssj2008-20251021-01543.txt
export const IDLE_W = 135.0;
export const PEAK_W = 711.0;
export const CORES = 320.0;
export const THREADS_PER_HOST = 640;
export const PUE_COLO = 1.54; // Uptime Institute 2025 weighted average (colo/enterprise is 1.58-1.80)
export const PUE_HYPER = 1.15; // Uptime 2025 hyperscale band 1.10-1.15; take the WORSE end for us
const G_PER_KWH_US = num('grid-us', 384.0); // Ember Global Electricity Review 2025, US
const G_PER_KWH_EU = num('grid-eu', 140.0); // IEA/EEA 2026 forecast, EU
export const HOURS_YEAR = 8766.0;

// drupflare's busy core is a physical core: each Workers isolate thread runs on one core
/** marginal power of one busy core, plus that core's share of idle while it is busy */
export const W_PER_CORE = (PEAK_W - IDLE_W) / CORES + IDLE_W / CORES;

/** Linear interpolation between idle and peak; standard first-order server power model. */
export function wattsAt(util: number): number {
	return IDLE_W + (PEAK_W - IDLE_W) * util;
}

/** One VPS's share of its host, running 24/7 whether or not anyone visits. */
export function vpsKwhYear(density: number, util: number): number {
	return ((wattsAt(util) / density) * PUE_COLO * HOURS_YEAR) / 1000.0;
}

// a VPS vCPU is a hardware thread, so a node owns vCPU / THREADS_PER_HOST of the host
// web pair plus database pair in a region (Acquia HA over two AZs, AWS Drupal reference architecture)
export const NODES_PER_REGION = 4;

/** An enterprise deployment's shape. `derived (modelled)`: no source sizes a node. */
export interface ProductionShape {
	name: string;
	regions: number;
	nodesPerRegion: number;
	vcpu: number;
	util: number;
}

/** The shapes the impact document compares against, production first and the worst case last. */
export const PRODUCTION_SHAPES: ProductionShape[] = [
	{
		name: 'latency-matched production',
		regions: 3,
		nodesPerRegion: NODES_PER_REGION,
		vcpu: 4,
		util: 0.15
	},
	{
		name: 'peak-sized production',
		regions: 3,
		nodesPerRegion: NODES_PER_REGION,
		vcpu: 8,
		util: 0.1
	},
	{
		name: 'single-region HA',
		regions: 1,
		nodesPerRegion: NODES_PER_REGION,
		vcpu: 4,
		util: 0.15
	}
];

/** Idle-dominated draw of one multi-node deployment: regions x nodes x each node's host share. */
export function productionKwhYear(s: ProductionShape): number {
	const nodeShare = s.vcpu / THREADS_PER_HOST;
	return (
		(s.regions * s.nodesPerRegion * nodeShare * wattsAt(s.util) * PUE_COLO * HOURS_YEAR) /
		1000.0
	);
}

/** a small VPS is two vCPUs, so it owns two hardware threads of the host */
export const SMALL_VPS_VCPU = 2;
export const SMALL_VPS_DENSITY = THREADS_PER_HOST / SMALL_VPS_VCPU;

/** The floor: one small VPS, two threads of a host at 15% utilisation, the worst case for the saving. */
export const FLOOR_KWH_YEAR = vpsKwhYear(SMALL_VPS_DENSITY, 0.15);

/** Energy is CPU-seconds actually executed, charged at the host's marginal power per core. */
export function drupflareKwhYear(viewsMonth: number, renderFrac: number, renderMs: number): number {
	const viewsYear = viewsMonth * 12.0;
	const cpuS = (viewsYear * ((1 - renderFrac) * CPU_MS_CACHED + renderFrac * renderMs)) / 1000.0;
	return (cpuS * W_PER_CORE * PUE_HYPER) / 3600.0 / 1000.0;
}

function row(
	views: number,
	density: number,
	util: number,
	renderMs = CPU_MS_RENDER,
	renderFrac = pageStoreFraction(views)
): [number, number, number] {
	const v = vpsKwhYear(density, util);
	const d = drupflareKwhYear(views, renderFrac, renderMs);
	return [v, d, (1 - d / v) * 100.0];
}

if (import.meta.main) {
	console.log('one site, renders from 5 saves a day, VPS idle-dominated\n');
	console.log(
		`${r('views/mo', 9)} ${r('VPS/host', 9)} ${r('VPS util', 9)} ${r('VPS kWh/y', 10)} ${r('drupflare', 10)} ${r('saving', 8)}`
	);
	for (const views of VIEWS) {
		for (const [density, util] of [
			[20, 0.05],
			[50, 0.1],
			[100, 0.15]
		] as const) {
			const [v, d, pct] = row(views, density, util);
			console.log(
				`${nr(views, 9)} ${r(density, 9)} ${pctr(util, 9, 0)} ${fr(v, 10, 1)} ${fr(d, 10, 4)} ${fr(pct, 7, 2)}%`
			);
		}
	}

	// the cold-bins render is a FIRST FILL, a cold boot or a container rebuild, so it is scored at
	// a cold-path frequency rather than the invalidation frequency the rows above use. Asking for
	// it at 1% throws, which is the point.
	console.log(
		'\nthe cold-bins render, charged at a cold-path frequency instead of a steady-state one'
	);
	const COLD_FRAC = 0.002;
	for (const views of [10_000, 100_000, 1_000_000]) {
		const [v, d, pct] = row(views, 100, 0.15, renderMsFor('cold-bins', COLD_FRAC), COLD_FRAC);
		console.log(
			`  ${nr(views, 9)} views/mo  VPS ${fr(v, 7, 1)} kWh/y  drupflare ${fr(d, 8, 3)}  saving ${fr(pct, 6, 2)}%`
		);
	}
	try {
		renderMsFor('cold-bins', 0.01);
	} catch (e) {
		console.log(
			`\n  and at a 1% render fraction it refuses, which is the guard:\n  ${(e as Error).message}`
		);
	}

	console.log('\ncarbon, 10k views/mo, most generous VPS assumption (100/host, 15% util)');
	const [v, d] = row(10_000, 100, 0.15);
	for (const [label, gkwh] of [
		['US grid', G_PER_KWH_US],
		['EU grid', G_PER_KWH_EU]
	] as const) {
		console.log(
			`  ${label}: VPS ${fr((v * gkwh) / 1000, 6, 2)} kg CO2e/y   drupflare ${fr((d * gkwh) / 1000, 6, 4)}   avoided ${fr(((v - d) * gkwh) / 1000, 6, 2)}`
		);
	}

	// at these volumes the page-store fraction is far below 1%, so 1% bounds the break-even from below
	console.log("\nbreak-even: views/month where drupflare's CPU equals the VPS's idle share");
	for (const [density, util] of [
		[20, 0.05],
		[50, 0.1],
		[100, 0.15]
	] as const) {
		const vv = vpsKwhYear(density, util);
		const perView = drupflareKwhYear(1.0, 0.01, CPU_MS_RENDER) / 12.0;
		console.log(
			`  ${r(density, 3)}/host at ${pctr(util, 4, 0)}: ${nr(vv / perView / 12, 14)} views/month`
		);
	}
}
