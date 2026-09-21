/** What the numbers equate to, at realistic density, with equivalencies. */
import { num, sweep } from './args.js';
import { f, fr, n, nr, r } from './fmt.js';

const SITES = sweep('sites', [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]);

const IDLE_W = 135.0;
const PUE = 1.54;
const G_US = num('grid-us', 384.0);
const HOURS_Y = 8766.0;
const EMBODIED_KG = 900.0;
const LIFE_Y = 4.0;
const CAR_T = 4.6;
const HOME_KWH = 10_791.0; // EIA average US household purchase
const IEA_TWH = 415.0; // global data centre electricity, 2024
const WFP_PER_1K = 26.22; // modelled, 1,000 sites at 10k views
const COMMODITY_LO = 6.0;
const COMMODITY_HI = 14.0; // per site per month, conservative envelope

function rows(density: number): [number, number, number, number, number][] {
	const perHostKwh = (IDLE_W * PUE * HOURS_Y) / 1000.0;
	const out: [number, number, number, number, number][] = [];
	for (const sites of SITES) {
		const hosts = sites / density;
		const kwh = hosts * perHostKwh;
		const opT = (kwh * G_US) / 1e6;
		const embT = (hosts * EMBODIED_KG) / LIFE_Y / 1000.0;
		out.push([sites, hosts, kwh, opT, embT]);
	}
	return out;
}

for (const [density, label] of [
	[1000, 'best case for the opponent (assumed)'],
	[233, 'realistic (Pantheon, 300 hosts)']
] as const) {
	console.log(`\n=== ${label}: ${density} sites/host ===`);
	console.log(
		`${r('sites', 12)} ${r('hosts', 8)} ${r('GWh/y', 9)} ${r('op+emb tCO2e', 13)} ${r('cars', 9)} ${r('homes', 9)} ${r('MW', 7)} ${r('% global DC', 12)}`
	);
	for (const [sites, hosts, kwh, op, emb] of rows(density)) {
		const tot = op + emb;
		console.log(
			`${nr(sites, 12)} ${nr(hosts, 8)} ${nr(kwh / 1e6, 9, 3)} ${nr(tot, 13)} ${nr(tot / CAR_T, 9)} ` +
				`${nr(kwh / HOME_KWH, 9)} ${nr(kwh / HOURS_Y, 7, 1)} ${fr((kwh / 1e9 / IEA_TWH) * 100, 11, 4)}%`
		);
	}
}

console.log('\n=== the money, same workload ===');
console.log(
	`${r('sites', 12)} ${r('commodity $/y', 22)} ${r('drupflare infra $/y', 20)} ${r('saving $/y', 22)}`
);
for (const sites of [1_000, 10_000, 100_000, 1_000_000]) {
	const lo = sites * COMMODITY_LO * 12;
	const hi = sites * COMMODITY_HI * 12;
	const dru = (sites / 1000.0) * WFP_PER_1K * 12;
	console.log(
		`${nr(sites, 12)} ${r('$' + n(lo, 0) + ' - $' + n(hi, 0), 22)} ` +
			`${r('$' + n(dru, 0), 20)} ${r('$' + n(lo - dru, 0) + ' - $' + n(hi - dru, 0), 22)}`
	);
}

console.log('\n=== Dartmouth, 4,500 undergrads, 75% with a site ===');
const sites = Math.trunc(4500 * 0.75);
console.log(`  ${n(sites, 0)} student sites before any departmental estate`);
for (const [density, lab] of [
	[350, 'dense'],
	[233, 'mid'],
	[78, 'sparse']
] as const) {
	const hosts = sites / density;
	const kwh = (hosts * IDLE_W * PUE * HOURS_Y) / 1000.0;
	const op = (kwh * G_US) / 1e6;
	const emb = (hosts * EMBODIED_KG) / LIFE_Y / 1000.0;
	console.log(
		`  ${r(lab, 6)} ${r(density, 4)}/host: ${fr(hosts, 5, 1)} hosts, ${fr(kwh / 1000, 5, 1)} MWh/y, ` +
			`${fr(op + emb, 5, 1)} tCO2e/y, ${fr(kwh / HOME_KWH, 4, 1)} US homes, ${fr((op + emb) / CAR_T, 4, 1)} cars`
	);
}
const lo = sites * COMMODITY_LO * 12;
const hi = sites * COMMODITY_HI * 12;
console.log(`  commodity hosting equivalent: $${n(lo, 0)} - $${n(hi, 0)}/year`);
void f;
