import type { Payload } from '../types';
import type { AlarmContext, AlarmEnd } from './context';

/**
 * Reconciliation runs before the image (a landed step invalidates it) and the fill (an unreconciled
 * site cannot store). Gated: its PHP beside a visitor's render booted a second interpreter.
 */
export async function reconcilePhase(ctx: AlarmContext): Promise<AlarmEnd | undefined> {
	const { site } = ctx;
	const reconcile = await site.gate.run(() => site.reconcileStepOnce(), 'alarm-reconcile');
	// a held step ends nothing: the hold is on PHP and the drains below are JS
	ctx.reconcileHeld =
		reconcile !== undefined &&
		Number((reconcile.reconcile as Payload | undefined)?.held ?? 0) > 0;
	if (reconcile && ctx.reconcileHeld) site.lastReconcile = reconcile;
	if (reconcile && !ctx.reconcileHeld) {
		site.lastReconcile = reconcile;
		site.lastAlarmOutcome = reconcile;
		site.alarmFirings = (site.alarmFirings ?? 0) + 1;
		site.alarmRearms = (site.alarmRearms ?? 0) + 1;
		await site.setAlarmAt(site.nowMs() + 1000);
		return { outcome: reconcile };
	}
	return undefined;
}
