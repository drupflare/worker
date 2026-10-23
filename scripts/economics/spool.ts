/**
 * What spool does to the request meter and the bill.
 *
 *   bun scripts/economics/spool.ts
 *   bun scripts/economics/spool.ts --views=1000000 --sites=100
 *
 * A view answered on the visitor's device never reaches the Worker, and every new device pays a
 * fixed set of requests once. The fixed count is `measured` ({@link SPOOL_REQUESTS}). The share of
 * views a device answers locally and the views a device makes while its worker is installed are
 * nobody's reading for a real site, so every table here is `derived (modelled)` and sweeps both.
 * The server CPU spool adds to a page it decorates is not in this file: it needs a deployed
 * `cpuTime` reading, and it enters through `extraCpuMs` once there is one.
 */
import { FREE_QUOTAS } from '../measure/free-envelope';
import { sweep } from './args';
import { account, DAYS_MONTH, PAID_BASE } from './bill';
import { PUE_HYPER, W_PER_CORE } from './energy';
import { f, l, n, pct, r } from './fmt';
import { CACHED_SERVE_TOTAL_MS, SPOOL_REQUESTS } from './measured';
import { VIEWS } from './perview';
import { WORKERS_PAID } from './rates';

/** shares of views a device answers on its own: a sweep, since none is measured for a real site */
export const LOCAL_SHARES = [0.25, 0.5, 0.75];

/** views one device makes while its worker is installed: a sweep for the same reason */
export const VIEWS_PER_DEVICE = [5, 10, 20, 50];

/** Worker requests one view costs on average: the views that miss the device plus the fixed set spread over them */
export const workerRequestsPerView = (
	localShare: number,
	viewsPerDevice: number,
	fixed: number = SPOOL_REQUESTS.fixedPerDevice
): number => 1 - localShare + fixed / viewsPerDevice;

/** views a device must make before spool sends the Worker fewer requests than it would have had */
export const breakEvenViews = (
	localShare: number,
	fixed: number = SPOOL_REQUESTS.fixedPerDevice
): number => fixed / localShare;

/** views a month the free plan's request cap carries at that mix; without spool it is the cap over 1 */
export const freeViewsMonth = (localShare: number, viewsPerDevice: number): number =>
	(FREE_QUOTAS.workerRequestsPerDay * DAYS_MONTH) /
	workerRequestsPerView(localShare, viewsPerDevice);

const requestFee = (requests: number): number =>
	(Math.max(0, requests - WORKERS_PAID.requestsIncluded) / 1e6) *
	WORKERS_PAID.usdPerMillionRequests;

/**
 * The account's monthly bill with spool on.
 *
 * The views that reach the Worker run the existing model unchanged, so their rendering, object and
 * CPU lines follow the traffic that is left. The fixed per-device requests are Worker requests only
 * and are added to the request meter and the request fee. A site the model calls free stays free
 * only while the added requests fit under the daily cap; past it the bill is the paid base.
 */
export function billWithSpool(
	sites: number,
	viewsPerSite: number,
	localShare: number,
	viewsPerDevice: number
): { total: number; free: boolean; binds: string } {
	const reaching = viewsPerSite * (1 - localShare);
	const fixed = (viewsPerSite / viewsPerDevice) * SPOOL_REQUESTS.fixedPerDevice;
	const base = account(sites, reaching);
	const requests = sites * (reaching + fixed);
	if (base.free && requests / DAYS_MONTH <= FREE_QUOTAS.workerRequestsPerDay) return base;
	const extra = requestFee(requests) - requestFee(sites * reaching);
	const total = (base.free ? PAID_BASE : base.total) + extra;
	return { total, free: false, binds: base.free ? 'requests' : base.binds };
}

/** server joules one local view spares: the cached serve's CPU at the model's watts per core */
export const serverJoulesSaved = (cpuMs: number = CACHED_SERVE_TOTAL_MS): number =>
	(cpuMs / 1000) * W_PER_CORE * PUE_HYPER;

const money = (x: number): string => (x === 0 ? 'free' : `$${x.toFixed(2)}`);

if (import.meta.main) {
	const shares = sweep('share', LOCAL_SHARES);
	const devices = sweep('devices', VIEWS_PER_DEVICE);
	console.log(
		`fixed requests per new device: ${SPOOL_REQUESTS.fixedPerDevice} ` +
			`(measured, ${SPOOL_REQUESTS.runs} runs, no spread)\n`
	);
	console.log('Worker requests a view costs, and the views per device where spool breaks even');
	console.log(
		`${l('local share', 11)} ${devices.map((v) => r(`${v}/dev`, 8)).join(' ')} ${r('break-even', 11)}`
	);
	for (const z of shares) {
		console.log(
			`${l(pct(z, 0), 11)} ${devices.map((v) => r(f(workerRequestsPerView(z, v), 2), 8)).join(' ')} ` +
				`${r(f(breakEvenViews(z), 1) + ' views', 11)}`
		);
	}
	console.log(
		`\nviews a month the free plan carries (${n(FREE_QUOTAS.workerRequestsPerDay * DAYS_MONTH)} without spool)`
	);
	console.log(`${l('local share', 11)} ${devices.map((v) => r(`${v}/dev`, 10)).join(' ')}`);
	for (const z of shares) {
		console.log(
			`${l(pct(z, 0), 11)} ${devices.map((v) => r(n(freeViewsMonth(z, v)), 10)).join(' ')}`
		);
	}
	const sites = Number(sweep('sites', [1])[0]);
	console.log(`\nmonthly bill, ${sites} site(s), 20 views a device`);
	console.log(
		`${l('views/site/mo', 13)} ${r('no spool', 10)} ${shares.map((z) => r(pct(z, 0), 10)).join(' ')}`
	);
	for (const views of sweep('views', VIEWS)) {
		const base = account(sites, views);
		console.log(
			`${l(n(views), 13)} ${r(money(base.total), 10)} ` +
				shares.map((z) => r(money(billWithSpool(sites, views, z, 20).total), 10)).join(' ')
		);
	}
	console.log(
		`\nserver energy one local view spares: ${f(serverJoulesSaved() * 1000, 2)} mJ ` +
			`(cached serve ${CACHED_SERVE_TOTAL_MS} ms at ${f(W_PER_CORE, 2)} W a core, PUE ${PUE_HYPER})`
	);
}
