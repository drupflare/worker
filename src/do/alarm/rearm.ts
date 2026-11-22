import { idleRearmMs } from '../../ops/cron';
import { mailDrainEnabled } from '../../ops/mail';
import { isPaid } from '../../ops/plan';
import { isQuarantined, parseState } from '../../ops/repair';
import { alarmRearmDelayMs, classifyAlarmOutcome } from '../alarm';
import { noteResident } from '../isolate';
import { httpDrainEnabled } from '../levers';
import type { AlarmContext } from './context';

/** when the earliest queued message is next due, or undefined when none is waiting for a retry */
function nextMailRetryMs(site: AlarmContext['site']): number | undefined {
	const row = site.sql
		.exec<{ at: number | null }>(
			'SELECT MIN(retry_at) AS at FROM cfw_mail_queue WHERE retry_at > ?',
			site.nowMs()
		)
		.toArray()[0];
	return row?.at === null || row?.at === undefined ? undefined : Number(row.at);
}

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
	const mailOn = mailDrainEnabled(site.env ?? {});
	// a message waiting out its retry delay is not backlog: counting it would spin the alarm
	const mailDue = mailOn
		? site.countOrNull('cfw_mail_queue', `retry_at <= ${site.nowMs()}`)
		: null;
	const mailRemaining = mailDue ?? 0;
	// null means no queue table, so there is nothing to wait for and no second read is spent
	const mailWaiting = mailDue === null ? undefined : nextMailRetryMs(site);
	const queued = remaining > 0 || httpRemaining > 0 || mailRemaining > 0;
	const cls = classifyAlarmOutcome(outcomes);
	// supervise() ran after the fills, so a site that just quarantined must not re-arm at +1 ms
	const quarantined = isQuarantined(parseState(site.metaGet('repair_state')));
	const delayMs = quarantined
		? 60_000
		: alarmRearmDelayMs(cls, {
				queueNonEmpty: queued,
				failures: site.consecutiveFillFailures ?? 0,
				// a lane nobody routes to must hibernate, since warming is per object and a pool
				// multiplies it; otherwise the predictor decides, never overriding SITE_WARM
				idleMs: site.laneIsIdle()
					? Math.max(
							idleRearmMs(site.env, site.degradation().cron, isPaid(site.env)),
							240_000
						)
					: site.thermalRearmMs(queued)
			});
	const heldDelayMs = Math.min(
		held && hold !== undefined ? Math.max(1, hold - site.nowMs()) : Infinity,
		mailWaiting === undefined ? Infinity : Math.max(1, mailWaiting - site.nowMs())
	);
	site.consecutiveFillFailures = cls === 'failure' ? (site.consecutiveFillFailures ?? 0) + 1 : 0;
	site.lastAlarmClass = cls;
	// the quiet moment the memory tripwire asks for, after a fill, install step or cron hook
	site.recycleIfOversized('alarm');
	site.traceMemory('alarm-end');
	noteResident(site.ctx.id.toString(), site.php);
	site.retainInterpreter();
	// the firing's own delay replaces any sooner arm the held events asked for along the way
	site.armHeldAtMs = undefined;
	await site.setAlarmAt(site.nowMs() + Math.min(delayMs, heldDelayMs));
	return site.lastAlarmOutcome;
}
