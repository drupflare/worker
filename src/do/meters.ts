import { addEncounters, ZERO_ENCOUNTERS } from '../ops/cold-encounter';
import { type DayMeters, dayMetersKey, writeDayMeters } from '../ops/day-meters';
import type { SitePhpDurableObject } from '../site-do';

/** folds every pending counter into one row and returns the totals after folding */
export function flushMeters(site: SitePhpDurableObject, nowMs = site.nowMs()): DayMeters {
	const rowsPending = site.rowsSinceFlush ?? 0;
	const doPending = site.doRequestsSinceFlush ?? 0;
	const servePending = site.serveRequestsPending ?? 0;
	const kvPending = site.kvGrantsSinceFlush ?? 0;
	const activity = site.activitySinceFlush ?? { renders: 0, alarms: 0, fetches: 0 };
	const seen = site.encounters;
	const encountersPending =
		seen.noPhp !== 0 || seen.warm !== 0 || seen.cold !== 0 || seen.absorbed !== 0;
	const stored = site.storedMeters(nowMs);
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
