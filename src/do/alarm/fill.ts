import { cmsOf } from '../../util/cms';
import { errorMessage } from '../../util/errors';
import { HeapRestoreIncomplete } from '../alarm';
import { visitorHoldUntil, visitorQuietMs } from '../levers';
import type { Payload } from '../types';
import type { AlarmContext } from './context';

/**
 * The fill batch: up to `maxPages` renders in one firing, because each re-arm costs a row write.
 *
 * The page count and the isolate's memory bound it; the wall clock cannot, since it does not
 * advance across a synchronous render. A young interpreter takes no background PHP, so the batch
 * waits and the re-arm lands on the end of the hold.
 */
export function fillPhase(ctx: AlarmContext): Promise<void> | undefined {
	const { site, info } = ctx;
	// a render that kills its isolate skips its strike; the retried queue head is that page
	if (info?.isRetry) {
		site.strikeFillHead(`the alarm died mid-batch (retry ${info.retryCount})`);
	}
	const hold = site.backgroundHold();
	ctx.hold = hold;
	let held = ctx.reconcileHeld && hold !== undefined;
	if (hold !== undefined && site.queueDepth() > 0) {
		held = true;
		site.fillHolds += 1;
		site.lastFillHold = { at: site.nowMs(), until: hold, queued: site.queueDepth() };
	}
	ctx.held = held;
	if (held || ctx.maxPages <= 0) {
		recordFill(ctx);
		return undefined;
	}
	const aside = visitorWaitUntil(ctx);
	if (aside !== undefined) {
		ctx.pauseUntil = aside;
		recordFill(ctx);
		return undefined;
	}
	return fillBatch(ctx);
}

/**
 * When the batch may resume after a visitor, or undefined when it may run now.
 *
 * A page a visitor is waiting on is not background work: the chain fills it at once.
 */
function visitorWaitUntil({ site }: AlarmContext): number | undefined {
	// WordPress renders take half a second each; Drupal's batch is left as it was
	if (cmsOf(site.env) !== 'wordpress') return undefined;
	const until = visitorHoldUntil(
		site.lastVisitorAt,
		site.lastAlarmFillAt,
		site.nowMs(),
		visitorQuietMs(site.env)
	);
	if (until === undefined || site.queueDepth() === 0) return undefined;
	const waiting = site.sql
		.exec('SELECT 1 FROM cfw_fill_queue WHERE priority = 0 LIMIT 1')
		.toArray();
	return waiting.length > 0 ? undefined : until;
}

/**
 * Gives a request that reached the object during a render its turn on the event loop.
 *
 * The timer is created and awaited inside a running alarm handler, so it has fired before the
 * firing ends and nothing pends when the object goes idle.
 */
function yieldToRequests(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 25));
}

async function fillBatch(ctx: AlarmContext): Promise<void> {
	const { site, outcomes } = ctx;
	for (let i = 0; i < ctx.maxPages; i++) {
		if (i > 0 && cmsOf(site.env) === 'wordpress') {
			await yieldToRequests();
			const aside = visitorWaitUntil(ctx);
			if (aside !== undefined) {
				ctx.pauseUntil = aside;
				break;
			}
		}
		let outcome: Payload | undefined;
		try {
			outcome = await site.gate.run(() => site.fillOne(), 'alarm');
		} catch (e) {
			// a throw skips fillOne()'s own strikes and would leave the queue row at +1 ms forever
			outcome = { error: errorMessage(e), threw: true };
			if (e instanceof HeapRestoreIncomplete) {
				// the restore branch drives the chain; striking would charge the page for a boot
				outcome.restorePending = true;
			} else {
				site.strikeFillHead(String(outcome.error));
			}
		}
		outcomes.push(outcome);
		site.lastAlarmFillAt = site.nowMs();
		console.info('cfw-fill', {
			page: outcome?.filled ?? null,
			remaining: outcome?.remaining ?? null,
			linear: site.heapNow(),
			isolate: site.isolateNow(),
			oversized: site.oversized()
		});
		if (!outcome || (outcome.filled === null && outcome.failed === undefined)) break;
		if ((outcome.remaining ?? 0) === 0) break;
		// N renders accumulate in one incarnation and the recycle only runs between invocations
		if (site.oversized()) {
			outcome.stoppedBy = 'memory';
			break;
		}
	}
	recordFill(ctx);
}

function recordFill({ site, outcomes, held }: AlarmContext): void {
	site.lastAlarmOutcome = held
		? { held: site.lastFillHold ?? null }
		: outcomes.length === 1
			? outcomes[0]
			: outcomes;
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;
	site.pagesFilledByAlarms =
		(site.pagesFilledByAlarms ?? 0) + outcomes.filter((o) => o?.filled).length;
}
