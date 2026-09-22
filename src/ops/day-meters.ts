/**
 * The four daily counters this object keeps, in one `cfw_meta` row.
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
};

export const ZERO_DAY_METERS: DayMeters = {
	rows: 0,
	doRequests: 0,
	serveTotal: 0,
	encounters: { ...ZERO_ENCOUNTERS }
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
		serialiseEncounters(meters.encounters)
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
	if (parts.length !== 4) return null;
	const [rows, doRequests, serveTotal] = parts.slice(0, 3).map((n) => Number(n)) as [
		number,
		number,
		number
	];
	if (![rows, doRequests, serveTotal].every((n) => Number.isFinite(n) && n >= 0)) return null;
	return { rows, doRequests, serveTotal, encounters: parseEncounters(parts[3]) };
}
