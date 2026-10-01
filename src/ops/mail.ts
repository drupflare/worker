/**
 * Outbound mail: the transports `CfwMail` resolves (`binding`, `api`, `smtp`) and the alarm drain.
 * The send is deferred (no render reads `MailManager::mail()`'s bool; parked SMTP is 13 round
 * trips), so `{ok: true}` means queued, like an SMTP 250. Workers Free reaches verified
 * destinations only, so `smtp` is the general answer there; port 25 and Cloudflare's relay IPs are
 * blocked. The `send_email` binding shows as dropped in the Email Routing summary even when
 * delivered; read Email Sending metrics.
 * @module
 */

import { connect as coreConnect, type ConnectOptions, type CoreSocket } from 'edgeport/core';
import { _sessionFromSocket, type Mail, type SmtpConnectOptions } from 'edgeport/smtp';
import { errorMessage } from '../util/errors';
import { firstRow } from '../util/sql';

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
 * A resolved transport; `from` is only the fallback sender (`MAIL_FROM`), as one transport serves
 * a whole drain and Drupal's site mail rides on each message. See {@link senderFor}.
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

/** the `send_email` binding surface this module uses; structural so a test can pass a recorder */
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

/** the outcome of sending one queued message */
export type MailAttempt = {
	id: number;
	to: string;
	transport: MailTransport['kind'];
	ok: boolean;
	error?: string;
	detail?: string;
};

/** what one drain pass sent and how many messages still wait */
export type MailDrain = {
	sent: MailAttempt[];
	remaining: number;
};

// #endregion

// #region limits

/** the Cloudflare send endpoint, the only one reachable without a binding */
export const CF_SEND_ENDPOINT =
	'https://api.cloudflare.com/client/v4/accounts/{account}/email/sending/send';

/** blocked on Workers, so a transport configured for it is refused rather than attempted */
export const BLOCKED_SMTP_PORT = 25;

/** Cloudflare's own submission relay, unreachable from a Worker because it is a Cloudflare IP */
const CF_SMTP_RELAY = /(^|\.)mx\.cloudflare\.net$/i;

/**
 * The largest message the queue accepts; the 2,199,995-byte Durable Object record binds, not
 * Cloudflare's 5 MiB. 1 MB leaves room for the JSON envelope.
 */
export const MAX_MAIL_BYTES = 1_000_000;

/** Cloudflare's per-message limits, checked at commit so `CfwMail` logs a refusal naming one */
export const MAX_RECIPIENTS = 50;
/** the longest subject Cloudflare accepts, in characters */
export const MAX_SUBJECT_CHARS = 998;
/** the most header bytes Cloudflare accepts */
export const MAX_HEADER_BYTES = 16_384;

/**
 * How many queued messages one drain may send: {@link MAIL_DRAIN_BUDGET_MS} over one send.
 * The meter is wall-clock duration: `connect()` blocks hibernation for the whole batch.
 */
export const DEFAULT_MAIL_DRAIN_LIMIT = 5;
/** the most messages `MAIL_DRAIN_LIMIT` may raise one firing to */
export const MAX_MAIL_DRAIN_LIMIT = 25;

/** the per-firing wall-clock budget the two bounds are derived from; stated, not yet measured */
export const MAIL_DRAIN_BUDGET_MS = 3_000;

/** what one send may take for {@link DEFAULT_MAIL_DRAIN_LIMIT} to fit that budget */
export const MAIL_SEND_BUDGET_MS = MAIL_DRAIN_BUDGET_MS / DEFAULT_MAIL_DRAIN_LIMIT;

/**
 * Attempts per message: one, since a send is not idempotent and a retry after a lost reply
 * double-delivers (two different reset links). A failure is recorded, not retried.
 */
export const MAIL_ATTEMPT_BUDGET = 1;

// #endregion

// #region transport resolution

/** trimmed string form, empty for null or undefined */
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
 * `smtp.settings` mapped onto the transport vars (`system.mail` is forced to `cfw_mail`, so the
 * module's own socket never runs). `smtp_protocol` is `standard` (none), `tls` (starttls) or `ssl`.
 */
export function mailEnvFromSite(settings: unknown): Partial<MailEnv> {
	if (settings === null || typeof settings !== 'object') return {};
	const s = settings as Record<string, unknown>;
	// `smtp_on` off means the site turned the relay off
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
 * The deployment's vars over the site's own settings; the env always wins, since whoever can
 * reach a Drupal admin form is a wider set than whoever can deploy.
 */
export function mergeMailEnv(env: MailEnv, fromSite: Partial<MailEnv>): MailEnv {
	const merged: MailEnv = { ...fromSite };
	for (const [key, value] of Object.entries(env)) {
		// an absent var arrives as undefined or '' and must not shadow a configured setting
		if (value === undefined || value === '') continue;
		(merged as Record<string, unknown>)[key] = value;
	}
	return merged;
}

/** the smtp transport from env, or the refusal naming what is wrong */
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
		// auth over plaintext puts the relay password on the wire
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

/** the Email Sending API transport from env, or the refusal */
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

/** the `send_email` binding transport from env, or the refusal */
function bindingPlan(env: MailEnv, from: string): MailPlan {
	const binding = env.SEND_EMAIL;
	if (!binding || typeof binding.send !== 'function') {
		return { refusal: 'no send_email binding named SEND_EMAIL is bound to this Worker' };
	}
	return { transport: { kind: 'binding', from, binding } };
}

/**
 * Which transport this site sends through (`auto` takes the first configured of binding, api,
 * smtp), or the refusal sentence `CfwMail` logs.
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
 * The address this message goes out as: Drupal's site mail, else `MAIL_FROM`. Empty means it
 * cannot be sent, which `cfwMail` refuses at commit time rather than the drain discovering it.
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

/** the outbound queue table */
export const MAIL_TABLE = 'cfw_mail_queue';

/**
 * Creates the outbound queue, keyed by rowid and not content (unlike `cfw_http_queue`): two
 * identical mails are two mails, and a second password reset must not collapse into the first.
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

/** a queued message's id and size, or the reason it was refused */
export type QueueOutcome = { id: number; bytes: number } | { refusal: string };

/**
 * The first per-message limit a message breaks, or undefined when it fits; named so the cause
 * lands in the Drupal log (a relay bounces after `cfwMail` has returned).
 */
export function mailLimitRefusal(message: MailMessage, bytes: number): string | undefined {
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
		// the DO record ceiling, not Cloudflare's 5 MiB
		return (
			`the message is ${bytes} bytes, over the ${MAX_MAIL_BYTES}-byte queue limit ` +
			'(one queued message is one Durable Object record, capped at 2,199,995 bytes)'
		);
	}
	return undefined;
}

/** commits one message to the queue, refusing rather than truncating */
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
	const row = firstRow(
		sql.exec(
			`INSERT INTO ${MAIL_TABLE} (recipient, transport, payload, queued_at)
			 VALUES (?, ?, ?, ?) RETURNING id`,
			recipients.join(', '),
			transport.kind,
			payload,
			nowMs
		)
	);
	return { id: Number(row?.id ?? 0), bytes };
}

/** how many messages are waiting */
export function mailQueueDepth(sql: MailSql): number {
	return Number(firstRow(sql.exec(`SELECT COUNT(*) AS c FROM ${MAIL_TABLE}`))?.c ?? 0);
}

// #endregion

// #region sending

/** the Cloudflare send body, built here so a spec can assert it */
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

/** the send endpoint for one account */
export function cloudflareSendUrl(accountId: string): string {
	return CF_SEND_ENDPOINT.replace('{account}', encodeURIComponent(accountId));
}

/** the edgeport message; `Reply-To` rides as a header because `Mail` has no field for it */
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
 * The two platform seams a spec replaces, so request building and edgeport's real SMTP
 * conversation still run (replacing `sendViaApi` would test a stub).
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

/** the real `fetch` and edgeport `connect` */
export const DEFAULT_MAIL_DEPS: MailDeps = {
	fetch: (url, init) => fetch(url, init),
	connect: coreConnect
};

/**
 * What a Cloudflare rejection likely means (un-onboarded domain, or Workers Free), as a hint
 * since the Worker cannot read either; the free-plan sentence is omitted when `plan` is `paid`.
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

/** posts one message to the Cloudflare Email Sending HTTP API */
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

/** hands one message to the `send_email` binding, which throws without a status (hint takes 0) */
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
			`send_email binding refused the message: ${errorMessage(e).slice(0, 200)}` +
				cloudflareFailureHint(0, plan)
		);
	}
}

/**
 * Opens a submission session and sends one message through it. Not edgeport's one-shot `send()`,
 * which dials `cloudflare:sockets` itself and so cannot be driven in the gate.
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
 * Sends what `cfwMail` queued, between PHP runs and bounded per call. A row leaves the queue
 * either way ({@link MAIL_ATTEMPT_BUDGET} is 1); failures return in {@link MailDrain.sent}.
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
			const error = errorMessage(e).slice(0, 200);
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
