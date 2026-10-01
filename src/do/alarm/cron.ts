import { cronOptions, writeCursor } from '../../ops/cron';
import {
	cronBudget,
	cronDue,
	cronIntervalMs,
	driveCron,
	drupalCronEnabled
} from '../../ops/cron-drive';
import { errorMessage } from '../../util/errors';
import type { AlarmContext } from './context';

/**
 * Drupal's own cron, after GC and before the drains, on by default and budgeted to a fraction of
 * the daily row meter. It yields to the quota ladder, to a fill backlog and to a young interpreter.
 */
export async function cronPhase(ctx: AlarmContext): Promise<void> {
	const { site, hold } = ctx;
	const cronLastRun = await site.storage.get<number>('cronLastRunMs');
	const cronHeld =
		hold !== undefined &&
		drupalCronEnabled(site.env) &&
		cronLastRun !== undefined &&
		cronDue(cronLastRun, site.nowMs(), cronIntervalMs(site.env));
	if (cronHeld) ctx.held = true;
	if (drupalCronEnabled(site.env) && cronLastRun === undefined) {
		// start the clock without running, so the first pass is an interval away and not on the
		// busiest alarm the site will have
		await site.storage.put('cronLastRunMs', site.nowMs());
	} else if (
		!cronHeld &&
		drupalCronEnabled(site.env) &&
		// the quota ladder's first rung: nobody is waiting on cron
		site.degradation().cron &&
		// the ladder is a daily meter; only an empty queue says no visitor is waiting for a page
		site.queueDepth() === 0 &&
		cronDue(cronLastRun, site.nowMs(), cronIntervalMs(site.env))
	) {
		try {
			await site.storage.put('cronLastRunMs', site.nowMs());
			// gated like reconciliation: cron runs PHP and a visitor may be mid-render
			const { hooks, discovered } = await site.gate.run(
				() => site.cronHooksForSite(),
				'alarm-cron'
			);
			site.lastCronHooks = hooks;
			if (discovered) {
				// discovery booted the kernel; a hook on top is two workloads in one incarnation
				site.lastCron = { at: Date.now(), value: { discoveredHooks: hooks.length } };
			} else {
				const cursor = await site.storage.get<string>('cronCursor');
				const driven = await site.gate.run(
					() =>
						driveCron(
							cursor,
							{ sql: site.sql, runJson: (code: string) => site.runJson(code) },
							// the pinned origin; cron has no request
							// and a default would point mail at localhost
							{
								...cronOptions(site.env),
								origin: site.canonicalOrigin(),
								hooks,
								healthObservation: site.healthObservation()
							},
							cronBudget(site.env)
						),
					'alarm-cron'
				);
				await site.storage.put('cronCursor', writeCursor(driven.cursor));
				site.lastCron = { at: Date.now(), value: driven };
			}
		} catch (e) {
			// a cron failure must never take down the alarm that serves the site
			site.lastCron = { at: Date.now(), value: { error: errorMessage(e) } };
		}
	}
}
