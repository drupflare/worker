/**
 * Cloudflare's published prices, the one place any of them is written.
 *
 * Every figure is PUBLISHED, from developers.cloudflare.com on the date beside its card. A price
 * that moves is edited here and every model reads the new one; a copy anywhere else is the drift
 * this module exists to stop.
 *
 * Workers Paid, retrieved 2026-09-20.
 */
export const WORKERS_PAID = {
	retrieved: '2026-09-20',
	usdPerMonth: 5.0,
	requestsIncluded: 10e6,
	cpuMsIncluded: 30e6,
	usdPerMillionRequests: 0.3,
	usdPerMillionCpuMs: 0.02
} as const;

/**
 * Workers for Platforms, retrieved 2026-09-20. Subrequests are not billed: the dispatch, user and
 * outbound chain is one request.
 */
export const WORKERS_FOR_PLATFORMS = {
	retrieved: '2026-09-20',
	usdPerMonth: 25.0,
	requestsIncluded: 20e6,
	cpuMsIncluded: 60e6,
	scriptsIncluded: 1000,
	usdPerMillionRequests: 0.3,
	usdPerMillionCpuMs: 0.02,
	usdPerScript: 0.02
} as const;

/** Durable Objects on the paid plan, retrieved 2026-09-20. Usage bills rounded up to the million */
export const DURABLE_OBJECTS = {
	retrieved: '2026-09-20',
	requestsIncluded: 1e6,
	usdPerMillionRequests: 0.15,
	gbSIncluded: 400_000,
	usdPerMillionGbS: 12.5,
	rowsWrittenIncluded: 50e6,
	usdPerMillionRowsWritten: 1.0,
	storageGbIncluded: 5.0,
	usdPerGbMonth: 0.2
} as const;

/** Cloudflare for SaaS, retrieved 2026-09-24. Up to 50,000 hostnames on a non-Enterprise zone */
export const CLOUDFLARE_FOR_SAAS = {
	retrieved: '2026-09-24',
	hostnamesIncluded: 100,
	usdPerHostnameMonth: 0.1
} as const;

/**
 * R2 standard storage, retrieved 2026-11-02 from the R2 pricing page, last updated Oct 30, 2026.
 * The free tier is the only included allowance the page prints; it does not say what a paid account
 * keeps beyond it, so the paid bill is priced with no allowance.
 */
export const R2 = {
	retrieved: '2026-11-02',
	source: 'https://developers.cloudflare.com/r2/pricing/',
	quote: 'Storage $0.015 / GB-month; Class A Operations $4.50 / million requests; Class B Operations $0.36 / million requests',
	usdPerGbMonth: 0.015,
	usdPerMillionClassA: 4.5,
	usdPerMillionClassB: 0.36,
	free: { gbMonth: 10, classAPerMonth: 1e6, classBPerMonth: 10e6 }
} as const;

/** Worker-to-Worker calls, retrieved 2026-11-02, page last updated Oct 2, 2026 */
export const SERVICE_BINDINGS = {
	retrieved: '2026-11-02',
	source: 'https://developers.cloudflare.com/workers/platform/pricing/',
	quote: 'Requests made from your Worker to another worker via a Service Binding do not incur additional request fees.',
	requestFeeUsd: 0
} as const;

/** Static asset requests, retrieved 2026-11-02, same page as {@link SERVICE_BINDINGS} */
export const STATIC_ASSETS = {
	retrieved: '2026-11-02',
	source: 'https://developers.cloudflare.com/workers/platform/pricing/',
	quote: 'Requests to static assets are free and unlimited.'
} as const;
