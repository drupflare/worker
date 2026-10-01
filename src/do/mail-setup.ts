import {
	type MailEnv,
	type MailMessage,
	mergeMailEnv,
	resolveMailTransport,
	senderFor,
	sendMail
} from '../ops/mail';
import { isPaid } from '../ops/plan';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { SITE_SMTP_KEY } from './keys';
import type { Payload } from './types';

/**
 * Sends one message now, so `ready` can mean delivered rather than inferred.
 *
 * Every stage below `ready` is a claim about configuration, not evidence: the send can still be
 * refused (an un-onboarded From domain, a plan that forbids the recipient, a quota). Sent rather
 * than queued, since a queued message is answered by the alarm.
 */
export async function sendMailTest(site: SitePhpDurableObject, to: string): Promise<Payload> {
	const recipient = String(to ?? '').trim();
	if (recipient === '') return { ok: false, error: 'a test send needs a recipient' };
	const plan = resolveMailTransport(site.mailEnv());
	if ('refusal' in plan) return { ok: false, error: plan.refusal };
	const from = senderFor(plan.transport, { from: '' });
	if (from === '') {
		return {
			ok: false,
			error: 'no sender address; set MAIL_FROM or the site mail address'
		};
	}
	const message: MailMessage = {
		to: recipient,
		from,
		subject: 'drupflare test message',
		text: 'This message was sent by the drupflare mail setup page to prove delivery works.',
		html: null,
		headers: {}
	};
	try {
		const id = await sendMail(
			plan.transport,
			message,
			undefined,
			isPaid(site.env) ? 'paid' : 'free'
		);
		return { ok: true, transport: plan.transport.kind, from, to: recipient, id };
	} catch (e) {
		// name the transport on failure too (the first thing an operator asks)
		return {
			ok: false,
			transport: plan.transport.kind,
			from,
			to: recipient,
			error: errorMessage(e).slice(0, 400)
		};
	}
}

/**
 * The deployment's mail vars, with the site's own `smtp.settings` filling the gaps.
 *
 * The drain never sees the message, so merging only at `cfwMail` time would resolve one transport
 * at commit and another on the alarm. The settings are persisted when PHP hands them over and both
 * resolvers read the same slot (not a per-row snapshot, so fixing a credential drains the queue
 * refused under the old one).
 */
export function mailEnv(site: SitePhpDurableObject): MailEnv {
	let fromSite: Partial<MailEnv> = {};
	try {
		fromSite = JSON.parse(site.metaGet(SITE_SMTP_KEY) ?? '{}') as Partial<MailEnv>;
	} catch {
		fromSite = {};
	}
	// merge the Cloudflare grant `/setup/cf` persists (no deploy sets `env.CF_EMAIL_TOKEN`, so the
	// api transport was otherwise unreachable)
	const grant = site.cfCredentialsSync();
	const merged = mergeMailEnv(site.env ?? {}, fromSite);
	if (grant.token !== '' && String(merged.CF_EMAIL_TOKEN ?? '') === '') {
		merged.CF_EMAIL_TOKEN = grant.token;
	}
	if (grant.accountId !== '' && String(merged.CF_EMAIL_ACCOUNT_ID ?? '') === '') {
		merged.CF_EMAIL_ACCOUNT_ID = grant.accountId;
	}
	return merged;
}
