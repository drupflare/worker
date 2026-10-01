import type { AlarmContext, AlarmEnd } from './context';

/** pool growth runs before the image and the fill: a lane copy is SQL only and boots nothing */
export async function autoscalePhase({ site }: AlarmContext): Promise<AlarmEnd | undefined> {
	const scaled = await site.autoScaleStep();
	if (!scaled) return undefined;
	site.lastAutoScale = scaled;
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	await site.setAlarmAt(site.nowMs() + 1000);
	return { outcome: (site.lastAlarmOutcome = scaled) };
}
