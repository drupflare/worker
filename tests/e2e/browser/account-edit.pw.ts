import { ADMIN_USER, expect, gotoPage, loginAsAdmin, test } from './utils/fixtures.js';

/** the second form that was a white screen; same entity form class as `/user/register` */
test('the account form renders for uid 1', async ({ page }) => {
	await loginAsAdmin(page);
	await gotoPage(page, '/user/1/edit');

	await expect(page.locator('form#user-form')).toBeVisible();
	await expect(page.locator('input#edit-name')).toHaveValue(ADMIN_USER);
	await expect(page.locator('input#edit-mail')).toHaveValue('admin@example.invalid');
	await expect(page.locator('input#edit-current-pass')).toBeVisible();
	await expect(page.locator('input#edit-pass-pass1')).toBeVisible();
	// the role checkboxes come from a second entity query, so their absence is its own failure
	await expect(page.locator('#edit-roles-administrator')).toBeChecked();
});
