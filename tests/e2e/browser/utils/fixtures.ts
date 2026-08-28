import { test as base, expect, type Page, type Response } from '@playwright/test';

/**
 * The browser lane's shared fixtures.
 *
 * The console guard is the whole reason this lane exists: `/user/register` and `/user/1/edit` were a
 * white screen on every site ever created and the HTTP lane read both as 200. It is an `auto`
 * fixture so a spec cannot forget it.
 */

/** the site name `SITE_ID` pins for a local host; the diagnostic routes take it as `?site=` */
export const SITE = process.env.CFW_BROWSER_SITE ?? 'browser';

export const BASE_URL =
	process.env.CFW_BROWSER_URL ?? `http://127.0.0.1:${process.env.CFW_BROWSER_PORT ?? 8789}`;

/** uid 1, as `global-setup.ts` configures it; the pack ships an empty hash and no way in */
export const ADMIN_USER = 'admin';
export const ADMIN_PASS = 'browser-lane-pw';

/** what firstrun renames the site to, which is how a spec tells a real render from the packed one */
export const SITE_NAME = 'Browser Lane';

/**
 * Everything the browser reported as an error, in order.
 *
 * There is no allow-list and adding one needs a measurement: the six pages here were observed clean
 * apart from a `warning` about an unused font preload, which this never collected.
 */
function collectConsoleErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return;
		errors.push(`console.error: ${msg.text()}`);
	});
	page.on('pageerror', (err) => {
		errors.push(`pageerror: ${err.message}`);
	});
	return errors;
}

export const test = base.extend<{ consoleGuard: void }>({
	consoleGuard: [
		async ({ page }, use) => {
			const errors = collectConsoleErrors(page);
			await use();
			expect(errors, `browser console reported ${errors.length} error(s)`).toEqual([]);
		},
		{ auto: true }
	]
});

export { expect };

/**
 * Waits out the fill queue OUTSIDE the browser.
 *
 * A cold anonymous page answers 503 with `Retry-After` while the queue renders it, which is the
 * designed answer rather than a fault. Retrying the navigation would work too, but chromium logs
 * every discarded attempt as a console error and the guard cannot tell that from a real one -- so
 * the waiting happens over `fetch` and the browser sees one request.
 *
 * A 4xx ends the wait: an authenticated-only path answers 403 to this anonymous probe and renders
 * inline for the session that follows.
 */
async function drainFillQueue(path: string, deadlineMs: number): Promise<void> {
	const until = Date.now() + deadlineMs;
	for (;;) {
		const res = await fetch(`${BASE_URL}${path}`, { redirect: 'manual' }).catch(() => null);
		if (res === null || res.status < 500 || Date.now() >= until) return;
		await new Promise((r) => setTimeout(r, 1000));
	}
}

/** navigates to a path that is warm, and fails with the status when it is not */
export async function gotoPage(page: Page, path: string, deadlineMs = 120_000): Promise<Response> {
	await drainFillQueue(path, deadlineMs);
	const res = await page.goto(path, { waitUntil: 'load' });
	if (res === null) throw new Error(`no response for ${path}`);
	expect(res.status(), `${path} answered ${res.status()}`).toBeLessThan(400);
	return res;
}

/** the user-account-menu one; the admin toolbar renders a second link with the same name */
export function logoutLink(page: Page) {
	return page.getByLabel('User account menu').getByRole('link', { name: 'Log out' });
}

/** logs uid 1 in through Drupal's own form, which is the only way a session cookie is minted */
export async function loginAsAdmin(page: Page): Promise<void> {
	await gotoPage(page, '/user/login');
	await page.locator('#edit-name').fill(ADMIN_USER);
	await page.locator('#edit-pass').fill(ADMIN_PASS);
	await Promise.all([page.waitForURL(/\/user\/1(\?|$)/), page.locator('#edit-submit').click()]);
}
