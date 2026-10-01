import {
	drainMailQueue,
	mailDrainEnabled,
	mailDrainLimit,
	resolveMailTransport
} from '../../ops/mail';
import { isPaid } from '../../ops/plan';
import { errorMessage } from '../../util/errors';
import { httpDrainEnabled, httpDrainLimit } from '../levers';
import { queueDeclaredFetches } from '../outbound';
import type { Payload } from '../types';
import type { AlarmContext } from './context';

/**
 * The background queues, after the fills so a visitor outranks them: the addressable sweep,
 * deferred HTTP, outbound mail, git polling and upload derivatives, each failing on its own.
 */
export async function drainsPhase({ site }: AlarmContext): Promise<void> {
	// after cron, whose empty-queue check a sweep that queued pages would otherwise suppress
	site.sweepBeat();

	// PHP cannot await, so queued fetches are performed here between PHP runs
	if (httpDrainEnabled(site.env)) {
		try {
			// urls the schedule decides are fetched before the render that wants them
			queueDeclaredFetches(site);
			const drained = await site.drainHttpQueue(httpDrainLimit(site.env));
			// an empty array is truthy, so the length is what says something drained
			if ((drained?.drained?.length ?? 0) > 0) {
				site.lastHttpDrain = { at: Date.now(), value: drained };
			}
		} catch (e) {
			site.lastHttpDrain = { at: Date.now(), value: { error: errorMessage(e) } };
		}
	}

	// a worker cannot send from inside a synchronous host call, so mail is committed and sent here
	if (mailDrainEnabled(site.env ?? {}) && (site.countOrNull('cfw_mail_queue') ?? 0) > 0) {
		await site.adoptSettings();
		// refresh the Cloudflare grant here: the commit path cannot await and reads it unrefreshed
		await site.cfCredentials().catch(() => ({ token: '', accountId: '' }));
		// re-resolved per drain, so a fixed credential drains what the old one refused
		const plan = resolveMailTransport(site.mailEnv());
		if ('refusal' in plan) {
			site.lastMailDrain = { at: Date.now(), value: { refusal: plan.refusal } };
		} else {
			try {
				// an open SMTP socket disables hibernation, so the drain is billed for duration
				site.mailSocketOpen = plan.transport.kind === 'smtp';
				const drained = await drainMailQueue(site.sql, plan.transport, {
					limit: mailDrainLimit(site.env ?? {}),
					plan: isPaid(site.env) ? 'paid' : 'free'
				});
				if (drained.sent.length > 0) {
					site.lastMailDrain = { at: Date.now(), value: drained as unknown as Payload };
				}
			} catch (e) {
				site.lastMailDrain = { at: Date.now(), value: { error: errorMessage(e) } };
			} finally {
				site.mailSocketOpen = false;
			}
		}
	}

	// a poll is a request and a fetch is a subrequest; a remote that never moves costs one advert
	if (site.gitRemotes().length > 0) {
		try {
			const polled = await site.gitPoll();
			if (polled.length > 0) {
				site.lastGitPoll = { at: Date.now(), value: polled };
			}
		} catch (e) {
			site.lastGitPoll = { at: Date.now(), value: [{ error: errorMessage(e) }] };
		}
	}

	// an upload's styles, ahead of the first view and before the mirror so they go out this firing
	try {
		await site.deriveStep();
	} catch (e) {
		site.lastDerive = { error: errorMessage(e) };
	}
}
