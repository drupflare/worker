import { beforeAll, describe, expect, it } from 'vitest';
import { e2eGate, ENDPOINT, SITE } from './helpers/endpoint';

/**
 * Drupal mail, delivered to a real SMTP server.
 *
 * Every other mail test in this repo stops at the queue. `mail-transport.spec.ts` proves a message
 * is committed to `cfw_mail_queue` and that Drupal's own `/user/password` flow reaches it, which is
 * the half that used to be missing -- but nothing has ever asserted that a message LEAVES. The
 * transport speaks SMTP over `cloudflare:sockets`, and a socket dialled against a mock is not
 * evidence about a socket.
 *
 * The rig is GreenMail, pinned by digest, taken from `js/edgeport`'s compose where the same image
 * backs its SMTP tests. `docker compose -f docker/compose.yml up -d`.
 *
 * SKIP LOCALLY, FAIL IN CI, the same asymmetry as the rest of this lane: a developer with no rig
 * running should not see red, and a CI run that quietly skipped is indistinguishable from a pass.
 */

const MAIL_API = process.env.CFW_E2E_MAIL_API ?? 'http://127.0.0.1:8080';
const MAILBOX = process.env.CFW_E2E_MAILBOX ?? 'drupflare';

type GreenMailMessage = {
	subject?: string;
	mimeMessage?: string;
	contentType?: string;
	uid?: string;
};

async function mailboxReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${MAIL_API}/api/service/readiness`, {
			signal: AbortSignal.timeout(3000)
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function messages(): Promise<GreenMailMessage[]> {
	const res = await fetch(`${MAIL_API}/api/user/${encodeURIComponent(MAILBOX)}/messages`, {
		signal: AbortSignal.timeout(10_000)
	});
	if (!res.ok) return [];
	return (await res.json()) as GreenMailMessage[];
}

/** clears the mailbox, so a count is about THIS test rather than about the whole run */
async function purge(): Promise<void> {
	await fetch(`${MAIL_API}/api/mail`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) })
		// GreenMail answers 404 on some builds; an unclearable mailbox is handled by matching on
		// subject rather than by trusting the count
		.catch(() => undefined);
}

/**
 * Waits for a message whose subject matches, because delivery is not synchronous with the request.
 *
 * The transport commits to `cfw_mail_queue` and the ALARM sends, so the HTTP response returns
 * before anything is on the wire. Polling a deadline is the only correct shape here; asserting
 * immediately after the POST would test the queue, which is already covered.
 */
async function waitForSubject(match: RegExp, timeoutMs = 45_000): Promise<GreenMailMessage | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const m of await messages()) {
			if (match.test(String(m.subject ?? ''))) return m;
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	return null;
}

describe('Drupal mail reaches a real SMTP server', () => {
	let skip = true;

	beforeAll(async () => {
		const worker = await e2eGate();
		const rig = await mailboxReachable();
		if (!rig && process.env.CI) {
			throw new Error(
				`no SMTP rig at ${MAIL_API}. Start it with: docker compose -f docker/compose.yml up -d`
			);
		}
		skip = worker || !rig;
		if (!skip) await purge();
	});

	/**
	 * The whole path, driven the way a person drives it.
	 *
	 * `/user/password` is Drupal's own form rather than a host binding, so this exercises the plugin
	 * selection, the queue, the alarm drain and the socket in one go. A pass here means every one of
	 * them works together; the unit lanes already prove each alone.
	 */
	it('delivers a password reset submitted through Drupal own form', async () => {
		if (skip) return;

		const body = new URLSearchParams({
			name: 'admin',
			form_id: 'user_pass',
			op: 'Submit'
		});
		const res = await fetch(
			`${ENDPOINT}/serve?site=${encodeURIComponent(SITE)}&path=${encodeURIComponent('/user/password')}&edge=0`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body
			}
		);
		// the form answers 200 with a status message or 303 to itself; either means it was accepted
		expect([200, 303]).toContain(res.status);

		const found = await waitForSubject(/replacement login|password|reset/i);
		expect(
			found,
			'no message arrived at the SMTP rig within the deadline; check MAIL_TRANSPORT=smtp and SMTP_HOST'
		).not.toBeNull();
	});

	/**
	 * The link has to point at the SITE, not at the object's own origin.
	 *
	 * A reset link built against the default host sends the recipient to their own machine, which is
	 * the defect `SITE_ORIGIN` and the origin pin exist for. It is only observable in a delivered
	 * message, so this lane is the only place it can be asserted.
	 */
	it('builds the reset link against the site origin', async () => {
		if (skip) return;
		const found = await waitForSubject(/replacement login|password|reset/i, 5000);
		if (!found) return;
		const raw = String(found.mimeMessage ?? '');
		expect(raw).toMatch(/user\/reset\//);
		expect(raw, 'a link to localhost points the recipient at their own machine').not.toMatch(
			/https?:\/\/(localhost|127\.0\.0\.1)/
		);
	});
});
