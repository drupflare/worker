/**
 * The daily counters this object keeps, in one `cfw_meta` row.
 *
 * Each of them used to have a key of its own, so a meter flush on a trafficked site wrote FOUR rows
 * -- while the comments beside the calls said the folding cost no row of its own. What the folding
 * saved was the alarm; the rows were never folded at all. Rows written is the meter that binds
 * regeneration, so a counter costing four of them to record a batch of them is the shape
 * `counter-counts-itself` already names once.
 *
 * Packed the way `writeRenderWindow()` packs its two values: one key, one row, a codec either side.
 *
 * `serveTotal` is a LIFETIME total and the other three are per UTC day. It rides in the daily row
 * anyway and carries forward on the first write of a new day, which is what keeps `/serve-stats`
 * reporting the same quantity it always did rather than quietly becoming a daily count.
 */

import {
	ZERO_ENCOUNTERS,
	parseEncounters,
	serialiseEncounters,
	type EncounterCounts
} from './cold-encounter.js';

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

export function dayMetersKey(nowMs: number): string {
	return `${DAY_METERS_PREFIX}${new Date(nowMs).toISOString().slice(0, 10)}`;
}

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
 * Reads one back, or null when there is nothing readable there.
 *
 * Null rather than a zeroed row, because the caller has to tell "this day has no row yet" from "this
 * day counted nothing": the first is what makes it look for the legacy keys and carry the lifetime
 * serve total forward, and the second is a day that genuinely served nothing.
 */
export function readDayMeters(raw: string | null | undefined): DayMeters | null {
	if (!raw) return null;
	const parts = raw.split(':');
	// four parts predates `kvWrites` and five the three activity counters; each counted none
	if (parts.length !== 4 && parts.length !== 5 && parts.length !== 8) return null;
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
	if (!all.every((n) => Number.isFinite(n) && n >= 0)) return null;
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
 * How much of the REMAINING daily row budget one eviction may lose unpersisted.
 *
 * The checkpoint exists for exactly one failure: a Durable Object is evicted whenever Cloudflare
 * likes, and whatever has accumulated in memory since the last write is gone. A live read is not
 * affected -- `dailyRows()` adds the pending counter to the stored one -- so the interval buys
 * nothing except a bound on that loss.
 *
 * A bound stated as a CONSTANT is wrong at both ends of the day. Twenty-five rows is 0.025% of a
 * fresh site's budget and 1% of what is left at 97.5%, and the second is the only reading that can
 * change a decision.
 */
export const METER_LOSS_FRACTION = 0.01;

/**
 * The tightest checkpoint, which is what the two constants this replaces did unconditionally.
 *
 * Kept as the floor rather than tightened, so the change cannot weaken the accounting anywhere: at
 * the ceiling the policy answers 25 rows and 60 s, which is byte for byte the old behaviour.
 */
export const METER_FLUSH_ROWS_MIN = 25;
export const METER_FLUSH_MS_MIN = 60_000;

/**
 * The loosest, which is the render window's own 15-minute bucket.
 *
 * Borrowed rather than chosen: `flushRenderWindow()` already answers this question for the arrival
 * rate and caps itself at 96 rows/day, and two checkpoints on the same object should not disagree
 * about how long a gap is acceptable.
 */
export const METER_FLUSH_MS_MAX = 900_000;
export const METER_FLUSH_ROWS_MAX =
	METER_FLUSH_ROWS_MIN * (METER_FLUSH_MS_MAX / METER_FLUSH_MS_MIN);

/**
 * When the day meters may next pay for a row, from how much budget is left.
 *
 * Both triggers state the same bound in different units, so both scale together: the row trigger is
 * what catches a busy object and the interval is what catches an idle one, and a warmed object at
 * one row per 8 s tick reaches neither quickly.
 *
 * At the shipping interval this is 1,440 flushes a day against 96, which is 1,344 rows returned to
 * the meter that binds regeneration. It moves the published free-plan ceiling by about 1.5% and
 * that is the whole of it; the reason to do it is that a counter should not be a measurable share
 * of what it counts.
 *
 * @param rowsToday what the day meter already holds, `dailyRows()`.
 * @param budgetRows the daily cap; `DAILY_ROWS_QUOTA` on free, and the same figure on paid because
 *   a paid site has nothing to protect and fewer writes are strictly cheaper there.
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
