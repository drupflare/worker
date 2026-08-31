import { decode, encode } from '@drupflare/durabledb/codec';
import { afterEach, describe, expect, it } from 'vitest';
import { driveAlarms, freshSite, inObject, statsOf, type ServeDo } from '../helpers/serve-do';
import { stubFetch } from '../helpers/stub-fetch';

/**
 * `cfwMail` end to end, against a REAL Durable Object: the host call PHP makes, the durable queue,
 * the alarm that drains it, and the request that leaves the Worker.
 *
 * The defect this replaces: the capability pushed onto an in-memory array and answered `{ok: true}`
 * whenever `CFW_EMAIL_BINDING` was `'1'`. Every test passed, because the var gated a return value
 * and there was no transport to remove. So every assertion here is downstream of something that
 * actually left the object -- the recorded `fetch` to the Email Sending API, or the recorded call
 * into a `send_email` binding -- and a `cfwMail` that only records would fail all of them.
 *
 * The SMTP lane is covered at full protocol fidelity in `tests/unit/ops/mail.spec.ts`, where the
 * socket can be scripted. It is absent here: the alarm drain dials the real
 * `cloudflare:sockets`, and a gate test must not open one.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/**
 * Replaces outbound fetch for this test; the object shares the isolate, so it sees this.
 *
 * Filtered by host for the reason `http-queue.spec.ts` gives: an object queued in an earlier test
 * arms an alarm at +1 ms and the runtime fires it whenever it likes, so a global spy really does see
 * another object's drain.
 */
/** one `Host::call('cfwMail', ...)`, encoded the way the PHP side encodes it */
function callMail(site: ServeDo, payload: Record<string, unknown>): Record<string, unknown> {
	const binary: Record<string, (json: string) => string> = {};
	site.installCapabilities(binary);
	const raw = binary.cfwMail!(JSON.stringify(encode(payload)));
	return decode(JSON.parse(raw)) as Record<string, unknown>;
}

const MESSAGE = {
	to: 'visitor@example.org',
	from: 'Site <site@example.com>',
	subject: 'Your new account',
	text: 'welcome aboard',
	html: null,
	headers: {}
};

describe('a refusal is a first-class outcome, and it names what is missing', () => {
	it('refuses on an unconfigured site instead of answering ok', async () => {
		const stub = freshSite();
		const out = await inObject(stub, (site) => {
			site.env = { ...site.env, MAIL_DRAIN_ON_ALARM: '0' };
			return {
				reply: callMail(site, MESSAGE),
				mails: site.mails,
				depth: site.countOrNull('cfw_mail_queue')
			};
		});
		expect(out.reply.ok).toBe(false);
		expect(String(out.reply.error)).toContain('no mail transport is configured');
		// nothing queued, and the attempt is still auditable with its reason
		expect(out.depth).toBeNull();
		expect(out.mails?.[0]).toMatchObject({ transport: null });
		expect(String(out.mails?.[0]?.refusal)).toContain('SMTP_HOST');
	});

	it('REFUSES WHERE THE OLD STUB SAID OK: a bare CFW_EMAIL_BINDING configures nothing', async () => {
		const stub = freshSite();
		const reply = await inObject(stub, (site) => {
			// the exact environment that used to return {ok: true} for a message that went nowhere
			site.env = { ...site.env, CFW_EMAIL_BINDING: '1', MAIL_DRAIN_ON_ALARM: '0' };
			return callMail(site, MESSAGE);
		});
		expect(reply.ok).toBe(false);
	});

	it('refuses a message with no recipient, which has nowhere to go', async () => {
		const stub = freshSite();
		const reply = await inObject(stub, (site) => {
			site.env = {
				...site.env,
				CF_EMAIL_ACCOUNT_ID: 'acct-none',
				CF_EMAIL_TOKEN: 'tok',
				MAIL_DRAIN_ON_ALARM: '0'
			};
			return callMail(site, { ...MESSAGE, to: '' });
		});
		expect(reply).toMatchObject({ ok: false, error: 'the message has no recipient' });
	});

	it('honours the KV kill switch, which is the lever an operator flips without a redeploy', async () => {
		const stub = freshSite();
		const reply = await inObject(stub, (site) => {
			site.env = {
				...site.env,
				MAIL_TRANSPORT: 'off',
				CF_EMAIL_ACCOUNT_ID: 'acct-off',
				CF_EMAIL_TOKEN: 'tok',
				MAIL_DRAIN_ON_ALARM: '0'
			};
			return callMail(site, MESSAGE);
		});
		expect(String(reply.error)).toContain('MAIL_TRANSPORT=off');
	});
});

describe('a queued message really leaves the Worker', () => {
	it('commits on the host call and POSTs to the Email Sending API on the alarm', async () => {
		const stub = freshSite();
		const calls = stubFetch();

		const committed = await inObject(stub, (site) => {
			site.env = {
				...site.env,
				CF_EMAIL_ACCOUNT_ID: 'acct-live',
				CF_EMAIL_TOKEN: 'tok-live',
				// the fill lane must not race the mail assertions; the mail drain stays ON
				HTTP_DRAIN_ON_ALARM: '0'
			};
			const reply = callMail(site, MESSAGE);
			return { reply, depth: site.countOrNull('cfw_mail_queue') };
		});

		// ok means COMMITTED, and the row is the evidence
		expect(committed.reply).toMatchObject({ ok: true, transport: 'api' });
		expect(committed.depth).toBe(1);

		await driveAlarms(stub, (site) => site.countOrNull('cfw_mail_queue') === 0);

		const sent = calls('acct-live');
		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe(
			'https://api.cloudflare.com/client/v4/accounts/acct-live/email/sending/send'
		);
		const headers = sent[0]!.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer tok-live');
		expect(JSON.parse(String(sent[0]!.init?.body))).toMatchObject({
			from: 'Site <site@example.com>',
			to: ['visitor@example.org'],
			subject: 'Your new account',
			text: 'welcome aboard'
		});

		const stats = await inObject(stub, (site) => statsOf(site));
		expect(stats.mailQueue).toBe(0);
		expect(stats.lastMailDrain?.sent?.[0]).toMatchObject({ ok: true, transport: 'api' });
	});

	it('hands the message to a send_email binding when one is bound, spending no credential', async () => {
		const stub = freshSite();
		const seen: Record<string, unknown>[] = [];

		const reply = await inObject(stub, (site) => {
			site.env = {
				...site.env,
				HTTP_DRAIN_ON_ALARM: '0',
				SEND_EMAIL: {
					send: async (body: Record<string, unknown>) => {
						seen.push(body);
						return { messageId: 'bound-1' };
					}
				}
			};
			return callMail(site, MESSAGE);
		});
		expect(reply).toMatchObject({ ok: true, transport: 'binding' });

		await driveAlarms(stub, (site) => site.countOrNull('cfw_mail_queue') === 0);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ to: ['visitor@example.org'], subject: 'Your new account' });
	});

	it('records a relay failure, because cfwMail had already returned by then', async () => {
		const stub = freshSite();
		stubFetch(403, 'domain not onboarded');

		await inObject(stub, (site) => {
			site.env = {
				...site.env,
				CF_EMAIL_ACCOUNT_ID: 'acct-fail',
				CF_EMAIL_TOKEN: 'tok',
				HTTP_DRAIN_ON_ALARM: '0'
			};
			return callMail(site, MESSAGE);
		});
		await driveAlarms(stub, (site) => site.countOrNull('cfw_mail_queue') === 0);

		const stats = await inObject(stub, (site) => statsOf(site));
		// the only surface on which a queued-but-undelivered message is visible at all
		expect(stats.lastMailDrain?.sent?.[0]).toMatchObject({ ok: false });
		expect(String(stats.lastMailDrain?.sent?.[0]?.error)).toContain('403');
		expect(stats.mailQueue).toBe(0);
	});
});

describe('the queue is durable and the chain wakes for it', () => {
	it('arms the alarm on commit, or a queued message waits for the 240 s keep-warm tick', async () => {
		const stub = freshSite();
		stubFetch();
		const out = await inObject(stub, async (site) => {
			site.env = {
				...site.env,
				CF_EMAIL_ACCOUNT_ID: 'acct-armed',
				CF_EMAIL_TOKEN: 'tok',
				HTTP_DRAIN_ON_ALARM: '0'
			};
			callMail(site, MESSAGE);
			const armed = { alarmAt: await site.ctx.storage.getAlarm(), now: Date.now() };
			// drained here rather than left for the runtime, so no alarm outlives this test
			await site.alarm();
			return armed;
		});
		expect(out.alarmAt).not.toBeNull();
		expect(Number(out.alarmAt) - out.now).toBeLessThan(1000);
	});

	it('does not drain when the switch is off, so a depth assertion is stable', async () => {
		const stub = freshSite();
		const calls = stubFetch();
		const stats = await inObject(stub, async (site) => {
			site.env = {
				...site.env,
				CF_EMAIL_ACCOUNT_ID: 'acct-switch',
				CF_EMAIL_TOKEN: 'tok',
				MAIL_DRAIN_ON_ALARM: '0',
				HTTP_DRAIN_ON_ALARM: '0'
			};
			callMail(site, MESSAGE);
			await site.alarm();
			return statsOf(site);
		});
		expect(calls('acct-switch')).toHaveLength(0);
		expect(stats.mailQueue).toBe(1);
		expect(stats.lastMailDrain).toBeNull();
	});

	it('reports null before anything queued, so an absence is not read as a verified zero', async () => {
		const stub = freshSite();
		const stats = await inObject(stub, (site) => statsOf(site));
		expect(stats.mailQueue).toBeNull();
		expect(stats.lastMailDrain).toBeNull();
	});

	it('records the refusal when the credentials went away between commit and drain', async () => {
		const stub = freshSite();
		stubFetch();
		const stats = await inObject(stub, async (site) => {
			site.env = {
				...site.env,
				CF_EMAIL_ACCOUNT_ID: 'acct-gone',
				CF_EMAIL_TOKEN: 'tok',
				HTTP_DRAIN_ON_ALARM: '0'
			};
			callMail(site, MESSAGE);
			// the transport is re-resolved at drain time, so a credential an operator removed leaves
			// the message queued rather than dropping it
			site.env = { ...site.env, CF_EMAIL_TOKEN: '' };
			await site.alarm();
			return statsOf(site);
		});
		expect(String(stats.lastMailDrain?.refusal)).toContain('CF_EMAIL_TOKEN');
		expect(stats.mailQueue).toBe(1);
	});
});

// #region TEMPORARY assertion counter
import { afterAll as __afterAll, afterEach as __afterEach } from 'vitest';
let __asserts = 0;
__afterEach(() => {
	__asserts += expect.getState().assertionCalls ?? 0;
});
__afterAll(() => {
	console.log(`ASSERTIONS tests/integration/mail-transport.spec.ts ${__asserts}`);
});
// #endregion
