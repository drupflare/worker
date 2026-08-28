import { ADMIN_PASS, ADMIN_USER, expect, gotoPage, logoutLink, test } from './utils/fixtures.js';

test('the login form renders and logs uid 1 in', async ({ page }) => {
	await gotoPage(page, '/user/login');

	await expect(page.locator('form#user-login-form')).toBeVisible();
	await expect(page.locator('#edit-name')).toBeVisible();
	await expect(page.locator('#edit-pass')).toBeVisible();

	await page.locator('#edit-name').fill(ADMIN_USER);
	await page.locator('#edit-pass').fill(ADMIN_PASS);
	await Promise.all([page.waitForURL(/\/user\/1(\?|$)/), page.locator('#edit-submit').click()]);

	// the class Drupal puts on an authenticated render, and the link only a session can produce
	await expect(page.locator('body')).toHaveClass(/user-logged-in/);
	await expect(logoutLink(page)).toBeVisible();
	await expect(page.locator('h1.page-title')).toHaveText(ADMIN_USER);
});
