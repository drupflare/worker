import type { AlarmContext, AlarmEnd } from './context';

/**
 * The heap image, once per pack generation, and it ends the firing: imaging boots the kernel and
 * the fill batch is more workloads in the same incarnation, which the recycle cannot reach.
 */
export async function imagePhase({ site }: AlarmContext): Promise<AlarmEnd | undefined> {
	const imaged = await site.snapshotStep();
	if (!imaged) return undefined;
	site.lastHeapImage = imaged;
	site.dropInterpreter();
	site.lastAlarmOutcome = imaged;
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	await site.setAlarmAt(site.nowMs() + 1000);
	return { outcome: site.lastAlarmOutcome };
}
