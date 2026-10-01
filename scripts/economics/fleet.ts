/**
 * Fleet comparison: N Drupal sites, drupflare against the STRONGEST conventional opponent.
 *
 * The dedicated-VPS comparison is not the fair fight; nobody runs 1,000 sites on 1,000 VPSes. The
 * opponent here is well-consolidated shared hosting, which is the arrangement that already
 * captures most of the multi-tenancy saving. Every contested input takes the value generous to the
 * opponent.
 */
import { model, pageStoreFraction } from '../measure/render-fraction';
import { num, sweep } from './args';
import { fr, nr, pctr, r } from './fmt';

const VIEWS = sweep('views', [1_000, 10_000, 100_000, 1_000_000]);
const HIGH_VIEWS = sweep('high-views', [1_000_000, 5_000_000, 10_000_000, 20_000_000]);
// measured.ts carries every figure with its provenance and the guard that stops a cold-path
// render being charged at invalidation frequency
import {
	CACHED_SERVE_TOTAL_MS as CPU_MS_CACHED,
	RENDER_WARM_BIN_MS as CPU_MS_RENDER
} from './measured';

export const IDLE_W = 135.0;
export const PEAK_W = 460.0;
export const CORES = 128.0;
export const PUE_COLO = 1.54;
export const PUE_HYPER = 1.15;
export const HOURS_YEAR = 8766.0;
export const G_US = num('grid-us', 384.0);
// LBNL 2024 US data center energy report: 66 bn L direct over 176 TWh, ~800 bn L via generation
export const WATER_DIRECT_L_PER_KWH = 0.375;
export const WATER_INDIRECT_L_PER_KWH = 4.55;
const RAM_GB_HOST = 1536.0; // a large modern 2-socket host
const RAM_GB_SITE = 1.0; // php-fpm pool + opcache + MySQL share for a small Drupal site; generous

/** the opponent's edge misses reach an origin, so its fraction carries the TTL floor over 8 colos */
export function originRenderFraction(viewsMonth: number): number {
	return model({
		paths: 100,
		colos: 8,
		viewsPerMonth: viewsMonth,
		savesPerDay: 5,
		pagesPerSave: 5,
		zipf: 1
	}).fraction;
}

export function watts(util: number): number {
	return IDLE_W + (PEAK_W - IDLE_W) * util;
}

/** Sites packed onto as few hosts as RAM allows, hosts sized to the offered CPU load. */
export function sharedHosting(
	sites: number,
	viewsMonth: number,
	renderFrac = originRenderFraction(viewsMonth)
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

const HOSTILE_VIEWS = sweep(
	'hostile-views',
	[50_000_000, 100_000_000, 250_000_000, 500_000_000, 1_000_000_000, 10_000_000_000]
);
const SOLVE_MAX = 1e12;
const sfxViews = (v: number) => `${v / 1e9}B`;

/** percent of the shared-hosting fleet's energy drupflare avoids, 1,000 sites */
export function saving(viewsMonth: number): number {
	return (1 - drupflare(1000, viewsMonth) / sharedHosting(1000, viewsMonth).kwh) * 100;
}

/** first per-site traffic, on a 1% log ladder from 1,000 views, where the saving is under `pct` */
export function firstBelow(pct: number, max = SOLVE_MAX): number | null {
	for (let v = 1_000; v <= max; v *= 1.01) if (saving(v) < pct) return Math.round(v);
	return null;
}

export function drupflare(
	sites: number,
	viewsMonth: number,
	renderFrac = pageStoreFraction(viewsMonth)
): number {
	const viewsY = sites * viewsMonth * 12.0;
	const cpuS =
		(viewsY * ((1 - renderFrac) * CPU_MS_CACHED + renderFrac * CPU_MS_RENDER)) / 1000.0;
	const wPerCore = PEAK_W / CORES; // charge the FULL per-core power, not the marginal delta
	return (cpuS * wPerCore * PUE_HYPER) / 3600.0 / 1000.0;
}

if (import.meta.main) {
	console.log('1,000 sites. Opponent = consolidated shared hosting behind a CDN, given');
	console.log("drupflare's per-request CPU so only idle, PUE and the render fraction differ.\n");
	console.log(
		`${r('views/site/mo', 13)} ${r('shared rnd', 10)} ${r('df rnd', 8)} ${r('hosts', 7)} ${r('util', 6)} ${r('shared kWh/y', 13)} ${r('drupflare', 11)} ${r('saving', 8)}`
	);
	for (const v of [...VIEWS, 20_000_000]) {
		const { hosts, util, kwh } = sharedHosting(1000, v);
		const d = drupflare(1000, v);
		console.log(
			`${nr(v, 13)} ${pctr(originRenderFraction(v), 10, 2)} ${pctr(pageStoreFraction(v), 8, 3)} ${fr(hosts, 7, 1)} ${pctr(util, 6, 1)} ${nr(kwh, 13)} ${nr(d, 11, 1)} ${fr((1 - d / kwh) * 100, 7, 2)}%`
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

	console.log('\nbeyond any institutional estate: the saving at hostile per-site traffic');
	for (const v of HOSTILE_VIEWS) {
		const s = sharedHosting(1000, v);
		const df = drupflare(1000, v);
		console.log(
			`  ${nr(v, 14)} views/site/mo: ${fr(s.hosts, 8, 1)} hosts at ${pctr(s.util, 5, 1)} util, saving ${fr(saving(v), 6, 2)}%`
		);
	}

	console.log('\nwhere the saving first falls below each threshold, 1,000 sites:');
	for (const t of [90, 75, 50, 25, 10, 0]) {
		const v = firstBelow(t);
		console.log(
			`  below ${r(`${t}%`, 3)}: ${v === null ? `never, up to ${sfxViews(SOLVE_MAX)} views/site/mo` : `${nr(v, 16)} views/site/mo`}`
		);
	}
	console.log(`  asymptote as both arms go CPU-bound: ${fr(saving(SOLVE_MAX), 2, 2)}%`);

	console.log(`\ncarbon and water avoided per year, 1,000 sites, from the kWh gap above:`);
	console.log(
		`${r('views/site/mo', 15)} ${r('kWh avoided', 12)} ${r(`CO2e @${G_US} g`, 14)} ${r('water direct', 13)} ${r('water indirect', 15)}`
	);
	for (const v of [10_000, 100_000, 1_000_000, 20_000_000, 100_000_000, 1_000_000_000]) {
		const gap = sharedHosting(1000, v).kwh - drupflare(1000, v);
		console.log(
			`${nr(v, 15)} ${nr(gap, 12)} ${r(`${nr((gap * G_US) / 1000, 0)} kg`, 14)} ${r(`${fr((gap * WATER_DIRECT_L_PER_KWH) / 1000, 0, 2)} kL`, 13)} ${r(`${fr((gap * WATER_INDIRECT_L_PER_KWH) / 1000, 0, 2)} kL`, 15)}`
		);
	}
}
