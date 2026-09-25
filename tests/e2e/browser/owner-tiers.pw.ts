import { expect, gotoPage, loginAsAdmin, test } from './utils/fixtures.js';

/**
 * The lowest of the three drupflare tiers, as a person holding only it sees the admin pages.
 *
 * A 403 that renders as a 200 with an empty page is what a status-code check alone would miss, so
 * the permitted page is read for its content and each refused one for Drupal's own denial.
 */

test.use({ refusals: [403] });

test('a status viewer reads the meters and is refused everything else', async ({ page }) => {
	const name = `viewer${Date.now()}`;
	const pass = 'cfw-Viewer-5521-pass';

	await loginAsAdmin(page);
	await gotoPage(page, '/admin/people/permissions/module/drupflare');
	await page.locator('input[name="content_editor[view drupflare status]"]').check();
	await page.locator('input[name="content_editor[administer drupflare site]"]').uncheck();
	await page.getByRole('button', { name: 'Save permissions' }).click();
	await expect(page.getByText('The changes have been saved.')).toBeVisible();

	await gotoPage(page, '/admin/people/create');
	await page.locator('#edit-mail').fill(`${name}@example.invalid`);
	await page.locator('#edit-name').fill(name);
	await page.locator('#edit-pass-pass1').fill(pass);
	await page.locator('#edit-pass-pass2').fill(pass);
	await page.locator('input[name="roles[content_editor]"]').check();
	await page.getByRole('button', { name: 'Create new account' }).click();
	await expect(page.getByText('Created a new user account')).toBeVisible();

	// the admin theme carries no account menu, so the session is dropped rather than logged out
	await page.context().clearCookies();
	await gotoPage(page, '/user/login');
	await page.locator('#edit-name').fill(name);
	await page.locator('#edit-pass').fill(pass);
	await Promise.all([page.waitForURL(/\/user\/\d+/), page.locator('#edit-submit').click()]);

	const status = await page.goto('/admin/config/drupflare/status');
	expect(status?.status()).toBe(200);
	await expect(page.getByText('Interpreter booted')).toBeVisible();

	for (const path of [
		'/admin/config/drupflare/settings',
		'/admin/config/development/drupflare-ops',
		'/admin/modules/drupflare'
	]) {
		const res = await page.goto(path);
		expect(res?.status(), path).toBe(403);
		await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
	}
});
