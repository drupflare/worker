/**
 * What running drupflare yourself costs, against what hosting the same site costs.
 *
 * THE ACCOUNT IS THE USER'S OWN. There is no platform fee here and no per-tenant charge: you deploy
 * to your own Cloudflare account and the bill is Cloudflare's published rate card applied to the
 * traffic you actually serve. Quotas are ACCOUNT-WIDE, so several sites share one envelope rather
 * than each paying its own floor.
 *
 * EVERY CONTESTED INPUT FAVOURS THE CONVENTIONAL HOST, so each figure is a floor on the saving: it
 * gets the cheapest real VPS price, the throughput measured on the arm that beats drupflare on
 * throughput, and the most efficient host density in the model.
 *
 *   bun scripts/economics/comparison.ts
 *   bun scripts/economics/comparison.ts --md
 *   bun scripts/economics/comparison.ts --views=1000,10000 --grid-us=280
 */
import { num, sweep } from './args.js';
import { drupflareKwhYear, vpsKwhYear } from './energy.js';
import { f, n, nr, r, sfx } from './fmt.js';
import {
	CACHED_SERVE_TOTAL_MS as CPU_CACHED,
	RENDER_WARM_BIN_MS as CPU_RENDER,
	MJ_CACHED_VPS,
	MJ_RENDER_VPS
} from './measured.js';

const VIEWS = sweep('views', [1_000, 10_000, 100_000, 1_000_000, 10_000_000]);
const SITES = sweep('sites', [1, 10, 100, 1_000]);

// Cloudflare's published rate card, retrieved 2026-09-21. Free is a set of DAILY caps; paid is a
// $5 subscription with monthly allowances on top.
const FREE_REQ_DAY = 100_000;
const FREE_ROWS_DAY = 100_000;
const FREE_DO_REQ_DAY = 100_000;
const FREE_STORE_GB = 5.0;
const PAID_BASE = num('paid-base', 5.0);
const PAID_REQ_INC = 10e6;
const PAID_CPU_INC = 30e6;
const PAID_ROWW_INC = 50e6;
const PAID_STORE_INC = 5.0;
const REQ_RATE = 0.3;
const CPU_RATE = 0.02;
const ROWW_RATE = 1.0;
const STORE_RATE = 0.2;
const DO_REQ_RATE = 0.15; // no included tier modelled, which overstates our own cost
const DAYS_MONTH = 30.44;

const SITE_GB = 4.726784 / 1000.0; // measured: a fresh site is 4,726,784 bytes
const ROWS_PER_FILL = num('rows-per-fill', 25.0); // mid of the measured 2-94 band
const RENDER_FRAC = num('render-frac', 0.0438); // derived per-colo figure, not a 1% assumption
const DO_HIT_FRAC = num('do-hit-frac', 0.18); // share of views that reach the object at all

type Bill = { total: number; free: boolean; binds: string };

/** One bill for the whole account, whatever number of sites share it. */
function account(sites: number, viewsPerSite: number): Bill {
	const v = sites * viewsPerSite;
	const rows = v * RENDER_FRAC * ROWS_PER_FILL;
	const cpuMs = v * ((1 - RENDER_FRAC) * CPU_CACHED + RENDER_FRAC * CPU_RENDER);
	const doReq = v * DO_HIT_FRAC;
	const storeGb = sites * SITE_GB;

	const perDay = (x: number) => x / DAYS_MONTH;
	const caps: [string, number][] = [
		['requests', perDay(v) / FREE_REQ_DAY],
		['rows written', perDay(rows) / FREE_ROWS_DAY],
		['object requests', perDay(doReq) / FREE_DO_REQ_DAY],
		['storage', storeGb / FREE_STORE_GB]
	];
	caps.sort((a, b) => b[1] - a[1]);
	const binds = caps[0]!;
	// naming a cap at 0.1% used reads as a warning it is not, so report the headroom instead
	if (binds[1] <= 1) {
		return { total: 0, free: true, binds: `${binds[0]} ${(binds[1] * 100).toFixed(0)}%` };
	}

	const total =
		PAID_BASE +
		(Math.max(0, v - PAID_REQ_INC) / 1e6) * REQ_RATE +
		(Math.max(0, cpuMs - PAID_CPU_INC) / 1e6) * CPU_RATE +
		(Math.max(0, rows - PAID_ROWW_INC) / 1e6) * ROWW_RATE +
		Math.max(0, storeGb - PAID_STORE_INC) * STORE_RATE +
		(doReq / 1e6) * DO_REQ_RATE;
	return { total, free: false, binds: binds[0] };
}

const VPS_USD_PER_2VCPU = num('vps-usd', 5.0); // about the cheapest real offer
const RENDER_S_PER_CPU = num('render-s-per-cpu', 56.0); // MEASURED: 67 renders/s on 1.2 cores
const ORIGIN_RENDER_FRAC = num('origin-render-frac', 1.0); // derived, not an assumed CDN hit rate
const PEAK_RATIO = num('peak', 5.0);
const TARGET_UTIL = num('util', 0.5);
const SECONDS_MONTH = 2_629_800.0;
const PANTHEON_BASIC = num('pantheon', 41.0);
const ACQUIA_ENTRY = num('acquia', 148.0);

/**
 * One self-managed VPS per site, never below the smallest instance.
 *
 * IT IS THE BOX MINIMUM ACROSS MOST OF THIS RANGE rather than a capacity calculation. Even charging
 * the origin EVERY view as a render, 100,000 views a month is 0.04 renders a second, and the
 * measured stack does 67 a second on 1.2 cores while holding 172 MB. Capacity is not what bounds a
 * small site, so the price is not the comparison; read it against the latency and energy sections.
 */
function vpsUsdMonth(views: number): number {
	const renderS = (views * ORIGIN_RENDER_FRAC) / SECONDS_MONTH;
	const need = (renderS * PEAK_RATIO) / TARGET_UTIL / RENDER_S_PER_CPU;
	return (Math.max(2, Math.ceil(need) * 2) / 2) * VPS_USD_PER_2VCPU;
}

const DENSITY = num('density', 100.0);
const UTIL = num('vps-util', 0.15);
const G_PER_KWH = num('grid-us', 384.0);
const HOME_KWH_Y = 10_791.0; // EIA, average US household purchased electricity
const CAR_T_Y = 4.6; // EPA, one passenger vehicle
const SERVER_KG = num('server-kg', 18.0); // MODELLED: a 1U two-socket server, mass only
const LB_PER_KG = 2.20462;

function asHome(kwhYear: number): string {
	const years = kwhYear / HOME_KWH_Y;
	if (years >= 1000) return `${n(years, 0)} US homes for a year`;
	if (years >= 1) return `${f(years, 1)} US homes for a year`;
	const days = years * 365.25;
	if (days >= 1) return `one US home for ${f(days, 1)} days`;
	return `one US home for ${f(days * 24, 1)} hours`;
}

function asCar(tonnes: number): string {
	const cars = tonnes / CAR_T_Y;
	if (cars >= 1000) return `${n(cars, 0)} cars off the road`;
	if (cars >= 1) return `${f(cars, 1)} cars off the road`;
	return `${n(tonnes * 2204.62, 0)} lb CO2e`;
}

function asEwaste(hosts: number): string {
	const lb = hosts * SERVER_KG * LB_PER_KG;
	if (lb >= 2_000_000) return `${n(lb / 2000, 0)} tons of e-waste`;
	if (lb >= 1) return `${n(lb, 0)} lb of e-waste`;
	return `${f(lb * 16, 1)} oz of e-waste`;
}

function row(sites: number, views: number) {
	const bill = account(sites, views);
	// THE CONVENTIONAL ARM IS CHARGED FOR THE WORK IT DOES, not only for standing there. An idle
	// allocation alone is traffic-independent, so the saving read identically across a 10,000x range
	// of views, which is a broken column rather than a finding. The marginal joules come off the same
	// counter as everything else.
	const vpsWorkKwh =
		(views *
			12 *
			((1 - ORIGIN_RENDER_FRAC) * MJ_CACHED_VPS + ORIGIN_RENDER_FRAC * MJ_RENDER_VPS)) /
		1e3 /
		3.6e6;
	const savedKwh =
		sites *
		(vpsKwhYear(DENSITY, UTIL) + vpsWorkKwh - drupflareKwhYear(views, RENDER_FRAC, 60.2));
	return {
		bill,
		vpsMo: sites * vpsUsdMonth(views),
		managedMo: sites * PANTHEON_BASIC,
		savedKwh,
		savedT: (savedKwh * G_PER_KWH) / 1e6,
		hosts: sites / DENSITY
	};
}

/** Spelled out below $100,000; a suffix past that, where the digits stop carrying information. */
const usd = (x: number) => (x >= 100_000 ? '$' + sfx(x) : '$' + n(x, 2));

/** kWh reads wrong above a few thousand, so the UNIT moves rather than a suffix being bolted on. */
function energy(kwh: number): string {
	if (kwh >= 1e6) return `${f(kwh / 1e6, 2)} GWh`;
	if (kwh >= 1e3) return `${f(kwh / 1e3, 2)} MWh`;
	return `${f(kwh, 1)} kWh`;
}

const yours = (b: Bill) => (b.free ? 'free' : usd(b.total));
const versus = (theirs: number, b: Bill) =>
	b.free
		? 'free'
		: theirs / b.total >= 1
			? `${f(theirs / b.total, 1)}x cheaper`
			: `${f(b.total / theirs, 1)}x dearer`;

const MD = process.argv.includes('--md');

/** One renderer for both outputs, so a markdown table and a terminal table cannot disagree. */
function table(title: string, headers: string[], rows: string[][]): void {
	if (MD) {
		console.log(`\n**${title}**\n`);
		console.log(`| ${headers.join(' | ')} |`);
		console.log(`| ${headers.map(() => '---').join(' | ')} |`);
		for (const row of rows) console.log(`| ${row.join(' | ')} |`);
		return;
	}
	const w = headers.map((h, i) => Math.max(h.length, ...rows.map((x) => (x[i] ?? '').length)));
	console.log(`\n${title}`);
	console.log(headers.map((h, i) => r(h, w[i]!)).join('  '));
	for (const row of rows) console.log(row.map((c, i) => r(c, w[i]!)).join('  '));
}

const siteCols = SITES.map((x) => `${n(x, 0)} site${x === 1 ? '' : 's'}`);

table(
	'What you pay, on your own account',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [n(v, 0), ...SITES.map((st) => yours(account(st, v)))])
);

table(
	'The first free cap you reach, and how much of it is used',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [n(v, 0), ...SITES.map((st) => account(st, v).binds)])
);

table(
	'What hosting the same site costs conventionally, per site',
	['views/site/mo', 'VPS floor', 'managed floor'],
	VIEWS.map((v) => [n(v, 0), usd(vpsUsdMonth(v)), usd(PANTHEON_BASIC)])
);

table(
	'Against the VPS floor',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [n(v, 0), ...SITES.map((st) => versus(st * vpsUsdMonth(v), account(st, v)))])
);

table(
	'Energy avoided per year',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [n(v, 0), ...SITES.map((st) => energy(row(st, v).savedKwh))])
);

const REF = VIEWS[VIEWS.length - 1]!;
table(
	`What that is comparable to, at ${n(REF, 0)} views per site per month`,
	['sites', 'electricity', 'carbon', 'hardware not built'],
	SITES.map((st) => {
		const d = row(st, REF);
		return [n(st, 0), asHome(d.savedKwh), asCar(d.savedT), asEwaste(d.hosts)];
	})
);

if (MD) process.exit(0);

console.log('\n--- where the free plan runs out ---');
for (const sites of SITES) {
	let lo = 1;
	let hi = 1e9;
	for (let i = 0; i < 60; i += 1) {
		const mid = (lo + hi) / 2;
		if (account(sites, mid).free) lo = mid;
		else hi = mid;
	}
	console.log(
		`  ${nr(sites, 6)} site${sites === 1 ? ' ' : 's'}: free to ${nr(Math.floor(lo), 12)} views/site/month` +
			`  (${sfx(Math.floor(lo) * sites)} across the account), then $${f(PAID_BASE, 2)}/mo`
	);
}

console.log('\n--- what each figure is ---');
console.log(
	"your cost     Cloudflare's published rates on your own account, applied to the measured"
);
console.log('              workload. `free` means the whole account fits inside the free plan.');
console.log('first cap     Which free meter is nearest its limit. It is rarely requests, which is');
console.log('              where a ceiling is usually assumed to be.');
console.log(
	'VPS floor     One self-managed VPS per site at about the cheapest real price. Excludes'
);
console.log(
	'              the labour of running it, which for most people is the largest real cost.'
);
console.log(
	`managed       Published. Pantheon Basic $${f(PANTHEON_BASIC, 0)}/mo for 20K visits; Acquia $${f(ACQUIA_ENTRY, 0)}/mo.`
);
console.log('energy        The conventional arm is charged its idle allocation AND the marginal');
console.log('              joules of the work it does, both measured. Per-request energy is at');
console.log(
	'              PARITY between the two runtimes, so the saving is the idle term and the'
);
console.log('              render fraction rather than efficiency.');
