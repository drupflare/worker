import { cronOptions, writeCursor } from '../../ops/cron';
import {
	cronBudget,
	cronDue,
	cronIntervalMs,
	driveCron,
	drupalCronEnabled,
	firingIdempotent,
	lostFiringCursor
} from '../../ops/cron-drive';
import {
	argsText,
	forgetRows,
	isReported,
	openOutbox,
	PermanentError,
	trimReported,
	type OutboxContext,
	type OutboxSql
} from '../../ops/outbox';
import { cmsOf } from '../../util/cms';
import { errorMessage } from '../../util/errors';
import { wordpressCronPhase } from '../../wordpress/cron';
import { phasesFor } from '../tree-boot';
import type { AlarmContext } from './context';

/** what a cron outbox row carries: the cursor the firing starts from and the hooks it may run */
type CronFiring = { cursor: string | null; hooks: string[] };

/** the options a firing runs with, which the lost-firing cursor must read the same way */
function firingOptions({ site }: AlarmContext, hooks: string[]) {
	return {
		...cronOptions(site.env),
		// the pinned origin; cron has no request
		// and a default would point mail at localhost
		origin: site.canonicalOrigin(),
		hooks,
		healthObservation: site.healthObservation()
	};
}

/**
 * The cron outbox. Its effect is one firing: the cursor in, `driveCron()` through the gate, the
 * cursor out. A row is claimed and flushed before the effect runs, so a reset that kills the
 * firing leaves a running row whose lease ends. The successor replays it only when the firing
 * reached SQL passes alone (`cron-idempotent`) and reports it otherwise (`cron`).
 */
function cronOutbox(ctx: AlarmContext) {
	const { site } = ctx;
	return openOutbox(
		site.sql as unknown as OutboxSql,
		'cron',
		async (row: OutboxContext) => {
			const firing = JSON.parse(argsText(row)) as CronFiring;
			try {
				const driven = await site.gate.run(
					() =>
						driveCron(
							firing.cursor ?? undefined,
							{
								sql: site.sql,
								runJson: (code: string) => site.runJsonMaybeParked(code)
							},
							firingOptions(ctx, firing.hooks),
							cronBudget(site.env)
						),
					'alarm-cron'
				);
				await site.storage.put('cronCursor', writeCursor(driven.cursor));
				site.lastCron = { at: Date.now(), value: driven };
				return JSON.stringify({ units: driven.units, stoppedBy: driven.stoppedBy });
			} catch (e) {
				// the firing may have run PHP, so it must not be tried again
				throw new PermanentError(errorMessage(e), { cause: e });
			}
		},
		{ flush: () => site.storage.sync() }
	);
}

/**
 * Drains the cron outbox and settles what it finished. A reported firing moves the stored cursor
 * past the PHP unit it may have run, once, and stays in the table for the operator.
 */
async function settleCron(ctx: AlarmContext, outbox: ReturnType<typeof cronOutbox>) {
	const { site } = ctx;
	await outbox.drain();
	const spent: string[] = [];
	let reported = false;
	for (const row of outbox.results()) {
		if (row.state === 'queued' || row.state === 'running') continue;
		if (!isReported(row)) {
			if (row.state === 'failed') {
				site.lastCron = { at: Date.now(), value: { error: row.error ?? 'failed' } };
			}
			spent.push(row.id);
			continue;
		}
		reported = true;
		const firing = JSON.parse(argsText(row)) as CronFiring;
		const stored = (await site.storage.get<string>('cronCursor')) ?? null;
		// only while no later firing has moved the cursor
		if (stored === firing.cursor) {
			await site.storage.put(
				'cronCursor',
				writeCursor(
					lostFiringCursor(firing.cursor ?? undefined, firingOptions(ctx, firing.hooks))
				)
			);
			site.lastCron = { at: Date.now(), value: { reported: row.id, error: row.error ?? '' } };
		}
	}
	forgetRows(site.sql as unknown as OutboxSql, 'cron', spent);
	if (reported) trimReported(site.sql as unknown as OutboxSql, 'cron');
}

/**
 * Drupal's own cron, after GC and before the drains, on by default and budgeted to a fraction of
 * the daily row meter. It yields to the quota ladder, to a fill backlog and to a young interpreter.
 */
export async function cronPhase(ctx: AlarmContext): Promise<void> {
	const { site, hold } = ctx;
	// each CMS has its own drive, and one with none must not run Drupal's on its tree
	const drive = phasesFor(cmsOf(site.env)).cron;
	if (drive === 'wordpress') return wordpressCronPhase(ctx);
	if (drive === 'none') return;
	// a firing an earlier object left running is replayed or reported before anything new starts
	if ((site.countOrNull('cfw_outbox_cron') ?? 0) > 0) {
		try {
			await settleCron(ctx, cronOutbox(ctx));
		} catch (e) {
			site.lastCron = { at: Date.now(), value: { error: errorMessage(e) } };
		}
	}
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
			// stamped and flushed before discovery boots a kernel, so a kill there cannot loop; the
			// claim below follows it, so a reset between the two skips an interval and never repeats
			// a firing
			const stamp = site.nowMs();
			await site.storage.put('cronLastRunMs', stamp);
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
				const cursor = (await site.storage.get<string>('cronCursor')) ?? null;
				const idempotent = firingIdempotent(
					cursor ?? undefined,
					firingOptions(ctx, hooks),
					cronBudget(site.env)
				);
				const outbox = cronOutbox(ctx);
				await outbox.enqueue([
					{
						id: `cron-${stamp}`,
						kind: idempotent ? 'cron-idempotent' : 'cron',
						argsJson: { cursor, hooks } satisfies CronFiring
					}
				]);
				await settleCron(ctx, outbox);
			}
		} catch (e) {
			// a cron failure must never take down the alarm that serves the site
			site.lastCron = { at: Date.now(), value: { error: errorMessage(e) } };
		}
	}
}
