import { describe, expect, it } from 'vitest';
import {
	BLOCKED_SMTP_PORT,
	DEFAULT_MAIL_DEPS,
	MAIL_ATTEMPT_BUDGET,
	MAIL_TABLE,
	MAX_HEADER_BYTES,
	MAX_MAIL_BYTES,
	MAX_MAIL_DRAIN_LIMIT,
	MAX_RECIPIENTS,
	MAX_SUBJECT_CHARS,
	cloudflareFailureHint,
	cloudflareSendBody,
	cloudflareSendUrl,
	defaultSmtpPort,
	drainMailQueue,
	ensureMailTable,
	mailDrainEnabled,
	mailDrainLimit,
	mailEnvFromSite,
	mailLimitRefusal,
	mailQueueDepth,
	mergeMailEnv,
	queueMail,
	resolveMailTransport,
	sendViaApi,
	sendViaBinding,
	sendViaSmtp,
	senderFor,
	smtpMail,
	splitAddresses,
	type MailDeps,
	type MailMessage,
	type MailSql,
	type MailTransport
} from '../../../src/ops/mail';
import { smtpServer } from '../../helpers/mock-socket';

/**
 * The defect these exist for: `binary.cfwMail` pushed the message onto an in-memory array and
 * answered `{ok: true}` whenever `CFW_EMAIL_BINDING` was `'1'`. Nothing was sent, and every test
 * passed, because the var gated a return value and there was no transport to remove.
 *
 * So the rule here is that no assertion may hold against a stub of this module's own code. The two
 * seams a spec replaces are `fetch` and `connect` -- the PLATFORM boundary. The Cloudflare lane
 * still builds its own request and reads its own response; the SMTP lane still runs edgeport's real
 * greeting/EHLO/STARTTLS/AUTH/DATA against a scripted server, so removing the transport takes the
 * protocol transcript with it.
 */

// #region stand-ins

/**
 * The `MailSql` surface, matching the five statements the queue issues.
 *
 * `rows` is exposed so a spec can corrupt one the way only a partial write could; that branch is
 * unreachable through the public functions, which is exactly why it needs a seam.
 */
function memorySql(): MailSql & { rows: Record<string, unknown>[] } {
	const rows: Record<string, unknown>[] = [];
	let nextId = 1;
	return {
		rows,
		exec(query: string, ...bindings: unknown[]) {
			const sql = query.replace(/\s+/g, ' ').trim();
			if (sql.startsWith('CREATE TABLE')) return { toArray: () => [] };
			if (sql.startsWith('INSERT INTO')) {
				const [recipient, transport, payload, queuedAt] = bindings;
				const row = {
					id: nextId++,
					recipient,
					transport,
					payload,
					queued_at: queuedAt,
					attempts: 0,
					last_error: null as string | null
				};
				rows.push(row);
				return { toArray: () => [{ id: row.id }] };
			}
			if (sql.startsWith('SELECT COUNT')) return { toArray: () => [{ c: rows.length }] };
			if (sql.startsWith('SELECT id')) {
				const limit = Number(bindings[0]);
				return { toArray: () => rows.slice(0, limit).map((r) => ({ ...r })) };
			}
			if (sql.startsWith('DELETE FROM')) {
				const at = rows.findIndex((r) => r.id === Number(bindings[0]));
				if (at >= 0) rows.splice(at, 1);
				return { toArray: () => [] };
			}
			if (sql.startsWith('UPDATE')) {
				const [attempts, error, id] = bindings;
				const row = rows.find((r) => r.id === Number(id));
				if (row) {
					row.attempts = attempts;
					row.last_error = error;
				}
				return { toArray: () => [] };
			}
			throw new Error(`unhandled statement: ${sql}`);
		}
	};
}

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
	to: 'visitor@example.org',
	from: 'Site <site@example.com>',
	subject: 'Your password reset',
	text: 'follow the link',
	...over
});

const API: Extract<MailTransport, { kind: 'api' }> = {
	kind: 'api',
	from: '',
	accountId: 'acct-1',
	token: 'tok-1'
};

const SMTP: Extract<MailTransport, { kind: 'smtp' }> = {
	kind: 'smtp',
	from: '',
	hostname: 'mail.example.net',
	port: 587,
	tls: 'starttls',
	auth: { username: 'postmaster', password: 'secret', mechanism: 'PLAIN' }
};

/** a `fetch` stand-in that records what the Cloudflare lane sent and answers with what it is given */
function recordingFetch(response: { ok: boolean; status: number; body?: string }) {
	const calls: Array<{
		url: string;
		init: { method: string; headers: Record<string, string>; body: string };
	}> = [];
	const fetchStub: MailDeps['fetch'] = async (url, init) => {
		calls.push({ url, init });
		return {
			ok: response.ok,
			status: response.status,
			statusText: 'stubbed',
			text: async () => response.body ?? ''
		};
	};
	return { calls, deps: { ...DEFAULT_MAIL_DEPS, fetch: fetchStub } satisfies MailDeps };
}

const refusalOf = (plan: ReturnType<typeof resolveMailTransport>) =>
	(plan as { refusal: string }).refusal;
const transportOf = (plan: ReturnType<typeof resolveMailTransport>) =>
	(plan as { transport: MailTransport }).transport;

// #endregion

describe('resolveMailTransport refuses with a reason, never with a bare false', () => {
	it('refuses an unconfigured site and names every way to configure one', () => {
		const plan = resolveMailTransport({ MAIL_FROM: 'site@example.com' });
		expect(plan).toHaveProperty('refusal');
		expect(refusalOf(plan)).toContain('SEND_EMAIL');
		expect(refusalOf(plan)).toContain('CF_EMAIL_ACCOUNT_ID');
		expect(refusalOf(plan)).toContain('SMTP_HOST');
	});

	it('honours MAIL_TRANSPORT=off, which is the kill switch that replaced CFW_EMAIL_BINDING', () => {
		const plan = resolveMailTransport({
			MAIL_TRANSPORT: 'off',
			SMTP_HOST: 'mail.example.net',
			MAIL_FROM: 'a@b.c'
		});
		expect(plan).toEqual({ refusal: expect.stringContaining('switched off') });
	});

	it('refuses a MAIL_TRANSPORT it does not recognise rather than falling through to auto', () => {
		const plan = resolveMailTransport({ MAIL_TRANSPORT: 'sendmail', MAIL_FROM: 'a@b.c' });
		expect(plan).toEqual({
			refusal: expect.stringContaining('auto, binding, api, smtp or off')
		});
	});
});

describe('the sender is per-message, not per-transport', () => {
	it("takes Drupal's own site mail, which is the address the site is configured to send as", () => {
		expect(senderFor({ from: 'fallback@example.com' }, { from: 'drupal@example.com' })).toBe(
			'drupal@example.com'
		);
	});

	it('falls back to MAIL_FROM when the message carries none', () => {
		expect(senderFor({ from: 'fallback@example.com' }, { from: '' })).toBe(
			'fallback@example.com'
		);
	});

	it('is empty when neither exists, which is what makes the commit refuse', () => {
		// a transport is resolved once and reused across the queue, so it cannot own the From;
		// resolving one WITH a message made the drain refuse every message it had no message for
		expect(senderFor({ from: '' }, { from: undefined })).toBe('');
		const sql = memorySql();
		expect(queueMail(sql, message({ from: '' }), API, 1)).toEqual({
			refusal: expect.stringContaining('MAIL_FROM is not set')
		});
	});
});

describe('which transport auto picks, and why the order is what it is', () => {
	it('prefers the binding, which reaches the same recipients for no credential', () => {
		const plan = resolveMailTransport({
			SEND_EMAIL: { send: async () => ({}) },
			CF_EMAIL_ACCOUNT_ID: 'acct',
			CF_EMAIL_TOKEN: 'tok',
			SMTP_HOST: 'mail.example.net'
		});
		expect(transportOf(plan).kind).toBe('binding');
	});

	it('takes the REST API when there is no binding but there are credentials', () => {
		const plan = resolveMailTransport({
			CF_EMAIL_ACCOUNT_ID: 'acct',
			CF_EMAIL_TOKEN: 'tok',
			SMTP_HOST: 'mail.example.net'
		});
		expect(transportOf(plan).kind).toBe('api');
	});

	it('takes SMTP when it is the only thing configured', () => {
		const plan = resolveMailTransport({ SMTP_HOST: 'mail.example.net' });
		expect(transportOf(plan)).toMatchObject({
			kind: 'smtp',
			hostname: 'mail.example.net',
			port: 587,
			tls: 'starttls'
		});
	});

	it('names the half-configured Cloudflare credential rather than silently trying SMTP', () => {
		// half a credential is a mistake, not a preference for the next transport down
		const plan = resolveMailTransport({ CF_EMAIL_ACCOUNT_ID: 'acct', SMTP_HOST: 'x.test' });
		expect(plan).toEqual({ refusal: expect.stringContaining('CF_EMAIL_TOKEN is not set') });
	});

	it('refuses MAIL_TRANSPORT=binding when nothing is bound, rather than falling back', () => {
		const plan = resolveMailTransport({
			MAIL_TRANSPORT: 'binding',
			SMTP_HOST: 'mail.example.net'
		});
		expect(plan).toEqual({ refusal: expect.stringContaining('no send_email binding') });
	});
});

describe('the SMTP transport refuses what a Worker cannot do', () => {
	it('REFUSES PORT 25, which is blocked on Workers, rather than opening a socket that cannot connect', () => {
		expect(BLOCKED_SMTP_PORT).toBe(25);
		const plan = resolveMailTransport({ SMTP_HOST: 'mail.example.net', SMTP_PORT: '25' });
		expect(refusalOf(plan)).toContain('block outbound TCP to port 25');
		expect(refusalOf(plan)).toContain('587');
		expect(refusalOf(plan)).toContain('465');
	});

	it("refuses Cloudflare's own relay, because a Worker cannot reach a Cloudflare IP over TCP", () => {
		const plan = resolveMailTransport({ SMTP_HOST: 'smtp.mx.cloudflare.net' });
		expect(plan).toEqual({ refusal: expect.stringContaining('MAIL_TRANSPORT=api') });
	});

	it('refuses AUTH over plaintext, which would put the relay password on the wire', () => {
		const plan = resolveMailTransport({
			SMTP_HOST: 'mail.example.net',
			SMTP_TLS: 'off',
			SMTP_USER: 'me',
			SMTP_PASS: 'pw'
		});
		expect(plan).toEqual({ refusal: expect.stringContaining('in the clear') });
	});

	it('defaults the port off the TLS mode, matching what submission actually listens on', () => {
		expect(defaultSmtpPort('starttls')).toBe(587);
		expect(defaultSmtpPort('implicit')).toBe(465);
		expect(defaultSmtpPort('off')).toBe(587);
		const implicit = resolveMailTransport({
			SMTP_HOST: 'mail.example.net',
			SMTP_TLS: 'implicit'
		});
		expect(transportOf(implicit)).toMatchObject({ port: 465 });
	});

	it('refuses a TLS mode, an AUTH mechanism and a port it cannot use', () => {
		expect(resolveMailTransport({ SMTP_HOST: 'h.test', SMTP_TLS: 'ssl' })).toHaveProperty(
			'refusal'
		);
		expect(
			resolveMailTransport({ SMTP_HOST: 'h.test', SMTP_USER: 'u', SMTP_AUTH: 'CRAM-MD5' })
		).toEqual({ refusal: expect.stringContaining('PLAIN or LOGIN') });
		expect(resolveMailTransport({ SMTP_HOST: 'h.test', SMTP_PORT: 'ninety' })).toEqual({
			refusal: expect.stringContaining('port number')
		});
	});

	it('carries the credentials through when they are complete', () => {
		const plan = resolveMailTransport({
			SMTP_HOST: 'mail.example.net',
			SMTP_PORT: 465,
			SMTP_TLS: 'implicit',
			SMTP_USER: 'postmaster',
			SMTP_PASS: 'secret',
			SMTP_AUTH: 'login'
		});
		expect(transportOf(plan)).toMatchObject({
			auth: { username: 'postmaster', password: 'secret', mechanism: 'LOGIN' }
		});
	});
});

describe('the message the wire carries', () => {
	it('splits a comma-separated recipient list, which is what Drupal hands over', () => {
		expect(splitAddresses('a@x.test, b@y.test ,, c@z.test')).toEqual([
			'a@x.test',
			'b@y.test',
			'c@z.test'
		]);
	});

	it('maps Cc/Bcc to their own fields and threading headers to headers, on the Cloudflare lane', () => {
		const body = cloudflareSendBody(
			API,
			message({
				replyTo: 'reply@example.com',
				html: '<p>hi</p>',
				headers: {
					Cc: 'cc@x.test',
					Bcc: 'bcc@y.test',
					'In-Reply-To': '<a@b>',
					References: '<a@b>'
				}
			})
		);
		expect(body).toMatchObject({
			from: 'Site <site@example.com>',
			to: ['visitor@example.org'],
			cc: ['cc@x.test'],
			bcc: ['bcc@y.test'],
			replyTo: 'reply@example.com',
			html: '<p>hi</p>',
			headers: { 'In-Reply-To': '<a@b>', References: '<a@b>' }
		});
	});

	it('omits every optional field rather than sending an empty one', () => {
		const body = cloudflareSendBody(API, message({ html: null }));
		expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
	});

	it('puts Reply-To in the headers on the SMTP lane, because edgeport Mail has no such field', () => {
		const mail = smtpMail(
			SMTP,
			message({
				replyTo: 'reply@example.com',
				headers: { Cc: 'cc@x.test', References: '<r>' }
			})
		);
		expect(mail.headers).toEqual({ References: '<r>', 'Reply-To': 'reply@example.com' });
		expect(mail.cc).toEqual(['cc@x.test']);
	});

	it('builds the account endpoint the REST API documents', () => {
		expect(cloudflareSendUrl('abc123')).toBe(
			'https://api.cloudflare.com/client/v4/accounts/abc123/email/sending/send'
		);
	});
});

describe('the Cloudflare lanes actually leave the Worker', () => {
	it('POSTs the message to the Email Sending API with the bearer token', async () => {
		const { calls, deps } = recordingFetch({ ok: true, status: 200 });
		const detail = await sendViaApi(API, message(), deps);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(
			'https://api.cloudflare.com/client/v4/accounts/acct-1/email/sending/send'
		);
		expect(calls[0]!.init.method).toBe('POST');
		expect(calls[0]!.init.headers.Authorization).toBe('Bearer tok-1');
		expect(JSON.parse(calls[0]!.init.body)).toMatchObject({
			from: 'Site <site@example.com>',
			to: ['visitor@example.org'],
			subject: 'Your password reset'
		});
		expect(detail).toBe('api 200');
	});

	it('throws with the status and the body when the API refuses, so the drain records it', async () => {
		const { deps } = recordingFetch({ ok: false, status: 403, body: 'domain not onboarded' });
		await expect(sendViaApi(API, message(), deps)).rejects.toThrow(/403: domain not onboarded/);
	});

	it('hands the same body to a send_email binding, which needs no credential', async () => {
		const seen: Record<string, unknown>[] = [];
		const detail = await sendViaBinding(
			{
				kind: 'binding',
				from: '',
				binding: {
					send: async (body) => {
						seen.push(body);
						return { messageId: 'mid-9' };
					}
				}
			},
			message()
		);
		expect(seen[0]).toMatchObject({
			from: 'Site <site@example.com>',
			to: ['visitor@example.org']
		});
		expect(detail).toBe('binding mid-9');
	});
});

describe('the SMTP lane actually opens a socket and speaks the protocol', () => {
	it('dials 587, upgrades with STARTTLS, authenticates and sends the envelope', async () => {
		const { connect, script } = smtpServer();
		const detail = await sendViaSmtp(SMTP, message({ to: 'a@x.test, b@y.test' }), {
			...DEFAULT_MAIL_DEPS,
			connect
		});

		expect(script.dialled).toMatchObject({
			hostname: 'mail.example.net',
			port: 587,
			tls: 'starttls'
		});
		// the transcript is the assertion: every one of these lines is edgeport's client driven by
		// this module, and a stubbed sender produces none of them
		expect(script.commands[0]).toBe('EHLO edgeport');
		expect(script.commands).toContain('STARTTLS');
		expect(script.upgrades).toBeGreaterThan(0);
		expect(script.commands.some((c) => c.startsWith('AUTH PLAIN '))).toBe(true);
		expect(script.commands).toContain('MAIL FROM:<site@example.com>');
		expect(script.commands).toContain('RCPT TO:<a@x.test>');
		expect(script.commands).toContain('RCPT TO:<b@y.test>');
		expect(script.commands).toContain('DATA');
		expect(script.commands).toContain('QUIT');
		// and the message itself went down the wire, not just the envelope
		expect(script.body).toContain('Subject: Your password reset');
		expect(script.body).toContain('follow the link');
		expect(detail).toBe('smtp 2 accepted');
	});

	it('dials 465 without a STARTTLS command when the TLS is implicit', async () => {
		const { connect, script } = smtpServer({ noStartTls: true });
		await sendViaSmtp({ ...SMTP, port: 465, tls: 'implicit' }, message(), {
			...DEFAULT_MAIL_DEPS,
			connect
		});
		expect(script.dialled).toMatchObject({ port: 465, tls: 'on' });
		expect(script.commands).not.toContain('STARTTLS');
		expect(script.upgrades).toBe(0);
	});

	it('throws when the relay rejects the envelope, and still QUITs the session', async () => {
		const { connect, script } = smtpServer({ failOn: 'MAIL FROM' });
		await expect(
			sendViaSmtp(SMTP, message(), { ...DEFAULT_MAIL_DEPS, connect })
		).rejects.toThrow(/MAIL FROM failed: 550/);
		expect(script.commands).toContain('QUIT');
	});
});

describe('the queue is what makes a synchronous cfwMail honest', () => {
	it('refuses a message with no recipient rather than queueing one that cannot be sent', () => {
		const sql = memorySql();
		expect(queueMail(sql, message({ to: '  ' }), API, 1)).toEqual({
			refusal: 'the message has no recipient'
		});
		expect(mailQueueDepth(sql)).toBe(0);
	});

	it('refuses a message over the record ceiling and names the ceiling that actually binds', () => {
		const sql = memorySql();
		const out = queueMail(sql, message({ text: 'x'.repeat(MAX_MAIL_BYTES + 1) }), API, 1);
		expect(out).toEqual({ refusal: expect.stringContaining(`${MAX_MAIL_BYTES}-byte`) });
		// the DO record ceiling, not Cloudflare's 5 MiB: naming the wrong one sends an operator to
		// the mail limits page for a limit that is not what stopped them
		expect((out as { refusal: string }).refusal).toContain('2,199,995');
	});

	it('does NOT de-duplicate, because two identical mails are two mails', () => {
		const sql = memorySql();
		// the http queue collapses a repeated deferral, correctly; collapsing a second password
		// reset would silently drop it
		queueMail(sql, message(), API, 1);
		queueMail(sql, message(), API, 1);
		expect(mailQueueDepth(sql)).toBe(2);
	});

	it('names its own table, so a stats reader and the drain cannot disagree', () => {
		expect(MAIL_TABLE).toBe('cfw_mail_queue');
		const sql = memorySql();
		ensureMailTable(sql);
		expect(mailQueueDepth(sql)).toBe(0);
	});
});

describe('the drain sends what was queued and reports what it could not', () => {
	it('sends every queued message and empties the queue', async () => {
		const sql = memorySql();
		queueMail(sql, message({ to: 'one@x.test' }), API, 1);
		queueMail(sql, message({ to: 'two@x.test' }), API, 2);
		const { calls, deps } = recordingFetch({ ok: true, status: 200 });

		const out = await drainMailQueue(sql, API, { deps });
		expect(calls).toHaveLength(2);
		expect(out.sent.map((s) => s.to)).toEqual(['one@x.test', 'two@x.test']);
		expect(out.sent.every((s) => s.ok)).toBe(true);
		expect(out.remaining).toBe(0);
	});

	it('takes only the limit it was given, oldest first', async () => {
		const sql = memorySql();
		for (const n of [1, 2, 3]) queueMail(sql, message({ to: `n${n}@x.test` }), API, n);
		const { calls, deps } = recordingFetch({ ok: true, status: 200 });
		const out = await drainMailQueue(sql, API, { limit: 2, deps });
		expect(calls).toHaveLength(2);
		expect(out.remaining).toBe(1);
	});

	it('gives a failed send ONE attempt, because a retry double-delivers a one-time link', async () => {
		expect(MAIL_ATTEMPT_BUDGET).toBe(1);
		const sql = memorySql();
		queueMail(sql, message(), API, 1);
		const { deps } = recordingFetch({ ok: false, status: 500, body: 'relay exploded' });

		const out = await drainMailQueue(sql, API, { deps });
		expect(out.sent[0]).toMatchObject({ ok: false });
		expect(String(out.sent[0]!.error)).toContain('relay exploded');
		// dropped rather than retried: the first attempt may have been accepted and only failed to
		// return, and two password resets with two different links is worse than none
		expect(out.remaining).toBe(0);
	});

	it('drops an unreadable row rather than letting it block the head of the queue', async () => {
		const sql = memorySql();
		queueMail(sql, message(), API, 1);
		sql.rows[0]!.payload = '{not json';
		const { calls, deps } = recordingFetch({ ok: true, status: 200 });

		const out = await drainMailQueue(sql, API, { deps });
		expect(calls).toHaveLength(0);
		expect(out.sent[0]).toMatchObject({ ok: false, error: 'unreadable payload' });
		expect(out.remaining).toBe(0);
	});

	it('drives the SMTP transport too, so the drain is not an api-only path', async () => {
		const sql = memorySql();
		queueMail(sql, message(), SMTP, 1);
		const { connect, script } = smtpServer();

		const out = await drainMailQueue(sql, SMTP, { deps: { ...DEFAULT_MAIL_DEPS, connect } });
		expect(script.commands).toContain('MAIL FROM:<site@example.com>');
		expect(out.sent[0]).toMatchObject({ ok: true, transport: 'smtp' });
		expect(out.remaining).toBe(0);
	});
});

describe("Cloudflare's per-message limits are named, not discovered at the relay", () => {
	it('counts To, Cc and Bcc together against the 50-recipient cap', () => {
		expect(MAX_RECIPIENTS).toBe(50);
		const many = Array.from({ length: 26 }, (_, i) => `p${i}@x.test`).join(', ');
		const refusal = mailLimitRefusal(message({ to: many, headers: { Cc: many } }), 100);
		expect(refusal).toContain('52 recipients across To/Cc/Bcc');
		// under the cap, nothing is refused
		expect(mailLimitRefusal(message({ to: 'a@x.test' }), 100)).toBeNull();
	});

	it('refuses a subject over 998 characters and headers over 16 KB', () => {
		expect(MAX_SUBJECT_CHARS).toBe(998);
		expect(MAX_HEADER_BYTES).toBe(16_384);
		expect(mailLimitRefusal(message({ subject: 's'.repeat(999) }), 100)).toContain(
			'999 characters'
		);
		expect(
			mailLimitRefusal(
				message({ headers: { References: 'r'.repeat(MAX_HEADER_BYTES) } }),
				100
			)
		).toContain('over the 16384-byte limit');
	});

	it('refuses at COMMIT, so the reason lands in the Drupal log next to what caused it', () => {
		const sql = memorySql();
		const many = Array.from({ length: 51 }, (_, i) => `p${i}@x.test`).join(', ');
		expect(queueMail(sql, message({ to: many }), API, 1)).toEqual({
			refusal: expect.stringContaining('51 recipients')
		});
		expect(mailQueueDepth(sql)).toBe(0);
	});
});

describe('a Cloudflare rejection says which thing it is, not just a status', () => {
	it('names the plan on free, because that is the cause a config check cannot find', async () => {
		const { deps } = recordingFetch({ ok: false, status: 403, body: 'forbidden' });
		await expect(sendViaApi(API, message(), deps, 'free')).rejects.toThrow(
			/no outbound Email Sending except to verified destination addresses/
		);
		// and it says what to do about it rather than leaving the owner stuck
		await expect(sendViaApi(API, message(), deps, 'free')).rejects.toThrow(
			/MAIL_TRANSPORT=smtp/
		);
	});

	it('drops the free sentence on paid, where it is noise', () => {
		expect(cloudflareFailureHint(403, 'paid')).not.toContain('Workers Free');
		expect(cloudflareFailureHint(403, 'paid')).toContain('onboarded');
	});

	it('names onboarding, verification and the token for a 401/403, in that order', () => {
		const hint = cloudflareFailureHint(401, 'paid');
		expect(hint.indexOf('onboarded')).toBeLessThan(hint.indexOf('verified destination'));
		expect(hint).toContain('Email Sending: Edit');
	});

	it('names the quota for a 429 and the message for a 400', () => {
		expect(cloudflareFailureHint(429, 'paid')).toContain('quota');
		expect(cloudflareFailureHint(400, 'paid')).toContain('un-onboarded sending domain');
	});

	it('attaches the same hint to a binding refusal, which throws instead of returning a status', async () => {
		await expect(
			sendViaBinding(
				{
					kind: 'binding',
					from: '',
					binding: {
						send: async () => {
							throw new Error('not a verified destination address');
						}
					}
				},
				message(),
				'free'
			)
		).rejects.toThrow(/verified destination address.*Workers Free/s);
	});
});

describe('the drain knobs', () => {
	it('is on unless it is switched off, so a depth assertion can be stable', () => {
		expect(mailDrainEnabled({})).toBe(true);
		expect(mailDrainEnabled({ MAIL_DRAIN_ON_ALARM: '0' })).toBe(false);
	});

	it('clamps the limit, because each send is one of 50 subrequests', () => {
		expect(mailDrainLimit({})).toBe(5);
		expect(mailDrainLimit({ MAIL_DRAIN_LIMIT: '2' })).toBe(2);
		expect(mailDrainLimit({ MAIL_DRAIN_LIMIT: '1000' })).toBe(MAX_MAIL_DRAIN_LIMIT);
		expect(mailDrainLimit({ MAIL_DRAIN_LIMIT: 'nonsense' })).toBe(5);
	});

	it('defaults to the real platform, so nothing ships pointing at a test double', () => {
		expect(DEFAULT_MAIL_DEPS.fetch).toBeTypeOf('function');
		expect(DEFAULT_MAIL_DEPS.connect).toBeTypeOf('function');
	});
});

describe('drupal/smtp: the module installs, its socket never runs, and its settings now count', () => {
	const SETTINGS = {
		smtp_on: true,
		smtp_host: 'relay.example',
		smtp_port: '2525',
		smtp_protocol: 'tls',
		smtp_username: 'postmaster',
		smtp_password: 'hunter2',
		smtp_from: 'site@example.com'
	};

	it('maps the module’s own settings onto the transport vars', () => {
		expect(mailEnvFromSite(SETTINGS)).toEqual({
			SMTP_HOST: 'relay.example',
			SMTP_PORT: '2525',
			// the module's `tls` is STARTTLS; its `ssl` is the implicit one
			SMTP_TLS: 'starttls',
			SMTP_USER: 'postmaster',
			SMTP_PASS: 'hunter2',
			MAIL_FROM: 'site@example.com'
		});
	});

	it('reads the three protocol values the way the module means them', () => {
		const tls = (protocol: string) =>
			mailEnvFromSite({ ...SETTINGS, smtp_protocol: protocol }).SMTP_TLS;
		expect(tls('ssl')).toBe('implicit');
		expect(tls('tls')).toBe('starttls');
		// `standard` is the module's word for no encryption at all, not for a default
		expect(tls('standard')).toBe('off');
	});

	it('honours the module’s own off switch and an unconfigured host', () => {
		expect(mailEnvFromSite({ ...SETTINGS, smtp_on: false })).toEqual({});
		expect(mailEnvFromSite({ ...SETTINGS, smtp_host: '' })).toEqual({});
		expect(mailEnvFromSite(null)).toEqual({});
		expect(mailEnvFromSite('not settings')).toEqual({});
	});

	/**
	 * THE DIRECTION IS THE SECURITY PROPERTY.
	 *
	 * A var is set by whoever can deploy the Worker; this form is reachable by anyone who can get to
	 * a Drupal admin page, which is a wider set of people. So the site fills gaps and never
	 * overrides a decision the deployer made.
	 */
	it('lets the deployment win every field it set', () => {
		const merged = mergeMailEnv(
			{ SMTP_HOST: 'operator.example', SMTP_PASS: 'from-the-var' },
			mailEnvFromSite(SETTINGS)
		);
		expect(merged.SMTP_HOST).toBe('operator.example');
		expect(merged.SMTP_PASS).toBe('from-the-var');
		// and the fields it did not set still come from the site
		expect(merged.SMTP_PORT).toBe('2525');
		expect(merged.SMTP_USER).toBe('postmaster');
	});

	// an unset var arrives as undefined or '' depending on how it was declared, and neither may
	// shadow a configured setting -- otherwise declaring an empty var silently disables the site's
	it('treats an empty var as absent rather than as an override', () => {
		const merged = mergeMailEnv(
			{ SMTP_HOST: '', SMTP_USER: undefined },
			mailEnvFromSite(SETTINGS)
		);
		expect(merged.SMTP_HOST).toBe('relay.example');
		expect(merged.SMTP_USER).toBe('postmaster');
	});

	it('resolves a working SMTP transport from the site settings alone', () => {
		const plan = resolveMailTransport(mergeMailEnv({}, mailEnvFromSite(SETTINGS)));
		if ('refusal' in plan) throw new Error(plan.refusal);
		expect(plan.transport).toMatchObject({
			kind: 'smtp',
			hostname: 'relay.example',
			port: 2525,
			tls: 'starttls'
		});
	});
});
