import { updbAlarmDelayMs, updbOptions } from '../../ops/updb';
import type { SitePhpDurableObject } from '../../site-do';
import { updbActive } from '../reconcile';
import type { AlarmContext, AlarmEnd } from './context';

/**
 * A database update in progress owns the chain (a fill from a half-updated schema would cache
 * output the finished site cannot reproduce); an ordinary alarm pays one indexed read.
 */
export function updbPhase({ site }: AlarmContext): Promise<AlarmEnd> | undefined {
	if (!updbActive(site)) return undefined;
	return updbFiring(site);
}

async function updbFiring(site: SitePhpDurableObject): Promise<AlarmEnd> {
	const outcome = await site.updbStepOnce();
	site.lastAlarmOutcome = outcome;
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	site.alarmRearms = (site.alarmRearms ?? 0) + 1;
	await site.setAlarmAt(site.nowMs() + updbAlarmDelayMs(outcome?.updb, updbOptions(site.env)));
	return { outcome };
}

/** a stepped operation (a config import, a queue drain) gets one step per firing */
export function opsJobPhase({ site }: AlarmContext): Promise<AlarmEnd> | undefined {
	if (!site.opsJobActive()) return undefined;
	return opsJobFiring(site);
}

async function opsJobFiring(site: SitePhpDurableObject): Promise<AlarmEnd> {
	const outcome = await site.opsJobBeat();
	site.lastAlarmOutcome = outcome;
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	site.alarmRearms = (site.alarmRearms ?? 0) + 1;
	await site.setAlarmAt(site.nowMs() + (site.opsJobActive() ? 1 : 1_000));
	return { outcome };
}
