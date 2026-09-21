/**
 * Fleet comparison: N Drupal sites, drupflare against the STRONGEST conventional opponent.
 *
 * The dedicated-VPS comparison is not the fair fight; nobody runs 1,000 sites on 1,000 VPSes. The
 * opponent here is well-consolidated shared hosting, which is the arrangement that already
 * captures most of the multi-tenancy saving. Every contested input takes the value generous to the
 * opponent.
 */
import { num, sweep } from './args.js';
import { fr, nr, pctr, r } from './fmt.js';

const VIEWS = sweep('views', [1_000, 10_000, 100_000, 1_000_000]);
const HIGH_VIEWS = sweep('high-views', [1_000_000, 5_000_000, 10_000_000, 20_000_000]);
// measured.ts carries every figure with its provenance and the guard that stops a cold-path
// render being charged at invalidation frequency
import {
	CACHED_SERVE_TOTAL_MS as CPU_MS_CACHED,
	RENDER_WARM_BIN_MS as CPU_MS_RENDER
} from './measured.js';

export const IDLE_W = 135.0;
export const PEAK_W = 460.0;
export const CORES = 128.0;
export const PUE_COLO = 1.54;
export const PUE_HYPER = 1.15;
export const HOURS_YEAR = 8766.0;
export const G_US = num('grid-us', 384.0);
const RAM_GB_HOST = 1536.0; // a large modern 2-socket host
const RAM_GB_SITE = 1.0; // php-fpm pool + opcache + MySQL share for a small Drupal site; generous

export function watts(util: number): number {
	return IDLE_W + (PEAK_W - IDLE_W) * util;
}

/** Sites packed onto as few hosts as RAM allows, hosts sized to the offered CPU load. */
export function sharedHosting(
	sites: number,
	viewsMonth: number,
	renderFrac = 0.01
): { hosts: number; util: number; kwh: number } {
	const byRam = RAM_GB_HOST / RAM_GB_SITE;
	// CPU the fleet actually needs, in core-seconds/year, using the SAME per-request cost as
	// drupflare: this gives the opponent drupflare's efficiency, so the only thing left in the
	// comparison is IDLE and PUE rather than any claim about PHP being faster here
	const viewsY = sites * viewsMonth * 12.0;
	const cpuS =
		(viewsY * ((1 - renderFrac) * CPU_MS_CACHED + renderFrac * CPU_MS_RENDER)) / 1000.0;
	const coreSPerHost = CORES * HOURS_YEAR * 3600.0;
	let hosts = Math.max(sites / byRam, cpuS / coreSPerHost);
	hosts = Math.max(hosts, 1.0);
	const util = Math.min(1.0, cpuS / (hosts * coreSPerHost));
	const kwh = (hosts * watts(util) * PUE_COLO * HOURS_YEAR) / 1000.0;
	return { hosts, util, kwh };
}

export function drupflare(sites: number, viewsMonth: number, renderFrac = 0.01): number {
	const viewsY = sites * viewsMonth * 12.0;
	const cpuS =
		(viewsY * ((1 - renderFrac) * CPU_MS_CACHED + renderFrac * CPU_MS_RENDER)) / 1000.0;
	const wPerCore = PEAK_W / CORES; // charge the FULL per-core power, not the marginal delta
	return (cpuS * wPerCore * PUE_HYPER) / 3600.0 / 1000.0;
}

if (import.meta.main) {
	console.log('1,000 sites, 1% of views render. Opponent = consolidated shared hosting,');
	console.log("given drupflare's own per-request CPU so only idle and PUE differ.\n");
	console.log(
		`${r('views/site/mo', 13)} ${r('hosts', 7)} ${r('util', 6)} ${r('shared kWh/y', 13)} ${r('drupflare', 11)} ${r('saving', 8)}`
	);
	for (const v of VIEWS) {
		const { hosts, util, kwh } = sharedHosting(1000, v);
		const d = drupflare(1000, v);
		console.log(
			`${nr(v, 13)} ${fr(hosts, 7, 1)} ${pctr(util, 6, 1)} ${nr(kwh, 13)} ${nr(d, 11, 1)} ${fr((1 - d / kwh) * 100, 7, 1)}%`
		);
	}

	console.log('\nwhere the saving comes from, 1,000 sites at 10k views/mo:');
	const { hosts, kwh } = sharedHosting(1000, 10_000);
	const d = drupflare(1000, 10_000);
	const idleShare = (hosts * IDLE_W * PUE_COLO * HOURS_YEAR) / 1000.0;
	console.log(`  shared hosting total          ${nr(kwh, 10)} kWh/y`);
	console.log(
		`  of which IDLE (RAM-bound)     ${nr(idleShare, 10)} kWh/y  = ${pctr(idleShare / kwh, 0, 1)}`
	);
	console.log(`  drupflare total               ${nr(d, 10, 1)} kWh/y`);
	console.log(`  carbon avoided, US grid       ${nr(((kwh - d) * G_US) / 1000, 10)} kg CO2e/y`);
	console.log(`  equivalent hosts retired      ${nr(hosts, 10, 1)}`);

	console.log(
		'\nthe honest boundary: at what per-site traffic does shared hosting become CPU-bound'
	);
	console.log('rather than RAM-bound, which is where its idle stops being wasted?');
	for (const v of HIGH_VIEWS) {
		const s = sharedHosting(1000, v);
		const df = drupflare(1000, v);
		console.log(
			`  ${nr(v, 12)} views/site/mo: ${fr(s.hosts, 6, 1)} hosts at ${pctr(s.util, 5, 1)} util, saving ${fr((1 - df / s.kwh) * 100, 5, 1)}%`
		);
	}
}
