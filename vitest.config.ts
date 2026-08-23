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
 * Measured from CI rather than guessed, and the list only ever grows by being MEASURED. Two errors
 * put a file here: the interpreter stub's "no PHP interpreter in this lane", and
 * `per-file pack not reachable: core.pf.json 404` / `dump contains no statements` once the
 * interpreter is restored but the pack is not. The pack is the wider and the binding case, because
 * it is the artifact a clean checkout cannot obtain at all.
 *
 * **No count in this sentence, deliberately.** It has said 15 while the list held 17 and 19, and
 * CLAUDE.md records that drift twice over. The skip message below reads `ARTIFACT_SPECS.length`, so
 * the lane reports the real number every run.
 *
 * A new spec that needs an artifact and is not listed here fails with one of those named errors,
 * which is the intended way to find out -- an exclusion list that silently grew would be worse.
 */
const ARTIFACT_SPECS = [
	'tests/integration/admin-config.spec.ts',
	'tests/integration/autoincrement.spec.ts',
	'tests/integration/contrib-verify.spec.ts',
	'tests/integration/cron-wire.spec.ts',
	'tests/integration/crossings.spec.ts',
	'tests/integration/crud-journey.spec.ts',
	'tests/integration/csrf.spec.ts',
	'tests/integration/degrade-serve.spec.ts',
	'tests/integration/enable-memory.spec.ts',
	'tests/integration/firstrun.spec.ts',
	'tests/integration/guzzle-handler.spec.ts',
	'tests/integration/heap-growth.spec.ts',
	'tests/integration/host-bridges.spec.ts',
	'tests/integration/lazy-fs-budget.spec.ts',
	'tests/integration/loaded-extensions.spec.ts',
	'tests/integration/linear-memory.spec.ts',
	'tests/integration/mail-drupal.spec.ts',
	'tests/integration/module-behaviour.spec.ts',
	'tests/integration/module-enable.spec.ts',
	'tests/integration/ops-surface.spec.ts',
	'tests/integration/php-clock.spec.ts',
	'tests/integration/render-origin.spec.ts',
	// these three joined the list on 2026-08-22 rather than being written into it: the serving-lane
	// work made a non-GET and a session-carrying request fall THROUGH to the gated lane instead of
	// being answered from cfw_page, so eight assertions that used to stop at the cache now end in a
	// real render. The behaviour is the C77 fix working; needing the pack is the consequence
	'tests/integration/serve-chain.spec.ts',
	'tests/integration/serve-invalidation.spec.ts',
	'tests/integration/serve-lanes.spec.ts',
	'tests/integration/serve-migration.spec.ts',
	'tests/integration/serve-restore.spec.ts',
	'tests/integration/shell-derivation.spec.ts',
	'tests/integration/statement-census.spec.ts',
	'tests/integration/static-sweep.spec.ts',
	'tests/integration/submission-wall.spec.ts',
	'tests/integration/workload-matrix.spec.ts',
	'tests/integration/write-amplification.spec.ts',
	'tests/unit/runtime/assets-ignore.spec.ts'
];

// collect the artifact specs without running them, so the metrics case count is a property of the
// checkout rather than of this machine; collection only imports, and nothing here reads at module scope
const listAll = process.env.DRUPFLARE_LIST_ALL === '1';

/**
 * A heap-growth arm, selected by env so the ladder runs the SAME binary at a different policy.
 *
 * `scripts/measure/growth-glue.ts` writes the variant; emscripten's growth step lives in the glue
 * rather than in the wasm, so an arm costs a file rewrite instead of a phasm rebuild. Unset is the
 * shipping 0.20.
 */
const growthStep = process.env.DRUPFLARE_GROWTH_STEP;
const growthGlue = growthStep
	? `.interp/php8.5-worker.growth-${growthStep.replace('.', 'p')}.mjs`
	: null;

if (growthGlue && !existsSync(growthGlue)) {
	throw new Error(
		`DRUPFLARE_GROWTH_STEP=${growthStep} but ${growthGlue} is absent; ` +
			`run \`bun scripts/measure/growth-glue.ts ${growthStep}\` first`
	);
}

const activeGlue = growthGlue ?? SHIPPING_GLUE;
const haveShipping = existsSync(SHIPPING_WASM) && existsSync(activeGlue);
const haveBinary = haveShipping || existsSync(DEFAULT_SEAM);

const havePack = existsSync(PACK_INDEX);
const haveStatic = existsSync(STATIC_TREE);
const haveArtifacts = haveBinary && havePack && haveStatic;

// stderr, not stdout: `vitest list --json` is parsed by the metrics collector, and a banner on
// stdout made every run answer `JSON Parse error: Unexpected identifier "vitest"`
if (haveShipping && growthGlue) {
	console.error(`[vitest] PHP 8.5 with the heap-growth step forced to ${growthStep}`);
} else if (haveShipping) {
	console.error('[vitest] running the SHIPPING PHP 8.5 interpreter from .interp/');
} else if (haveBinary) {
	console.error(`[vitest] no ${SHIPPING_WASM}: falling back to PHP 8.3 from ${DEFAULT_SEAM}.`);
}

// never a silent reduction in coverage: the lane says what it dropped and how to get it back
if (!haveArtifacts && !listAll) {
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
	? [seamAlias(`${DEFAULT_SEAM}.wasm`, SHIPPING_WASM), seamAlias(DEFAULT_SEAM, activeGlue)]
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
					exclude: haveArtifacts || listAll ? [] : ARTIFACT_SPECS,
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
