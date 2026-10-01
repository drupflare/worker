/**
 * The daily counters this object keeps, packed into one `cfw_meta` row.
 *
 * One key and one row, because rows written is the meter that binds regeneration and a flush of
 * four separate keys cost four. `serveTotal` is a lifetime total (the rest are per UTC day); it
 * carries forward on the first write of a new day, so `/serve-stats` keeps its meaning.
 * @module
 */
import {
	ZERO_ENCOUNTERS,
	parseEncounters,
	serialiseEncounters,
	type EncounterCounts
} from './cold-encounter';

/** the packed daily counters; see {@link writeDayMeters} for the wire format */
export type DayMeters = {
	/** rows written today, against the daily quota */
	rows: number;
	/** Durable Object invocations today, against the other daily quota */
	doRequests: number;
	/** requests answered over this object's whole life, not today's */
	serveTotal: number;
	encounters: EncounterCounts;
	/** page writes to `PAGE_KV` this object granted today, against `KV_WRITES_PER_DAY` */
	kvWrites: number;
	/** pages PHP rendered today, inline or in a fill */
	renders: number;
	/** alarm firings today; each is a Durable Object request */
	alarms: number;
	/** outbound fetches the drain performed today */
	fetches: number;
};

/** a day with nothing counted */
export const ZERO_DAY_METERS: DayMeters = {
	rows: 0,
	doRequests: 0,
	serveTotal: 0,
	encounters: { ...ZERO_ENCOUNTERS },
	kvWrites: 0,
	renders: 0,
	alarms: 0,
	fetches: 0
};

/** the prefix a day row is found under, and the one `carriedServeTotal()` scans */
export const DAY_METERS_PREFIX = 'meters_';

/** the `cfw_meta` key for the UTC day containing `nowMs` */
export function dayMetersKey(nowMs: number): string {
	return `${DAY_METERS_PREFIX}${new Date(nowMs).toISOString().slice(0, 10)}`;
}

/** packs the meters as colon-joined integers; encounters ride in the fourth slot */
export function writeDayMeters(meters: DayMeters): string {
	return [
		Math.max(0, Math.round(meters.rows)),
		Math.max(0, Math.round(meters.doRequests)),
		Math.max(0, Math.round(meters.serveTotal)),
		serialiseEncounters(meters.encounters),
		Math.max(0, Math.round(meters.kvWrites)),
		Math.max(0, Math.round(meters.renders)),
		Math.max(0, Math.round(meters.alarms)),
		Math.max(0, Math.round(meters.fetches))
	].join(':');
}

/**
 * Reads one back, or undefined when nothing readable is there.
 * Undefined, not zeros: "no row yet" makes the caller look for legacy keys and carry the lifetime
 * serve total forward, while a zero row is a day that served nothing.
 */
export function readDayMeters(raw: string | null | undefined): DayMeters | undefined {
	if (!raw) return undefined;
	const parts = raw.split(':');
	// four parts has no `kvWrites` and five lacks the three activity counters (each reads zero)
	if (parts.length !== 4 && parts.length !== 5 && parts.length !== 8) return undefined;
	const [rows, doRequests, serveTotal] = parts.slice(0, 3).map((n) => Number(n)) as [
		number,
		number,
		number
	];
	const [kvWrites, renders, alarms, fetches] = [4, 5, 6, 7].map((i) => Number(parts[i] ?? 0)) as [
		number,
		number,
		number,
		number
	];
	const all = [rows, doRequests, serveTotal, kvWrites, renders, alarms, fetches];
	if (!all.every((n) => Number.isFinite(n) && n >= 0)) return undefined;
	return {
		rows,
		doRequests,
		serveTotal,
		encounters: parseEncounters(parts[3]),
		kvWrites,
		renders,
		alarms,
		fetches
	};
}

/**
 * The fraction of the remaining daily row budget one eviction may lose unpersisted.
 * A fixed bound is wrong at both ends of the day: 25 rows is 0.025% of a fresh budget and 1% of
 * what is left at 97.5%. Live reads add the pending counter, so this only bounds eviction loss.
 */
export const METER_LOSS_FRACTION = 0.01;

/** the tightest checkpoint, 25 rows and 60 s (the old unconditional behaviour, kept as floor) */
export const METER_FLUSH_ROWS_MIN = 25;
/** the tightest checkpoint interval, in ms */
export const METER_FLUSH_MS_MIN = 60_000;

/** the loosest checkpoint interval, the render window's own 15-minute bucket, so the two agree */
export const METER_FLUSH_MS_MAX = 900_000;
/** the row trigger that matches {@link METER_FLUSH_MS_MAX} */
export const METER_FLUSH_ROWS_MAX =
	METER_FLUSH_ROWS_MIN * (METER_FLUSH_MS_MAX / METER_FLUSH_MS_MIN);

/**
 * When the day meters may next pay for a row, from how much budget is left.
 * Both triggers state one bound in different units: rows catches a busy object, the interval an
 * idle one. At the shipping interval this is 1,440 flushes a day against 96, about 1.5% on the
 * free-plan ceiling.
 *
 * @param rowsToday what the day meter already holds, `dailyRows()`
 * @param budgetRows the daily cap; the same figure on paid, where fewer writes are cheaper
 */
export function meterFlushBudget(
	rowsToday: number,
	budgetRows: number
): { rows: number; intervalMs: number } {
	const remaining = Math.max(0, budgetRows - Math.max(0, rowsToday));
	const rows = Math.min(
		METER_FLUSH_ROWS_MAX,
		Math.max(METER_FLUSH_ROWS_MIN, Math.round(remaining * METER_LOSS_FRACTION))
	);
	return { rows, intervalMs: METER_FLUSH_MS_MIN * (rows / METER_FLUSH_ROWS_MIN) };
}
