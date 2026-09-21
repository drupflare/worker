/**
 * Density derived from Pantheon's own published architecture, replacing an assumed figure.
 *
 * Published by Pantheon: "hundreds of very large host machines (endpoints)"; "a distributed grid of
 * over a million Linux containers"; "more than 70,000 custom WordPress and Drupal sites"; "more
 * than 210,000 web applications" (dev/test/live per site).
 */
import { num } from './args.js';
import { f, fr, nr, r } from './fmt.js';

const CONTAINERS = 1_000_000;
const APPS = 210_000;
const SITES = 70_000;
const IDLE_W = 135.0;
const PUE_COLO = 1.54;
const HOURS_Y = 8766.0;
const G_US = num('grid-us', 384.0);

console.log(
	`${r('hosts', 6)} ${r('containers/host', 16)} ${r('apps/host', 10)} ${r('sites/host', 11)}`
);
for (const hosts of [200, 300, 500, 900]) {
	console.log(
		`${r(hosts, 6)} ${nr(CONTAINERS / hosts, 16)} ${nr(APPS / hosts, 10)} ${nr(SITES / hosts, 11)}`
	);
}

console.log('\nenergy per SITE per year at each density, host idle-dominated:');
for (const hosts of [200, 300, 500, 900]) {
	const perHostKwh = (IDLE_W * PUE_COLO * HOURS_Y) / 1000.0;
	const sitesPerHost = SITES / hosts;
	const kwhSite = perHostKwh / sitesPerHost;
	console.log(
		`  ${r(hosts, 3)} hosts -> ${nr(sitesPerHost, 6)} sites/host, ` +
			`${fr(kwhSite, 6, 2)} kWh/site/y, ${fr((kwhSite * G_US) / 1000, 5, 2)} kg CO2e/site/y`
	);
}

console.log('\nmy earlier model assumed 1,000 sites on one 1.5 TB host = 1.82 kWh/site/y.');
console.log("Pantheon's own numbers put a real platform at 78 to 350 sites per host,");
console.log('so the opponent is 3x to 13x LESS efficient than I credited it with.');
console.log('\nThe conservative choice is to KEEP the 1,000/host assumption: it is the');
console.log("best case for the opponent and still loses. Recording Pantheon's figure as");
console.log('the realistic case rather than substituting it.');

const best = 1823.0 / 1000.0;
const real = (IDLE_W * PUE_COLO * HOURS_Y) / 1000.0 / (SITES / 300);
console.log(`\n  best case for opponent (assumed): ${f(best, 2)} kWh/site/y`);
console.log(
	`  realistic (Pantheon, 300 hosts):  ${f(real, 2)} kWh/site/y  = ${f(real / best, 1)}x worse`
);
