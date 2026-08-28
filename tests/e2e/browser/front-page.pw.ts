import { expect, gotoPage, SITE_NAME, test } from './utils/fixtures.js';

test('the front page renders a real Drupal page', async ({ page }) => {
	await gotoPage(page, '/');

	// the packed artifact says "Drupal"; firstrun renamed it, so this is a render of THIS site
	await expect(page).toHaveTitle(new RegExp(`\\| ${SITE_NAME}$`));
	await expect(page.locator('h1.page-title')).toHaveText('Welcome!');

	// a 503 from the fill queue is 8 bytes of text and would satisfy a status check
	await expect(page.locator('body')).toHaveClass(/path-frontpage/);
	await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
});
