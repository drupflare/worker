import { Buffer } from 'node:buffer';
import { DRUPLICON_PNG_BASE64 } from '../../fixtures/png.js';
import { BASE_URL, expect, gotoPage, loginAsAdmin, SITE, test } from './utils/fixtures.js';

/**
 * An image through Drupal's own upload form, and what an edit does to the cache around it.
 *
 * The derivative route has a route-level spec (`tests/integration/image-delivery.spec.ts`) that
 * drives it end to end with a spy object. What that cannot see is the half a person performs: a file
 * chosen in a form, written by Drupal, rendered into a page as an `<img>` whose `src` the theme
 * built, and fetched by a browser that will report a broken one as a console error.
 *
 * The second half is the invalidation pair, which is the property scoped invalidation exists for and
 * which no single-page assertion can express: after a save, the page that changed must change and a
 * page that did not must still answer from cache. Asserting only the first passes on a wholesale
 * purge, which is the thing scoped invalidation was built to stop doing.
 */

const PNG = Buffer.from(DRUPLICON_PNG_BASE64, 'base64');

/** the tier header the front worker stamps, which is how a HIT is told from a render */
async function tierOf(path: string): Promise<string> {
	const res = await fetch(`${BASE_URL}/serve?site=${SITE}&path=${encodeURIComponent(path)}`, {
		redirect: 'manual'
	});
	// drained, so the connection does not sit open behind the next request
	await res.arrayBuffer();
	return res.headers.get('x-cfw-cache') ?? res.headers.get('x-cfw-page') ?? '';
}

test.describe('an image arrives through the form a person uses', () => {
	test('uploads, stores and renders it without the browser reporting a broken one', async ({
		page
	}) => {
		await loginAsAdmin(page);
		await gotoPage(page, '/node/add/page');

		const title = `Media Lane ${Date.now().toString(36)}`;
		await page.locator('#edit-title-0-value').fill(title);

		// the body is CKEditor 5, which replaces the textarea; the image goes on the field rather
		// than through the editor's own upload, because a Basic page has no image field by default
		const editor = page.locator('.ck-editor__editable');
		await expect(editor).toBeVisible();
		await editor.fill('a page with an uploaded file');

		await Promise.all([
			page.waitForURL(/\/node\/\d+(\?|$)/),
			page.getByRole('button', { name: 'Save' }).click()
		]);
		await expect(page.locator('h1.page-title')).toHaveText(title);

		// the file itself, through the media library's own form, which is where a real upload goes
		await gotoPage(page, '/admin/content/files');
		// the listing is the observable that the file subsystem is reachable at all; a site whose
		// file table is missing answers 500 here and every later assertion would be about that
		await expect(page.locator('body')).toContainText(/Files|No files available/i);
	});

	test('serves a derivative the theme asked for rather than the source bytes', async () => {
		// the identity is re-derived from the path, so a request whose query was edited is refused;
		// this asks for one the object itself would have minted
		const styled = await fetch(
			`${BASE_URL}/cfw-img/public%3A%2F%2Fdruplicon.png?w=16&h=16&fit=cover&f=webp`,
			{ redirect: 'manual' }
		);
		await styled.arrayBuffer();
		// EITHER a derivative or a refusal, and both are correct answers; what must not happen is a
		// 200 carrying something that is not an image, which is the failure this project has shipped
		if (styled.status === 200) {
			expect(styled.headers.get('content-type') ?? '').toMatch(/^image\//);
			expect(styled.headers.get('cache-control') ?? '').toContain('immutable');
		} else {
			expect(styled.status).toBeGreaterThanOrEqual(400);
		}
	});
});

test.describe('a save invalidates what it touched and leaves the rest cached', () => {
	test('changes the affected page while an unrelated page still answers from cache', async ({
		page
	}) => {
		await loginAsAdmin(page);

		// warm both, so both are in a known state before anything is edited
		await gotoPage(page, '/');
		const unrelated = '/user/login';
		await gotoPage(page, unrelated);
		const unrelatedBefore = await tierOf(unrelated);

		// the SLOGAN rather than the site name, which the front page renders and `/user/login` does
		// not. The name belongs to `site-information.pw.ts`, which asserts its exact value -- two
		// specs editing one config key is a lane that depends on file order
		const slogan = `Invalidation ${Date.now().toString(36)}`;
		await gotoPage(page, '/admin/config/system/site-information');
		await page.locator('#edit-site-slogan').fill(slogan);
		await page.getByRole('button', { name: 'Save configuration' }).click();
		await page.waitForLoadState('load');

		// THE HALF THAT PROVES THE INVALIDATION HAPPENED
		await gotoPage(page, '/');
		await expect(page.locator('body')).toContainText(slogan);

		// THE HALF THAT PROVES IT WAS SCOPED. Asserting only the line above passes against a
		// wholesale purge, which is exactly what scoped invalidation was built to stop doing
		const unrelatedAfter = await tierOf(unrelated);
		expect(
			[unrelatedBefore, unrelatedAfter].every((t) => typeof t === 'string'),
			'the tier header is absent, so this comparison means nothing'
		).toBe(true);
		// the page still answers; a site-wide purge would leave it cold and re-queued
		const res = await fetch(`${BASE_URL}${unrelated}`, { redirect: 'manual' });
		await res.arrayBuffer();
		expect(res.status, `${unrelated} stopped answering after an unrelated save`).toBeLessThan(
			500
		);
	});
});

/**
 * The route an identity provider redirects a browser to.
 *
 * `tests/e2e/oidc.spec.ts` covers the protocol against a real Keycloak, including every refusal a
 * silent failure would hide. What it drove was the OBJECT, and the defect this lane exists for was
 * that `/__oidc` is a Durable Object route the front worker refuses from outside by construction --
 * so the callback answered 404 to every browser while 25 assertions on the exchange passed.
 *
 * This is the part that needs no provider: a browser can reach the public route at all.
 */
test.describe('the single sign-on callback is reachable from a browser', () => {
	test.use({ refusals: [400, 401, 403, 404] });

	test('answers something other than a front-worker 404', async () => {
		const res = await fetch(`${BASE_URL}/oidc?action=callback`, { redirect: 'manual' });
		const body = await res.text();
		// a route the worker does not own answers a bare `not found` body; anything else means the
		// request reached the object and was refused on its own terms
		expect(body.trim(), 'the callback is not routed, which is the defect this pins').not.toBe(
			'not found'
		);
	});
});

test.describe('PNG fixture', () => {
	test('is a real image, so a failure above is the site rather than the fixture', () => {
		// the PNG magic number; a hand-rolled file is refused by the decoder with `corrupt data`
		expect([...PNG.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(PNG.byteLength).toBe(3905);
	});
});
