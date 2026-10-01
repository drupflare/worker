import type { SitePhpDurableObject } from '../../site-do';
import { migrateAlarmDelayMs } from '../alarm';
import { migrationSelfDrives } from '../levers';
import type { AlarmContext, AlarmEnd } from './context';

/**
 * Migration comes first and ends the firing: an unmigrated site has nothing to fill, and a chunk
 * is the largest unit that fits alone, so it never shares an invocation with a render.
 */
export function migratePhase({ site }: AlarmContext): Promise<AlarmEnd | undefined> | undefined {
	if (!migrationSelfDrives(site.env)) return undefined;
	return migrateFiring(site);
}

async function migrateFiring(site: SitePhpDurableObject): Promise<AlarmEnd | undefined> {
	const pending = await site.migrateStepIfPending();
	if (!pending) return undefined;
	site.lastAlarmOutcome = pending;
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	site.alarmRearms = (site.alarmRearms ?? 0) + 1;

	// a failing step must back off; at +1 ms it starved every gated request behind the alarm
	if (pending.migrate?.ok === false) {
		site.migrateFailures = (site.migrateFailures ?? 0) + 1;
	} else {
		site.migrateFailures = 0;
	}
	const delay = migrateAlarmDelayMs(pending.migrate, site.migrateFailures);
	await site.setAlarmAt(site.nowMs() + delay);
	return { outcome: pending };
}

/** an incomplete database cannot be rendered against, and booting to fill one costs a ~4 s boot */
export function migratePartialPhase({ site }: AlarmContext): Promise<AlarmEnd> | undefined {
	if (!site.migratePartial()) return undefined;
	return partialFiring(site);
}

async function partialFiring(site: SitePhpDurableObject): Promise<AlarmEnd> {
	site.lastAlarmOutcome = { skipped: 'migration incomplete' };
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	await site.setAlarmAt(site.nowMs() + 1000);
	return { outcome: site.lastAlarmOutcome };
}
