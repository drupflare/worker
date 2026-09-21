/**
 * v1.2 business case: the institutional fleet, priced against our real marginal cost.
 *
 * Per-site pricing breaks down above a few hundred sites. A university with thousands of
 * mostly-idle sites wants a licence, and our marginal cost makes that trivially profitable.
 */
import { num } from './args.js';
import { fr, n, nr, r } from './fmt.js';

const WFP_BASE = 25.0;
const MARGINAL_SITE = 0.0012; // measured earlier: storage plus DO requests
const COMMODITY_LO = 6.0;
const COMMODITY_HI = 14.0; // per site per month
const PANTHEON = num('pantheon', 55.0);
const UNIS_WORLD = 50_000;

function cost(sites: number): number {
	return WFP_BASE + sites * MARGINAL_SITE;
}

console.log(
	`${r('institution', 22)} ${r('sites', 7)} ${r('our cost/mo', 12)} ${r('commodity/yr', 24)} ${r('Pantheon/yr', 14)}`
);
for (const [label, sites] of [
	['small college', 300],
	['mid university', 1_500],
	['Dartmouth-shaped', 3_375],
	['large public', 10_000],
	['state system', 50_000]
] as const) {
	const c = cost(sites);
	console.log(
		`${r(label, 22)} ${nr(sites, 7)} ${r('$' + n(c, 2), 12)} ` +
			`${r('$' + n(sites * COMMODITY_LO * 12, 0) + '-' + n(sites * COMMODITY_HI * 12, 0), 24)} ` +
			`${r('$' + n(sites * PANTHEON * 12, 0), 14)}`
	);
}

console.log('\ninstitutional licence, priced for the buyer rather than per site:');
for (const [label, sites, priceMo] of [
	['small college', 300, 250],
	['mid university', 1_500, 900],
	['Dartmouth-shaped', 3_375, 1_500],
	['large public', 10_000, 3_000],
	['state system', 50_000, 10_000]
] as const) {
	const c = cost(sites);
	const rev = priceMo * 12;
	const saveLo = sites * COMMODITY_LO * 12 - rev;
	console.log(
		`  ${r(label, 18)} ${nr(sites, 6)} sites  $${nr(priceMo, 6)}/mo = $${nr(rev, 8)}/yr  ` +
			`margin ${fr(((rev - c * 12) / rev) * 100, 5, 1)}%  buyer saves $${nr(saveLo, 9)}+/yr ` +
			`(${fr((sites * COMMODITY_LO * 12) / rev, 4, 1)}x)`
	);
}

console.log('\naddressable population, conservative:');
for (const [pen, lab] of [
	[0.001, '0.1%'],
	[0.01, '1%'],
	[0.05, '5%']
] as const) {
	const num = UNIS_WORLD * pen;
	console.log(`  ${r(lab, 5)} of ${n(UNIS_WORLD, 0)} universities = ${nr(num, 7)} institutions`);
	for (const [avg, price] of [
		[1_000, 900],
		[3_000, 1_500]
	] as const) {
		console.log(
			`        at ${n(avg, 0)} sites each: ${nr(num * avg, 12)} sites, ` +
				`$${nr(num * price * 12, 13)}/yr revenue`
		);
	}
}
