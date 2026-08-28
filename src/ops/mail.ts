/**
 * Outbound mail: the transport `CfwMail` reaches, and the queue that actually sends it.
 *
 * `binary.cfwMail` used to push the message onto an in-memory array and answer `{ok: true}` whenever
 * `CFW_EMAIL_BINDING` was `'1'`. Nothing was ever sent, and the var gated a RETURN VALUE rather than
 * a transport, so the lower layer reported success for a message that went nowhere. This module is
 * the transport that was missing; the var is gone.
 *
 * **A send cannot happen inside `cfwMail`.** PHP calls the host synchronously and cannot await, the
 * same constraint that split `cfwFetch` into a queue and a drain. So `cfwMail` resolves a transport
 * and durably queues, and the send happens here on the alarm, in JS, between PHP runs. `{ok: true}`
 * therefore means "a transport resolved and the message is committed to the queue" -- what an SMTP
 * submission server means by 250, not "the recipient has it". No transport means a refusal WITH A
 * REASON, which is what `CfwMail` logs.
 *
 * ## Three transports, and what actually gates them
 *
 * | kind      | how it sends                        | needs                                    |
 * | --------- | ----------------------------------- | ---------------------------------------- |
 * | `binding` | a `send_email` Workers binding      | the binding, no credentials              |
 * | `api`     | the Email Sending REST API          | `CF_EMAIL_ACCOUNT_ID` + `CF_EMAIL_TOKEN` |
 * | `smtp`    | a third-party relay, over edgeport  | `SMTP_HOST` and friends                  |
 *
 * **THE GATE IS NOT WHICH CLOUDFLARE API YOU PICK.** Cloudflare states the limits "apply to emails
 * sent via the REST API, the Workers binding, and SMTP unless noted otherwise", so `binding` and
 * `api` differ only in whether a credential is spent. Two other things gate them, and both are the
 * site owner's problem rather than this module's:
 *
 *   - **A sending domain that is not onboarded** reaches VERIFIED DESTINATION ADDRESSES ONLY -- the
 *     200 per account somebody clicked a link to confirm. Onboard the domain (SPF/DKIM on
 *     Cloudflare DNS) and any recipient works immediately.
 *   - **Workers Free has no outbound Email Sending at all**, with one carve-out that decides what
 *     this product can promise: sends to verified destination addresses are free on EVERY plan,
 *     from your routing domains, and count against no quota. So a free site can mail its owner and
 *     cannot mail a visitor who just registered.
 *
 * **That makes `smtp` the only general answer on free**, not a nice-to-have. A free site that has
 * to send a password reset to an arbitrary address needs a third-party relay, and the refusal path
 * says so rather than reporting a generic failure.
 *
 * `@earth-app/smoke` uses the REST API for all real outbound and reserves the `cloudflare:email`
 * path for `message.reply()` on an inbound message, which is a different capability again.
 *
 * **Port 25 is blocked on Workers**, so submission is 587 with STARTTLS or 465 with implicit TLS;
 * {@link resolveMailTransport} refuses 25 by name rather than opening a socket that cannot connect.
 * Cloudflare's own relay, `smtps://smtp.mx.cloudflare.net:465`, is refused on the same grounds and
 * the grounds are MEASURED rather than assumed: it resolves to 162.159.205.26-28, which is inside
 * the published `162.158.0.0/15`, and the Workers docs say "Outbound TCP sockets to Cloudflare IP
 * ranges are blocked". That is why the Cloudflare lanes here are HTTP and a binding, never SMTP.
 *
 * **One trap for whoever debugs deliverability**: mail sent through the `send_email` binding shows
 * as **dropped** in the Email Routing summary even when it was delivered. Read Email Sending
 * metrics instead; the routing summary will otherwise say the transport is broken when it is not.
 *
 * @see https://developers.cloudflare.com/email-service/platform/limits/
 * @see https://developers.cloudflare.com/email-service/platform/pricing/
 * @see https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
 */

import { connect as coreConnect, type ConnectOptions, type CoreSocket } from 'edgeport/core';
import { _sessionFromSocket, type Mail, type SmtpConnectOptions } from 'edgeport/smtp';

// #region shapes

/** what `CfwMail` hands across the bridge, after `format()` has done Drupal's half */
export type MailMessage = {
	to: string;
	from?: string;
	replyTo?: string;
	subject: string;
	text: string;
	html?: string | null;
	/** only `Cc`, `Bcc`, `In-Reply-To` and `References`; `CfwMail` intersects the rest away */
	headers?: Record<string, string>;
};

/**
 * `from` is the FALLBACK sender, not the sender.
 *
 * A transport is resolved once per drain and reused across every queued message, so it cannot own
 * the From address -- Drupal's own site mail rides on the message and differs per site. The
 * effective sender is {@link senderFor}, and `from` here is `MAIL_FROM` for a message that carries
 * none. Getting this backwards made the drain resolve a transport with no message in hand, refuse
 * every time on "no From address", and leave the queue full while `cfwMail` reported success --
 * the same shape as the defect this module replaces.
 */
export type MailTransport =
	| { kind: 'binding'; from: string; binding: SendEmailLike }
	| { kind: 'api'; from: string; accountId: string; token: string }
	| {
			kind: 'smtp';
			from: string;
			hostname: string;
			port: number;
			tls: 'starttls' | 'implicit' | 'off';
			auth?: { username: string; password: string; mechanism: 'PLAIN' | 'LOGIN' };
	  };

/** either a transport, or the reason there is not one; never a bare boolean */
export type MailPlan = { transport: MailTransport } | { refusal: string };

/**
 * The `send_email` binding surface this module uses.
 *
 * Declared structurally rather than imported as `SendEmail`, so a test can pass a recorder and so
 * the module does not depend on which `@cloudflare/workers-types` entry point is in scope.
 */
export type SendEmailLike = {
	send(builder: Record<string, unknown>): Promise<unknown>;
};

/** the vars a transport is resolved from; a subset of `SiteEnv`, so the resolver is drivable */
export type MailEnv = {
	MAIL_TRANSPORT?: string;
	MAIL_FROM?: string;
	CF_EMAIL_ACCOUNT_ID?: string;
	CF_EMAIL_TOKEN?: string;
	SMTP_HOST?: string;
	SMTP_PORT?: string | number;
	SMTP_TLS?: string;
	SMTP_USER?: string;
	SMTP_PASS?: string;
	SMTP_AUTH?: string;
	MAIL_DRAIN_ON_ALARM?: string;
	MAIL_DRAIN_LIMIT?: string | number;
	SEND_EMAIL?: SendEmailLike;
};

/** minimal SQL surface, matching `PageMirrorSql`, so the queue is drivable over a stand-in */
export type MailSql = {
	exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

export type MailAttempt = {
	id: number;
	to: string;
	transport: MailTransport['kind'];
	ok: boolean;
	error?: string;
	detail?: string;
};

export type MailDrain = {
	sent: MailAttempt[];
	remaining: number;
};

// #endregion

// #region limits

/** the endpoint `@earth-app/smoke` posts to, and the only Cloudflare send reachable without a binding */
export const CF_SEND_ENDPOINT =
	'https://api.cloudflare.com/client/v4/accounts/{account}/email/sending/send';

/** blocked on Workers, so a transport configured for it is refused rather than attempted */
export const BLOCKED_SMTP_PORT = 25;

/** Cloudflare's own submission relay, unreachable from a Worker because it is a Cloudflare IP */
const CF_SMTP_RELAY = /(^|\.)mx\.cloudflare\.net$/i;

/**
 * The largest message the queue accepts.
 *
 * **The Durable Object record ceiling binds, not Cloudflare's.** A queued message is ONE record and
 * that ceiling is 2,199,995 bytes; Cloudflare caps a sent message at 5 MiB, which is larger and
 * therefore never the limit that fires here. 1 MB leaves room for the JSON envelope and is far
 * above any mail Drupal generates without attachments, which this transport does not carry.
 */
export const MAX_MAIL_BYTES = 1_000_000;

/**
 * Cloudflare's own per-message limits, checked here so a refusal names the limit.
 *
 * A relay that rejects the message reports it after `cfwMail` has already returned, where only
 * `/__serve-stats` sees it. Checking at commit turns three of them into something `CfwMail` logs
 * against the content operation that caused them.
 */
export const MAX_RECIPIENTS = 50;
export const MAX_SUBJECT_CHARS = 998;
export const MAX_HEADER_BYTES = 16_384;

/**
 * How many queued messages one drain may send: {@link MAIL_DRAIN_BUDGET_MS} over one send.
 *
 * The meter is DURATION, not the 50 subrequests this used to cite -- `connect()` blocks
 * hibernation and the socket is held for the whole sequential batch, so the object is billed wall
 * clock for every conversation in it.
 */
export const DEFAULT_MAIL_DRAIN_LIMIT = 5;
export const MAX_MAIL_DRAIN_LIMIT = 25;

/** the per-firing wall-clock budget the two bounds are derived from; stated, not yet measured */
export const MAIL_DRAIN_BUDGET_MS = 3_000;

/** what one send may take for {@link DEFAULT_MAIL_DRAIN_LIMIT} to fit that budget */
export const MAIL_SEND_BUDGET_MS = MAIL_DRAIN_BUDGET_MS / DEFAULT_MAIL_DRAIN_LIMIT;

/**
 * How many times one message may be attempted, in total.
 *
 * **ONE**, and for the reason `attemptBudget()` gives a POST in `deferred-post.ts`: a send is not
 * idempotent. The first attempt may have been accepted at the far end and only failed to return, so
 * a retry double-delivers -- and a password-reset mail arriving twice with two different one-time
 * links is worse than one that did not arrive. A failure is recorded as a failure and reported on
 * `/__serve-stats`, rather than laundered into a duplicate.
 */
export const MAIL_ATTEMPT_BUDGET = 1;

// #endregion

// #region transport resolution

function str(value: unknown): string {
	return value === undefined || value === null ? '' : String(value).trim();
}

/** splits Drupal's comma-separated recipient list; `MailInterface` allows one */
export function splitAddresses(value: string): string[] {
	return str(value)
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** the port submission runs on when nothing says otherwise, per TLS mode */
export function defaultSmtpPort(tls: 'starttls' | 'implicit' | 'off'): number {
	return tls === 'implicit' ? 465 : 587;
}

/**
 * `smtp.settings`, mapped onto the transport vars.
 *
 * **`drupal/smtp` INSTALLS HERE AND ITS SOCKET NEVER RUNS**, because `system.mail` is forced to
 * `cfw_mail`. So a site that installed it, filled in its relay and saved has a complete, correct
 * SMTP configuration that nothing read -- the operator then had to type the same host, port and
 * password again as Worker vars to get mail out. This closes that: the module's own settings become
 * a transport source, and the module stays unmodified and inert.
 *
 * The module's `smtp_protocol` is `standard | tls | ssl`, where `standard` means no encryption at
 * all; edgeport's `starttls` is what `tls` means there.
 */
export function mailEnvFromSite(settings: unknown): Partial<MailEnv> {
	if (settings === null || typeof settings !== 'object') return {};
	const s = settings as Record<string, unknown>;
	// smtp_on off means the site turned the relay off; honouring it is the difference between a
	// disabled configuration and a live one
	if (s.smtp_on === false || s.smtp_on === 0 || s.smtp_on === '0') return {};

	const host = str(s.smtp_host);
	if (host === '') return {};

	const protocol = str(s.smtp_protocol).toLowerCase();
	const out: Partial<MailEnv> = {
		SMTP_HOST: host,
		SMTP_TLS: protocol === 'ssl' ? 'implicit' : protocol === 'standard' ? 'off' : 'starttls'
	};
	if (str(s.smtp_port) !== '') out.SMTP_PORT = str(s.smtp_port);
	if (str(s.smtp_username) !== '') out.SMTP_USER = str(s.smtp_username);
	if (str(s.smtp_password) !== '') out.SMTP_PASS = str(s.smtp_password);
	if (str(s.smtp_from) !== '') out.MAIL_FROM = str(s.smtp_from);
	return out;
}

/**
 * The deployment's vars over the site's own settings.
 *
 * **THE ENV WINS, always.** A var is set by whoever can deploy the Worker; `smtp.settings` is set by
 * whoever can reach a Drupal admin form, which is a wider set of people. So the site's settings fill
 * gaps and never override a decision the deployer made -- and a deployer who wants to pin the relay
 * only has to set `SMTP_HOST`.
 */
export function mergeMailEnv(env: MailEnv, fromSite: Partial<MailEnv>): MailEnv {
	const merged: MailEnv = { ...fromSite };
	for (const [key, value] of Object.entries(env)) {
		// an absent var arrives as undefined or '' and must not shadow a configured setting
		if (value === undefined || value === null || value === '') continue;
		(merged as Record<string, unknown>)[key] = value;
	}
	return merged;
}

function smtpPlan(env: MailEnv, from: string): MailPlan {
	const hostname = str(env.SMTP_HOST);
	if (!hostname) {
		return { refusal: 'SMTP is selected but SMTP_HOST is not set' };
	}
	if (CF_SMTP_RELAY.test(hostname)) {
		return {
			refusal:
				`${hostname} is a Cloudflare relay and a Worker cannot open TCP to a Cloudflare IP; ` +
				'use MAIL_TRANSPORT=api or a send_email binding for Cloudflare mail'
		};
	}

	const rawTls = str(env.SMTP_TLS).toLowerCase() || 'starttls';
	if (rawTls !== 'starttls' && rawTls !== 'implicit' && rawTls !== 'off') {
		return { refusal: `SMTP_TLS must be starttls, implicit or off; got ${rawTls}` };
	}
	const tls = rawTls;

	const rawPort = str(env.SMTP_PORT);
	const port = rawPort === '' ? defaultSmtpPort(tls) : Number(rawPort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { refusal: `SMTP_PORT must be a port number; got ${rawPort}` };
	}
	if (port === BLOCKED_SMTP_PORT) {
		return {
			refusal:
				'Cloudflare Workers block outbound TCP to port 25; use 587 with STARTTLS or 465 ' +
				'with implicit TLS'
		};
	}

	const username = str(env.SMTP_USER);
	const password = str(env.SMTP_PASS);
	if (username && tls === 'off') {
		// AUTH over plaintext puts the relay password on the wire; refusing is the only honest answer
		return { refusal: 'SMTP_TLS=off with SMTP_USER would send the password in the clear' };
	}
	const rawMechanism = str(env.SMTP_AUTH).toUpperCase() || 'PLAIN';
	if (rawMechanism !== 'PLAIN' && rawMechanism !== 'LOGIN') {
		return { refusal: `SMTP_AUTH must be PLAIN or LOGIN; got ${rawMechanism}` };
	}

	return {
		transport: {
			kind: 'smtp',
			from,
			hostname,
			port,
			tls,
			...(username ? { auth: { username, password, mechanism: rawMechanism } } : {})
		}
	};
}

function apiPlan(env: MailEnv, from: string): MailPlan {
	const accountId = str(env.CF_EMAIL_ACCOUNT_ID);
	const token = str(env.CF_EMAIL_TOKEN);
	if (!accountId || !token) {
		return {
			refusal:
				'the Cloudflare Email Sending API needs CF_EMAIL_ACCOUNT_ID and CF_EMAIL_TOKEN; ' +
				`${!accountId ? 'CF_EMAIL_ACCOUNT_ID' : 'CF_EMAIL_TOKEN'} is not set`
		};
	}
	return { transport: { kind: 'api', from, accountId, token } };
}

function bindingPlan(env: MailEnv, from: string): MailPlan {
	const binding = env.SEND_EMAIL;
	if (!binding || typeof binding.send !== 'function') {
		return { refusal: 'no send_email binding named SEND_EMAIL is bound to this Worker' };
	}
	return { transport: { kind: 'binding', from, binding } };
}

/**
 * Which transport this site sends through, or why it cannot send.
 *
 * `MAIL_TRANSPORT` names one explicitly; `auto` (the default) takes the first that is configured, in
 * the order binding, api, smtp. The binding leads on CREDENTIALS alone -- it reaches exactly what
 * the REST API reaches, and an operator who added `send_email` to their Wrangler config has already
 * said what they want, so spending an API token instead would be gratuitous.
 *
 * The refusal is a sentence rather than a flag, because it is what `CfwMail` writes to the log and
 * the operator reads. "No email binding is configured" was the whole of the previous diagnostic and
 * it named nothing an operator could act on.
 */
export function resolveMailTransport(env: MailEnv): MailPlan {
	const selected = (str(env.MAIL_TRANSPORT) || 'auto').toLowerCase();
	if (selected === 'off') {
		return { refusal: 'mail is switched off by MAIL_TRANSPORT=off' };
	}

	// the fallback sender only; the effective one is per-message, see `senderFor`
	const from = str(env.MAIL_FROM);

	if (selected === 'binding') return bindingPlan(env, from);
	if (selected === 'api') return apiPlan(env, from);
	if (selected === 'smtp') return smtpPlan(env, from);
	if (selected !== 'auto') {
		return {
			refusal: `MAIL_TRANSPORT must be auto, binding, api, smtp or off; got ${selected}`
		};
	}

	const binding = bindingPlan(env, from);
	if ('transport' in binding) return binding;
	if (str(env.CF_EMAIL_ACCOUNT_ID) || str(env.CF_EMAIL_TOKEN)) return apiPlan(env, from);
	if (str(env.SMTP_HOST)) return smtpPlan(env, from);

	return {
		refusal:
			'no mail transport is configured: bind a send_email binding as SEND_EMAIL, or set ' +
			'CF_EMAIL_ACCOUNT_ID and CF_EMAIL_TOKEN, or set SMTP_HOST'
	};
}

/**
 * The address this message goes out as.
 *
 * Drupal's own site mail wins, because that is what the site is configured to send as; `MAIL_FROM`
 * covers a message that carries none. Empty means the message cannot be sent at all, which is a
 * refusal `cfwMail` makes at commit time rather than a failure the drain discovers.
 */
export function senderFor(transport: { from: string }, message: Pick<MailMessage, 'from'>): string {
	return str(message.from) || str(transport.from);
}

/** whether `alarm()` drains the mail queue; off is for a spec that asserts on queue depth */
export function mailDrainEnabled(env: MailEnv): boolean {
	return str(env.MAIL_DRAIN_ON_ALARM) !== '0';
}

/** how many messages one firing may send, clamped to {@link MAX_MAIL_DRAIN_LIMIT} */
export function mailDrainLimit(env: MailEnv): number {
	const raw = Number(str(env.MAIL_DRAIN_LIMIT));
	const wanted = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAIL_DRAIN_LIMIT;
	return Math.max(1, Math.min(Math.floor(wanted), MAX_MAIL_DRAIN_LIMIT));
}

// #endregion

// #region the queue

export const MAIL_TABLE = 'cfw_mail_queue';

/**
 * The outbound queue.
 *
 * KEYED BY ROWID, not by content, and that is the one place this differs from `cfw_http_queue`. Two
 * identical deferred fetches are one request and de-duplicate correctly; two identical mails are TWO
 * MAILS -- a visitor who asks for a password reset twice must receive two of them, and collapsing
 * them would silently drop the second.
 */
export function ensureMailTable(sql: MailSql): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS ${MAIL_TABLE} (
			id INTEGER PRIMARY KEY,
			recipient TEXT NOT NULL,
			transport TEXT NOT NULL,
			payload TEXT NOT NULL,
			queued_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT
		)`
	);
}

export type QueueOutcome = { id: number; bytes: number } | { refusal: string };

/**
 * Every per-message limit, checked before the row is written, or `null` when the message fits.
 *
 * Named individually rather than reported as "invalid": a relay refuses these after `cfwMail` has
 * returned, so the operator sees a bounce with no cause. Checked here, the cause is in the Drupal
 * log next to the operation that produced the message.
 */
export function mailLimitRefusal(message: MailMessage, bytes: number): string | null {
	const recipients = [
		...splitAddresses(message.to),
		...splitAddresses(str(message.headers?.Cc)),
		...splitAddresses(str(message.headers?.Bcc))
	];
	if (recipients.length > MAX_RECIPIENTS) {
		return (
			`${recipients.length} recipients across To/Cc/Bcc, over Cloudflare's ` +
			`${MAX_RECIPIENTS}-per-message limit`
		);
	}
	if (message.subject.length > MAX_SUBJECT_CHARS) {
		return `the subject is ${message.subject.length} characters, over the ${MAX_SUBJECT_CHARS}-character limit`;
	}
	const headerBytes = new TextEncoder().encode(
		Object.entries(message.headers ?? {})
			.map(([k, v]) => `${k}: ${v}`)
			.join('\r\n')
	).length;
	if (headerBytes > MAX_HEADER_BYTES) {
		return `the headers are ${headerBytes} bytes, over the ${MAX_HEADER_BYTES}-byte limit`;
	}
	if (bytes > MAX_MAIL_BYTES) {
		// the DO record ceiling, NOT Cloudflare's 5 MiB; naming the wrong one sends an operator
		// looking at the mail limits page for a limit that is not what stopped them
		return (
			`the message is ${bytes} bytes, over the ${MAX_MAIL_BYTES}-byte queue limit ` +
			'(one queued message is one Durable Object record, capped at 2,199,995 bytes)'
		);
	}
	return null;
}

/**
 * Commits one message to the queue.
 *
 * Refuses rather than truncating: a mail with no recipient has nowhere to go, and one over the
 * record ceiling would fail the storage write, which surfaces as an opaque error rather than as
 * something `CfwMail` can log.
 */
export function queueMail(
	sql: MailSql,
	message: MailMessage,
	transport: MailTransport,
	nowMs: number
): QueueOutcome {
	const recipients = splitAddresses(message.to);
	if (recipients.length === 0) return { refusal: 'the message has no recipient' };
	if (!senderFor(transport, message)) {
		return { refusal: 'no From address: the message carries none and MAIL_FROM is not set' };
	}

	const payload = JSON.stringify(message);
	const bytes = new TextEncoder().encode(payload).length;
	const overLimit = mailLimitRefusal(message, bytes);
	if (overLimit) return { refusal: overLimit };

	ensureMailTable(sql);
	const row = sql
		.exec(
			`INSERT INTO ${MAIL_TABLE} (recipient, transport, payload, queued_at)
			 VALUES (?, ?, ?, ?) RETURNING id`,
			recipients.join(', '),
			transport.kind,
			payload,
			nowMs
		)
		.toArray()[0];
	return { id: Number(row?.id ?? 0), bytes };
}

/** how many messages are waiting; `null` before anything has queued, so an absence is not a 0 */
export function mailQueueDepth(sql: MailSql): number {
	return Number(sql.exec(`SELECT COUNT(*) AS c FROM ${MAIL_TABLE}`).toArray()[0]?.c ?? 0);
}

// #endregion

// #region sending

/** the Cloudflare send body, built where it can be asserted rather than inline in a `fetch` */
export function cloudflareSendBody(
	transport: { from: string },
	message: MailMessage
): Record<string, unknown> {
	const headers = message.headers ?? {};
	const threading: Record<string, string> = {};
	for (const name of ['In-Reply-To', 'References']) {
		const value = str(headers[name]);
		if (value) threading[name] = value;
	}
	const cc = splitAddresses(str(headers.Cc));
	const bcc = splitAddresses(str(headers.Bcc));
	const replyTo = str(message.replyTo);
	const html = str(message.html);

	return {
		from: senderFor(transport, message),
		to: splitAddresses(message.to),
		subject: message.subject,
		text: message.text,
		...(html ? { html } : {}),
		...(cc.length > 0 ? { cc } : {}),
		...(bcc.length > 0 ? { bcc } : {}),
		...(replyTo ? { replyTo } : {}),
		...(Object.keys(threading).length > 0 ? { headers: threading } : {})
	};
}

/** the REST endpoint for one account */
export function cloudflareSendUrl(accountId: string): string {
	return CF_SEND_ENDPOINT.replace('{account}', encodeURIComponent(accountId));
}

/** the edgeport message, built where it can be asserted; `Reply-To` is a header because `Mail` has no field */
export function smtpMail(transport: { from: string }, message: MailMessage): Mail {
	const headers: Record<string, string> = {};
	for (const name of ['In-Reply-To', 'References']) {
		const value = str(message.headers?.[name]);
		if (value) headers[name] = value;
	}
	const replyTo = str(message.replyTo);
	if (replyTo) headers['Reply-To'] = replyTo;
	const cc = splitAddresses(str(message.headers?.Cc));
	const bcc = splitAddresses(str(message.headers?.Bcc));
	const html = str(message.html);

	return {
		from: senderFor(transport, message),
		to: splitAddresses(message.to),
		subject: message.subject,
		text: message.text,
		...(html ? { html } : {}),
		...(cc.length > 0 ? { cc } : {}),
		...(bcc.length > 0 ? { bcc } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {})
	};
}

/**
 * The two seams a spec replaces, and nothing else.
 *
 * `fetch` and `connect` are the PLATFORM boundary, not this module's own code: the Cloudflare lane
 * still builds its own request and reads its own response, and the SMTP lane still runs edgeport's
 * real greeting/EHLO/STARTTLS/AUTH/DATA against whatever is on the other end. A spec that replaced
 * `sendViaApi` or `sendViaSmtp` instead would pass against a stub, which is the defect this module
 * exists to fix.
 */
export type MailDeps = {
	/** narrower than `typeof fetch`, which carries a `preconnect` property a stub cannot supply */
	fetch: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string }
	) => Promise<{
		ok: boolean;
		status: number;
		statusText: string;
		text(): Promise<string>;
	}>;
	connect: (opts: ConnectOptions) => Promise<CoreSocket>;
};

export const DEFAULT_MAIL_DEPS: MailDeps = {
	fetch: (url, init) => fetch(url, init),
	connect: coreConnect
};

/**
 * What a Cloudflare rejection most likely means, in the operator's terms.
 *
 * A bare `403` sends a site owner to their own configuration, and for the two commonest causes
 * their configuration is fine: the sending domain is not onboarded, or the site is on Workers Free
 * where outbound Email Sending does not exist except to verified destination addresses. Both are
 * account-level facts this Worker cannot read, so the hint is offered AS a hint -- but naming the
 * three candidates beats a status code, and a free site is told the answer is a third-party relay.
 *
 * `plan` is what the site is deployed as; the free sentence is omitted on paid, where it is noise.
 */
export function cloudflareFailureHint(status: number, plan?: string): string {
	const free = String(plan ?? 'free').toLowerCase() !== 'paid';
	const freeNote = free
		? ' On Workers Free there is no outbound Email Sending except to verified destination ' +
			'addresses from your routing domains, so an arbitrary recipient needs MAIL_TRANSPORT=smtp.'
		: '';
	if (status === 401 || status === 403) {
		return (
			' Check, in this order: the sending domain is onboarded (SPF/DKIM), the recipient is a ' +
			'verified destination address if it is not, and the token carries Email Sending: Edit.' +
			freeNote
		);
	}
	if (status === 400 || status === 422) {
		return (
			' Usually the From domain or the recipient: an un-onboarded sending domain may only ' +
			'reach verified destination addresses.' +
			freeNote
		);
	}
	if (status === 429) {
		return ' The account is over its daily or monthly sending quota.' + freeNote;
	}
	return freeNote;
}

/** posts one message to the Cloudflare Email Sending REST API */
export async function sendViaApi(
	transport: Extract<MailTransport, { kind: 'api' }>,
	message: MailMessage,
	deps: MailDeps = DEFAULT_MAIL_DEPS,
	plan?: string
): Promise<string> {
	const res = await deps.fetch(cloudflareSendUrl(transport.accountId), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${transport.token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(cloudflareSendBody(transport, message))
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(
			`Cloudflare Email Sending API ${res.status}: ${detail.slice(0, 200) || res.statusText}` +
				cloudflareFailureHint(res.status, plan)
		);
	}
	return `api ${res.status}`;
}

/**
 * Hands one message to the `send_email` binding.
 *
 * The binding throws rather than returning a status, so the hint is attached without one -- which
 * still carries the free-plan sentence, the part an operator most often needs.
 */
export async function sendViaBinding(
	transport: Extract<MailTransport, { kind: 'binding' }>,
	message: MailMessage,
	plan?: string
): Promise<string> {
	const body = cloudflareSendBody(transport, message);
	try {
		const result = (await transport.binding.send(body)) as { messageId?: string } | undefined;
		return `binding ${str(result?.messageId) || 'accepted'}`;
	} catch (e: unknown) {
		throw new Error(
			`send_email binding refused the message: ${String((e as Error)?.message ?? e).slice(0, 200)}` +
				cloudflareFailureHint(0, plan)
		);
	}
}

/**
 * Opens a submission session and sends one message through it.
 *
 * `connect()` + `_sessionFromSocket()` rather than edgeport's one-shot `send()`, which is those two
 * lines plus a `close()`. The one-shot dials `cloudflare:sockets` itself, so nothing above it can
 * reach the socket and the whole protocol would be untestable in the gate; taking the transport as a
 * dependency lets a spec script a real SMTP server against edgeport's real client.
 */
export async function sendViaSmtp(
	transport: Extract<MailTransport, { kind: 'smtp' }>,
	message: MailMessage,
	deps: MailDeps = DEFAULT_MAIL_DEPS
): Promise<string> {
	const opts: SmtpConnectOptions = {
		hostname: transport.hostname,
		port: transport.port,
		tls: transport.tls,
		...(transport.auth ? { auth: transport.auth } : {})
	};
	const socket = await deps.connect({
		hostname: transport.hostname,
		port: transport.port,
		tls: transport.tls === 'implicit' ? 'on' : transport.tls === 'off' ? 'off' : 'starttls'
	});
	const session = await _sessionFromSocket(socket, opts);
	try {
		const result = await session.send(smtpMail(transport, message));
		return `smtp ${result.accepted.length} accepted`;
	} finally {
		await session.close();
	}
}

/** one message down whichever transport was resolved */
export function sendMail(
	transport: MailTransport,
	message: MailMessage,
	deps: MailDeps = DEFAULT_MAIL_DEPS,
	plan?: string
): Promise<string> {
	if (transport.kind === 'binding') return sendViaBinding(transport, message, plan);
	if (transport.kind === 'api') return sendViaApi(transport, message, deps, plan);
	return sendViaSmtp(transport, message, deps);
}

// #endregion

// #region the drain

/**
 * Sends what `cfwMail` queued, in JS, where awaiting is legal.
 *
 * Runs between PHP invocations rather than inside one, and bounded per call for the same reason the
 * HTTP drain is: a queue full of slow relays would otherwise occupy the object. A row leaves the
 * queue whether it succeeded or not -- {@link MAIL_ATTEMPT_BUDGET} is 1 -- and the failure travels
 * back in {@link MailDrain.sent} so `/__serve-stats` can show it.
 */
export async function drainMailQueue(
	sql: MailSql,
	transport: MailTransport,
	options: { limit?: number; deps?: MailDeps; plan?: string } = {}
): Promise<MailDrain> {
	ensureMailTable(sql);
	const limit = Math.max(
		1,
		Math.min(options.limit ?? DEFAULT_MAIL_DRAIN_LIMIT, MAX_MAIL_DRAIN_LIMIT)
	);
	const pending = sql
		.exec(
			`SELECT id, recipient, payload, attempts FROM ${MAIL_TABLE} ORDER BY id LIMIT ?`,
			limit
		)
		.toArray();

	const sent: MailAttempt[] = [];
	for (const row of pending) {
		const id = Number(row.id);
		const to = String(row.recipient ?? '');
		let message: MailMessage;
		try {
			message = JSON.parse(String(row.payload)) as MailMessage;
		} catch {
			// an unparseable row can never be sent, so it leaves rather than blocking the head
			sql.exec(`DELETE FROM ${MAIL_TABLE} WHERE id = ?`, id);
			sent.push({
				id,
				to,
				transport: transport.kind,
				ok: false,
				error: 'unreadable payload'
			});
			continue;
		}

		try {
			const detail = await sendMail(transport, message, options.deps, options.plan);
			sql.exec(`DELETE FROM ${MAIL_TABLE} WHERE id = ?`, id);
			sent.push({ id, to, transport: transport.kind, ok: true, detail });
		} catch (e: unknown) {
			const error = String((e as Error)?.message ?? e).slice(0, 200);
			const attempts = Number(row.attempts ?? 0) + 1;
			if (attempts >= MAIL_ATTEMPT_BUDGET) {
				sql.exec(`DELETE FROM ${MAIL_TABLE} WHERE id = ?`, id);
			} else {
				sql.exec(
					`UPDATE ${MAIL_TABLE} SET attempts = ?, last_error = ? WHERE id = ?`,
					attempts,
					error,
					id
				);
			}
			sent.push({ id, to, transport: transport.kind, ok: false, error });
		}
	}

	return { sent, remaining: mailQueueDepth(sql) };
}

// #endregion
