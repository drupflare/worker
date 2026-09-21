/**
 * Scale model with a PERFORMANCE-CONSTRAINED opponent that also has a CDN.
 *
 * Three corrections over fleet.ts, each of which makes the opponent STRONGER:
 *   1. host count is max(memory, throughput-with-headroom), not memory alone
 *   2. the opponent runs a CDN, so its origin sees a fraction of page views
 *   3. embodied carbon is counted, annualised over a 4-year life
 *
 * Sources: Boavizta platform_compute_medium embedded 900 kg CO2e (range 461.8-2089.0), VERIFIED.
 * Dell R6725 PCF 5th/95th 1,976-23,261 kg, VERIFIED; its phase split is reported secondhand and
 * could not be opened, so the 900 kg figure leads and Dell is the cross-check. Uptime 2025 PUE
 * 1.54 weighted average. SPECpower R6725 active idle 135 W. EPA 4.6 t CO2e/passenger vehicle/year.
 * Ember US grid 384 g/kWh. Measured here: VPS 122 req/s anonymous cached at 32 clients on 2 vCPU.
 */
import { num, sweep } from './args.js';
import { fr, nr, r } from './fmt.js';

const SITES = sweep('sites', [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]);

const IDLE_W = 135.0;
const PUE = 1.54;
const G_US = num('grid-us', 384.0);
const HOURS_Y = 8766.0;
const EMBODIED_KG = 900.0;
const LIFE_Y = 4.0;
const CAR_T = 4.6;
const RAM_GB_HOST = 1536.0;
const RAM_GB_SITE = 1.0;
const CORES = 128.0;
const REQ_S_PER_CORE = 122.0 / 2.0; // measured VPS, per vCPU
const SCALING_EFF = 0.7; // 128 cores do not scale linearly; generous to the opponent
const PEAK_RATIO = 5.0; // diurnal peak
const TARGET_UTIL = 0.5; // you size for headroom, not for the peak
// reassigned below to run the no-CDN arm, so `let` rather than `const`: the Python model mutates
// this module global and `hosts_for` reads it, which is the behaviour being reproduced
let CDN_HIT = num('cdn-hit', 0.99); // the fair competitor caches too

function hostsFor(sites: number, viewsMonth: number): [number, number, number] {
	const byRam = sites / (RAM_GB_HOST / RAM_GB_SITE);
	const originViewsS = (sites * viewsMonth * 12 * (1 - CDN_HIT)) / 31_557_600.0;
	const needReqS = (originViewsS * PEAK_RATIO) / TARGET_UTIL;
	const perHost = REQ_S_PER_CORE * CORES * SCALING_EFF;
	const byThr = needReqS / perHost;
	return [Math.max(byRam, byThr, 1.0), byRam, byThr];
}

function burden(sites: number, viewsMonth: number): [number, number, number, number, string] {
	const [h, byRam, byThr] = hostsFor(sites, viewsMonth);
	const kwh = (h * IDLE_W * PUE * HOURS_Y) / 1000.0;
	const opT = (kwh * G_US) / 1e6;
	const embT = (h * EMBODIED_KG) / LIFE_Y / 1000.0;
	return [h, kwh, opT, embT, byRam >= byThr ? 'RAM' : 'THROUGHPUT'];
}

console.log('conventional counterfactual, 10,000 views/site/month, opponent has a 99% CDN\n');
console.log(
	`${r('sites', 12)} ${r('hosts', 9)} ${r('bound by', 10)} ${r('MWh/y', 10)} ${r('op tCO2e', 9)} ${r('emb tCO2e', 10)} ${r('cars', 8)} ${r('kW', 8)}`
);
for (const sites of SITES) {
	const [h, kwh, op, emb, bound] = burden(sites, 10_000);
	console.log(
		`${nr(sites, 12)} ${nr(h, 9)} ${r(bound, 10)} ${nr(kwh / 1000, 10, 1)} ${nr(op, 9)} ${nr(emb, 10)} ` +
			`${nr((op + emb) / CAR_T, 8)} ${nr((kwh * 1000) / HOURS_Y, 8)}`
	);
}

console.log('\nwhere does throughput start to bind, at 1,000 sites? (views/site/month)');
for (const v of [10_000, 100_000, 1_000_000, 10_000_000, 20_000_000]) {
	const [h, byRam, byThr] = hostsFor(1_000, v);
	console.log(
		`  ${nr(v, 12)}: RAM wants ${fr(byRam, 6, 2)} hosts, throughput wants ${fr(byThr, 8, 2)} -> ${fr(h, 7, 1)}`
	);
}

console.log('\nsame, with NO CDN on the opponent (the model fleet.ts used):');
CDN_HIT = 0.0;
for (const v of [10_000, 1_000_000, 20_000_000]) {
	const [h, byRam, byThr] = hostsFor(1_000, v);
	console.log(
		`  ${nr(v, 12)}: RAM ${fr(byRam, 6, 2)}, throughput ${fr(byThr, 8, 2)} -> ${fr(h, 7, 1)} hosts`
	);
}
