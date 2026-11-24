/**
 * Prices the pack staged into the object's own storage: one-time rows written, bytes stored, and the
 * rows a cold page reads, against the free plan's bounds and the paid list rates.
 *
 *   bun scripts/measure/pack-storage-price.ts [--cold-rows=2277] [--pack-rows=218]
 *
 * The inputs are row counts and byte counts from `tests/integration/pack-residency.spec.ts` on a
 * local workerd; none is a CPU figure. Rows are labelled measured, derived or recalled beside each
 * constant.
 */
import { DURABLE_OBJECTS, WORKERS_PAID } from '../economics/rates';
import { GENERATED_FREE_QUOTAS as FREE } from '../generated/quotas';

const MIB = 1_048_576;

/** the staged pack, measured: 199 chunk rows of 64 KiB plus the table and root rows */
export const PACK = {
	/** rows written to stage it, local workerd, three objects, no spread (stage minus the flag-off arm) */
	stageRowsWritten: 403,
	/** the chunk rows' storage as the docs record it; the pack itself is 13,012,361 bytes */
	storedBytes: 13_148_160,
	/** bytes the pack occupies in the isolate when it is resident, measured by the mount */
	residentBytes: 12.41 * MIB
} as const;

/**
 * Rows read per page, measured on stock Drupal, three objects per arm, no spread. `coldRows` is the
 * whole page after the interpreter is dropped with the pack staged; `packRows` is the part that
 * reads pack chunks; `warmRows` is a second request on the same interpreter.
 */
export const DRUPAL_PAGE = {
	front: { coldRows: 2277, packRows: 218, warmRows: 55 },
	admin: { coldRows: 2434, packRows: 255, warmRows: 76 },
	flush: { coldRows: 7388, packRows: 509, warmRows: 6081 }
} as const;

/**
 * The same readings on WordPress, where every PHP request mounts afresh so every page is a cold
 * one: rows read per request with the pack staged, and the part that is the pack. The flag-off
 * arm reads 643, 143 and 189.
 */
export const WORDPRESS_PAGE = {
	front: { coldRows: 928, packRows: 281 },
	login: { coldRows: 290, packRows: 147 },
	search: { coldRows: 354, packRows: 165 }
} as const;

/** recalled from the Durable Objects pricing page, not yet in `rates.ts`: $0.001 per million rows read */
export const ROWS_READ = {
	usdPerMillion: 0.001,
	includedPerMonth: 25e9,
	source: 'recalled'
} as const;

/** sites a free account's storage ceiling holds, at `perSiteBytes` each */
export function sitesAtStorage(perSiteBytes: number, ceilingBytes = FREE.storageBytes): number {
	return Math.floor(ceilingBytes / perSiteBytes);
}

/** cold pages a day at which rows read reach the free bound */
export function coldPagesAtRowsReadBound(rowsPerColdPage: number): number {
	return Math.floor(FREE.rowsReadPerDay / rowsPerColdPage);
}

/** cold pages a day at which the one-time staging writes, spread over `objects`, reach the write bound */
export function stagingShareOfWrites(objects: number): number {
	return (objects * PACK.stageRowsWritten) / FREE.rowsWrittenPerDay;
}

/**
 * Share of a free day's WordPress renders the staged pack costs at the rows-read bound: renders a
 * day without the pack rows against with them, from one page's `coldRows` and `packRows`.
 */
export function wordpressFreeRenderLoss(page: { coldRows: number; packRows: number }): number {
	const without = coldPagesAtRowsReadBound(page.coldRows - page.packRows);
	return 1 - coldPagesAtRowsReadBound(page.coldRows) / without;
}

/** list-rate dollars for `pages` cold pages that read `rowsPerPage` rows each, before the included allowance */
export function usdForColdPages(pages: number, rowsPerPage: number): number {
	return (pages * rowsPerPage * ROWS_READ.usdPerMillion) / 1e6;
}

/** list-rate dollars to stage one object's pack once */
export function usdToStage(): number {
	return (PACK.stageRowsWritten * DURABLE_OBJECTS.usdPerMillionRowsWritten) / 1e6;
}

/** list-rate dollars a month to hold one object's staged pack, before the 5 GB-month allowance */
export function usdStoragePerMonth(): number {
	return (PACK.storedBytes / 1e9) * DURABLE_OBJECTS.usdPerGbMonth;
}

/** what a headroom ladder run costs, modelled from its call counts and an assumed per-call wall time */
export function ladderRunCost(options: {
	headroomMiB: number;
	ladders: number;
	prepRequestsPerLadder: number;
	secondsPerCall: number;
	rungMiB?: number;
}) {
	const rungs = Math.ceil(options.headroomMiB / (options.rungMiB ?? 4)) + 1;
	const requestsPerLadder = rungs + 1 + options.prepRequestsPerLadder;
	const requests = requestsPerLadder * options.ladders;
	const gbS = requests * options.secondsPerCall * 0.128;
	return {
		requests,
		gbS,
		usd:
			(requests * DURABLE_OBJECTS.usdPerMillionRequests) / 1e6 +
			(requests * WORKERS_PAID.usdPerMillionRequests) / 1e6 +
			(gbS * DURABLE_OBJECTS.usdPerMillionGbS) / 1e6
	};
}

if (import.meta.main) {
	const arg = (name: string, fallback: number) => {
		const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
		return hit ? Number(hit.split('=')[1]) : fallback;
	};
	const cold = arg('cold-rows', DRUPAL_PAGE.front.coldRows);
	const pack = arg('pack-rows', DRUPAL_PAGE.front.packRows);
	const rows = (label: string, value: string | number) =>
		console.log(`${label.padEnd(58)} ${value}`);
	rows('stage: rows written (once per object)', PACK.stageRowsWritten);
	rows(
		'stage: share of the free daily write bound, one object',
		`${(stagingShareOfWrites(1) * 100).toFixed(2)}%`
	);
	rows(
		'stage: share, 50 objects the same day',
		`${(stagingShareOfWrites(50) * 100).toFixed(1)}%`
	);
	rows('stored bytes per object', PACK.storedBytes);
	rows('free: sites that fit at the pack alone', sitesAtStorage(PACK.storedBytes));
	rows(
		'free: sites that fit with the pack, seed and heap image',
		sitesAtStorage(PACK.storedBytes + 5_550_080 + 11_206_656)
	);
	rows(`free: cold pages a day at ${cold} rows read each`, coldPagesAtRowsReadBound(cold));
	rows(
		`free: cold pages a day without the pack rows (${cold - pack})`,
		coldPagesAtRowsReadBound(cold - pack)
	);
	const wp = WORDPRESS_PAGE.search;
	rows(
		`free: WordPress renders a day at ${wp.coldRows} rows each`,
		coldPagesAtRowsReadBound(wp.coldRows)
	);
	rows(
		`free: WordPress renders a day without the pack rows (${wp.coldRows - wp.packRows})`,
		coldPagesAtRowsReadBound(wp.coldRows - wp.packRows)
	);
	rows(
		'free: WordPress renders lost to the staged pack (1 - 5,000,000/354 over 5,000,000/189)',
		`${(wordpressFreeRenderLoss(wp) * 100).toFixed(1)}%`
	);
	rows('paid: stage once, list rate (USD)', usdToStage().toFixed(6));
	rows('paid: storage per object-month, before allowance (USD)', usdStoragePerMonth().toFixed(5));
	rows(
		`paid: 10,000 cold pages, all rows (USD, ${ROWS_READ.source} rate)`,
		usdForColdPages(10_000, cold).toFixed(4)
	);
	rows('paid: 10,000 cold pages, pack rows only (USD)', usdForColdPages(10_000, pack).toFixed(4));
	const ladder = ladderRunCost({
		headroomMiB: 216,
		ladders: 12,
		prepRequestsPerLadder: 6,
		secondsPerCall: 0.5
	});
	rows('ladder run: 12 ladders at 216 MiB, requests', ladder.requests);
	rows('ladder run: duration (GB-s, modelled at 0.5 s per call)', ladder.gbS.toFixed(1));
	rows('ladder run: list-rate USD, modelled', ladder.usd.toFixed(5));
}
