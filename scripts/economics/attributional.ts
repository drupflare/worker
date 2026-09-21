/**
 * The ATTRIBUTIONAL bound: allocate Cloudflare's whole published footprint across its traffic.
 *
 * The marginal argument, that a request adds only its CPU, is standard and correct, and it is also
 * the argument a critic will not accept. This is the version that concedes everything: every gram
 * Cloudflare emits, divided by every request it serves, charged to us per page view.
 */
import { num, sweep } from './args.js';
import { f, fr, nr } from './fmt.js';

const VIEWS = sweep('views', [10_000, 100_000, 1_000_000]);

const CF_SCOPE2_KG = num('scope2-kg', 62_780_000.0); // Cloudflare 2024 inventory, location-based
const REQ_PER_S = num('req-per-s', 81e6); // Cloudflare published average, 2025
const SECONDS_YEAR = 31_557_600.0;
const G_US = num('grid-us', 384.0);

const reqYear = REQ_PER_S * SECONDS_YEAR;
const gPerReq = (CF_SCOPE2_KG * 1000.0) / reqYear;

console.log(`Cloudflare requests/year        ${nr(reqYear, 20)}`);
console.log(`Scope 2 (location-based)        ${nr(CF_SCOPE2_KG, 20)} kg CO2e`);
console.log(`=> per request                  ${fr(gPerReq, 20, 6)} g CO2e`);
console.log(`   per 1,000 page views         ${fr(gPerReq * 1000, 20, 4)} g CO2e\n`);

// a drupflare page view is not one request: front worker plus possibly a DO hop. Charge THREE.
const REQ_PER_VIEW = num('req-per-view', 3.0);
console.log(`charging ${f(REQ_PER_VIEW, 0)} Cloudflare requests per drupflare page view:`);
for (const views of VIEWS) {
	const kgY = (views * 12 * REQ_PER_VIEW * gPerReq) / 1000.0;
	console.log(`  ${nr(views, 9)} views/mo -> ${fr(kgY, 8, 3)} kg CO2e/y per site`);
}

console.log(
	"\nagainst one site's share of a RAM-bound shared host (from fleet.ts, 1,000 sites/host):"
);
const SHARED_KWH_SITE = 1823.0 / 1000.0;
const sharedKg = (SHARED_KWH_SITE * G_US) / 1000.0;
console.log(`  shared hosting   ${fr(sharedKg, 8, 3)} kg CO2e/y per site`);
for (const views of [10_000, 100_000, 1_000_000]) {
	const kgY = (views * 12 * REQ_PER_VIEW * gPerReq) / 1000.0;
	console.log(
		`  drupflare @${nr(views, 9)}/mo ${fr(kgY, 8, 3)}  -> saving ${fr((1 - kgY / sharedKg) * 100, 6, 1)}%`
	);
}
