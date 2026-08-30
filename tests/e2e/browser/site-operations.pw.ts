import { expect, gotoPage, loginAsAdmin, test } from './utils/fixtures.js';

// unique per run: a vocabulary and a user account are both created once and refused the second
// time, so fixed names make a re-run against a warm state directory fail for the wrong reason
const RUN = Date.now().toString(36);

/**
 * The rest of a site owner's first week: taxonomy, a second user, and the content list's own tools.
 *
 * Each one crosses a write path the lane did not have. A vocabulary is a config entity and a term is
 * a content entity in a different storage; creating a user runs the password hasher and the mail
 * system; the exposed filter is a GET-driven view rebuild; the bulk-operations form is a POST that
 * loads entities by id and saves them, which is the only place the lane exercises `entity_load` on a
 * set rather than a single node.
 */

test('an admin creates a vocabulary and a term in it', async ({ page }) => {
	await loginAsAdmin(page);

	await gotoPage(page, '/admin/structure/taxonomy/add');
	await page.locator('#edit-name').fill(`Lane Topics ${RUN}`);
	await expect(page.locator('.machine-name-value')).toHaveText(`lane_topics_${RUN}`, {
		timeout: 60_000
	});
	await page.getByRole('button', { name: 'Save' }).first().click();
	await page.waitForLoadState('load');

	await gotoPage(page, `/admin/structure/taxonomy/manage/lane_topics_${RUN}/add`);
	await page.locator('#edit-name-0-value').fill(`Edge Rendering ${RUN}`);
	await page.getByRole('button', { name: 'Save' }).first().click();
	await page.waitForLoadState('load');

	await gotoPage(page, `/admin/structure/taxonomy/manage/lane_topics_${RUN}/overview`);
	await expect(page.getByText(`Edge Rendering ${RUN}`)).toBeVisible();
});

test('an admin creates a user and the account appears in the people list', async ({ page }) => {
	await loginAsAdmin(page);

	await gotoPage(page, '/admin/people/create');
	await page.locator('#edit-name').fill(`lane-editor-${RUN}`);
	await page.locator('#edit-mail').fill(`lane-editor-${RUN}@example.invalid`);
	// both halves, or the form re-renders with a mismatch error and saves nothing
	await page.locator('#edit-pass-pass1').fill('lane-editor-pw-1');
	await page.locator('#edit-pass-pass2').fill('lane-editor-pw-1');
	await page.getByRole('button', { name: 'Create new account' }).click();
	await page.waitForLoadState('load');

	await gotoPage(page, '/admin/people');
	// exact, because the row also carries an "Edit lane-editor" operation link
	await expect(page.getByRole('link', { name: `lane-editor-${RUN}`, exact: true })).toBeVisible();
});

test('the content list filters, which rebuilds the view from a GET', async ({ page }) => {
	await loginAsAdmin(page);
	await gotoPage(page, '/admin/content');

	await page.locator('#edit-title').fill('Browser Pass');
	await page.getByRole('button', { name: 'Filter' }).click();
	await page.waitForLoadState('load');

	// the filter is in the URL, which is what makes the result linkable and the view cacheable
	expect(page.url()).toContain('title=Browser+Pass');
	await expect(page.locator('table')).toBeVisible();
});

test('an admin unpublishes a node through the bulk-operations form', async ({ page }) => {
	await loginAsAdmin(page);

	// a node of our own, so the assertion does not depend on what another spec left behind
	await gotoPage(page, '/node/add/page');
	await page.locator('#edit-title-0-value').fill(`Bulk Operation Target ${RUN}`);
	await page.getByRole('button', { name: 'Save' }).first().click();
	await page.waitForLoadState('load');

	await gotoPage(page, `/admin/content?title=Bulk+Operation+Target+${RUN}`);
	const row = page.locator('tbody tr', { hasText: `Bulk Operation Target ${RUN}` }).first();
	await row.locator('input[type="checkbox"]').check();
	await page.locator('#edit-action').selectOption('node_unpublish_action');
	await page.getByRole('button', { name: 'Apply to selected items' }).click();
	await page.waitForLoadState('load');

	await gotoPage(page, `/admin/content?title=Bulk+Operation+Target+${RUN}`);
	await expect(
		page.locator('tbody tr', { hasText: `Bulk Operation Target ${RUN}` }).first()
	).toContainText('Unpublished');
});
