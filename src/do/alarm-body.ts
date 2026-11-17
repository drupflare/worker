import type { SitePhpDurableObject } from '../site-do';
import { autoscalePhase } from './alarm/autoscale';
import type { AlarmContext, GatePhase, WorkPhase } from './alarm/context';
import { cronPhase } from './alarm/cron';
import { drainsPhase } from './alarm/drains';
import { fillPhase } from './alarm/fill';
import { healthPhase } from './alarm/health';
import { imagePhase } from './alarm/image';
import { lanePhase } from './alarm/lane';
import { metersPhase } from './alarm/meters';
import { migratePartialPhase, migratePhase } from './alarm/migrate';
import { mirrorsPhase } from './alarm/mirrors';
import { quarantinePhase } from './alarm/quarantine';
import { rearmPhase } from './alarm/rearm';
import { reconcilePhase } from './alarm/reconcile';
import { restorePhase } from './alarm/restore';
import { restorePartsPhase } from './alarm/restore-parts';
import { opsJobPhase, updbPhase } from './alarm/stepped';
import { recordInDeployment } from './fleet';
import { keepLaneReplicating } from './lane';
import { fillBatchSize, sleepBudgetMs } from './levers';
import { adoptRetained } from './retention';
import { noteAlarmDemand } from './stats';

/**
 * Phases that can end the firing, in order: restore, lane, migration, database update and stepped
 * jobs own the chain; quarantine and a partial database stop the fill; pool growth,
 * reconciliation and the image precede the fill that would boot.
 */
const GATES: GatePhase[] = [
	restorePhase,
	lanePhase,
	migratePhase,
	updbPhase,
	opsJobPhase,
	quarantinePhase,
	migratePartialPhase,
	autoscalePhase,
	reconcilePhase,
	imagePhase
];

/** work that never ends the firing; a waiting visitor outranks it, so it follows the fill */
const WORK: WorkPhase[] = [
	fillPhase,
	healthPhase,
	cronPhase,
	drainsPhase,
	mirrorsPhase,
	restorePartsPhase,
	metersPhase
];

/** one alarm firing: gate phases, work phases, re-arm; `site.gate` is not reentrant */
export async function alarmBody(
	site: SitePhpDurableObject,
	info?: AlarmInvocationInfo
): Promise<any> {
	site.lastAlarmAt = site.nowMs();
	// the alarm this firing consumed; whatever the firing sets on its way out replaces it
	site.alarmDueMs = undefined;
	// an alarm is a billed invocation, so slicing work into more alarms spends the meter it dodges
	site.doRequestsSinceFlush = (site.doRequestsSinceFlush ?? 0) + 1;
	// before the budgets are read: an alarm never passes handle(), so KV edits would not reach them
	await site.adoptSettings();
	const ctx: AlarmContext = {
		site,
		info,
		outcomes: [],
		maxPages: fillBatchSize(site.env),
		held: false,
		reconcileHeld: false
	};

	for (const phase of GATES) {
		const pending = phase(ctx);
		if (pending === undefined) continue;
		const end = await pending;
		if (end) return end.outcome;
	}
	for (const phase of WORK) {
		const pending = phase(ctx);
		if (pending) await pending;
	}
	return rearmPhase(ctx);
}

/**
 * Fill one page, then re-arm at +1 ms (each link is a fresh invocation with a fresh budget).
 *
 * The fill runs inside the gate. The return is `any` because the platform discards it and this
 * one feeds `/__serve-stats`.
 */
export async function alarmEntry(
	site: SitePhpDurableObject,
	info?: AlarmInvocationInfo
): Promise<any> {
	if (site.retired) return { retired: true };
	await site.adoptSecrets();
	adoptRetained(site);
	recordInDeployment(site);
	site.sleepBudget = { remainingMs: sleepBudgetMs(site.env, 'alarm') };
	site.countActivity('alarms');
	// an alarm writes authoritative state (cron), so seal in `finally`: an unsealed buffer
	// would leak into the next request with the wrong parent
	const linearBefore = site.heapNow();
	site.resetBridgeBytes();
	try {
		const outcome = await alarmBody(site, info);
		noteAlarmDemand(site, outcome, linearBefore);
		return outcome;
	} catch (e) {
		site.noteRangeError(e, 'alarm');
		throw e;
	} finally {
		// cron saves content, so settle the plan flag here too; after the work, not at the head
		// of `route()` (DDL on the fast lane would sit next to an open replay)
		site.settlePendingIfOwed();
		const invalidated = site.flushTagPurge();
		if (invalidated.length > 0) site.lastInvalidatedTags = invalidated;
		const settled = site.settlePlans(invalidated);
		if (settled.cleared)
			site.lastPlanPurge = { purged: settled.purged, tags: invalidated.length };
		await site.sealGeneration();
		await keepLaneReplicating(site);
	}
}
