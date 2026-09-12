import type { Page } from '@playwright/test';
import { BASE_URL, expect, gotoPage, SITE, test } from './utils/fixtures.js';
import { callJson } from './utils/global-setup.js';

/**
 * Whether `ASSET_AGGREGATES=1` leaves the page DRESSED.
 *
 * The lever shipped as a no-op: `assets/.assetsignore` denies by default and never allowed `/agg/`,
 * so the substitution rewrote every asset tag to a URL the asset layer would not serve and the page
 * rendered with no CSS at all. A status check cannot see that, and neither can a `<link>` count.
 *
 * Two arms, because either one alone proves nothing. The page must name aggregates AND be styled;
 * the same page with the aggregates stubbed empty must then be UNSTYLED, which is what separates a
 * working aggregate from an assertion that cannot fail.
 *
 * THE CONTROL USED TO BE A SECOND WORKER AND IT WAS ASSERTING NOTHING. `wrangler.jsonc` carries
 * `ASSET_AGGREGATES: "1"`, which landed after this file, so the "lever off" server had the lever on
 * and the arm passed only while the shared site's `/` row still came from `assets/prefill.json`.
 * Provisioning a second `wrangler dev` also put two interpreters and a browser on one CI runner,
 * which is where the lane died: a message-less `[ERROR]` after the second worker's `/firstrun`, then
 * `fetch failed` on every later call to it.
 */

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
async function oliveroComputed(page: Page): Promise<{ font: string; background: string }> {
	const font = await page
		.locator('html')
		.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).fontFamily);
	const background = await page
		.locator('body')
		.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).backgroundImage);
	return { font: font.toLowerCase(), background };
}

/**
 * Whether the `/` ROW carries the substitution, read out of the table rather than over HTTP.
 *
 * A `/serve?path=/` reply cannot answer this. The front worker puts it in `caches.default` for
 * 300 s, so the first call -- which on a cold site is the pre-aggregate render -- is what every
 * later call reads back, and a loop waiting for the row to change never sees it change. That cost a
 * session: `lastAggregation` reported 13 libraries and 63 tags removed while the probe read the
 * edge's copy and concluded the lever was dead.
 */
async function frontPageRowHasAggregates(): Promise<boolean> {
	const q = "SELECT instr(CAST(html AS TEXT),'/agg/') AS agg FROM cfw_page WHERE path='/'";
	const res = await callJson<{ ok: boolean; rows: { agg: number }[] }>(
		`/sql?q=${encodeURIComponent(q)}`
	);
	return Number(res.rows?.[0]?.agg ?? 0) > 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A generation nothing has cached a page under, which is what makes the NEXT serve a real render.
 *
 * THREE TIERS CAN ANSWER `/serve` AND TWO OF THEM NEVER REACH THE OBJECT. `pageKey()` is origin,
 * site, GENERATION and path -- no query string -- so a cache-busting parameter changes nothing and
 * a `/serve` loop reads the front worker's in-isolate memo forever: measured, forty consecutive
 * calls answering `x-cfw-cache: MEM` while `cfw_page` held no `/` row at all. A bump moves the
 * generation, and `site.ts` re-reads it once its 5 s `genMemo` window closes.
 */
async function freshGeneration(): Promise<void> {
	await callJson('/bump?reason=aggregate-lane');
	await sleep(6000);
}

/**
 * `/` has to be a page this object RENDERED, not the one it was seeded with.
 *
 * The substitution runs in `fillOne()` at store time and `assets/prefill.json` is baked without it,
 * so a site whose front page is still the seeded row names the individual files however the lever is
 * set. The serve is what renders it: a MISS goes through the same `fillOne()` and stores. The queue
 * cannot be used for this -- a drain takes the head, and every spec before this one saves
 * configuration and re-queues its own paths.
 *
 * The closing bump is not tidiness. It leaves the browser a generation under which no pre-aggregate
 * copy of `/` exists in either tier above the object.
 */
async function frontPageCarriesAggregates(): Promise<void> {
	let last = 'never served';
	for (let i = 0; i < 8; i++) {
		if (await frontPageRowHasAggregates()) {
			await freshGeneration();
			return;
		}
		await freshGeneration();
		const res = await fetch(`${BASE_URL}/serve?site=${SITE}&path=%2F`, {
			signal: AbortSignal.timeout(180_000)
		}).catch(() => null);
		last =
			res === null
				? 'fetch failed'
				: `${res.status} ${res.headers.get('x-cfw-cache')} ${res.headers.get('cache-control')}`;
		if (res !== null && res.status >= 500) await sleep(1500);
	}
	const stats = await callJson<{ lastAggregation: unknown }>('/serve-stats');
	const dump = async (q: string) =>
		JSON.stringify(await callJson<unknown>(`/sql?q=${encodeURIComponent(q)}`)).slice(0, 400);
	throw new Error(
		`/ never stored an aggregate; last serve ${last}, ` +
			`lastAggregation ${JSON.stringify(stats.lastAggregation)}, ` +
			`pages ${await dump('SELECT path, status FROM cfw_page ORDER BY path')}`
	);
}

test.beforeAll(async () => {
	test.setTimeout(600_000);
	await frontPageCarriesAggregates();
});

test('the aggregated page names aggregates, serves them, and is styled', async ({ page }) => {
	// the aggregates pull fonts and icons of their own, and a relative `url()` inside one resolves
	// against /agg/ rather than against the directory it was written in. That was 270 broken targets
	// across 408 aggregates until `pack-aggregates.ts` rebased them
	const failed: string[] = [];
	page.on('response', (res) => {
		if (res.status() >= 400) failed.push(`${res.status()} ${new URL(res.url()).pathname}`);
	});

	await gotoPage(page, '/');
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
		const asset = await page.request.get(url);
		expect(asset.status(), url).toBe(200);
		expect((await asset.body()).length, url).toBeGreaterThan(0);
	}

	const { font, background } = await oliveroComputed(page);
	expect(font, 'html font-family').toContain('metropolis');
	expect(background, 'body background-image').toContain('data:image/svg+xml');
	expect(failed, 'requests the aggregated page could not load').toEqual([]);
});

test('the same page is undressed when the aggregates arrive empty, which is the control', async ({
	page
}) => {
	// fulfilled rather than aborted: an aborted subresource is a console error, and the fixture fails
	// a spec on one. An empty 200 is the same absence of CSS without the noise
	await page.route('**/agg/*.css', (route) =>
		route.fulfill({ status: 200, contentType: 'text/css', body: '' })
	);
	await gotoPage(page, '/');
	await expect(page.locator('body')).toHaveClass(/path-frontpage/);

	const { font, background } = await oliveroComputed(page);
	expect(font, 'html font-family with no stylesheet').not.toContain('metropolis');
	expect(background, 'body background-image with no stylesheet').toBe('none');
});
