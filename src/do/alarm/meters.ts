import type { AlarmContext } from './context';

/**
 * Folds this firing's writes into the daily total (last, so it sees all of them), then reports to
 * the fleet inventory. The flush is rate-limited: an idle tick would otherwise record only itself.
 */
export async function metersPhase({ site }: AlarmContext): Promise<void> {
	// its own interval, so it sits outside the meter gate and an idle tick writes nothing here
	site.flushRenderWindow();
	if (site.shouldFlushMeters()) {
		// one row for all four counters
		site.flushMeters();
		site.lastMeterFlushMs = site.nowMs();
	}
	// identity moves report at once, otherwise once a day, so a quiet fleet spends no D1 meter
	await site.reportToFleet();
}
