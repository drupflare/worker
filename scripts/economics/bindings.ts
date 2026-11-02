/**
 * Service bindings, Worker invocations and R2: the per-request terms the model does not charge, and
 * what each one moves.
 *
 *   bun scripts/economics/bindings.ts
 *
 * The shipped model charges a view its measured CPU at the watts per core and PUE in energy.ts. A
 * Worker-to-Worker call is a separate invocation with its own CPU and no request fee. An R2 binding
 * read is a subrequest of the invocation that makes it, so it adds no invocation. Every figure here is
 * `derived (modelled)` from the CPU readings below, each with its source. Where a term has no reading,
 * the arms bracket it and nothing is reported as a point value.
 */
import { TRAFFIC_MIX } from '../measure/verdict-math';
import { account, type Warming } from './bill';
import { PRODUCTION_SHAPES, PUE_HYPER, W_PER_CORE, productionKwhYear } from './energy';
import { f, l, n, nr, r } from './fmt';
import { CACHED_SERVE_TOTAL_MS } from './measured';
import { drupflareKwhYearOnMix, drupflareRenderRate } from './perview';
import { DURABLE_OBJECTS, R2, SERVICE_BINDINGS, WORKERS_PAID } from './rates';

// measured CPU, each with its source. cpuTime is 1 ms granular per invocation, so a sub-ms figure is
// a p50 over many invocations, never a single sample.

/** whole front-worker request on the anonymous edge tier, p50, deployed free worker, 2026-09-10 */
export const EDGE_HIT_P50_MS = 0.703;
/** the same tier's p90, the same 17,412-request window */
export const EDGE_HIT_P90_MS = 1.174;
/** front worker on a cached object serve, deployed paid workers, 2026-09-14; n not recorded */
export const FRONT_CACHED_MS = 1.1;
/** Durable Object on a cached object serve, the same workers and date; n not recorded */
export const DO_HIT_MS = 0.7;
/** a Worker invocation that returns an image file with spool off, cpuTime, n=185, 2026-10-23 */
export const FILE_INVOCATION_MS = { median: 1, p90: 3, max: 9, n: 185 } as const;

/**
 * The bracket for one more Worker invocation per view. The upper value is the caller-side cost of a
 * cached object serve, a stand-in for a Worker-to-Worker call whose callee CPU is unmeasured.
 */
export const EXTRA_MS = { none: 0, upper: FRONT_CACHED_MS } as const;

/** Worker and Durable Object invocations one request makes on each path, with the reading behind it */
export const PATHS = {
	edgeHit: {
		workerInvocations: 1,
		durableObjectInvocations: 0,
		source: 'caches.default answers in the front worker; TECHNICAL_REPORT page-memo, 2026-09-10'
	},
	objectHit: {
		workerInvocations: 1,
		durableObjectInvocations: 1,
		source: 'front worker plus object; measured.ts CACHED_SERVE_TOTAL_MS'
	},
	render: {
		workerInvocations: 1,
		durableObjectInvocations: 1,
		source: 'measured.ts RENDER_WARM_BIN_MS is Durable Object cpuTime; front worker CPU unmeasured'
	},
	staticAsset: {
		workerInvocations: 0,
		durableObjectInvocations: 0,
		source: 'Workers pricing: static asset requests are free and unlimited; results/90'
	},
	r2PublicBucket: {
		workerInvocations: 0,
		durableObjectInvocations: 0,
		source: 'R2 public bucket on a custom domain; docs/configuration/serving/index.md; no Worker in the path'
	},
	r2ThroughWorker: {
		workerInvocations: 1,
		durableObjectInvocations: 0,
		source: 'R2 read is a subrequest of the same invocation; one invocation stands in for its CPU'
	},
	serviceBindingHop: {
		workerInvocations: 2,
		durableObjectInvocations: 0,
		source: 'Worker to Worker: caller and callee are two invocations; no request fee'
	}
} as const;

/** mJ a view costs per ms of Worker CPU at the model's watts per core and PUE; 1 W for 1 ms is 1 mJ */
export const mjPerMs = (): number => W_PER_CORE * PUE_HYPER;

/** mJ a view adds for `extraMs` of CPU on every view */
export const extraMjPerView = (extraMs: number): number => extraMs * mjPerMs();

const J_PER_KWH = 3.6e6;

/** kWh a year one site adds for `extraMs` of CPU on every view */
export function extraKwhYear(viewsMonth: number, extraMs: number): number {
	return ((extraMjPerView(extraMs) / 1000) * viewsMonth * 12) / J_PER_KWH;
}

/** the whole-year headline with `extraMs` of CPU added to every view, against the matched production shape */
export function headlineWithExtra(viewsMonth: number, extraMs: number) {
	const production = productionKwhYear(PRODUCTION_SHAPES[0]!);
	const drupflareKwh = drupflareKwhYearOnMix(viewsMonth) + extraKwhYear(viewsMonth, extraMs);
	return {
		drupflareKwh,
		productionKwh: production,
		multiple: production / drupflareKwh,
		saving: (1 - drupflareKwh / production) * 100
	};
}

/**
 * kWh a year the front worker adds to the renders: the render figure is Durable Object CPU only, so a
 * render also pays one front-worker invocation at the cached-serve reading.
 */
export function renderFrontKwhYear(viewsMonth: number): number {
	const renders = drupflareRenderRate(viewsMonth) * viewsMonth * 12;
	return (renders * extraMjPerView(FRONT_CACHED_MS)) / 1000 / J_PER_KWH;
}

/**
 * mJ a view the shipped 1.8 ms cached serve charges above the edge tier's measured p50, weighted by the
 * edge share of the mix. Reported as a sensitivity: the shipped constant is not changed here.
 */
export function edgeRebaseMjPerView(): number {
	return (
		TRAFFIC_MIX['anon-cached']!.weight * extraMjPerView(CACHED_SERVE_TOTAL_MS - EDGE_HIT_P50_MS)
	);
}

/** the account bill for a number of sites at one traffic level, with the upper-bound CPU and the request what-if */
export function billArms(sites: number, viewsPerSite: number, warming: Warming) {
	return {
		base: account(sites, viewsPerSite, warming).total,
		extraCpu: account(sites, viewsPerSite, warming, { cpuMs: EXTRA_MS.upper }).total,
		hopAsRequest: account(sites, viewsPerSite, warming, { requests: 1 }).total
	};
}

/** a page mirrored to R2 costs this much a month to store, per 1,000 pages of `pageBytes` (one page, n=1) */
export function r2StoragePerThousandPagesUsd(pageBytes: number): number {
	return (1000 * pageBytes * R2.usdPerGbMonth) / 1e9;
}

if (import.meta.main) {
	const views = [10_000, 100_000, 1_000_000, 10_000_000, 30_000_000];

	console.log('invocations per request, and the reading behind each count\n');
	console.log(`${l('path', 18)} ${r('worker', 7)} ${r('object', 7)}  source`);
	for (const [name, p] of Object.entries(PATHS)) {
		console.log(
			`${l(name, 18)} ${r(p.workerInvocations, 7)} ${r(p.durableObjectInvocations, 7)}  ${p.source}`
		);
	}

	console.log('\nthe bracket for one more Worker invocation per view (derived (modelled))');
	console.log(
		`  ${f(EXTRA_MS.upper, 2)} ms = ${f(extraMjPerView(EXTRA_MS.upper), 2)} mJ a view at ${f(mjPerMs(), 4)} mJ per ms`
	);

	console.log(
		'\nthe whole-year headline, one site, idle included on the production side (derived (modelled))'
	);
	console.log(
		`${r('views/mo', 11)} ${r('shipped Wh', 11)} ${r('+1 invoc Wh', 12)} ${r('shipped x', 10)} ${r('+1 x', 10)} ${r('shipped %', 10)} ${r('+1 %', 10)}`
	);
	for (const v of views) {
		const a = headlineWithExtra(v, 0);
		const b = headlineWithExtra(v, EXTRA_MS.upper);
		console.log(
			`${nr(v, 11)} ${r(f(a.drupflareKwh * 1000, 2), 11)} ${r(f(b.drupflareKwh * 1000, 2), 12)} ${r(n(a.multiple, 0), 10)} ${r(n(b.multiple, 0), 10)} ${r(f(a.saving, 4), 10)} ${r(f(b.saving, 4), 10)}`
		);
	}
	const r1m = renderFrontKwhYear(1_000_000);
	console.log(
		`\nrender front-worker CPU, +${f(FRONT_CACHED_MS, 2)} ms a render: ${f(r1m * 1000, 4)} Wh a year at 1M ` +
			`(${f((r1m / headlineWithExtra(1_000_000, 0).drupflareKwh) * 100, 3)}% of shipped)`
	);
	console.log(
		`edge tier sensitivity, not applied: ${f(edgeRebaseMjPerView(), 3)} mJ a view at the mix, ` +
			`from ${f(CACHED_SERVE_TOTAL_MS, 2)} ms to the ${f(EDGE_HIT_P50_MS, 3)} ms p50`
	);
	const e1m = headlineWithExtra(1_000_000, 0).drupflareKwh;
	console.log(
		`  at 1M views the shipped figure would fall ${f(
			((edgeRebaseMjPerView() * 12 * 1_000_000) / 1000 / J_PER_KWH) * 1000,
			2
		)} Wh a year, from ${f(e1m * 1000, 2)} Wh`
	);

	console.log('\nthe bill, thousand sites, paid plan (derived (modelled))');
	console.log(
		`${r('views/site', 11)} ${r('warming', 8)} ${r('shipped', 10)} ${r('+1 invoc', 10)} ${r('hop as req', 11)}`
	);
	for (const v of [10_000, 100_000, 1_000_000]) {
		for (const w of ['thermal', 'always'] as const) {
			const b = billArms(1000, v, w);
			console.log(
				`${nr(v, 11)} ${l(w, 8)} ${r(`$${f(b.base, 2)}`, 10)} ${r(`$${f(b.extraCpu, 2)}`, 10)} ${r(`$${f(b.hopAsRequest, 2)}`, 11)}`
			);
		}
	}

	console.log('\nper million views, paid plan after the included allowances (derived)');
	const cpuUsd = (ms: number) => ms * WORKERS_PAID.usdPerMillionCpuMs;
	const reqUsd = WORKERS_PAID.usdPerMillionRequests;
	console.log(`  worker request, one per view           $${f(reqUsd, 2)}`);
	console.log(
		`  edge hit CPU ${f(EDGE_HIT_P50_MS, 3)} ms             $${f(cpuUsd(EDGE_HIT_P50_MS), 4)}`
	);
	console.log(
		`  object hit CPU ${f(CACHED_SERVE_TOTAL_MS, 2)} ms          $${f(cpuUsd(CACHED_SERVE_TOTAL_MS), 4)}`
	);
	console.log(
		`  object hit, Durable Object request     $${f(DURABLE_OBJECTS.usdPerMillionRequests, 2)}`
	);
	console.log(
		`  service hop CPU ${f(FRONT_CACHED_MS, 2)} ms, no request fee   $${f(cpuUsd(FRONT_CACHED_MS), 4)}`
	);
	console.log(`  R2 Class B read, no cache absorption   $${f(R2.usdPerMillionClassB, 2)}`);
	console.log(`  R2 Class A write, one per fill         $${f(R2.usdPerMillionClassA, 2)}`);
	console.log(
		`  R2 storage, per 1,000 pages of ${f(17.2, 1)} KB  $${f(r2StoragePerThousandPagesUsd(17_200), 6)} a month`
	);
	console.log(`  billed-request rule: "${SERVICE_BINDINGS.quote}"`);
}
