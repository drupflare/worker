import type { SitePhpDurableObject } from '../../site-do';
import type { HeapRestoreCursor } from '../alarm';
import { restoreAlarmDecision } from '../alarm';
import { restoreStepOnce } from '../heap-image';
import type { AlarmContext, AlarmEnd } from './context';

/**
 * An open heap restore owns the chain: ensurePhp() throws until it closes, so every other phase
 * would only raise.
 */
export function restorePhase({ site }: AlarmContext): Promise<AlarmEnd> | undefined {
	if (!site.heapRestoreCursor) return undefined;
	return restoreFiring(site, site.heapRestoreCursor);
}

async function restoreFiring(
	site: SitePhpDurableObject,
	cursor: HeapRestoreCursor
): Promise<AlarmEnd> {
	const before = cursor.nextChunk;
	const outcome = await restoreStepOnce(site);
	site.lastAlarmOutcome = outcome;
	site.alarmFirings = (site.alarmFirings ?? 0) + 1;

	const decision = restoreAlarmDecision(before, site.heapRestoreCursor);
	// a firing that moved the cursor zero chunks would re-arm at +1 ms forever and starve the gate
	if (decision.action === 'halt') {
		site.heapRestore = {
			restored: false,
			reason: `restore stalled at chunk ${before}; abandoned rather than re-armed`,
			discardedHeap: true
		};
		site.heapRestoreCursor = undefined;
		site.php = undefined;
		return { outcome: { heapRestore: site.heapRestore } };
	}

	site.alarmRearms = (site.alarmRearms ?? 0) + 1;
	await site.setAlarmAt(site.nowMs() + decision.delayMs);
	return { outcome };
}
