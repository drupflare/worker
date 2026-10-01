import type { SitePhpDurableObject } from '../../site-do';
import { CATCH_UP_INTERVAL_MS } from '../limits';
import type { AlarmContext, AlarmEnd } from './context';

/** a pool lane below `SERVING` owns the chain until it catches up (it refuses every request) */
export function lanePhase({ site }: AlarmContext): Promise<AlarmEnd | undefined> | undefined {
	if (!site.isPoolLane()) return undefined;
	return laneFiring(site);
}

async function laneFiring(site: SitePhpDurableObject): Promise<AlarmEnd | undefined> {
	// nothing else asks a withdrawn lane back, so it asks for itself
	const readmission =
		site.replicaStage() === 'WITHDRAWN' ? await site.requestReadmission() : undefined;
	const caught = await site.catchUpOnce();
	site.lastCatchUp = caught;
	if (site.replicaStage() === 'SERVING') return undefined;

	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	// a copy spans many primary firings, so a lane waiting on one backs off instead of asking
	const waiting = readmission !== undefined || site.awaitingCopy();
	if (caught.ran || waiting) {
		site.alarmRearms = (site.alarmRearms ?? 0) + 1;
		await site.setAlarmAt(
			site.nowMs() + (waiting ? site.copyBackoffMs() : CATCH_UP_INTERVAL_MS)
		);
	}
	return { outcome: { catchUp: caught, ...(readmission ? { readmission } : {}) } };
}
