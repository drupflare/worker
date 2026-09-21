/**
 * The render fraction, derived from its parts instead of assumed at 1%.
 *
 *   bun scripts/measure/render-fraction.ts
 *   bun scripts/measure/render-fraction.ts --paths=200 --colos=12 --views=100000
 *
 * THIS IS `derived (modelled)` AND NOT A MEASUREMENT. What it replaces is a bare 1% that no file
 * derived. Every input is either measured and cited below or modelled and named; nothing is
 * invented silently.
 *
 * The render fraction is not a free parameter, which is why this is worth computing at all:
 *
 *     renders/window = min( P x L x window/TTL , requests )  +  S x I x L
 *     fraction       = renders / requests
 *
 * P distinct cacheable paths, L colos that see traffic, TTL the edge cache lifetime, S content saves
 * in the window, I pages each save invalidates. Four of the six are measurable.
 *
 * THE CONSEQUENCE THAT MATTERS: the render floor `P x L x window/TTL` does not depend on traffic, so
 * the FRACTION falls as traffic rises. A render fraction is a property of the content-to-traffic
 * ratio for a site, not a constant of the platform, and quoting one number for a fleet is the error.
 *
 * AND A SINGLE-ADDRESS GENERATOR UNDERSTATES IT. `caches.default` is per-colo, so one source address
 * drives L = 1 while real visitors spread over many, and each colo renders a path independently.
 * Every render-fraction reading taken from one machine is a FLOOR. Same shape as the affinity finding
 * in `load-generator-discipline`, one cache layer over.
 */

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
	const args: Args = {};
	for (const a of argv) {
		if (!a.startsWith('--')) continue;
		const [k, v] = a.slice(2).split('=');
		args[k as string] = v === undefined ? true : v;
	}
	return args;
}

/** measured, `src/ops/edge-cache.ts`'s TTL on the front worker's `caches.default` tier */
const TTL_S = 300;

/**
 * Pages an ordinary node save invalidates, measured on a populated site (n=3).
 *
 * The other two shapes measured beside it are a term save at 2 and a save the MAIN MENU references
 * at 34, which was every cached page on that site. A menu-touching save therefore has no scoping
 * benefit at all, so `--pages-per-save=34` is the pessimistic arm rather than a different model.
 */
const PAGES_PER_SAVE = 5;

/** measured 2026-09-21 on bare metal, RAPL package, 2-CPU VPS arm, n=7; see `vps-energy.ts` */
const MJ_RENDER = 368.96;
const MJ_CACHED = 55.07;

/**
 * A diurnal shape, MODELLED and not measured here.
 *
 * Twenty-four relative weights, twin-peaked at late morning and mid-evening with an overnight trough
 * near a quarter of peak, which is the shape published web-traffic curves show. It is named as an
 * input because the trough is what matters: the render floor is flat while traffic is not, so the
 * render fraction PEAKS at the quietest hour and that is where a flat average misleads.
 */
const DIURNAL = [
	0.3, 0.24, 0.2, 0.18, 0.18, 0.22, 0.32, 0.5, 0.7, 0.88, 1.0, 0.98, 0.92, 0.9, 0.88, 0.86, 0.84,
	0.86, 0.92, 0.98, 0.95, 0.8, 0.6, 0.42
];

type Inputs = {
	paths: number;
	colos: number;
	viewsPerMonth: number;
	savesPerDay: number;
	pagesPerSave: number;
	/** Zipf exponent over the path set; 0 is the uniform strawman, ~1 is what web traffic reports near */
	zipf: number;
};

type Result = {
	fraction: number;
	rendersPerDay: number;
	requestsPerDay: number;
	/** the hour whose fraction is worst, which a daily average hides */
	peakHourFraction: number;
	mjPerRequest: number;
};

/**
 * Zipf weights over `paths`, normalised to 1.
 *
 * PER-PATH IS THE WHOLE MODEL AND AN AGGREGATE CLAMP IS WRONG. Renders are
 * `sum_i min(requests_i, window/TTL)`, and `min(sum_i requests_i, P x window/TTL)` only equals it
 * when every path is requested equally. Under a uniform split the two agree, which is exactly why a
 * uniform model looks adequate and is not: real traffic is head-heavy, the head caches well, and the
 * long tail is requested about once and misses every time.
 *
 * `s` is the exponent. s=0 is the uniform strawman, s=1 is the Zipf that web request distributions
 * are usually reported near, and s>1 concentrates harder on the head.
 */
function zipf(paths: number, s: number): number[] {
	const raw = Array.from({ length: paths }, (_, i) => 1 / Math.pow(i + 1, s));
	const h = raw.reduce((a, b) => a + b, 0);
	return raw.map((r) => r / h);
}

/**
 * Renders and requests over a day, hour by hour and path by path.
 *
 * Hourly because the render floor is flat while traffic is not, so a daily average hides that the
 * fraction PEAKS at the quietest hour. Per-path because of the note on `zipf` above. Per-colo
 * because `caches.default` is per-colo and a path's rate is divided across them, which is the term a
 * single-address generator cannot drive.
 */
function model(inp: Inputs): Result {
	const weightSum = DIURNAL.reduce((a, b) => a + b, 0);
	const requestsPerDay = (inp.viewsPerMonth * 12) / 365;
	const share = zipf(inp.paths, inp.zipf);
	const rendersPerColoPerHour = 3600 / TTL_S;
	const invalidationPerDay = inp.savesPerDay * inp.pagesPerSave * inp.colos;

	let renders = 0;
	let worst = 0;
	for (const w of DIURNAL) {
		const reqs = (requestsPerDay * w) / weightSum;
		let hourRenders = 0;
		for (const sh of share) {
			// one path at one colo: it renders once per TTL if it is asked for at least that often,
			// and once per request if it is asked for less often than that
			const perColo = (reqs * sh) / inp.colos;
			hourRenders += inp.colos * Math.min(perColo, rendersPerColoPerHour);
		}
		renders += hourRenders;
		if (reqs > 0) worst = Math.max(worst, hourRenders / reqs);
	}
	renders += Math.min(invalidationPerDay, Math.max(0, requestsPerDay - renders));

	const fraction = requestsPerDay > 0 ? Math.min(1, renders / requestsPerDay) : 0;
	return {
		fraction,
		rendersPerDay: renders,
		requestsPerDay,
		peakHourFraction: worst,
		mjPerRequest: fraction * MJ_RENDER + (1 - fraction) * MJ_CACHED
	};
}

const args = parseArgs(process.argv.slice(2));
const base: Inputs = {
	// 173 of the shipped seed's 423 declared routes carry no {param}; most of those are admin paths
	// that never cache because `$skip_cache` fires on a session cookie. A real content site's P is
	// dominated by its nodes and terms instead, so it is swept below rather than fixed.
	paths: Number(args.paths ?? 100),
	colos: Number(args.colos ?? 8),
	viewsPerMonth: Number(args.views ?? 100_000),
	savesPerDay: Number(args.saves ?? 5),
	pagesPerSave: Number(args['pages-per-save'] ?? PAGES_PER_SAVE),
	zipf: Number(args.zipf ?? 1)
};

console.log('render fraction, derived (modelled). measured inputs:');
console.log(`  edge TTL ${TTL_S}s, pages per ordinary node save ${PAGES_PER_SAVE}`);
console.log(
	`  ${MJ_RENDER} mJ/render and ${MJ_CACHED} mJ/cached serve, RAPL package, 2-CPU VPS arm`
);
console.log('modelled inputs: the diurnal shape, the colo count, and P for a real site\n');

console.log(`P=${base.paths} paths, L=${base.colos} colos, ${base.savesPerDay} saves/day:`);
console.log('  views/site/mo | renders/day | requests/day | fraction | worst hour | mJ/request');
for (const views of [10_000, 100_000, 1_000_000, 20_000_000]) {
	const r = model({ ...base, viewsPerMonth: views });
	console.log(
		`  ${String(views).padStart(13)} | ${r.rendersPerDay.toFixed(0).padStart(11)} | ` +
			`${r.requestsPerDay.toFixed(0).padStart(12)} | ${(100 * r.fraction).toFixed(2).padStart(7)}% | ` +
			`${(100 * r.peakHourFraction).toFixed(1).padStart(9)}% | ${r.mjPerRequest.toFixed(1).padStart(10)}`
	);
}

console.log('\nsensitivity of energy per request to the fraction itself, which is the point:');
for (const f of [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1]) {
	const mj = f * MJ_RENDER + (1 - f) * MJ_CACHED;
	console.log(
		`  fraction ${(100 * f).toFixed(1).padStart(5)}%  ->  ${mj.toFixed(1).padStart(6)} mJ/request` +
			`  (${(mj / MJ_CACHED).toFixed(2)}x the all-cached floor)`
	);
}

console.log('\nthe colo term, which one generator cannot drive:');
for (const colos of [1, 4, 8, 20, 50]) {
	const r = model({ ...base, colos, viewsPerMonth: 20_000_000 });
	console.log(
		`  L=${String(colos).padStart(2)}  fraction ${(100 * r.fraction).toFixed(2).padStart(6)}%` +
			`  ->  ${r.mjPerRequest.toFixed(1)} mJ/request`
	);
}

console.log('\nthe Zipf exponent, which is what "a too-simplistic generator" means here:');
for (const s of [0, 0.6, 0.8, 1, 1.2, 1.5]) {
	const lo = model({ ...base, zipf: s, viewsPerMonth: 100_000 });
	const hi = model({ ...base, zipf: s, viewsPerMonth: 20_000_000 });
	console.log(
		`  s=${s.toFixed(1)}  at 100k views/mo ${(100 * lo.fraction).toFixed(1).padStart(6)}%` +
			`  at 20M views/mo ${(100 * hi.fraction).toFixed(2).padStart(6)}%`
	);
}

// the crossover the economics tables actually rest on
const target = 0.01;
let views = 1_000;
while (views < 1e11 && model({ ...base, viewsPerMonth: views }).fraction > target) views *= 1.2;
console.log(
	`\nthe 1% assumption is first reached at about ${(views / 1e6).toFixed(1)}M views/site/month` +
		` at P=${base.paths}, L=${base.colos}, s=${base.zipf}.`
);
console.log('Below that the assumption understates renders, and the economics tables are built on');
console.log('10k to 20M views/site/month.');

/**
 * THE COLO TERM APPLIES TO A CDN-PLUS-ORIGIN ARM AND NOT TO DRUPFLARE, which is the finding.
 *
 * On a conventional host a per-colo edge miss goes to the ORIGIN and renders. On drupflare it goes to
 * the site's Durable Object, which serves it out of `cfw_page` without booting PHP -- and there is one
 * object per site, not one per colo. So the L multiplier that inflates a conventional host's render
 * count is absorbed, and drupflare's render fraction is set as though L = 1.
 *
 * This is a structural advantage that nothing in the economics model currently claims.
 */
console.log('\nthe same traffic against the two architectures, 20M views/site/month:');
const cdn = model({ ...base, viewsPerMonth: 20_000_000 });
const edge = model({ ...base, viewsPerMonth: 20_000_000, colos: 1 });
console.log(
	`  CDN + origin, L=${base.colos}: ${(100 * cdn.fraction).toFixed(2)}% renders, ` +
		`${cdn.rendersPerDay.toFixed(0)} renders/day`
);
console.log(
	`  drupflare, one object:   ${(100 * edge.fraction).toFixed(2)}% renders, ` +
		`${edge.rendersPerDay.toFixed(0)} renders/day`
);
console.log(
	`  the object absorbs ${(cdn.rendersPerDay / edge.rendersPerDay).toFixed(1)}x the renders, ` +
		`because a per-colo miss reaches a page store rather than an origin`
);
