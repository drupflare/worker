import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import {
	WP_ADMIN_PASS,
	WP_ADMIN_USER,
	WP_ORIGIN,
	WP_OWNER_FILE,
	WP_SESSION_FILE,
	WP_SITE_NAME
} from '../utils/wordpress';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** polls until the worker answers the path with the status, because `wrangler dev` takes a while to bind */
async function waitFor(path: string, status: number, deadlineMs: number): Promise<void> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const res = await fetch(`${WP_ORIGIN}${path}`, { redirect: 'manual' }).catch(() => null);
		if (res?.status === status) return;
		if (Date.now() >= until) throw new Error(`${path} never answered ${status}`);
		await sleep(1500);
	}
}

/** claims the site and keeps the owner token; a second claim answers 409, which means an earlier run already did */
async function claim(): Promise<void> {
	const res = await fetch(`${WP_ORIGIN}/firstrun`, {
		method: 'POST',
		signal: AbortSignal.timeout(180_000),
		body: JSON.stringify({
			adminName: WP_ADMIN_USER,
			adminMail: 'owner@example.test',
			adminPass: WP_ADMIN_PASS,
			siteName: WP_SITE_NAME
		})
	});
	if (res.status !== 200 && res.status !== 409) {
		throw new Error(`claim answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
	if (res.status === 200) {
		const { ownerToken } = (await res.json()) as { ownerToken?: string };
		if (ownerToken)
			writeFileSync(WP_OWNER_FILE, JSON.stringify({ ownerToken }), { mode: 0o600 });
	}
}

/** a cold anonymous page can answer 503 while the fill queue renders it */
async function warm(path: string, deadlineMs = 180_000): Promise<void> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const res = await fetch(`${WP_ORIGIN}${path}`, { redirect: 'manual' });
		if (res.status < 500) return;
		if (Date.now() >= until) throw new Error(`${path} never left 5xx`);
		await sleep(1500);
	}
}

/** signs in through the login form and keeps the session for the specs that need one */
async function saveSession(): Promise<void> {
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({ baseURL: WP_ORIGIN });
		const page = await context.newPage();
		await page.goto('/wp-login.php');
		await page.locator('#user_login').fill(WP_ADMIN_USER);
		await page.locator('#user_pass').fill(WP_ADMIN_PASS);
		await Promise.all([
			page.waitForURL(/\/wp-admin\//, { timeout: 150_000, waitUntil: 'commit' }),
			page.locator('#wp-submit').click()
		]);
		await context.storageState({ path: WP_SESSION_FILE });
	} finally {
		await browser.close();
	}
}

export default async function globalSetup(): Promise<void> {
	console.log(`[wordpress browser] provisioning ${WP_ORIGIN}`);
	await waitFor('/wp-login.php', 200, 300_000);
	await claim();
	for (const path of ['/', '/2026/01/01/hello-world/', '/wp-login.php']) await warm(path);
	await saveSession();
	console.log('[wordpress browser] ready');
}
