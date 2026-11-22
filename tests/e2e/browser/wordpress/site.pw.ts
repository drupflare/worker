import type { Page, Response } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { expect, test } from '../utils/fixtures';
import {
	ASSET_PATH,
	WP_ADMIN_PASS,
	WP_ADMIN_USER,
	WP_ORIGIN,
	WP_OWNER_FILE,
	WP_SESSION_FILE,
	WP_SITE_NAME
} from '../utils/wordpress';

/** every static response the page receives, kept to be read once the page has settled */
function watchAssets(page: Page): Response[] {
	const seen: Response[] = [];
	page.on('response', (res) => {
		if (ASSET_PATH.test(new URL(res.url()).pathname)) seen.push(res);
	});
	return seen;
}

/**
 * Each static file answered 200 from the asset layer. The worker stamps `x-cfw-cache` on every
 * answer it gives, so a file with that header was served by PHP's route and not by the asset tier.
 */
async function expectFromAssetTier(seen: Response[], atLeast = 1): Promise<void> {
	expect(seen.length, 'the page requested too few static files').toBeGreaterThanOrEqual(atLeast);
	for (const res of seen) {
		const headers = await res.allHeaders();
		expect(res.status(), res.url()).toBe(200);
		expect(headers['x-cfw-cache'], `${res.url()} came from the worker`).toBeUndefined();
		expect(headers['cache-control'], res.url()).toMatch(/max-age=31536000/);
	}
}

test('the front page is styled by the theme and its files come from the asset tier', async ({
	page
}) => {
	const seen = watchAssets(page);
	const res = await page.goto('/', { waitUntil: 'load' });
	expect(res?.status()).toBe(200);
	await expect(page).toHaveTitle(WP_SITE_NAME);
	await expect(page.locator('body')).toHaveClass(/wp-theme-twentytwentyfive/);

	const style = (await page.evaluate(`(async () => {
		await document.fonts.ready;
		const body = getComputedStyle(document.body);
		return {
			family: body.fontFamily,
			weight: body.fontWeight,
			background: body.backgroundColor,
			loaded: document.fonts.check('300 1em Manrope')
		};
	})()`)) as { family: string; weight: string; background: string; loaded: boolean };
	expect(style.family).toContain('Manrope');
	expect(style.weight).toBe('300');
	expect(style.background).toBe('rgb(255, 255, 255)');
	expect(style.loaded, 'the theme font did not load').toBe(true);

	expect(seen.map((r) => new URL(r.url()).pathname)).toContain(
		'/wp-content/themes/twentytwentyfive/assets/fonts/manrope/Manrope-VariableFont_wght.woff2'
	);
	await expectFromAssetTier(seen);
});

test('a post page renders its title and body', async ({ page }) => {
	const seen = watchAssets(page);
	const res = await page.goto('/2026/01/01/hello-world/', { waitUntil: 'load' });
	expect(res?.status()).toBe(200);
	await expect(page.getByRole('heading', { level: 1, name: 'Hello world!' })).toBeVisible();
	await expect(page.getByText('Welcome to WordPress.')).toBeVisible();
	await expectFromAssetTier(seen);
});

test('the login form signs the owner in to the dashboard', async ({ page }) => {
	const seen = watchAssets(page);
	await page.goto('/wp-login.php', { waitUntil: 'load' });
	await expect(page.locator('#loginform')).toBeVisible();
	await expectFromAssetTier(seen);

	await page.locator('#user_login').fill(WP_ADMIN_USER);
	await page.locator('#user_pass').fill(WP_ADMIN_PASS);
	await Promise.all([page.waitForURL(/\/wp-admin\/$/), page.locator('#wp-submit').click()]);
	await expect(page.locator('#wpadminbar')).toBeVisible();
});

test.describe('signed in', () => {
	test.use({ storageState: WP_SESSION_FILE });

	test('the dashboard loads with its admin bar and no console error', async ({ page }) => {
		const seen = watchAssets(page);
		const res = await page.goto('/wp-admin/', { waitUntil: 'load' });
		expect(res?.status()).toBe(200);
		await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
		await expect(page.locator('#wpadminbar')).toBeVisible();
		await expectFromAssetTier(seen);
	});

	test('the block editor opens a new post', async ({ page }) => {
		const seen = watchAssets(page);
		await page.goto('/wp-admin/post-new.php', { waitUntil: 'load' });
		await expect(
			page
				.locator('.edit-post-layout, .editor-visual-editor, iframe[name="editor-canvas"]')
				.first()
		).toBeVisible({ timeout: 120_000 });
		await expectFromAssetTier(seen);
	});

	test('a REST call from the page with the nonce returns the signed-in user', async ({
		page
	}) => {
		await page.goto('/wp-admin/', { waitUntil: 'load' });
		const answer = await page.evaluate(async () => {
			const nonce = await (await fetch('/wp-admin/admin-ajax.php?action=rest-nonce')).text();
			const res = await fetch('/wp-json/wp/v2/users/me', {
				headers: { 'x-wp-nonce': nonce }
			});
			return { status: res.status, body: (await res.json()) as { slug?: string } };
		});
		expect(answer.status).toBe(200);
		expect(answer.body.slug).toBe('owner');
	});
});

test('an anonymous REST call from the page lists the posts', async ({ page }) => {
	await page.goto('/', { waitUntil: 'load' });
	const answer = await page.evaluate(async () => {
		const res = await fetch('/wp-json/wp/v2/posts');
		return {
			status: res.status,
			body: (await res.json()) as { id: number; title: { rendered: string } }[]
		};
	});
	expect(answer.status).toBe(200);
	expect(answer.body[0]?.title.rendered).toBe('Hello world!');
});

test.describe('a path that does not exist', () => {
	test.use({ refusals: [404] });

	test('answers 404 with the theme template', async ({ page }) => {
		const seen = watchAssets(page);
		const res = await page.goto('/no-such-page-xyz/', { waitUntil: 'load' });
		expect(res?.status()).toBe(404);
		await expect(page).toHaveTitle(/Page not found/);
		await expectFromAssetTier(seen, 0);
	});
});

// #region plugin lifecycle

const PLUGIN_FILE = 'classic-editor/classic-editor.php';

interface Receipt {
	op: string;
	fromVersion: string | null;
	toVersion: string | null;
	fromDigest: string | null;
	toDigest: string | null;
}

interface Listing {
	receipts: Receipt[];
	registry: Record<string, { versions: Record<string, { digest: string }> }>;
}

/** one owner call to the package route; the token comes from the claim and is never printed */
async function packages(
	op: 'install' | 'rollback' | 'delete',
	version?: string
): Promise<{ status: number; body: { ok: boolean; receipt?: Receipt; error?: string } }> {
	const { ownerToken } = JSON.parse(readFileSync(WP_OWNER_FILE, 'utf8')) as {
		ownerToken: string;
	};
	const query = new URLSearchParams({ op, slug: 'classic-editor' });
	if (version !== undefined) query.set('version', version);
	const res = await fetch(`${WP_ORIGIN}/wp-packages?${query}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${ownerToken}` },
		signal: AbortSignal.timeout(180_000)
	});
	return { status: res.status, body: await res.json() };
}

async function listing(): Promise<Listing> {
	const { ownerToken } = JSON.parse(readFileSync(WP_OWNER_FILE, 'utf8')) as {
		ownerToken: string;
	};
	const res = await fetch(`${WP_ORIGIN}/wp-packages`, {
		headers: { authorization: `Bearer ${ownerToken}` }
	});
	return (await res.json()) as Listing;
}

test.describe('a real plugin through the staged install', () => {
	test.use({ storageState: WP_SESSION_FILE });

	test('Classic Editor installs, activates, updates, rolls back and deactivates', async ({
		page
	}) => {
		test.setTimeout(900_000);
		const row = page.locator(`tr[data-plugin="${PLUGIN_FILE}"]`);
		const registry = (await listing()).registry['classic-editor']!.versions;

		await test.step('installs the highest pinned version and lists it inactive', async () => {
			const out = await packages('install');
			expect(out.status, JSON.stringify(out.body)).toBe(200);
			expect(out.body.receipt).toMatchObject({
				op: 'install',
				toVersion: '1.7.0',
				toDigest: registry['1.7.0']!.digest
			});
			await page.goto('/wp-admin/plugins.php', { waitUntil: 'load' });
			await expect(row).toBeVisible();
			await expect(row).toHaveClass(/inactive/);
			await expect(row).toContainText('Version 1.7.0');
		});

		await test.step('the block editor is the editor while the plugin is inactive', async () => {
			await page.goto('/wp-admin/post-new.php', { waitUntil: 'load' });
			await expect(
				page.locator('.edit-post-layout, .editor-visual-editor').first()
			).toBeVisible({ timeout: 120_000 });
		});

		await test.step('Activate on the Plugins screen switches it on', async () => {
			await page.goto('/wp-admin/plugins.php', { waitUntil: 'load' });
			await row.locator('span.activate a').click();
			await expect(row).toHaveClass(/active/);
			await expect(page.locator('#message')).toContainText('Plugin activated');
		});

		await test.step('the classic editor replaces the block editor', async () => {
			await page.goto('/wp-admin/post-new.php', { waitUntil: 'load' });
			await expect(page.locator('form#post')).toBeVisible();
			await expect(page.locator('#wp-content-editor-container')).toBeVisible();
			await expect(page.locator('.edit-post-layout')).toHaveCount(0);
			await expect(page.locator('#editor.block-editor__container')).toHaveCount(0);
		});

		await test.step('an older release installs as an update and the receipt names both digests', async () => {
			const out = await packages('install', '1.6.7');
			expect(out.status, JSON.stringify(out.body)).toBe(200);
			expect(out.body.receipt).toMatchObject({
				op: 'update',
				fromVersion: '1.7.0',
				toVersion: '1.6.7',
				fromDigest: registry['1.7.0']!.digest,
				toDigest: registry['1.6.7']!.digest
			});
			await page.goto('/wp-admin/plugins.php', { waitUntil: 'load' });
			await expect(row).toHaveClass(/active/);
			await expect(row).toContainText('Version 1.6.7');
			await page.goto('/wp-admin/post-new.php', { waitUntil: 'load' });
			await expect(page.locator('form#post')).toBeVisible();
		});

		await test.step('rollback mounts the earlier files again and the plugin stays active', async () => {
			const out = await packages('rollback');
			expect(out.status, JSON.stringify(out.body)).toBe(200);
			expect(out.body.receipt).toMatchObject({
				op: 'rollback',
				fromVersion: '1.6.7',
				toVersion: '1.7.0'
			});
			await page.goto('/wp-admin/plugins.php', { waitUntil: 'load' });
			await expect(row).toHaveClass(/active/);
			await expect(row).toContainText('Version 1.7.0');
			await page.goto('/wp-admin/post-new.php', { waitUntil: 'load' });
			await expect(page.locator('form#post')).toBeVisible();
		});

		await test.step('delete is refused while the plugin is active', async () => {
			const out = await packages('delete');
			expect(out.status).toBe(409);
			expect(out.body.error).toContain('active in WordPress');
		});

		await test.step('Deactivate brings the block editor back', async () => {
			await page.goto('/wp-admin/plugins.php', { waitUntil: 'load' });
			await row.locator('span.deactivate a').click();
			await expect(row).toHaveClass(/inactive/);
			await page.goto('/wp-admin/post-new.php', { waitUntil: 'load' });
			await expect(
				page.locator('.edit-post-layout, .editor-visual-editor').first()
			).toBeVisible({ timeout: 120_000 });
			await expect(page.locator('form#post .wp-editor-area')).toHaveCount(0);
		});

		const receipts = (await listing()).receipts.map((r) => r.op).reverse();
		expect(receipts).toEqual(['install', 'update', 'rollback']);
	});
});

// #endregion
