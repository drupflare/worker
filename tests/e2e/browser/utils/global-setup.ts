import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { ADMIN_PASS, ADMIN_USER, BASE_URL, OWNER_TOKEN_FILE, SITE, SITE_NAME } from './fixtures.js';

/**
 * Brings the site the browser lane navigates to a state where a browser has something to look at.
 *
 * The same stages `tests/e2e/README.md` documents for the HTTP lane -- migrate, first run, warm --
 * plus one the HTTP lane never needed: visitor registration, without which `/user/register` is an
 * access-denied page rather than a form.
 */

/** how long a caller waits out a supervised restart; measured at 15-25 s for `wrangler dev` */
const RESTART_WAIT_S = 60;

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
 *
 * THREE TRIES A SECOND APART CANNOT OUTLAST A RESTART. A Durable Object reset exits `wrangler dev`,
 * and the supervisor in `playwright.config.ts` brings it back in 15-25 s -- so a setup that gave up
 * after 3 s reported `fetch failed` and took the lane with it, on a dependency bump that touched
 * nothing.
 */
export async function callJson<T>(path: string, init?: RequestInit, tries = 3): Promise<T> {
	let last = '';
	// UNREACHABLE AND ANSWERING-BADLY ARE DIFFERENT WAITS. A connection refused means the supervisor
	// is rebuilding the worker and the only useful thing to do is wait it out; a reply that is not
	// JSON is a decision the worker made and repeating it 45 times just spends the deadline
	let unreachable = 0;
	for (let i = 0; i < tries + unreachable; i++) {
		if (i > 0) await new Promise((r) => setTimeout(r, 1000));
		let text: string;
		try {
			text = await (await call(path, init)).text();
		} catch (e) {
			last = String(e);
			if (unreachable < RESTART_WAIT_S) unreachable++;
			continue;
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			last = `not JSON: ${text.slice(0, 200)}`;
		}
	}
	throw new Error(`${path} failed after ${tries + unreachable} tries: ${last}`);
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
	const reply = await callJson<{ ok: boolean; error?: string; ownerToken?: string }>(
		'/firstrun?force=1',
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				siteName: SITE_NAME,
				adminName: ADMIN_USER,
				adminMail: 'admin@example.invalid',
				adminPass: ADMIN_PASS,
				timezone: 'UTC'
			})
		}
	);
	if (!reply.ok) throw new Error(`firstrun refused: ${reply.error ?? JSON.stringify(reply)}`);
	// the credential the `/_cfw` surface takes, and the only run that ever shows it
	if (!reply.ownerToken) throw new Error('firstrun returned no owner token');
	writeFileSync(OWNER_TOKEN_FILE, reply.ownerToken, 'utf8');
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
 * The isolate's own accounting, printed around the renders that have killed the worker.
 *
 * A crossed 128 MiB isolate limit arrives here as a message-less `[ERROR]` from wrangler and then
 * `ERR_CONNECTION_REFUSED` on the NEXT navigation, which reads as a dead server rather than as
 * memory -- so the run that fails names nothing. `/serve-stats` already reports `isolateBytes` as
 * its parts, and `USE_ZEND_ALLOC=0` means demand inside one incarnation is the SUM, so the shape to
 * look for is a rise across consecutive authenticated renders rather than any single figure.
 *
 * Never throws: an instrument that can fail the lane it measures is worse than no instrument.
 */
async function reportIsolate(label: string): Promise<void> {
	try {
		const res = await fetch(`${BASE_URL}/serve-stats?site=${SITE}`, {
			signal: AbortSignal.timeout(10_000)
		});
		const body = (await res.json()) as {
			isolateBytes?: Record<string, number>;
			recycles?: number;
		};
		const b = body.isolateBytes ?? {};
		const mib = (n: number | undefined) => (n === undefined ? '?' : (n / 1048576).toFixed(2));
		console.log(
			`[isolate] ${label}: total ${mib(b['total'])} MiB of ${mib(b['ceiling'])} ` +
				`(linear ${mib(b['linear'])}, mount ${mib(b['mount'])}, resident ${mib(b['resident'])}), ` +
				`recycles ${body.recycles ?? '?'}`
		);
	} catch (e) {
		console.log(`[isolate] ${label}: unreadable (${e instanceof Error ? e.message : e})`);
	}
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
		await reportIsolate('before the login');
		await page.goto('/user/login');
		await page.locator('#edit-name').fill(ADMIN_USER);
		await page.locator('#edit-pass').fill(ADMIN_PASS);
		await Promise.all([
			page.waitForURL(/\/user\/1(\?|$)/),
			page.locator('#edit-submit').click()
		]);
		// the first authenticated render, which is where the documented rise starts
		await reportIsolate('after /user/1');

		await page.goto('/admin/config/people/accounts');
		await reportIsolate('after /admin/config/people/accounts');
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
