import { setupHtml } from '../../../src/ops/setup-page.ts';
import { expect, test } from './utils/fixtures.js';

/**
 * The claim page's script, run in a real engine against a stubbed `/firstrun`.
 *
 * Served on an origin of its own rather than through the lane's site, which global setup has
 * already claimed and so never shows this page. What is under test is the page after a claim: the
 * owner token is issued once, and the page used to navigate to the login form five seconds after
 * a claim with a chosen password, taking the token with it.
 */

const ORIGIN = 'https://claim.test';
const TOKEN = 'cfw-owner-token-for-the-claim-page';

test('keeps the owner token on screen until the visitor says it is stored', async ({
	page,
	context
}) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
	await page.route(`${ORIGIN}/`, (route) =>
		route.fulfill({ contentType: 'text/html', body: setupHtml(ORIGIN) })
	);
	await page.route(`${ORIGIN}/firstrun`, (route) =>
		route.fulfill({ json: { ok: true, ownerToken: TOKEN } })
	);
	await page.goto(`${ORIGIN}/`);

	await page.locator('input[name="adminPass"]').fill('a-password-i-chose-1');
	await page.getByRole('button', { name: 'Claim This Site' }).click();

	await expect(page.getByText('is shown once, on this page')).toBeVisible();
	const token = page.getByRole('textbox', { name: 'Owner Token' });
	await expect(token).toHaveValue(TOKEN);

	await page.locator('.cred', { has: token }).getByRole('button', { name: 'Copy' }).click();
	// the browser's navigator, which the workers types in this program do not describe
	const read = () =>
		(
			navigator as unknown as { clipboard: { readText(): Promise<string> } }
		).clipboard.readText();
	expect(await page.evaluate(read)).toBe(TOKEN);

	const login = page.getByRole('link', { name: 'Log in as admin' });
	await expect(login).toHaveClass('off');
	// the old page left here on its own after five seconds
	await page.waitForTimeout(6_000);
	expect(page.url()).toBe(`${ORIGIN}/`);

	await page.getByRole('checkbox', { name: 'I have stored the owner token' }).check();
	await expect(login).not.toHaveClass('off');
});
