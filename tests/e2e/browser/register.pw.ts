import { expect, gotoPage, test } from './utils/fixtures.js';

/**
 * The regression this lane was built for.
 *
 * `/user/register` was a white screen on every site ever created. It answered 200 the whole time, so
 * the HTTP lane read it as healthy; only rendering the markup shows the form is not there.
 */
test('the registration form renders its fields', async ({ page }) => {
	await gotoPage(page, '/user/register');

	await expect(page).toHaveTitle(/^Create new account \|/);
	await expect(page.locator('form#user-register-form')).toBeVisible();

	// the fields, not the form element: a form that renders empty is the failure this pins
	await expect(page.getByLabel('Username')).toBeVisible();
	await expect(page.getByLabel('Email address')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Create new account' })).toBeVisible();

	// the widget comes from the entity form display rather than the base form, so it is the half
	// of the render that a broken field plugin drops while the rest still draws
	await expect(page.locator('#edit-user-picture-0-upload')).toBeAttached();

	// no build id means Drupal cannot match a submission back to a form, whatever the page looks like
	await expect(page.locator('input[name="form_build_id"]')).toHaveValue(/^form-/);
});
