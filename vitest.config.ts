import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const SHIPPING_CODE = [
	'src/site.ts',
	'src/site-do.ts',
	'src/runtime/**',
	'src/db/**',
	'src/drupal/**',
	'src/ops/**'
];

const DEFAULT_SEAM = 'vendor/static-free-v1/php8.3-worker.mjs';
const SHIPPING_GLUE = '.interp/php8.5-worker.mjs';
const SHIPPING_WASM = '.interp/php8.5.wasm';

/**
 * The packed Drupal tree and the migration chunks, which a clean checkout cannot build.
 *
 * `bun run assets:pack` needs a native-PHP Drupal bake plus `assets/drupal/site.sqlite`, whose trim
 * recipe is written down nowhere -- so unlike the interpreter these cannot be restored from the CDN
 * either. They arrive only in a published release payload, via `bun run hydrate`.
 */
const PACK_INDEX = 'assets/drupal-pf/core.pf.json';

/**
 * The browser-fetchable core tree, which `tests/unit/runtime/assets-ignore.spec.ts` fetches through
 * the real ASSETS binding.
 *
 * Its own lane boundary: `bun run assets:static` copies it out of `drupal-src`, which a clean
 * checkout does not have either, so it arrives with the pack rather than with `bun install`.
 */
const STATIC_TREE = 'assets/core/misc/drupal.js';

/**
 * The specs that need a BUILD ARTIFACT: the interpreter, the pack, the migration chunks, or the
 * browser-fetchable core tree.
 *
 * Measured from CI rather than guessed, twice. With the interpreter stubbed, 11 files fail on the
 * stub's own "no PHP interpreter in this lane" error. With the interpreter RESTORED but no pack, 15
 * fail -- the same 11 plus four that mount the tree or replay a migration, on
 * `per-file pack not reachable: core.pf.json 404` and `dump contains no statements`. The wider list
 * is the one that matters, because the pack is the artifact a clean checkout cannot obtain at all.
 *
 * A new spec that needs an artifact and is not listed here fails with one of those named errors,
 * which is the intended way to find out -- an exclusion list that silently grew would be worse.
 */
const ARTIFACT_SPECS = [
	'tests/integration/admin-config.spec.ts',
	'tests/integration/contrib-verify.spec.ts',
	'tests/integration/cron-wire.spec.ts',
	'tests/integration/crud-journey.spec.ts',
	'tests/integration/csrf.spec.ts',
	'tests/integration/enable-memory.spec.ts',
	'tests/integration/firstrun.spec.ts',
	'tests/integration/lazy-fs-budget.spec.ts',
	'tests/integration/mail-drupal.spec.ts',
	'tests/integration/module-behaviour.spec.ts',
	'tests/integration/module-enable.spec.ts',
	'tests/integration/ops-surface.spec.ts',
	'tests/integration/render-origin.spec.ts',
	'tests/integration/serve-invalidation.spec.ts',
	'tests/integration/serve-migration.spec.ts',
	'tests/integration/serve-restore.spec.ts',
	'tests/integration/static-sweep.spec.ts',
	'tests/integration/submission-wall.spec.ts',
	'tests/unit/runtime/assets-ignore.spec.ts'
];

const haveShipping = existsSync(SHIPPING_WASM) && existsSync(SHIPPING_GLUE);
const haveBinary = haveShipping || existsSync(DEFAULT_SEAM);

const havePack = existsSync(PACK_INDEX);
const haveStatic = existsSync(STATIC_TREE);
const haveArtifacts = haveBinary && havePack && haveStatic;

// stderr, not stdout: `vitest list --json` is parsed by the metrics collector, and a banner on
// stdout made every run answer `JSON Parse error: Unexpected identifier "vitest"`
if (haveShipping) {
	console.error('[vitest] running the SHIPPING PHP 8.5 interpreter from .interp/');
} else if (haveBinary) {
	console.error(`[vitest] no ${SHIPPING_WASM}: falling back to PHP 8.3 from ${DEFAULT_SEAM}.`);
}

// never a silent reduction in coverage: the lane says what it dropped and how to get it back
if (!haveArtifacts) {
	console.error(
		`[vitest] SKIPPING ${ARTIFACT_SPECS.length} spec files that need a build artifact ` +
			`(${haveBinary ? 'have' : 'no'} interpreter, ${havePack ? 'have' : 'no'} pack, ` +
			`${haveStatic ? 'have' : 'no'} static tree).\n` +
			'         `bun install` restores the interpreter; the pack needs `bun run hydrate`,\n' +
			'         which needs a published release payload. The static tree ships in that\n' +
			'         payload too, or comes from `bun run assets:static` against a fetched tree.'
	);
}

/**
 * Repoint the default seam's two imports, or stub them.
 *
 * `.wasm` FIRST in both arms: a Vite string `find` is a prefix match, so the bare specifier would
 * otherwise swallow it. Replacements are ABSOLUTE -- a relative one is joined against the importer
 * and resolves outside the repo, which is how the first attempt produced
 * `/Users/gamer/gmitch215/vendor/...`.
 */
const seamAlias = (from: string, to: string) => ({
	find: `../../${from}`,
	replacement: resolve(import.meta.dirname, to)
});

const binaryAlias = haveShipping
	? [seamAlias(`${DEFAULT_SEAM}.wasm`, SHIPPING_WASM), seamAlias(DEFAULT_SEAM, SHIPPING_GLUE)]
	: haveBinary
		? []
		: [
				seamAlias(`${DEFAULT_SEAM}.wasm`, 'tests/helpers/php-wasm-absent.ts'),
				seamAlias(DEFAULT_SEAM, 'tests/helpers/php-binary-absent.ts')
			];

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						remoteBindings: false,
						wrangler: { configPath: './wrangler.jsonc' },
						miniflare: {
							bindings: { PW_DIAGNOSTICS: '1' },
							isolatedStorage: true
						}
					})
				],
				resolve: { alias: binaryAlias },
				test: {
					name: 'workers',
					include: ['tests/unit/**/*.spec.ts', 'tests/integration/**/*.spec.ts'],
					exclude: haveArtifacts ? [] : ARTIFACT_SPECS,
					maxWorkers: process.env.CI ? 1 : 2,
					testTimeout: 15000
				}
			},
			{
				test: {
					name: 'node',
					environment: 'node',
					include: ['tests/node/**/*.spec.ts'],
					// these shell out to php and read the filesystem; serial keeps the failure
					// output attributable
					maxWorkers: 1,
					fileParallelism: false,
					testTimeout: 30000
				}
			},
			{
				test: {
					name: 'e2e',
					environment: 'node',
					include: ['tests/e2e/**/*.spec.ts'],
					maxWorkers: 1,
					fileParallelism: false,
					// a cold boot is ~4 s of interpreter start before the first byte
					testTimeout: 60000
				}
			}
		],
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: SHIPPING_CODE,
			exclude: ['src/probes/**', 'tests/**', '**/*.d.ts'],
			thresholds: {
				lines: 75,
				functions: 72,
				branches: 63,
				statements: 74
			}
		}
	}
});
