/**
 * What spool does to the request meter and the bill.
 *
 *   bun scripts/economics/spool.ts
 *   bun scripts/economics/spool.ts --views-month=1000000 --sites=100
 *
 * Spool's own files are static assets, which are not Worker invocations. A device's worker fetches a
 * page the first time it sees it, in place of the document the browser would have sent, and answers a
 * page it holds with no request, so a device never sends the Worker more requests than it would with
 * spool off ({@link SPOOL_REQUESTS}, `measured` on a demo site, local and paid-deployed, n=1). The
 * saving depends on views a device makes and distinct pages it visits; neither is read off a real
 * site, so every population table here is `derived (modelled)` over a sweep. The server CPU spool adds
 * to a page it decorates is the paid-account median from {@link SPOOL_DEVICE}; the free-plan figure
 * against the 10 ms handler cap is not measured.
 */
import {
	COST_PER_VIEW,
	DEFAULT_MIX,
	envelope,
	FREE_QUOTAS,
	ROWS_PER_FILL_MEMORY_BINS,
	SHIPPING_ROWS_PER_FILL,
	WORDPRESS_RENDER_SECONDS,
	WORDPRESS_ROWS_PER_FILL,
	type Envelope
} from '../measure/free-envelope';
import { sweep } from './args';
import { account, DAYS_MONTH, PAID_BASE } from './bill';
import { PUE_HYPER, W_PER_CORE } from './energy';
import { f, l, n, pct, r } from './fmt';
import {
	CACHED_SERVE_TOTAL_MS,
	RENDER_WARM_BIN_MS,
	SPOOL_DEVICE,
	SPOOL_REQUESTS
} from './measured';
import { WORKERS_PAID } from './rates';

/** the per-device request constants as plain numbers, so a sweep can replace one */
export type Requests = { [K in keyof typeof SPOOL_REQUESTS]: number };

/** which client a visit comes from: one whose worker controls the page, or no spool at all */
export type Engine = 'worker' | 'none';

/**
 * One visit of one new device: `views` page views of `distinct` distinct pages. A page the device
 * holds costs no request, so `distinct` bounds what the worker fetches.
 */
export interface Visit {
	views: number;
	distinct: number;
	returnDays?: number;
	writes?: number;
}

/** the Worker requests of a visit, split by what the meters price differently */
export interface Load {
	documents: number;
	contacts: number;
	writes: number;
}

/** the 121-view session of the spool repo on the demo site's nine pages; the page count is the demo site's, not a real site's */
export const MIX_121: Visit = { views: 121, distinct: 9 };

/** the 2,000-view tab, a bound: one device that never leaves the page runtime, on the demo site's nine pages */
export const TAB_2000: Visit = { views: 2000, distinct: 9 };

/** the share of visits whose device runs a worker; the rest run no spool. No real site's split is measured */
export interface Population {
	worker: number;
}

/** sweep inputs: shares of visits that run a worker, each a guess */
export const WORKER_SHARES = [0.5, 0.75, 1];

/** sweep inputs: views one visit makes */
export const VIEWS_PER_VISIT = [2, 5, 10, 20, 50, 121];

/** sweep inputs: distinct pages one visit reaches */
export const DISTINCT_PAGES = [1, 3, 9, 20, 50];

/** sweep inputs: requests a device adds beyond its documents and fetches, for a client no reading covers */
export const DEVICE_EXTRAS = [0, 1, 2];

const clampDistinct = (v: Visit): number => Math.min(Math.max(v.distinct, 1), v.views);

/** a visit as it would be with spool off: every view a document, every return day another */
export function loadOff(v: Visit): Load {
	return { documents: v.views + (v.returnDays ?? 0), contacts: 0, writes: v.writes ?? 0 };
}

/**
 * The Worker requests of a visit whose device runs a worker. The first `documentsBeforeControl` views
 * reach the network, later views fetch a page only the first time, and a held page costs `heldView`.
 * A page seen before the worker controlled is not held, so this is an upper bound that assumes every
 * such page is visited again; {@link sequenceDocuments} counts an actual path.
 */
export function workerLoad(v: Visit, k: Requests = SPOOL_REQUESTS): Load {
	const before = Math.min(v.views, k.documentsBeforeControl);
	const later = v.views - before;
	const fetches = Math.min(later, clampDistinct(v));
	const extra = v.views > 1 ? k.deviceExtra : 0;
	return {
		documents: before + fetches + (later - fetches) * k.heldView + extra,
		contacts: (v.returnDays ?? 0) * k.returnDayContact,
		writes: v.writes ?? 0
	};
}

/** the Worker requests of a visit with spool on, for one kind of client */
export function visitLoad(v: Visit, engine: Engine, k: Requests = SPOOL_REQUESTS): Load {
	return engine === 'none' ? loadOff(v) : workerLoad(v, k);
}

/**
 * The Worker documents a worker-controlled device sends over a sequence of page views. Views before
 * control are network documents; after it, a page the worker has not fetched is one request and a
 * page it holds costs `heldView`.
 */
export function sequenceDocuments(path: readonly string[], k: Requests = SPOOL_REQUESTS): number {
	const held = new Set<string>();
	let documents = path.length > 1 ? k.deviceExtra : 0;
	path.forEach((page, i) => {
		if (i < k.documentsBeforeControl) documents += 1;
		else if (held.has(page)) documents += k.heldView;
		else {
			documents += 1;
			held.add(page);
		}
	});
	return documents;
}

/** the page sequence the measurement rig walks: the front page, then article 1 to 8 with the front page between each, wrapping */
export function rigPath(views: number): string[] {
	const path = ['/'];
	for (let i = 1; i < views; i++) {
		path.push(i % 2 === 1 ? `/node/${(((i - 1) / 2) % 8) + 1}` : '/');
	}
	return path;
}

/** one cell of the device matrix: Worker-class requests of a visit, and of the visit plus one returning view of the front page */
export interface MatrixPoint {
	views: number;
	off: number;
	on: number;
	offReturn: number;
	onReturn: number;
}

/**
 * Worker-class requests per device on the local rig, `measured`: network documents, service-worker
 * page fetches and spool endpoints, static assets excluded, Chromium headless, demo site of nine
 * pages, n=1 per cell, no spread. Source: `scripts/measure/spool-deployed.ts --compare-devices`.
 */
export const MATRIX: readonly MatrixPoint[] = [
	{ views: 1, off: 1, on: 1, offReturn: 2, onReturn: 2 },
	{ views: 2, off: 2, on: 2, offReturn: 3, onReturn: 3 },
	{ views: 3, off: 3, on: 3, offReturn: 4, onReturn: 3 },
	{ views: 5, off: 5, on: 4, offReturn: 6, onReturn: 4 },
	{ views: 10, off: 10, on: 7, offReturn: 11, onReturn: 7 },
	{ views: 20, off: 20, on: 11, offReturn: 21, onReturn: 11 },
	{ views: 100, off: 100, on: 11, offReturn: 101, onReturn: 11 }
];

/**
 * The paid deployed fixed session, `measured` from Workers Observability events, n=1: a first view
 * and 20 clicks, then a reload and a repeat visit. Source: `fixon.json` and `fixoff.json`.
 */
export const DEPLOYED_SESSION = { views: 21, tail: 2, on: 12, off: 23 };

/** the model's counts for the matrix at the local rig's two documents before control, and their residuals (model minus measured) */
export function matrixResiduals(k: Requests = { ...SPOOL_REQUESTS, documentsBeforeControl: 2 }) {
	return MATRIX.map((m) => {
		const path = rigPath(m.views);
		const back = [...path, '/'];
		return {
			views: m.views,
			on: sequenceDocuments(path, k) - m.on,
			onReturn: sequenceDocuments(back, k) - m.onReturn,
			off: path.length - m.off,
			offReturn: back.length - m.offReturn
		};
	});
}

/** the model's count for the deployed session and its residuals; the worker took control one view later there */
export function deployedResiduals(k: Requests = SPOOL_REQUESTS) {
	const path = rigPath(DEPLOYED_SESSION.views);
	const held = path[path.length - 1]!;
	const full = [...path, ...Array<string>(DEPLOYED_SESSION.tail).fill(held)];
	return {
		on: sequenceDocuments(full, k) - DEPLOYED_SESSION.on,
		off: full.length - DEPLOYED_SESSION.off
	};
}

const total = (x: Load): number => x.documents + x.contacts + x.writes;

/** the visit's load averaged over the clients of a population */
export function populationLoad(v: Visit, pop: Population, k: Requests = SPOOL_REQUESTS): Load {
	const on = visitLoad(v, 'worker', k);
	const off = visitLoad(v, 'none', k);
	const mix = (a: number, b: number) => pop.worker * a + (1 - pop.worker) * b;
	return {
		documents: mix(on.documents, off.documents),
		contacts: mix(on.contacts, off.contacts),
		writes: mix(on.writes, off.writes)
	};
}

/** Worker requests one view costs on average over a population; with spool off it is 1 plus writes and returns */
export const requestsPerView = (v: Visit, pop: Population, k: Requests = SPOOL_REQUESTS): number =>
	total(populationLoad(v, pop, k)) / v.views;

/** views a day the free plan's request cap carries at that many Worker requests a view */
export const freeViewsPerDay = (perView: number): number =>
	FREE_QUOTAS.workerRequestsPerDay / perView;

/** views a month, at the model's month */
export const freeViewsMonth = (perView: number): number => freeViewsPerDay(perView) * DAYS_MONTH;

/**
 * The net floor of capacity: the views a day the free plan's 100,000 Worker requests carry when every
 * visit reaches a new page on every view, which is the shape that costs spool the most per view. With
 * spool off the same figure is the cap itself, and a device never costs more than off, so any term
 * that lowers the floor below the cap is a request added per device, `deviceExtra`.
 */
export function netFloor(
	k: Requests = SPOOL_REQUESTS,
	maxViews = 500
): { viewsPerDay: number; atViews: number; perView: number } {
	let worst = { viewsPerDay: Infinity, atViews: 1, perView: 1 };
	for (let views = 1; views <= maxViews; views++) {
		const perView = total(workerLoad({ views, distinct: views }, k)) / views;
		if (freeViewsPerDay(perView) < worst.viewsPerDay) {
			worst = { viewsPerDay: freeViewsPerDay(perView), atViews: views, perView };
		}
	}
	return worst;
}

/** the capacity when every visitor makes one view and never returns, which is the cap whatever spool does */
export function firstViewFloor(k: Requests = SPOOL_REQUESTS): number {
	return freeViewsPerDay(total(workerLoad({ views: 1, distinct: 1 }, k)));
}

/** views a visit of `distinct` pages must reach before spool sends the Worker fewer requests than the same visit would have; undefined when it never does */
export function breakEvenViews(distinct: number, k: Requests = SPOOL_REQUESTS): number | undefined {
	for (let views = 2; views <= 10_000; views++) {
		const v = { views, distinct };
		if (total(workerLoad(v, k)) < total(loadOff(v))) return views;
	}
	return undefined;
}

/** the envelope's spool input for a visit over a population: documents and contacts per view */
export function envelopeInput(
	v: Visit,
	pop: Population,
	missScale?: number
): { documentsPerView: number; contactsPerView: number; missScale?: number } {
	const load = populationLoad(v, pop);
	return {
		documentsPerView: load.documents / v.views,
		contactsPerView: load.contacts / v.views,
		...(missScale === undefined ? {} : { missScale })
	};
}

/** the two arms the regeneration ceiling is read for: Drupal at the shipping default and WordPress on its deployed wall */
export type Arm = 'drupal' | 'wordpress';

/** the free-plan envelope for one arm, with spool's requests per view when `spool` is given */
export function armEnvelope(arm: Arm, spool?: ReturnType<typeof envelopeInput>): Envelope {
	return arm === 'drupal'
		? envelope(DEFAULT_MIX, { rowsPerFill: SHIPPING_ROWS_PER_FILL, spool })
		: envelope(DEFAULT_MIX, {
				rowsPerFill: WORDPRESS_ROWS_PER_FILL,
				renderSeconds: WORDPRESS_RENDER_SECONDS.p50,
				spool
			});
}

/** Workers CPU a decorated page costs over an undecorated one, the difference of two paid-account medians in whole milliseconds */
export const DECORATION_CPU_MS =
	SPOOL_DEVICE.workerCpu.pageOn.median - SPOOL_DEVICE.workerCpu.pageOff.median;

/** dollars one Worker request costs past the plan's allowance, plus its CPU at the given milliseconds */
export const marginalUsdPerRequest = (cpuMs: number): number =>
	WORKERS_PAID.usdPerMillionRequests / 1e6 + (cpuMs * WORKERS_PAID.usdPerMillionCpuMs) / 1e6;

/** the requests a view sends, per view: documents the Worker renders or serves and contacts it only answers */
export interface SpoolLoad {
	documentsPerView: number;
	contactsPerView: number;
}

/**
 * The account's monthly bill with spool on.
 *
 * Documents run the existing model, so rendering, object and CPU lines follow the traffic that
 * reaches the Worker, and each document carries the decoration CPU. Contacts are Worker requests
 * only. A site the model calls free stays free only while every meter, requests included, fits.
 */
export function billWithSpool(
	sites: number,
	viewsPerSite: number,
	load: SpoolLoad,
	decorationCpuMs: number = DECORATION_CPU_MS
): { total: number; free: boolean; binds: string } {
	return account(sites, viewsPerSite * load.documentsPerView, 'thermal', {
		requests: load.contactsPerView / load.documentsPerView,
		cpuMs: decorationCpuMs
	});
}

/** server joules one local view spares: the cached serve's CPU at the model's watts per core */
export const serverJoulesSaved = (cpuMs: number = CACHED_SERVE_TOTAL_MS): number =>
	(cpuMs / 1000) * W_PER_CORE * PUE_HYPER;

const money = (x: number): string => (x === 0 ? 'free' : `$${x.toFixed(2)}`);

if (import.meta.main) {
	const k: Requests = SPOOL_REQUESTS;
	console.log(
		`per device: ${k.documentsBeforeControl} views reach the network before the worker controls ` +
			`(paid deployed, n=1; local rig 2, n=1), then one request per distinct page, held page ` +
			`${k.heldView} (measured); return-day contact ${k.returnDayContact} (assumed bound); ` +
			`extra per device ${k.deviceExtra} (no reading, swept)\n`
	);

	console.log(
		'fit to the local matrix at 2 documents before control; residual = model - measured'
	);
	console.log(
		`${l('views', 7)} ${r('on', 5)} ${r('on+return', 10)} ${r('off', 5)} ${r('off+return', 11)}`
	);
	for (const m of matrixResiduals()) {
		console.log(
			`${l(m.views, 7)} ${r(m.on, 5)} ${r(m.onReturn, 10)} ${r(m.off, 5)} ${r(m.offReturn, 11)}`
		);
	}
	const dep = deployedResiduals();
	console.log(
		`deployed fixed session (${DEPLOYED_SESSION.views} views, reload, repeat; 3 documents before control): ` +
			`model ${DEPLOYED_SESSION.on + dep.on} on, ${DEPLOYED_SESSION.off + dep.off} off; measured ` +
			`${DEPLOYED_SESSION.on} on, ${DEPLOYED_SESSION.off} off; residual ${dep.on} and ${dep.off}\n`
	);

	const shapes: [string, Visit][] = [
		['1 view', { views: 1, distinct: 1 }],
		['2 views, 2 pages', { views: 2, distinct: 2 }],
		['5 views, 3 pages', { views: 5, distinct: 3 }],
		['20 views, 9 pages', { views: 20, distinct: 9 }],
		['20 views, 20 pages', { views: 20, distinct: 20 }],
		['121-view session', MIX_121],
		['2,000-view tab', TAB_2000]
	];
	console.log(
		'Worker requests of one visit: spool off, spool on (worker), upper bound of the model'
	);
	console.log(`${l('visit', 22)} ${r('off', 7)} ${r('worker', 8)}`);
	for (const [name, v] of shapes) {
		console.log(
			`${l(name, 22)} ${r(total(loadOff(v)), 7)} ${r(total(visitLoad(v, 'worker')), 8)}`
		);
	}

	const floor = netFloor();
	console.log(
		`\nnet floor, free plan: ${n(floor.viewsPerDay)} views a day at ${f(floor.perView, 2)} requests a ` +
			`view (every view a new page, first at ${floor.atViews} views) against ` +
			`${n(FREE_QUOTAS.workerRequestsPerDay)} with spool off; first views only: ` +
			`${n(firstViewFloor())}`
	);
	console.log(
		'net floor if a client with no reading adds requests per device (sweep input, not measured)'
	);
	for (const extra of DEVICE_EXTRAS) {
		const fl = netFloor({ ...SPOOL_REQUESTS, deviceExtra: extra });
		console.log(
			`${l(`+${extra} a device`, 12)} ${r(n(fl.viewsPerDay), 8)} views a day at ${fl.atViews} views`
		);
	}

	const views = sweep('views', VIEWS_PER_VISIT);
	const pages = sweep('pages', DISTINCT_PAGES);
	console.log(
		'\nviews a day the free plan carries, all visits on a worker, by distinct pages a visit reaches'
	);
	console.log(`${l('pages', 7)} ${views.map((v) => r(`${v} views`, 10)).join(' ')}`);
	for (const d of pages) {
		console.log(
			`${l(d, 7)} ${views
				.map((v) =>
					r(
						n(
							freeViewsPerDay(
								requestsPerView({ views: v, distinct: d }, { worker: 1 })
							)
						),
						10
					)
				)
				.join(' ')}`
		);
	}
	console.log(
		`${l('121 session', 11)} ${r(n(freeViewsPerDay(requestsPerView(MIX_121, { worker: 1 }))), 10)}   ` +
			`2,000 tab (bound) ${n(freeViewsPerDay(requestsPerView(TAB_2000, { worker: 1 })))}`
	);

	console.log(
		'\nviews a day, 20-view visits, by the share of visits that run a worker (rest run none)'
	);
	console.log(`${l('worker share', 12)} ${pages.map((d) => r(`${d} pages`, 10)).join(' ')}`);
	for (const w of WORKER_SHARES) {
		console.log(
			`${l(pct(w, 0), 12)} ${pages
				.map((d) =>
					r(
						n(
							freeViewsPerDay(
								requestsPerView({ views: 20, distinct: d }, { worker: w })
							)
						),
						10
					)
				)
				.join(' ')}`
		);
	}

	console.log('\nbreak-even views a visit, by distinct pages');
	for (const d of pages) console.log(`${l(`${d} pages`, 9)} ${breakEvenViews(d) ?? 'never'}`);

	console.log(
		'\nfree-plan serving ceiling by arm, views a day (121-view session, all on a worker)'
	);
	const pop: Population = { worker: 1 };
	for (const arm of ['drupal', 'wordpress'] as const) {
		const off = armEnvelope(arm);
		const same = armEnvelope(arm, envelopeInput(MIX_121, pop));
		const held = armEnvelope(arm, envelopeInput(MIX_121, pop, 1));
		console.log(
			`${l(arm, 10)} off ${n(off.servingViewsPerDay)} (${off.servingBoundBy}); on, mix per document ` +
				`${n(same.servingViewsPerDay)} (${same.servingBoundBy}); on, renders held ` +
				`${n(held.servingViewsPerDay)} (${held.servingBoundBy}); regenerations a day ` +
				`${n(off.regenerationsPerDay)} unchanged`
		);
	}

	console.log('\nWorker requests, object requests and rows a view reaches, by class');
	for (const [name, cost] of Object.entries(COST_PER_VIEW)) {
		console.log(`${l(name, 14)} worker ${cost.worker}  object ${cost.do}`);
	}
	console.log(
		`rows a fill writes, shipping default: ${Object.entries(ROWS_PER_FILL_MEMORY_BINS)
			.map(([name, rows]) => `${name} ${rows}`)
			.join(', ')}`
	);

	console.log('\ndollars a request costs past the plan allowance, list price');
	console.log(`a request alone ${marginalUsdPerRequest(0).toExponential(2)}`);
	console.log(
		`cached serve ${marginalUsdPerRequest(CACHED_SERVE_TOTAL_MS).toExponential(2)}; decorated ` +
			`(+${DECORATION_CPU_MS} ms, paid-account median, upper estimate) ` +
			`${marginalUsdPerRequest(CACHED_SERVE_TOTAL_MS + DECORATION_CPU_MS).toExponential(2)}; ` +
			`render ${marginalUsdPerRequest(RENDER_WARM_BIN_MS).toExponential(2)}`
	);

	const sites = Number(sweep('sites', [1])[0]);
	const named: [string, Visit, Population][] = [
		['first views only', { views: 1, distinct: 1 }, pop],
		['2-view visits', { views: 2, distinct: 2 }, pop],
		['20 views, 20 pages', { views: 20, distinct: 20 }, pop],
		['20 views, 9 pages', { views: 20, distinct: 9 }, pop],
		['same, 75% worker', { views: 20, distinct: 9 }, { worker: 0.75 }],
		['121-view session', MIX_121, pop],
		['2,000-view tab', TAB_2000, pop]
	];
	console.log(`\nmonthly bill, ${sites} site(s); spool off, then spool on at each population`);
	console.log(
		`${l('views/site/mo', 13)} ${r('off', 8)} ${named.map(([name]) => r(name, 20)).join(' ')}`
	);
	for (const v of sweep('views-month', [1_000_000, 10_000_000, 30_000_000])) {
		console.log(
			`${l(n(v), 13)} ${r(money(account(sites, v).total), 8)} ` +
				named
					.map(([, visit, p]) => {
						const load = populationLoad(visit, p);
						return r(
							money(
								billWithSpool(sites, v, {
									documentsPerView: load.documents / visit.views,
									contactsPerView: load.contacts / visit.views
								}).total
							),
							20
						);
					})
					.join(' ')
		);
	}
	console.log(`paid base ${money(PAID_BASE)} a month is in every paid figure`);
	console.log(
		`\nserver energy one local view spares: ${f(serverJoulesSaved() * 1000, 2)} mJ ` +
			`(cached serve ${CACHED_SERVE_TOTAL_MS} ms at ${f(W_PER_CORE, 2)} W a core, PUE ${PUE_HYPER})`
	);
}
