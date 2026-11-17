import type { AlarmContext } from '../do/alarm/context';
import type { Payload } from '../do/types';
import { cronDue, cronIntervalMs } from '../ops/cron-drive';
import { errorMessage } from '../util/errors';
import { wordpressRender } from './site-php';

/** `WORDPRESS_CRON=0` turns the drive off; absent means on, as for Drupal's cron */
export function wordpressCronEnabled(env?: { WORDPRESS_CRON?: string }): boolean {
	const raw = env?.WORDPRESS_CRON;
	return raw === undefined || raw === '' ? true : !(raw === '0' || raw === 'false');
}

/** what one run reports, without the page body */
function summary(out: Payload | undefined): Payload {
	if (out === undefined) return { error: 'no result' };
	const { status, stop, entry, error, at, exited } = out;
	return { status, stop, entry, ...(error ? { error, at } : {}), ...(exited ? { exited } : {}) };
}

/**
 * WordPress's own cron, requested through `wp-cron.php` on the one-shot path.
 *
 * `wp-cron.php` holds WordPress's `doing_cron` lock, so a firing that finds a live lock runs no
 * event. It yields as Drupal's does: to the quota ladder, to a fill backlog and to a young
 * interpreter, and runs at most once per `CRON_INTERVAL_MS`.
 */
export async function wordpressCronPhase(ctx: AlarmContext): Promise<void> {
	const { site, hold } = ctx;
	if (!wordpressCronEnabled(site.env)) return;
	const last = await site.storage.get<number>('cronLastRunMs');
	if (last === undefined) {
		// start the clock without running, so the first pass is an interval away
		await site.storage.put('cronLastRunMs', site.nowMs());
		return;
	}
	if (!cronDue(last, site.nowMs(), cronIntervalMs(site.env))) return;
	if (hold !== undefined) {
		ctx.held = true;
		return;
	}
	if (!site.degradation().cron || site.queueDepth() !== 0) return;
	try {
		await site.storage.put('cronLastRunMs', site.nowMs());
		const out = await site.gate.run(async () => {
			const result = await site.runJsonMaybeParked(
				wordpressRender('/wp-cron.php', { origin: site.canonicalOrigin() })
			);
			// the one-shot interpreter is gone after a request, whatever it answered
			site.resetPhp();
			return result;
		}, 'alarm-cron');
		site.lastCron = { at: Date.now(), value: summary(out) };
	} catch (e) {
		site.lastCron = { at: Date.now(), value: { error: errorMessage(e) } };
	}
}
