/**
 * One account's monthly bill: Cloudflare's published rate card applied to a number of sites.
 *
 * Split out of comparison.ts so the arithmetic can be asserted without running its tables.
 */
import { BREAK_EVEN_RENDERS_PER_DAY } from '../../src/ops/thermal';
import {
	DO_GB_ALLOCATED,
	FREE_QUOTAS,
	PAID_DURATION,
	ROWS_PER_FILL_MEMORY_BINS,
	SECONDS_PER,
	STEADY_STATE_WARMTH,
	WARM_INTERVAL_MS,
	keepWarmFleetCost,
	rowsForWarmthMix
} from '../measure/free-envelope';
import { pageStoreFraction } from '../measure/render-fraction';
import { num } from './args';
import {
	CACHED_SERVE_TOTAL_MS as CPU_CACHED,
	RENDER_WARM_BIN_MS as CPU_RENDER,
	SITE_GB,
	WARM_FIRING_WALL_MS
} from './measured';
import { DURABLE_OBJECTS, WORKERS_PAID } from './rates';

// Cloudflare's published rate card, retrieved 2026-09-21. Free is a set of DAILY caps; paid is a
// $5 subscription with monthly allowances on top.
const FREE_REQ_DAY = FREE_QUOTAS.workerRequestsPerDay;
const FREE_ROWS_DAY = FREE_QUOTAS.rowsWrittenPerDay;
const FREE_DO_REQ_DAY = FREE_QUOTAS.doRequestsPerDay;
const FREE_STORE_GB = FREE_QUOTAS.storageBytes / 1e9;
export const PAID_BASE = num('paid-base', WORKERS_PAID.usdPerMonth);
const PAID_REQ_INC = WORKERS_PAID.requestsIncluded;
const PAID_CPU_INC = WORKERS_PAID.cpuMsIncluded;
const PAID_ROWW_INC = DURABLE_OBJECTS.rowsWrittenIncluded;
const PAID_STORE_INC = DURABLE_OBJECTS.storageGbIncluded;
const REQ_RATE = WORKERS_PAID.usdPerMillionRequests;
const CPU_RATE = WORKERS_PAID.usdPerMillionCpuMs;
const ROWW_RATE = DURABLE_OBJECTS.usdPerMillionRowsWritten;
const STORE_RATE = DURABLE_OBJECTS.usdPerGbMonth;
const DO_REQ_RATE = DURABLE_OBJECTS.usdPerMillionRequests;
const PAID_DO_REQ_INC = DURABLE_OBJECTS.requestsIncluded;
export const DAYS_MONTH = 30.44;

const FREE_GBS_DAY = FREE_QUOTAS.durationGbSPerDay;
// the shipping default priced on the warmth mix, from the audit spec's pinned classes. It was a flat
// 25 ("mid of the 2-94 band"), 14x the shipping figure, which made rows written read as binding
const ROWS_PER_FILL = num(
	'rows-per-fill',
	rowsForWarmthMix(STEADY_STATE_WARMTH, ROWS_PER_FILL_MEMORY_BINS)
);
// renders follow saves, not views, so the fraction is per site traffic; --render-frac pins one
const RENDER_FRAC_FLAG = num('render-frac', -1);
const renderFrac = (viewsPerSite: number) =>
	RENDER_FRAC_FLAG >= 0 ? RENDER_FRAC_FLAG : pageStoreFraction(viewsPerSite);
const DO_HIT_FRAC = num('do-hit-frac', 0.18); // share of views that reach the object at all
// wall clock, since duration bills wall clock; the render figure is the envelope's pessimistic one
const RENDER_S = num('render-s', SECONDS_PER.warmRender);
export const WARMING = keepWarmFleetCost(1, WARM_INTERVAL_MS);

export type Bill = { total: number; free: boolean; binds: string };

/**
 * Whether sites stay asleep or are all kept warm. `thermal` warms a site only above the break-even
 * render rate, which a site on the free plan gets by default; `always` is the paid plan's default.
 */
export type Warming = 'thermal' | 'always';

/** One bill for the whole account, whatever number of sites share it. */
export function account(sites: number, viewsPerSite: number, warming: Warming = 'thermal'): Bill {
	const v = sites * viewsPerSite;
	const rf = renderFrac(viewsPerSite);
	// thermal.ts keeps a site resident above its break-even render rate, and the chain spends rows
	// and object requests before any visitor arrives
	const warmed =
		warming === 'always' || (viewsPerSite * rf) / DAYS_MONTH >= BREAK_EVEN_RENDERS_PER_DAY;
	const warmSites = warmed ? sites : 0;
	const warmFirings = warmSites * WARMING.doRequestsPerDay * DAYS_MONTH;
	const rows = v * rf * ROWS_PER_FILL + warmSites * WARMING.rowsPerDay * DAYS_MONTH;
	const cpuMs = v * ((1 - rf) * CPU_CACHED + rf * CPU_RENDER);
	const doReq = v * DO_HIT_FRAC + warmFirings;
	// a firing is billed for its wall time, and an object waiting on an armed alarm is not
	const gbS =
		(v * (DO_HIT_FRAC * SECONDS_PER.doHit + rf * RENDER_S) +
			warmFirings * (WARM_FIRING_WALL_MS / 1000)) *
		DO_GB_ALLOCATED;
	const storeGb = sites * SITE_GB;

	const perDay = (x: number) => x / DAYS_MONTH;
	const caps: [string, number][] = [
		['requests', perDay(v) / FREE_REQ_DAY],
		['rows written', perDay(rows) / FREE_ROWS_DAY],
		['object requests', perDay(doReq) / FREE_DO_REQ_DAY],
		['duration', perDay(gbS) / FREE_GBS_DAY],
		['storage', storeGb / FREE_STORE_GB]
	];
	caps.sort((a, b) => b[1] - a[1]);
	const binds = caps[0]!;
	// naming a cap at 0.1% used reads as a warning it is not, so report the headroom instead
	if (binds[1] <= 1) {
		return { total: 0, free: true, binds: `${binds[0]} ${(binds[1] * 100).toFixed(0)}%` };
	}

	const total =
		PAID_BASE +
		(Math.max(0, v - PAID_REQ_INC) / 1e6) * REQ_RATE +
		(Math.max(0, cpuMs - PAID_CPU_INC) / 1e6) * CPU_RATE +
		(Math.max(0, rows - PAID_ROWW_INC) / 1e6) * ROWW_RATE +
		Math.max(0, storeGb - PAID_STORE_INC) * STORE_RATE +
		// Durable Object usage over the allowance bills rounded UP to the next million
		Math.ceil(Math.max(0, doReq - PAID_DO_REQ_INC) / 1e6) * DO_REQ_RATE +
		Math.ceil(Math.max(0, gbS - PAID_DURATION.includedGbSPerMonth) / 1e6) *
			PAID_DURATION.usdPerMillionGbS;
	return { total, free: false, binds: binds[0] };
}
