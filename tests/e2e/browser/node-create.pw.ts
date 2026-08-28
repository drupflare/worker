import { expect, gotoPage, loginAsAdmin, test } from './utils/fixtures.js';

test('an admin creates a node and the saved node renders', async ({ page }) => {
	const title = `Browser Lane Node ${Date.now().toString(36)}`;
	const body = `written by the browser lane at ${new Date().toISOString()}`;

	await loginAsAdmin(page);
	await gotoPage(page, '/node/add/page');

	await expect(page.locator('form#node-page-form')).toBeVisible();
	await page.locator('#edit-title-0-value').fill(title);

	// ckeditor5 replaces the textarea with a contenteditable, so the textarea itself is never filled
	const editor = page.locator('.ck-editor__editable');
	await expect(editor).toBeVisible();
	await editor.fill(body);

	await Promise.all([
		page.waitForURL(/\/node\/\d+(\?|$)/),
		page.getByRole('button', { name: 'Save' }).click()
	]);

	await expect(page.locator('[data-drupal-messages]')).toContainText(title);
	await expect(page.locator('h1.page-title')).toHaveText(title);
	await expect(page.locator('.node__content')).toContainText(body);
});
