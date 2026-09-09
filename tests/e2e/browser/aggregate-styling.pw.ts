import type { Page } from '@playwright/test';
import { ADMIN_PASS, ADMIN_USER, expect, gotoPage, SITE, test } from './utils/fixtures.js';
import { callJson } from './utils/global-setup.js';

/**
 * Whether `ASSET_AGGREGATES=1` leaves the page DRESSED.
 *
 * The lever shipped as a no-op: `assets/.assetsignore` denies by default and never allowed `/agg/`,
 * so the substitution rewrote every asset tag to a URL the asset layer would not serve and the page
 * rendered with no CSS at all. A status check cannot see that, and neither can a `<link>` count.
 *
 * Two arms, because either one alone proves nothing. With the lever ON the page must name aggregates
 * AND be styled; with it OFF the same page must still be styled, which is what separates a broken
 * aggregate from a broken harness.
 *
 * The lever is read inside the Durable Object from `this.env`, and nothing writes the `settings` KV
 * key over HTTP, so it cannot be flipped per spec. `playwright.config.ts` starts a second worker for
 * the ON arm and this file provisions it.
 */

const AGG_BASE =
	process.env.CFW_BROWSER_AGG_URL ??
	`http://127.0.0.1:${process.env.CFW_BROWSER_AGG_PORT ?? Number(process.env.CFW_BROWSER_PORT ?? 8789) + 2}`;

/** every aggregate URL the rendered document names, read off the DOM rather than off the source */
async function aggregateUrls(page: Page): Promise<string[]> {
	const out: string[] = [];
	for (const link of await page.locator('link[rel="stylesheet"][href^="/agg/"]').all()) {
		out.push((await link.getAttribute('href')) ?? '');
	}
	for (const script of await page.locator('script[src^="/agg/"]').all()) {
		out.push((await script.getAttribute('src')) ?? '');
	}
	return out;
}

/**
 * Two computed values Olivero produces and a stylesheet-less page cannot.
 *
 * The font face is named in `css/base/variables.css` and applied in `css/base/base.css`, so reading
 * it back proves BOTH files reached the browser rather than just the first. The background is
 * `base.css` alone, and a user agent's default is `none`.
 */
async function expectStyledByOlivero(page: Page): Promise<void> {
	const font = await page
		.locator('html')
		.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).fontFamily);
	const background = await page
		.locator('body')
		.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).backgroundImage);
	expect(font.toLowerCase(), 'html font-family').toContain('metropolis');
	expect(background, 'body background-image').toContain('data:image/svg+xml');
}

/** the `/` row as the object holds it, which is where the substitution lands; '' while it warms */
async function storedFrontPage(): Promise<string> {
	const res = await fetch(`${AGG_BASE}/serve?site=${encodeURIComponent(SITE)}&path=%2F`).catch(
		() => null
	);
	return res !== null && res.ok ? res.text() : '';
}

/**
 * Brings the aggregating worker to a page a browser can look at.
 *
 * `/` arrives from `assets/prefill.json`, which is a page this object never rendered and therefore
 * carries no aggregate. The substitution runs in `fillOne()` at STORE time, so the row has to be
 * replaced by a real render before any of this means anything.
 *
 * The claim is not optional and `curl` hides that it is not: an unclaimed site answers a NAVIGATION
 * with the setup page, so the browser saw a form where the shell got Drupal. Its owner token is
 * dropped rather than written, because `OWNER_TOKEN_FILE` is keyed on the site name and the shared
 * worker uses the same one.
 */
async function provisionAggregateSite(): Promise<void> {
	for (let i = 0; i < 60; i++) {
		const reply = await callJson<{ ok: boolean; done: boolean | null }>(
			'/migrate?all=1',
			undefined,
			3,
			AGG_BASE
		);
		if (reply.done === true) break;
		if (reply.ok === false) throw new Error(`migration refused: ${JSON.stringify(reply)}`);
		if (i === 59) throw new Error('migration did not finish in 60 calls');
	}

	const claimed = await callJson<{ ok: boolean; error?: string }>(
		'/firstrun?force=1',
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				siteName: 'Aggregate Lane',
				adminName: ADMIN_USER,
				adminMail: 'admin@example.invalid',
				adminPass: ADMIN_PASS,
				timezone: 'UTC'
			})
		},
		3,
		AGG_BASE
	);
	if (!claimed.ok)
		throw new Error(`firstrun refused: ${claimed.error ?? JSON.stringify(claimed)}`);

	// ON THE STORED PAGE RATHER THAN ON WHAT A FILL REPORTS: firstrun leaves several paths queued, so
	// one drive renders whichever is at the head, and an alarm that fires first empties the queue
	// before the drive sees it. Both read as a failure against the reply and neither is one
	await callJson('/fill?path=/', undefined, 3, AGG_BASE);
	for (let i = 0; i < 20; i++) {
		if ((await storedFrontPage()).includes('/agg/')) return;
		await callJson('/fill', undefined, 3, AGG_BASE);
	}
	throw new Error('/ never stored an aggregate; ASSET_AGGREGATES did nothing on this worker');
}

test.beforeAll(async () => {
	test.setTimeout(600_000);
	await provisionAggregateSite();
});

test('the aggregated page names aggregates, serves them, and is styled', async ({ page }) => {
	// the aggregates pull fonts and icons of their own, and a relative `url()` inside one resolves
	// against /agg/ rather than against the directory it was written in. That was 270 broken targets
	// across 408 aggregates until `pack-aggregates.ts` rebased them
	const failed: string[] = [];
	page.on('response', (res) => {
		if (res.status() >= 400) failed.push(`${res.status()} ${new URL(res.url()).pathname}`);
	});

	const res = await page.goto(`${AGG_BASE}/`, { waitUntil: 'load' });
	expect(res?.status(), 'the aggregating worker did not serve /').toBe(200);
	// an unclaimed site answers a navigation with the setup form, which names no asset at all
	await expect(page.locator('body')).toHaveClass(/path-frontpage/);

	const urls = await aggregateUrls(page);
	expect(
		urls.length,
		'the page names no aggregate, so the lever changed nothing'
	).toBeGreaterThan(0);
	// the substitution replaces a library's whole run, so a source file it claimed must be gone
	expect(await page.content()).not.toContain('/core/themes/olivero/css/base/base.css');

	for (const url of urls) {
		const asset = await page.request.get(`${AGG_BASE}${url}`);
		expect(asset.status(), url).toBe(200);
		expect((await asset.body()).length, url).toBeGreaterThan(0);
	}

	await expectStyledByOlivero(page);
	expect(failed, 'requests the aggregated page could not load').toEqual([]);
});

test('the same page is styled with the lever off, which is the control', async ({ page }) => {
	await gotoPage(page, '/');
	expect(await aggregateUrls(page), 'the shared worker aggregates nothing').toEqual([]);
	await expectStyledByOlivero(page);
});
