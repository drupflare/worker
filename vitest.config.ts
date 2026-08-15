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
 * The specs that BOOT the interpreter rather than stubbing it, so they cannot run without one.
 *
 * Measured, not guessed: with the stub forced on, these are exactly the 11 files whose tests fail
 * with the stub's own "no PHP interpreter in this lane" error. Every other workers spec replaces the
 * interpreter with `stubRender()` and passes.
 *
 * A new spec that boots PHP and is not listed here fails on CI with that same named error, which is
 * the intended way to find out -- an exclusion list that silently grew would be worse.
 */
const INTERPRETER_SPECS = [
	'tests/integration/admin-config.spec.ts',
	'tests/integration/contrib-verify.spec.ts',
	'tests/integration/cron-wire.spec.ts',
	'tests/integration/crud-journey.spec.ts',
	'tests/integration/csrf.spec.ts',
	'tests/integration/enable-memory.spec.ts',
	'tests/integration/firstrun.spec.ts',
	'tests/integration/module-behaviour.spec.ts',
	'tests/integration/module-enable.spec.ts',
	'tests/integration/ops-surface.spec.ts',
	'tests/integration/submission-wall.spec.ts'
];

const haveShipping = existsSync(SHIPPING_WASM) && existsSync(SHIPPING_GLUE);
const haveBinary = haveShipping || existsSync(DEFAULT_SEAM);

if (haveShipping) {
	console.log('[vitest] running the SHIPPING PHP 8.5 interpreter from .interp/');
} else if (haveBinary) {
	console.log(`[vitest] no ${SHIPPING_WASM}: falling back to PHP 8.3 from ${DEFAULT_SEAM}.`);
} else {
	// never a silent reduction in coverage: the lane says what it dropped and how to get it back
	console.log(
		`[vitest] no interpreter: stubbing it and SKIPPING ${INTERPRETER_SPECS.length} spec files ` +
			'that boot it.\n         Run `bun install` to restore it from the CDN.'
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
					exclude: haveBinary ? [] : INTERPRETER_SPECS,
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
