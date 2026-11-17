import { DAILY_ROWS_QUOTA } from '../ops/auth-budget';
import {
	ZERO_ENCOUNTERS,
	addEncounters,
	encounterReport,
	parseEncounters,
	type EncounterCounts
} from '../ops/cold-encounter';
import {
	DAY_METERS_PREFIX,
	dayMetersKey,
	meterFlushBudget,
	readDayMeters,
	writeDayMeters,
	type DayMeters
} from '../ops/day-meters';
import { dailyLimit, degradation as degradationFor, type Degradation } from '../ops/degrade';
import { isMissingTable } from '../util/errors';
import { firstRow } from '../util/sql';
import type { MeterHost } from './host';

/** folds every pending counter into one row and returns the totals after folding */
export function flushMeters(site: MeterHost, nowMs = site.nowMs()): DayMeters {
	const rowsPending = site.rowsSinceFlush ?? 0;
	const doPending = site.doRequestsSinceFlush ?? 0;
	const servePending = site.serveRequestsPending ?? 0;
	const kvPending = site.kvGrantsSinceFlush ?? 0;
	const activity = site.activitySinceFlush ?? { renders: 0, alarms: 0, fetches: 0 };
	const seen = site.encounters;
	const encountersPending =
		seen.noPhp !== 0 || seen.warm !== 0 || seen.cold !== 0 || seen.absorbed !== 0;
	const stored = storedMeters(site, nowMs);
	if (
		rowsPending === 0 &&
		doPending === 0 &&
		servePending === 0 &&
		kvPending === 0 &&
		activity.renders + activity.alarms + activity.fetches === 0 &&
		!encountersPending
	) {
		return stored;
	}
	site.rowsSinceFlush = 0;
	site.doRequestsSinceFlush = 0;
	site.serveRequestsPending = 0;
	site.kvGrantsSinceFlush = 0;
	site.activitySinceFlush = { renders: 0, alarms: 0, fetches: 0 };
	site.encounters = { ...ZERO_ENCOUNTERS };
	const total: DayMeters = {
		rows: stored.rows + rowsPending,
		doRequests: stored.doRequests + doPending,
		serveTotal: stored.serveTotal + servePending,
		encounters: addEncounters(stored.encounters, seen),
		kvWrites: stored.kvWrites + kvPending,
		renders: stored.renders + activity.renders,
		alarms: stored.alarms + activity.alarms,
		fetches: stored.fetches + activity.fetches
	};
	site.carriedServe = total.serveTotal;
	// yesterday's key is left in place: one row per day is nothing, and a
	// history of daily totals is what makes "is this site trending over" answerable at all
	site.metaSet(dayMetersKey(nowMs), writeDayMeters(total));
	return total;
}

/** adds `n` to today's pending counter for `kind` */
export function countActivity(
	site: MeterHost,
	kind: 'renders' | 'alarms' | 'fetches',
	n = 1
): void {
	const held = site.activitySinceFlush ?? { renders: 0, alarms: 0, fetches: 0 };
	held[kind] += n;
	site.activitySinceFlush = held;
}

/** today's activity counters, stored plus pending, so a read between flushes is current */
export function activityToday(
	site: MeterHost,
	nowMs = site.nowMs()
): { renders: number; alarms: number; fetches: number } {
	const stored = storedMeters(site, nowMs);
	const pending = site.activitySinceFlush ?? { renders: 0, alarms: 0, fetches: 0 };
	return {
		renders: stored.renders + pending.renders,
		alarms: stored.alarms + pending.alarms,
		fetches: stored.fetches + pending.fetches
	};
}

/**
 * Folds the writes since the last flush into a per-UTC-day total; flushed on the alarm, never
 * per write (that would double the count; the flush row is itself counted).
 *
 * @returns the running total for today
 */
export function flushDailyRows(site: MeterHost, nowMs = site.nowMs()): number {
	return flushMeters(site, nowMs).rows;
}

/**
 * What the packed day row holds, else the four legacy keys (read-only, so an upgrade mid-day
 * keeps the row budget the degrade guard reads).
 */
export function storedMeters(site: MeterHost, nowMs = site.nowMs()): DayMeters {
	const packed = readDayMeters(site.metaGet(dayMetersKey(nowMs)));
	if (packed) return packed;
	const day = new Date(nowMs).toISOString().slice(0, 10);
	return {
		rows: Number(site.metaGet(`rows_written_${day}`, '0') ?? 0),
		doRequests: Number(site.metaGet(`do_requests_${day}`, '0') ?? 0),
		serveTotal: carriedServeTotal(site),
		encounters: parseEncounters(site.metaGet(`encounters_${day}`)),
		kvWrites: 0,
		renders: 0,
		alarms: 0,
		fetches: 0
	};
}

/**
 * The lifetime serve total from whichever day last recorded one; memoised, since it only moves
 * through `flushMeters()`.
 */
export function carriedServeTotal(site: MeterHost): number {
	if (site.carriedServe !== undefined) return site.carriedServe;
	let latest = 0;
	try {
		const row = firstRow(
			site.sql.exec(
				`SELECT v FROM cfw_meta WHERE k GLOB '${DAY_METERS_PREFIX}*' ORDER BY k DESC LIMIT 1`
			)
		) as { v?: string } | undefined;
		latest = readDayMeters(row?.v)?.serveTotal ?? 0;
	} catch (e) {
		// a missing cfw_meta is the zero total; the next flush writes one
		if (!isMissingTable(e)) site.noteError('carriedServeTotal', e);
	}
	site.carriedServe = Math.max(latest, Number(site.metaGet('serve_requests', '0') ?? 0));
	return site.carriedServe;
}

/**
 * Whether this firing should pay for a daily-meter flush.
 *
 * Two triggers: pending volume flushes at once, an idle warming tick waits for the interval.
 * Both come from `meterFlushBudget()` (the remaining budget), reaching 25 rows and 60 s at the
 * ceiling. The accumulator is in memory, so an eviction loses at most one interval of counting.
 */
export function shouldFlushMeters(site: MeterHost, nowMs = site.nowMs()): boolean {
	const pending = (site.rowsSinceFlush ?? 0) + (site.doRequestsSinceFlush ?? 0);
	if (pending === 0) return false;
	const budget = meterFlushBudget(dailyRows(site, nowMs), DAILY_ROWS_QUOTA);
	if (pending >= budget.rows) return true;
	return nowMs - (site.lastMeterFlushMs ?? 0) >= budget.intervalMs;
}

/**
 * Folds served requests into their durable total, on the meters' own interval.
 *
 * A row per view would cost ~15,000 of free's 100,000 rows/day. A serve arms the fill alarm at
 * +1 ms and that firing flushes, so an eviction loses about a millisecond of counting.
 */
export function flushServeRequests(site: MeterHost): number {
	const pending = site.serveRequestsPending ?? 0;
	if (pending === 0) return 0;
	flushMeters(site);
	return pending;
}

/** the durable total plus what has not been paid for yet; for a read that must not write */
export function serveRequests(site: MeterHost): number {
	return storedMeters(site).serveTotal + (site.serveRequestsPending ?? 0);
}

/** today's rows written, without flushing (for a read that must not write) */
export function dailyRows(site: MeterHost, nowMs = site.nowMs()): number {
	return storedMeters(site, nowMs).rows + (site.rowsSinceFlush ?? 0);
}

/**
 * Folds this firing's Durable Object invocations into a per-UTC-day total.
 *
 * Counts only what reached this object (an edge-cache hit never enters the isolate), so it is
 * the DO meter and not the Worker-request meter.
 */
export function flushDailyDoRequests(site: MeterHost, nowMs = site.nowMs()): number {
	return flushMeters(site, nowMs).doRequests;
}

/**
 * Folds this incarnation's cold-encounter counts into a per-UTC-day total; called from the
 * alarm, where a row is already written.
 */
export function flushEncounters(site: MeterHost, nowMs = site.nowMs()): EncounterCounts {
	return flushMeters(site, nowMs).encounters;
}

/**
 * The share of requests that met an evicted interpreter, today and in this incarnation (score
 * a boot proposal against it).
 */
export function coldEncounterRate(
	site: MeterHost,
	nowMs = site.nowMs()
): {
	today: ReturnType<typeof encounterReport>;
	incarnation: ReturnType<typeof encounterReport>;
} {
	return {
		today: encounterReport(
			addEncounters(storedMeters(site, nowMs).encounters, site.encounters)
		),
		incarnation: encounterReport(site.encounters)
	};
}

/**
 * Where this site sits on the quota ladder; both daily meters reset at midnight UTC, so
 * nothing is persisted (two warm reads, no await).
 */
export function degradation(site: MeterHost, nowMs = site.nowMs()): Degradation {
	const rowsLimit = dailyLimit('rows-written', site.env);
	const doLimit = dailyLimit('do-requests', site.env);
	return degradationFor({
		rowsFraction: rowsLimit > 0 ? dailyRows(site, nowMs) / rowsLimit : 0,
		doFraction: doLimit > 0 ? dailyDoRequests(site, nowMs) / doLimit : 0
	});
}

/** today's DO invocations, without flushing */
export function dailyDoRequests(site: MeterHost, nowMs = site.nowMs()): number {
	return storedMeters(site, nowMs).doRequests + (site.doRequestsSinceFlush ?? 0);
}

/** today's granted `PAGE_KV` page writes, without flushing */
export function dailyKvWrites(site: MeterHost, nowMs = site.nowMs()): number {
	return storedMeters(site, nowMs).kvWrites + (site.kvGrantsSinceFlush ?? 0);
}
