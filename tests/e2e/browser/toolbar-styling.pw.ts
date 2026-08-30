import { expect, gotoPage, loginAsAdmin, test } from './utils/fixtures.js';

/**
 * Whether the admin toolbar arrived DRESSED, which no other lane can see.
 *
 * Every check this repository had would pass on the defect this was written for. The page answered
 * 200, the console was clean, the markup carried every class, and the toolbar rendered as blue
 * underlined links and `2px outset` grey buttons -- because the pack strips `.css` as "a static
 * asset PHP never opens", and `ComponentPluginManager::findAsset()` resolves a single-directory
 * component's stylesheet with `file_exists()`. Every SDC therefore shipped a generated library with
 * no CSS in it, while the asset layer served the file correctly to anyone who asked. Nothing asked.
 *
 * Three assertions, in the order they narrow:
 *
 *   1. no stylesheet 404s -- the cheap, general net;
 *   2. the component stylesheet is reachable -- the asset layer's half;
 *   3. a toolbar button is not user-agent chrome -- what a person would have noticed.
 *
 * (3) is the one that catches the defect, and it asserts a property that cannot be true by
 * accident: `admin-reset-styles.css` does `all: revert` inside `[data-drupal-admin-styles]`, so an
 * undressed button reverts to the UA button appearance -- `2px outset`, `cursor: default`, square
 * corners. A dressed one has `border: 0`, `cursor: pointer` and a radius, all from `.toolbar-button`
 * in the component stylesheet and from nowhere else.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED is that the stylesheet arrives as its own `<link>`. It does on
 * a site with aggregation off and an inline-rendered toolbar, and does not when BigPipe
 * placeholders it -- so that assertion fails on a correctly styled page, which makes it worse than
 * no assertion.
 */

/** what SDC generates a library for, and what the pack has to carry beside the manifest */
const COMPONENT_CSS = '/core/modules/navigation/components/toolbar-button/toolbar-button.css';

test('the admin toolbar is styled, not just present', async ({ page }) => {
	const broken: string[] = [];
	page.on('response', (res) => {
		const url = new URL(res.url());
		if (!/\.css($|\?)/.test(url.pathname)) return;
		if (res.status() >= 400) broken.push(`${res.status()} ${url.pathname}`);
	});

	await loginAsAdmin(page);
	await gotoPage(page, '/admin/content');

	expect(broken, 'stylesheets that did not load').toEqual([]);

	// the asset layer's half: the file has to be REACHABLE, or no amount of correct library
	// building would help. Asserted by fetching it rather than by looking for a <link>, because
	// whether it arrives as its own element depends on aggregation and on whether BigPipe
	// placeholdered the toolbar -- neither of which is the property under test
	const asset = await page.request.get(COMPONENT_CSS);
	expect(asset.status(), COMPONENT_CSS).toBe(200);
	expect((await asset.text()).length).toBeGreaterThan(0);

	// the element the whole toolbar is built from; every menu entry and every popover trigger is one
	const button = page.locator('.toolbar-button').first();
	await expect(button).toBeAttached();
	const appearance = await button.evaluate((el) => {
		const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
		return { border: cs.borderTopWidth, cursor: cs.cursor, radius: cs.borderTopLeftRadius };
	});
	// UA buttons are `2px outset`; `.toolbar-button` sets `border: 0` and a radius
	expect(appearance.border).toBe('0px');
	expect(appearance.cursor).toBe('pointer');
	expect(appearance.radius).not.toBe('0px');
});

test('every stylesheet the front page asks for resolves', async ({ page }) => {
	// the anonymous half of the same net: olivero ships an SDC too (`components/teaser`), and a
	// visitor never loads the admin toolbar
	const broken: string[] = [];
	page.on('response', (res) => {
		const url = new URL(res.url());
		if (!/\.(css|js)($|\?)/.test(url.pathname)) return;
		if (res.status() >= 400) broken.push(`${res.status()} ${url.pathname}`);
	});

	await gotoPage(page, '/');
	expect(broken, 'assets that did not load').toEqual([]);
});
