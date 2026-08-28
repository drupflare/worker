import { expect, gotoPage, loginAsAdmin, SITE_NAME, test } from './utils/fixtures.js';

/**
 * A config form, saved through the UI rather than through `/sql`.
 *
 * The name is put back before the spec ends, so nothing else in the lane depends on the order files
 * happen to run in.
 */
test('an admin saves a config form and the new value takes', async ({ page }) => {
	const renamed = `${SITE_NAME} Renamed`;

	await loginAsAdmin(page);
	await gotoPage(page, '/admin/config/system/site-information');

	await expect(page.locator('form#system-site-information-settings')).toBeVisible();
	const name = page.locator('#edit-site-name');
	await expect(name).toHaveValue(SITE_NAME);

	await name.fill(renamed);
	await page.getByRole('button', { name: 'Save configuration' }).click();

	await expect(page.locator('[data-drupal-messages]')).toContainText(
		'The configuration options have been saved'
	);
	await expect(page.locator('#edit-site-name')).toHaveValue(renamed);
	// the config write reached a render, not just the form it was typed into
	await expect(page).toHaveTitle(new RegExp(`\\| ${renamed}$`));

	await page.locator('#edit-site-name').fill(SITE_NAME);
	await page.getByRole('button', { name: 'Save configuration' }).click();
	await expect(page.locator('#edit-site-name')).toHaveValue(SITE_NAME);
	await expect(page).toHaveTitle(new RegExp(`\\| ${SITE_NAME}$`));
});
