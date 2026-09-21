/** The two boundaries a critic will look for: the carbon crossover, and the true marginal cost. */
import { num, sweep } from './args.js';
import { f, fr, nr, r } from './fmt.js';

const VIEWS = sweep('views', [10_000, 100_000]);

// --- carbon crossover, hostile (attributional) accounting ---
const CF_SCOPE2_KG = 62_780_000.0;
const REQ_PER_S = 81e6;
const SEC_Y = 31_557_600.0;
const gPerReq = (CF_SCOPE2_KG * 1000.0) / (REQ_PER_S * SEC_Y);
const G_US = num('grid-us', 384.0);
/** one site's share of a RAM-bound host */
const SHARED_KG_SITE = ((1823.0 / 1000.0) * G_US) / 1000.0;

for (const rpv of [1.0, 2.0, 3.0]) {
	// views/yr where drupflare's attributed carbon equals shared hosting's
	const viewsY = (SHARED_KG_SITE * 1000.0) / (rpv * gPerReq);
	console.log(
		`charging ${f(rpv, 0)} CF request(s)/view: crossover at ${nr(viewsY / 12, 12)} views/month/site`
	);
}

console.log(`\nper-request attributed carbon: ${f(gPerReq * 1e6, 3)} ug CO2e`);
console.log(`one site's shared-hosting share: ${f(SHARED_KG_SITE, 3)} kg CO2e/y\n`);

// --- true marginal cost of one more site ---
const SITE_GB = 4.726784 / 1000.0;
const DO_STORE = 0.2;
const DO_REQ = 0.15;
for (const views of VIEWS) {
	const storage = SITE_GB * DO_STORE;
	const doReq = ((views * 0.18) / 1e6) * DO_REQ;
	console.log(
		`marginal cost of site #1001 at ${nr(views, 7)} views/mo: ` +
			`storage $${f(storage, 5)} + DO $${f(doReq, 5)} = $${f(storage + doReq, 5)}/month`
	);
}

console.log('\nsites needed to cover the $25 WfP base at a given price point:');
for (const price of [1.0, 2.0, 3.0, 5.0]) {
	console.log(`  $${f(price, 0)}/site/mo -> ${fr(25.0 / price, 5, 1)} paying sites`);
}
void r;
