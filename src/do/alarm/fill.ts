import { errorMessage } from '../../util/errors';
import { HeapRestoreIncomplete } from '../alarm';
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
	return fillBatch(ctx);
}

async function fillBatch(ctx: AlarmContext): Promise<void> {
	const { site, outcomes } = ctx;
	for (let i = 0; i < ctx.maxPages; i++) {
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
