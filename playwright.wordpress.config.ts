import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WP_ORIGIN, WP_PORT } from './tests/e2e/browser/utils/wordpress';

/**
 * The browser lane for a WordPress site.
 *
 * It serves `assets/wordpress-site` as the asset directory, which is what a WordPress deploy does,
 * so a page's stylesheets and scripts come from the asset layer. A failed spec is a result and is
 * never retried to green.
 */

const STATE_DIR =
	process.env.CFW_WP_BROWSER_STATE ?? join(tmpdir(), 'drupflare-wordpress-browser-state');

export default defineConfig({
	testDir: './tests/e2e/browser/wordpress',
	testMatch: '**/*.pw.ts',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 240_000,
	expect: { timeout: 30_000 },
	globalSetup: fileURLToPath(
		new URL('./tests/e2e/browser/wordpress/global-setup.ts', import.meta.url)
	),
	reporter: [['list']],
	outputDir: 'playwright-results',
	webServer: [
		{
			command: [
				'bunx wrangler dev -c wrangler.jsonc',
				'--assets assets/wordpress-site',
				`--port ${WP_PORT}`,
				`--inspector-port ${WP_PORT + 1000}`,
				`--persist-to ${JSON.stringify(STATE_DIR)}`,
				'--var PW_DIAGNOSTICS:1',
				'--var CMS:wordpress',
				'--var PLAN:paid',
				`--var SITE_ORIGIN:${WP_ORIGIN}`,
				'--var SQL_CHUNK_PREFIX:wordpress/sql',
				'--var HEAP_SNAPSHOT:0',
				'--var CRON_INTERVAL_MS:0'
			].join(' '),
			url: `${WP_ORIGIN}/wp-login.php`,
			reuseExistingServer: !process.env.CI,
			timeout: 300_000,
			stdout: 'pipe',
			stderr: 'pipe'
		}
	],
	use: {
		baseURL: WP_ORIGIN,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		actionTimeout: 30_000,
		navigationTimeout: 120_000
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
