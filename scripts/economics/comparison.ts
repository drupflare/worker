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
import { BREAK_EVEN_RENDERS_PER_DAY } from '../../src/ops/thermal.js';
import {
	DO_GB_ALLOCATED,
	FREE_QUOTAS,
	PAID_DURATION,
	ROWS_PER_FILL_MEMORY_BINS,
	SECONDS_PER,
	STEADY_STATE_WARMTH,
	WARM_INTERVAL_MS,
	keepWarmFleetCost,
	rowsForWarmthMix
} from '../measure/free-envelope.js';
import { pageStoreFraction } from '../measure/render-fraction.js';
import { num, sweep } from './args.js';
import { drupflareKwhYear, vpsKwhYear } from './energy.js';
import { f, n, nr, r, sfx } from './fmt.js';
import {
	CACHED_SERVE_TOTAL_MS as CPU_CACHED,
	RENDER_WARM_BIN_MS as CPU_RENDER,
	MJ_CACHED_VPS,
	MJ_RENDER_VPS,
	SITE_GB
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
const DO_REQ_RATE = 0.15;
const PAID_DO_REQ_INC = 1e6;
const DAYS_MONTH = 30.44;

const FREE_GBS_DAY = FREE_QUOTAS.durationGbSPerDay;
// the shipping default priced on the warmth mix, from the audit spec's pinned classes. It was a flat
// 25 ("mid of the 2-94 band"), 14x the shipping figure, which made rows written read as binding
const ROWS_PER_FILL = num(
	'rows-per-fill',
	rowsForWarmthMix(STEADY_STATE_WARMTH, ROWS_PER_FILL_MEMORY_BINS)
);
// renders follow saves, not views, so the fraction is per site traffic; --render-frac pins one
const RENDER_FRAC_FLAG = num('render-frac', -1);
const renderFrac = (viewsPerSite: number) =>
	RENDER_FRAC_FLAG >= 0 ? RENDER_FRAC_FLAG : pageStoreFraction(viewsPerSite);
const DO_HIT_FRAC = num('do-hit-frac', 0.18); // share of views that reach the object at all
// wall clock, since duration bills wall clock; the render figure is the envelope's pessimistic one
const RENDER_S = num('render-s', SECONDS_PER.warmRender);
const WARMING = keepWarmFleetCost(1, WARM_INTERVAL_MS);

type Bill = { total: number; free: boolean; binds: string };

/** One bill for the whole account, whatever number of sites share it. */
function account(sites: number, viewsPerSite: number): Bill {
	const v = sites * viewsPerSite;
	const rf = renderFrac(viewsPerSite);
	// thermal.ts keeps a site resident above its break-even render rate, and the chain spends rows
	// and object requests before any visitor arrives
	const warmed = (viewsPerSite * rf) / DAYS_MONTH >= BREAK_EVEN_RENDERS_PER_DAY;
	const warmSites = warmed ? sites : 0;
	const rows = v * rf * ROWS_PER_FILL + warmSites * WARMING.rowsPerDay * DAYS_MONTH;
	const cpuMs = v * ((1 - rf) * CPU_CACHED + rf * CPU_RENDER);
	const doReq = v * DO_HIT_FRAC + warmSites * WARMING.doRequestsPerDay * DAYS_MONTH;
	const gbS = v * (DO_HIT_FRAC * SECONDS_PER.doHit + rf * RENDER_S) * DO_GB_ALLOCATED;
	const storeGb = sites * SITE_GB;

	const perDay = (x: number) => x / DAYS_MONTH;
	const caps: [string, number][] = [
		['requests', perDay(v) / FREE_REQ_DAY],
		['rows written', perDay(rows) / FREE_ROWS_DAY],
		['object requests', perDay(doReq) / FREE_DO_REQ_DAY],
		['duration', perDay(gbS) / FREE_GBS_DAY],
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
		// Durable Object usage over the allowance bills rounded UP to the next million
		Math.ceil(Math.max(0, doReq - PAID_DO_REQ_INC) / 1e6) * DO_REQ_RATE +
		Math.ceil(Math.max(0, gbS - PAID_DURATION.includedGbSPerMonth) / 1e6) *
			PAID_DURATION.usdPerMillionGbS;
	return { total, free: false, binds: binds[0] };
}

const VPS_USD_PER_2VCPU = num('vps-usd', 5.0); // about the cheapest real offer
const RENDER_S_PER_CPU = num('render-s-per-cpu', 56.0); // MEASURED: 67 renders/s on 1.2 cores
const ORIGIN_RENDER_FRAC = num('origin-render-frac', 1.0); // derived, not an assumed CDN hit rate
const PEAK_RATIO = num('peak', 5.0);
const TARGET_UTIL = num('util', 0.5);
const SECONDS_MONTH = 2_629_800.0;
const PANTHEON_BASIC = num('pantheon', 41.0);
// a latency-matched conventional host: the floor box in each region plus one global load balancer.
// DigitalOcean's global LB is $15/mo (docs, verified 2026-07-13). Three regions still leave most
// visitors tens of ms from an origin where the edge answers from their colo, and no database
// replication is priced, so this too is a floor
const MATCHED_REGIONS = num('regions', 3);
const GLOBAL_LB_USD = num('global-lb', 15.0);
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

/** One site served from `MATCHED_REGIONS` regions behind a global load balancer. */
function matchedUsdMonth(views: number): number {
	return MATCHED_REGIONS * vpsUsdMonth(views / MATCHED_REGIONS) + GLOBAL_LB_USD;
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
		(vpsKwhYear(DENSITY, UTIL) +
			vpsWorkKwh -
			drupflareKwhYear(views, renderFrac(views), CPU_RENDER));
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
	['views/site/mo', 'VPS floor', 'latency-matched VPS', 'managed floor'],
	VIEWS.map((v) => [n(v, 0), usd(vpsUsdMonth(v)), usd(matchedUsdMonth(v)), usd(PANTHEON_BASIC)])
);

table(
	'Against the VPS floor',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [n(v, 0), ...SITES.map((st) => versus(st * vpsUsdMonth(v), account(st, v)))])
);

table(
	'Against a latency-matched VPS',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [
		n(v, 0),
		...SITES.map((st) => versus(st * matchedUsdMonth(v), account(st, v)))
	])
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
console.log('first cap     Which free meter is nearest its limit. At the shipping default it is');
console.log('              Worker requests, one per view, until storage binds an idle fleet.');
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
