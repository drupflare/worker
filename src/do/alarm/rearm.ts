import { idleRearmMs } from '../../ops/cron';
import { mailDrainEnabled } from '../../ops/mail';
import { isQuarantined, parseState } from '../../ops/repair';
import { alarmRearmDelayMs, classifyAlarmOutcome } from '../alarm';
import { noteResident } from '../isolate';
import { httpDrainEnabled } from '../levers';
import type { AlarmContext } from './context';

/**
 * Decides the next firing and arms it, last of all. The delay comes from what the batch achieved;
 * a non-empty queue can speed up a chain that is progressing but never rescue a failing one.
 */
export async function rearmPhase({ site, outcomes, held, hold }: AlarmContext): Promise<any> {
	// one re-arm per batch, not per page
	site.alarmRearms = (site.alarmRearms ?? 0) + 1;

	const remaining = site.queueDepth();
	const httpRemaining = httpDrainEnabled(site.env)
		? (site.countOrNull('cfw_http_queue') ?? 0)
		: 0;
	// a mail queue the limit could not empty must not wait for the keep-warm tick
	const mailRemaining = mailDrainEnabled(site.env ?? {})
		? (site.countOrNull('cfw_mail_queue') ?? 0)
		: 0;
	const cls = classifyAlarmOutcome(outcomes);
	// supervise() ran after the fills, so a site that just quarantined must not re-arm at +1 ms
	const quarantined = isQuarantined(parseState(site.metaGet('repair_state')));
	const delayMs = quarantined
		? 60_000
		: alarmRearmDelayMs(cls, {
				queueNonEmpty: remaining > 0 || httpRemaining > 0 || mailRemaining > 0,
				failures: site.consecutiveFillFailures ?? 0,
				// a lane nobody routes to must hibernate, since warming is per object and a pool
				// multiplies it; otherwise the predictor decides, never overriding SITE_WARM
				idleMs: site.laneIsIdle()
					? Math.max(idleRearmMs(site.env, site.degradation().cron), 240_000)
					: site.thermalRearmMs()
			});
	const heldDelayMs = held && hold !== undefined ? Math.max(1, hold - site.nowMs()) : Infinity;
	site.consecutiveFillFailures = cls === 'failure' ? (site.consecutiveFillFailures ?? 0) + 1 : 0;
	site.lastAlarmClass = cls;
	// the quiet moment the memory tripwire asks for, after a fill, install step or cron hook
	site.recycleIfOversized('alarm');
	site.traceMemory('alarm-end');
	noteResident(site.ctx.id.toString(), site.php);
	site.retainInterpreter();
	await site.setAlarmAt(site.nowMs() + Math.min(delayMs, heldDelayMs));
	return site.lastAlarmOutcome;
}
