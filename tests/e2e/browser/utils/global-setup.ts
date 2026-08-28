import { chromium } from '@playwright/test';
import { ADMIN_PASS, ADMIN_USER, BASE_URL, SITE, SITE_NAME } from './fixtures.js';

/**
 * Brings the site the browser lane navigates to a state where a browser has something to look at.
 *
 * The same stages `tests/e2e/README.md` documents for the HTTP lane -- migrate, first run, warm --
 * plus one the HTTP lane never needed: visitor registration, without which `/user/register` is an
 * access-denied page rather than a form.
 */

const call = async (path: string, init?: RequestInit): Promise<globalThis.Response> => {
	const url = new URL(`${BASE_URL}${path}`);
	if (!url.searchParams.has('site')) url.searchParams.set('site', SITE);
	return fetch(url, { signal: AbortSignal.timeout(180_000), ...init });
};

/**
 * One JSON call, retried.
 *
 * `wrangler dev` answers an occasional `500 Error: Network connection lost.` on a warm object, and a
 * setup that aborts on one of those takes the whole lane down before a single spec runs.
 */
async function callJson<T>(path: string, init?: RequestInit, tries = 3): Promise<T> {
	let last = '';
	for (let i = 0; i < tries; i++) {
		if (i > 0) await new Promise((r) => setTimeout(r, 1000));
		let text: string;
		try {
			text = await (await call(path, init)).text();
		} catch (e) {
			last = String(e);
			continue;
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			last = `not JSON: ${text.slice(0, 200)}`;
		}
	}
	throw new Error(`${path} failed after ${tries} tries: ${last}`);
}

const sql = (q: string): Promise<{ ok: boolean; rows: Record<string, string>[] }> =>
	callJson(`/sql?q=${encodeURIComponent(q)}`);

async function migrate(): Promise<void> {
	for (let i = 0; i < 60; i++) {
		const reply = await callJson<{ ok: boolean; done: boolean | null }>('/migrate?all=1');
		if (reply.done === true) return;
		if (reply.ok === false) throw new Error(`migration refused: ${JSON.stringify(reply)}`);
	}
	throw new Error('migration did not finish in 60 calls');
}

/**
 * `force=1` every run, so the credentials the specs use are the credentials the site has.
 *
 * Without it a state directory left over from a run with different constants answers
 * `already configured` and every authenticated spec fails on a password nobody can recover.
 */
async function firstRun(): Promise<void> {
	const reply = await callJson<{ ok: boolean; error?: string }>('/firstrun?force=1', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			siteName: SITE_NAME,
			adminName: ADMIN_USER,
			adminMail: 'admin@example.invalid',
			adminPass: ADMIN_PASS,
			timezone: 'UTC'
		})
	});
	if (!reply.ok) throw new Error(`firstrun refused: ${reply.error ?? JSON.stringify(reply)}`);
}

const REGISTER_VISITORS = 's:8:"register";s:8:"visitors";';

/** what `user.settings:register` currently is, read straight out of the config table */
async function registrationIsOpen(): Promise<boolean> {
	const row = await sql(`SELECT CAST(data AS TEXT) AS d FROM config WHERE name='user.settings'`);
	const data = row.rows[0]?.d ?? '';
	if (data === '') throw new Error('user.settings is missing; the site is not migrated');
	return data.includes(REGISTER_VISITORS);
}

/**
 * Opens registration to visitors, which the pack ships as `admin_only`.
 *
 * Through Drupal's own form rather than an UPDATE, and this was measured rather than assumed: the
 * host-side write plus a `cache_config` delete leaves the LIVE interpreter's config factory holding
 * `admin_only` in a static, so `/user/register` kept answering 403 with the table already correct.
 */
async function openRegistration(): Promise<void> {
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({ baseURL: BASE_URL });
		const page = await context.newPage();
		await page.goto('/user/login');
		await page.locator('#edit-name').fill(ADMIN_USER);
		await page.locator('#edit-pass').fill(ADMIN_PASS);
		await Promise.all([
			page.waitForURL(/\/user\/1(\?|$)/),
			page.locator('#edit-submit').click()
		]);

		await page.goto('/admin/config/people/accounts');
		await page.locator('#edit-user-register-visitors').check();
		await page.getByRole('button', { name: 'Save configuration' }).click();
		await page.waitForLoadState('load');
	} finally {
		await browser.close();
	}
	if (!(await registrationIsOpen())) throw new Error('user.settings:register did not take');
}

/** a cold anonymous path answers 503 until the fill queue renders it */
async function warm(path: string, deadlineMs = 180_000): Promise<void> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const res = await call(`/serve?path=${encodeURIComponent(path)}`);
		if (res.status < 500) {
			if (res.status >= 400) throw new Error(`${path} answered ${res.status} while warming`);
			return;
		}
		if (Date.now() >= until) throw new Error(`${path} never left 5xx`);
		await new Promise((r) => setTimeout(r, 1500));
	}
}

export default async function globalSetup(): Promise<void> {
	console.log(`[browser] provisioning ${SITE} at ${BASE_URL}`);
	await migrate();
	await firstRun();

	const open = await registrationIsOpen();
	if (!open) {
		// the admin form is reached with a browser, so the login page has to be renderable first
		await warm('/user/login');
		await openRegistration();
	}

	// firstrun and the config save both invalidate every cached page, so warming comes last
	for (const path of ['/', '/user/login', '/user/register']) await warm(path);
	console.log(`[browser] ready (visitor registration ${open ? 'already on' : 'enabled'})`);
}
