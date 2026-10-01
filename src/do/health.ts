import { DAILY_DO_QUOTA, DAILY_ROWS_QUOTA } from '../ops/auth-budget';
import { isFree } from '../ops/plan';
import { parseState, recordOutcome, serialiseState } from '../ops/repair';
import {
	type Finding,
	type Observation,
	quarantineDecision,
	recordFinding,
	runHostTripwires,
	SEVERITY
} from '../ops/supervisor';
import { projectImageTransforms } from '../ops/thresholds';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { firstRow } from '../util/sql';
import { shimGlobals } from './isolate';
import type { Payload, Row } from './types';

/**
 * What the object can see about itself at the end of an alarm.
 *
 * Fields are scalars or rings capped at 8, so this stays cheap on every firing. `countOrNull()`
 * is why `semaphoreRows` is omitted, not 0, on an unmigrated site.
 */
export function observe(
	site: SitePhpDurableObject,
	outcomes: (Payload | undefined)[]
): Observation {
	const last = [...outcomes].reverse().find((o) => o?.filled);
	const path = last ? String(last.filled) : undefined;
	const bytes = last && typeof last.bytes === 'number' ? last.bytes : undefined;

	// whole isolate (linear plus the JS mount): linear alone and capped MEMFS both saturate, so
	// neither can show four rising readings
	const memory = site.isolateNow();
	if (memory > 0) site.memoryRing.push(memory);
	const rowsToday = site.dailyRows();
	const doToday = site.dailyDoRequests();
	site.rowsRing.push(rowsToday);
	site.doRing.push(doToday);

	const semaphore = site.countOrNull('semaphore');
	const migrate = site.migrateCursorOrNull();
	const updb = site.lastUpdb?.value;

	const obs: Observation = {
		asyncifyCalls: shimGlobals.__cfwAsyncifyCalls ?? 0,
		memorySamples: site.memoryRing.samples(),
		rowsWritten: rowsToday,
		doRequests: doToday,
		rowsWrittenSamples: site.rowsRing.samples(),
		doRequestsSamples: site.doRing.samples(),
		ledgerRows: Number(
			firstRow(site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_health'))
				?.c ?? 0
		)
	};
	if (path !== undefined) obs.path = path;
	if (bytes !== undefined) {
		obs.status = 200;
		obs.bytes = bytes;
		// read the baseline before recording this render into it
		const median = site.medianRenderBytes(path ?? '');
		if (median !== undefined) obs.medianBytes = median;
		site.noteRenderBytes(path ?? '', bytes);
	}
	if (semaphore !== null) obs.semaphoreRows = semaphore;
	if (migrate) {
		obs.migrateChunk = Number(migrate.chunk ?? 0);
		obs.migrateChunks = Number(migrate.chunks ?? 0);
	}
	if (updb && typeof updb.phase === 'string') obs.updbPhase = updb.phase;
	// the daily quotas are hard caps on free only (paid is billed, not capped)
	if (isFree(site.env)) {
		obs.rowsWrittenLimit = DAILY_ROWS_QUOTA;
		obs.doRequestsLimit = DAILY_DO_QUOTA;
	}

	// projected from configuration; null (unmigrated) is not zero, so the projection is omitted
	const styles = site.countOrNull('config', "name LIKE 'image.style.%'");
	const images = site.countOrNull('file_managed', "filemime LIKE 'image/%'");
	if (styles !== null && images !== null) {
		const projection = projectImageTransforms({ images, styles }, site.env);
		obs.imageTransforms = projection.uniques;
		if (projection.limit !== null) obs.imageTransformsLimit = projection.limit;
	}
	const pack = site.packGeneration();
	const db = site.metaGet('pack_generation');
	if (pack && db) {
		obs.packGeneration = pack;
		obs.dbGeneration = db;
	}
	return obs;
}

/**
 * Runs the host tripwires and moves the repair ladder, on the alarm only (`recordFinding()` is
 * a row write and a waiting visitor outranks bookkeeping).
 *
 * State is persisted only when it changes, so a healthy site writes zero rows.
 */
export function supervise(
	site: SitePhpDurableObject,
	outcomes: (Payload | undefined)[]
): Finding[] {
	let findings: Finding[];
	try {
		findings = runHostTripwires(site.observe(outcomes));
	} catch (e) {
		// a throwing tripwire is a tripwire defect, not evidence about the site
		site.lastFindings = [
			{
				code: 'health.observe_failed',
				severity: 'warn',
				scope: 'supervisor',
				context: errorMessage(e)
			}
		];
		return site.lastFindings;
	}
	site.lastFindings = findings;

	const before = parseState(site.metaGet('repair_state'));
	const decision = quarantineDecision(findings);
	// error and above is a failure, not critical-only (three `bridge.asyncify_called` is durable);
	// warn is not, or a healthy busy site would be quarantined
	const failing = findings.filter((f) => SEVERITY[f.severity] >= SEVERITY.error);
	const after =
		failing.length > 0
			? recordOutcome(
					before,
					{ ok: false, code: failing[0]?.code ?? 'unknown' },
					site.nowMs()
				)
			: recordOutcome(before, { ok: true }, site.nowMs());

	for (const f of findings) {
		recordFinding(site.sql, f, site.nowMs(), after.rung, decision.reason, after.strikes);
	}
	const serialised = serialiseState(after);
	if (serialised !== serialiseState(before)) site.metaSet('repair_state', serialised);
	return findings;
}
