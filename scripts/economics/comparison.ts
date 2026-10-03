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
import { num, sweep } from './args';
import { PAID_BASE, account, type Bill } from './bill';
import {
	PRODUCTION_SHAPES,
	SMALL_VPS_DENSITY,
	THREADS_PER_HOST,
	productionKwhYear,
	vpsKwhYear,
	type ProductionShape
} from './energy';
import { asCar, asHome, asServers, f, n, nr, r, sfx } from './fmt';
import { MJ_CACHED_VPS, MJ_RENDER_VPS } from './measured';
import { drupflareKwhYearOnMix } from './perview';

const VIEWS = sweep('views', [1_000, 10_000, 100_000, 1_000_000, 10_000_000]);
const SITES = sweep('sites', [1, 10, 100, 1_000]);

const VPS_USD_PER_2VCPU = num('vps-usd', 5.0); // about the cheapest real offer
const RENDER_S_PER_CPU = num('render-s-per-cpu', 56.0); // MEASURED: 67 renders/s on 1.2 cores
const ORIGIN_RENDER_FRAC = num('origin-render-frac', 1.0); // derived, not an assumed CDN hit rate
const PEAK_RATIO = num('peak', 5.0);
const TARGET_UTIL = num('util', 0.5);
const SECONDS_MONTH = 2_629_800.0;
// Pantheon Basic at $500 a year billed annually ($55 billed monthly), pricing page 2026-09-28
const PANTHEON_BASIC = num('pantheon', 500 / 12);
// a latency-matched conventional host: the floor box in each region plus one global load balancer.
// DigitalOcean's global LB is $15/mo (docs, verified 2026-07-13). Three regions still leave most
// visitors tens of ms from an origin where the edge answers from their colo, and no database
// replication is priced, so this too is a floor
const MATCHED_REGIONS = num('regions', 3);
const GLOBAL_LB_USD = num('global-lb', 15.0);

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

const DENSITY = num('density', SMALL_VPS_DENSITY);
const UTIL = num('vps-util', 0.15);
const G_PER_KWH = num('grid-us', 384.0);
const HOME_KWH_Y = 10_791.0; // EIA, average US household purchased electricity
const CAR_T_Y = 4.6; // EPA, one passenger vehicle
const homes = (kwhYear: number) => asHome(kwhYear / HOME_KWH_Y);
const cars = (tonnes: number) => asCar(tonnes / CAR_T_Y);

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
		sites * (vpsKwhYear(DENSITY, UTIL) + vpsWorkKwh - drupflareKwhYearOnMix(views));
	return {
		bill,
		vpsMo: sites * vpsUsdMonth(views),
		managedMo: sites * PANTHEON_BASIC,
		savedKwh,
		savedT: (savedKwh * G_PER_KWH) / 1e6,
		hosts: sites / DENSITY
	};
}

/** what moving sites off a production deployment saves: its whole-year energy against drupflare's */
function productionRow(shape: ProductionShape, sites: number, views: number) {
	const savedKwh = sites * (productionKwhYear(shape) - drupflareKwhYearOnMix(views));
	const hostsPerSite = (shape.regions * shape.nodesPerRegion * shape.vcpu) / THREADS_PER_HOST;
	return { savedKwh, savedT: (savedKwh * G_PER_KWH) / 1e6, hosts: sites * hostsPerSite };
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

// #region crossover
// where the per-site bill meets each conventional price, solved on the real functions: the VPS is
// sized by its render load, so extrapolating the flat low-traffic price would misplace every line
if (process.argv.includes('--crossover')) {
	const perSite = (sites: number, v: number) => account(sites, v).total / sites;
	const first = (sites: number, price: (v: number) => number): number | null => {
		for (let v = 10_000; v <= 1e12; v *= 1.01)
			if (perSite(sites, v) >= price(v)) return Math.round(v);
		return null;
	};
	// the VPS is priced in whole boxes, so drupflare can fall behind and pull ahead again; this is the
	// point above which it stays behind, when there is one
	const last = (sites: number, price: (v: number) => number): number | null => {
		let v = 1e12;
		while (v >= 10_000 && perSite(sites, v) >= price(v)) v /= 1.01;
		return v >= 1e12 ? null : Math.round(v * 1.01);
	};
	const at = (v: number | null) => (v === null ? 'never, to 1T' : `${n(v, 0)} views/site/mo`);
	const band = (sites: number, price: (v: number) => number) => {
		const a = first(sites, price);
		const z = last(sites, price);
		return a === null
			? 'never, to 1T'
			: a === z
				? at(a)
				: `first ${at(a)}, for good above ${at(z)}`;
	};
	for (const sites of [1, 1_000]) {
		console.log(
			`\n${n(sites, 0)} site${sites === 1 ? '' : 's'}: where drupflare stops being the cheaper bill`
		);
		console.log(`  VPS floor            ${band(sites, vpsUsdMonth)}`);
		console.log(`  latency-matched VPS  ${band(sites, matchedUsdMonth)}`);
		console.log(
			`  managed floor        ${at(first(sites, () => PANTHEON_BASIC))} (held flat; a real plan at that traffic is far dearer)`
		);
	}
	console.log('\nper site, 1,000 sites, at hostile traffic');
	for (const v of [10_000_000, 20_000_000, 50_000_000, 100_000_000, 1_000_000_000]) {
		console.log(
			`  ${nr(v, 14)} views/site/mo: drupflare ${usd(perSite(1_000, v))}, VPS ${usd(vpsUsdMonth(v))}, matched ${usd(matchedUsdMonth(v))}`
		);
	}
	process.exit(0);
}
// #endregion

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
	'Against the managed floor',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [n(v, 0), ...SITES.map((st) => versus(st * PANTHEON_BASIC, account(st, v)))])
);

// the paid plan warms every site, so a fleet on it pays for the chain before a visitor arrives
table(
	'What you pay with every site kept warm, the paid plan default',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [n(v, 0), ...SITES.map((st) => yours(account(st, v, 'always')))])
);

table(
	'Kept warm, against the VPS floor',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [
		n(v, 0),
		...SITES.map((st) => versus(st * vpsUsdMonth(v), account(st, v, 'always')))
	])
);

table(
	'Kept warm, against a latency-matched VPS',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [
		n(v, 0),
		...SITES.map((st) => versus(st * matchedUsdMonth(v), account(st, v, 'always')))
	])
);

table(
	'Kept warm, against the managed floor',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [
		n(v, 0),
		...SITES.map((st) => versus(st * PANTHEON_BASIC, account(st, v, 'always')))
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
	['sites', 'electricity', 'carbon', 'servers not built'],
	SITES.map((st) => {
		const d = row(st, REF);
		return [n(st, 0), homes(d.savedKwh), cars(d.savedT), asServers(d.hosts)];
	})
);

const [PRODUCTION, PEAK] = PRODUCTION_SHAPES as [ProductionShape, ProductionShape];

table(
	'Energy avoided per year, against production',
	['views/site/mo', ...siteCols],
	VIEWS.map((v) => [
		n(v, 0),
		...SITES.map((st) => energy(productionRow(PRODUCTION, st, v).savedKwh))
	])
);

table(
	`What that is comparable to against production, at ${n(REF, 0)} views per site per month`,
	['sites', 'against', 'electricity', 'carbon', 'servers not built'],
	SITES.flatMap((st) =>
		(
			[
				['production', PRODUCTION],
				['peak-sized production', PEAK]
			] as const
		).map(([name, shape]) => {
			const d = productionRow(shape, st, REF);
			return [n(st, 0), name, homes(d.savedKwh), cars(d.savedT), asServers(d.hosts)];
		})
	)
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
	`managed       Published. Pantheon Basic $${f(PANTHEON_BASIC, 2)}/mo, billed annually at $500.`
);
console.log('energy        The conventional arm is charged its idle allocation AND the marginal');
console.log('              joules of the work it does, both measured. Per-request energy is at');
console.log(
	'              PARITY between the two runtimes, so the saving is the idle term and the'
);
console.log('              render fraction rather than efficiency.');
