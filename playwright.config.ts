import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The browser lane.
 *
 * The `e2e` vitest project drives HTTP and cannot see a page that answers 200 with a widget that
 * threw; this one runs the markup in a real engine and fails on a console error. Specs are named
 * `*.pw.ts` because the `e2e` project in `vitest.config.ts` globs every spec file under `tests/e2e`
 * and would otherwise try to run these under vitest.
 */

const isCI = !!process.env.CI;
const PORT = Number(process.env.CFW_BROWSER_PORT ?? 8789);
const BASE_URL = process.env.CFW_BROWSER_URL ?? `http://127.0.0.1:${PORT}`;

/** the site the worker resolves for a local host; `SITE_ID` is layer 2 of `resolveSite()` */
const SITE = process.env.CFW_BROWSER_SITE ?? 'browser';

// outside the repo: one Durable Object namespace was measured at 970 MB under `.wrangler/state`
const STATE_DIR = process.env.CFW_BROWSER_STATE ?? join(tmpdir(), 'drupflare-browser-state');

/**
 * A SECOND worker, and the only difference is `ASSET_AGGREGATES:1`.
 *
 * The lever is an env var read inside the Durable Object, so it cannot be flipped per spec: nothing
 * writes the `settings` KV key over HTTP, and turning it on for the shared server would change what
 * every other spec here renders. `aggregate-styling.pw.ts` drives this one and the shared one as its
 * control, which is what separates a broken aggregate from a broken harness.
 *
 * Its own `--persist-to`, because two miniflare instances on one state directory share sqlite files.
 */
const AGG_PORT = Number(process.env.CFW_BROWSER_AGG_PORT ?? PORT + 2);
const AGG_STATE_DIR =
	process.env.CFW_BROWSER_AGG_STATE ?? join(tmpdir(), 'drupflare-browser-agg-state');

/**
 * The OIDC rig, which is opt-in because it needs a container.
 *
 * `docker compose -f docker/compose.yml up -d keycloak` brings it up. When it is not running the
 * single-sign-on specs skip themselves rather than failing the lane; the realm fixture carries the
 * client secret in the clear, so this is not a credential.
 */
const OIDC_SECRET = process.env.CFW_BROWSER_OIDC_SECRET ?? 'drupflare-rig-secret';

const reporters: ReporterDescription[] = [
	['list'],
	['html', { open: 'never', outputFolder: 'playwright-report' }]
];

if (isCI) {
	reporters.push(['github']);
	reporters.push(['junit', { outputFile: 'playwright-report/junit.xml' }]);
}

export default defineConfig({
	testDir: './tests/e2e/browser',
	testMatch: '**/*.pw.ts',
	testIgnore: ['**/utils/**'],
	// one site is one Durable Object with one interpreter, so parallel pages queue behind each other
	// and start answering 503 from the fill queue rather than going faster
	fullyParallel: false,
	workers: 1,
	forbidOnly: isCI,
	// LOCALLY TOO, and it is not a way to hide a failure: playwright reports a retried pass as
	// "flaky" rather than as "passed", so the signal survives. A cold authenticated render on the
	// wasm interpreter genuinely exceeds the 30 s expect timeout on a busy machine, and without a
	// retry that is indistinguishable from a broken page -- which is the comparison the house rules
	// say to make before reporting either.
	retries: 1,
	// a cold render on the free plan is seconds, not milliseconds
	timeout: 240_000,
	expect: { timeout: 30_000 },
	globalSetup: fileURLToPath(
		new URL('./tests/e2e/browser/utils/global-setup.ts', import.meta.url)
	),
	reporter: reporters,
	outputDir: 'playwright-results',
	webServer: [
		{
			command: [
				'bunx wrangler dev -c wrangler.jsonc',
				`--port ${PORT}`,
				`--inspector-port ${PORT + 1000}`,
				`--persist-to ${JSON.stringify(STATE_DIR)}`,
				'--var PW_DIAGNOSTICS:1',
				`--var SITE_ID:${SITE}`,
				// the OIDC rig's client secret. A `--var` rather than a secret because this value is in
				// `docker/keycloak-realm.json` in the clear and belongs to a container that exists for
				// this lane; a real deployment binds it as a secret
				`--var OIDC_CLIENT_SECRET:${OIDC_SECRET}`
			].join(' '),
			// `/stats` answers 200 on a site that holds nothing; `/` answers 503 until the queue fills it
			url: `${BASE_URL}/stats?site=${encodeURIComponent(SITE)}`,
			reuseExistingServer: !isCI,
			timeout: 180_000,
			stdout: 'pipe',
			stderr: 'pipe'
		},
		{
			command: [
				'bunx wrangler dev -c wrangler.jsonc',
				`--port ${AGG_PORT}`,
				`--inspector-port ${AGG_PORT + 1000}`,
				`--persist-to ${JSON.stringify(AGG_STATE_DIR)}`,
				'--var PW_DIAGNOSTICS:1',
				`--var SITE_ID:${SITE}`,
				'--var ASSET_AGGREGATES:1'
			].join(' '),
			url: `http://127.0.0.1:${AGG_PORT}/stats?site=${encodeURIComponent(SITE)}`,
			reuseExistingServer: !isCI,
			timeout: 180_000,
			stdout: 'pipe',
			stderr: 'pipe'
		}
	],
	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		actionTimeout: 30_000,
		navigationTimeout: 120_000
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
