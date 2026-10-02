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
import {
	CORES,
	FLOOR_KWH_YEAR,
	HOURS_YEAR,
	IDLE_W,
	PEAK_W,
	PRODUCTION_SHAPES,
	PUE_COLO,
	PUE_HYPER,
	productionKwhYear,
	type ProductionShape
} from './energy';
import { energyKwh, fr, l, nr, pctr, r, sig3 } from './fmt';
import { DRUPFLARE_MS, NATIVE_MS, anonShare, drupflareKwhYearOnMix } from './perview';

const VIEWS = sweep('views', [1_000, 10_000, 100_000, 1_000_000]);
const HIGH_VIEWS = sweep('high-views', [1_000_000, 5_000_000, 10_000_000, 20_000_000]);
// measured.ts carries every figure with its provenance and the guard that stops a cold-path
// render being charged at invalidation frequency
import {
	CACHED_SERVE_TOTAL_MS as CPU_MS_CACHED,
	RENDER_WARM_BIN_MS as CPU_MS_RENDER
} from './measured';

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
	// CPU the fleet actually needs, in core-seconds/year, using the SAME per-request cost as
	// drupflare: this gives the opponent drupflare's efficiency, so the only thing left in the
	// comparison is IDLE and PUE rather than any claim about PHP being faster here
	// the logged-in share of the mix is charged at drupflare's own plan cost, so both arms carry
	// the same views
	const msPerView =
		anonShare * ((1 - renderFrac) * CPU_MS_CACHED + renderFrac * CPU_MS_RENDER) +
		DRUPFLARE_MS.authMix;
	return packHosts(sites, (sites * viewsMonth * 12.0 * msPerView) / 1000.0);
}

/** which per-request cost the shared-hosting arm is charged */
export type SharedArm = 'same-cost' | 'native-nginx' | 'native-fpm';

export const SHARED_ARMS: SharedArm[] = ['same-cost', 'native-nginx', 'native-fpm'];

/**
 * Shared hosting charged the MEASURED native per-request costs, logged-in views included.
 *
 * An anonymous view renders on the opponent's own render fraction and otherwise costs an nginx hit
 * (`nginx`) or a PHP-FPM page-cache hit (`fpm`, no nginx in front); every logged-in view renders
 * natively. Native CPU is lower than the wasm CPU the `same-cost` arm charges, so this arm can lower
 * the fleet saving.
 */
export function sharedHostingNative(
	sites: number,
	viewsMonth: number,
	hit: 'nginx' | 'fpm',
	renderFrac = originRenderFraction(viewsMonth)
): { hosts: number; util: number; kwh: number } {
	const hitMs = hit === 'nginx' ? NATIVE_MS.nginxHit : NATIVE_MS.fpmHit;
	const msPerView =
		anonShare * ((1 - renderFrac) * hitMs + renderFrac * NATIVE_MS.render) + NATIVE_MS.authMix;
	return packHosts(sites, (sites * viewsMonth * 12.0 * msPerView) / 1000.0);
}

/** the arm named, by one name, for tables and tests */
export function sharedHostingArm(arm: SharedArm, sites: number, viewsMonth: number) {
	if (arm === 'same-cost') return sharedHosting(sites, viewsMonth);
	return sharedHostingNative(sites, viewsMonth, arm === 'native-nginx' ? 'nginx' : 'fpm');
}

/**
 * The arm that is LESS favourable to drupflare, which is the one the document quotes: the lowest
 * shared-hosting energy of the three, so the smallest saving.
 */
export function sharedHostingPublished(
	sites: number,
	viewsMonth: number
): { arm: SharedArm; hosts: number; util: number; kwh: number } {
	let best = { arm: SHARED_ARMS[0]!, ...sharedHostingArm(SHARED_ARMS[0]!, sites, viewsMonth) };
	for (const arm of SHARED_ARMS.slice(1)) {
		const s = sharedHostingArm(arm, sites, viewsMonth);
		if (s.kwh < best.kwh) best = { arm, ...s };
	}
	return best;
}

function packHosts(sites: number, cpuS: number): { hosts: number; util: number; kwh: number } {
	const byRam = RAM_GB_HOST / RAM_GB_SITE;
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
	return (
		(1 - drupflareMix(1000, viewsMonth) / sharedHostingPublished(1000, viewsMonth).kwh) * 100
	);
}

/** drupflare's whole-year energy for `sites` sites on the traffic mix, logged-in views included */
export function drupflareMix(sites: number, viewsMonth: number): number {
	return sites * drupflareKwhYearOnMix(viewsMonth);
}

/** first per-site traffic, on a 1% log ladder from 1,000 views, where the saving is under `pct` */
export function firstBelow(pct: number, max = SOLVE_MAX): number | null {
	for (let v = 1_000; v <= max; v *= 1.01) if (saving(v) < pct) return Math.round(v);
	return null;
}

/** drupflare on anonymous views only, at the page-store render fraction; the mix model is `drupflareMix` */
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

/** kWh the published arm of the fleet model avoids a year */
export function fleetGapKwh(sites: number, viewsMonth: number): number {
	return sharedHostingPublished(sites, viewsMonth).kwh - drupflareMix(sites, viewsMonth);
}

export const carbonKg = (kwh: number, gPerKwh = G_US): number => (kwh * gPerKwh) / 1000;
export const waterDirectL = (kwh: number): number => kwh * WATER_DIRECT_L_PER_KWH;
export const waterIndirectL = (kwh: number): number => kwh * WATER_INDIRECT_L_PER_KWH;

/** the rows of the Fleet Energy table */
export const FLEET_TABLE_VIEWS = [
	10_000, 100_000, 1_000_000, 20_000_000, 50_000_000, 100_000_000, 250_000_000, 500_000_000,
	1_000_000_000
];

/** the published estates, at their own average per-site traffic */
export const WORKLOADS: [string, number][] = [
	['Arizona State University (426 sites)', 82_160],
	['Mass.gov (1 site)', 15_000_000],
	['NASA (1 site)', 30_440_000],
	['US news agency, low (47 sites)', 21_300_000],
	['US news agency, high (47 sites)', 42_600_000]
];

if (import.meta.main) {
	console.log('1,000 sites. Opponent = consolidated shared hosting behind a CDN. Three arms:');
	console.log(
		'  same-cost    charged drupflare per-request CPU, logged-in views at its plan cost, so only idle, PUE'
	);
	console.log('               and the render fraction differ');
	console.log(
		'  native-nginx charged the MEASURED native costs, logged-in views included, nginx hit'
	);
	console.log('  native-fpm   the same with the PHP-FPM page-cache hit, no nginx in front');
	console.log(
		'drupflare is the traffic mix, logged-in views included. The published arm is the one'
	);
	console.log('with the smallest saving.\n');
	console.log(
		`${r('views/site/mo', 13)} ${r('shared rnd', 10)} ${r('df rnd', 8)} ${r('drupflare kWh/y', 16)} ${SHARED_ARMS.map((a) => r(`${a} kWh/y`, 22)).join(' ')} ${r('published', 13)} ${r('saving', 9)}`
	);
	for (const v of [...VIEWS, 20_000_000]) {
		const d = drupflareMix(1000, v);
		const arms = SHARED_ARMS.map((a) => sharedHostingArm(a, 1000, v).kwh);
		const pub = sharedHostingPublished(1000, v);
		console.log(
			`${nr(v, 13)} ${pctr(originRenderFraction(v), 10, 2)} ${pctr(pageStoreFraction(v), 8, 3)} ${nr(d, 16, 1)} ${arms.map((k) => nr(k, 22)).join(' ')} ${r(pub.arm, 13)} ${fr((1 - d / pub.kwh) * 100, 8, 3)}%`
		);
	}

	console.log('\nsaving by arm, percent, 1,000 sites');
	console.log(`${r('views/site/mo', 15)} ${SHARED_ARMS.map((a) => r(a, 14)).join(' ')}`);
	for (const v of [10_000, 100_000, 1_000_000, 20_000_000, 100_000_000, 1_000_000_000]) {
		const d = drupflareMix(1000, v);
		console.log(
			`${nr(v, 15)} ${SHARED_ARMS.map((a) => fr((1 - d / sharedHostingArm(a, 1000, v).kwh) * 100, 14, 3)).join(' ')}`
		);
	}

	console.log('\nwhere the saving comes from, 1,000 sites at 10k views/mo:');
	const { hosts, kwh } = sharedHostingPublished(1000, 10_000);
	const d = drupflareMix(1000, 10_000);
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
		const s = sharedHostingPublished(1000, v);
		const df = drupflareMix(1000, v);
		console.log(
			`  ${nr(v, 12)} views/site/mo: ${fr(s.hosts, 6, 1)} hosts at ${pctr(s.util, 5, 1)} util, saving ${fr((1 - df / s.kwh) * 100, 5, 1)}%`
		);
	}

	console.log('\nbeyond any institutional estate: the saving at hostile per-site traffic');
	for (const v of HOSTILE_VIEWS) {
		const s = sharedHostingPublished(1000, v);
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
		`${r('views/site/mo', 15)} ${r('kWh avoided', 12)} ${r(`CO2e @${G_US} g`, 14)} ${r('water direct', 13)} ${r('water indirect', 15)} ${r('water total', 13)}`
	);
	for (const v of [10_000, 100_000, 1_000_000, 20_000_000, 100_000_000, 1_000_000_000]) {
		const gap = fleetGapKwh(1000, v);
		console.log(
			`${nr(v, 15)} ${nr(gap, 12)} ${r(`${nr(carbonKg(gap), 0)} kg`, 14)} ${r(`${fr(waterDirectL(gap) / 1000, 0, 2)} kL`, 13)} ${r(`${fr(waterIndirectL(gap) / 1000, 0, 2)} kL`, 15)} ${r(`${nr(waterDirectL(gap) + waterIndirectL(gap), 0)} L`, 13)}`
		);
	}

	console.log(
		'\nfleet energy table rows, 1,000 sites (shared renders, drupflare renders, saving)'
	);
	for (const v of FLEET_TABLE_VIEWS) {
		console.log(
			`${nr(v, 15)} ${pctr(originRenderFraction(v), 9, 2)} ${r(sig3(pageStoreFraction(v) * 100) + '%', 9)} ${fr(saving(v), 8, 2)}%`
		);
	}

	console.log('\nreal institutional workloads, saving at the estate average per-site traffic');
	for (const [name, v] of WORKLOADS) {
		console.log(`  ${l(name, 34)} ${nr(v, 12)} views/site/mo ${fr(saving(v), 7, 2)}%`);
	}

	console.log(
		`\nper site, per year, derived: energy, CO2e @${G_US} g/kWh, water (direct, indirect)`
	);
	console.log(
		`${l('', 30)} ${r('energy', 11)} ${r('CO2e kg', 9)} ${r('direct L', 10)} ${r('indirect L', 11)}`
	);
	const [matched, peak] = PRODUCTION_SHAPES as [ProductionShape, ProductionShape];
	const perSite: [string, number][] = [
		['production', productionKwhYear(matched)],
		['peak-sized production', productionKwhYear(peak)],
		['worst case, one small VPS', FLOOR_KWH_YEAR],
		['drupflare, 1M views a month', drupflareKwhYearOnMix(1_000_000)]
	];
	for (const [name, kwh] of perSite) {
		console.log(
			`${l(name, 30)} ${r(energyKwh(kwh), 11)} ${r(sig3(carbonKg(kwh)), 9)} ${r(sig3(waterDirectL(kwh)), 10)} ${r(sig3(waterIndirectL(kwh)), 11)}`
		);
	}
	const saved = productionKwhYear(peak) - drupflareKwhYearOnMix(1_000_000);
	console.log(
		`  saved per site against peak-sized: ${energyKwh(saved)}, ${carbonKg(saved).toFixed(1)} kg CO2e, ${(waterDirectL(saved) + waterIndirectL(saved)).toFixed(0)} L water`
	);
}
