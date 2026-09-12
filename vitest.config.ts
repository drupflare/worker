import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { existsSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

import {
	TUNED_GLUE,
	emitTunedGlue,
	glueFor,
	tunedGlueFor,
	type Abi
} from './scripts/measure/growth-glue.js';

const SHIPPING_CODE = [
	'src/site.ts',
	'src/site-do.ts',
	'src/runtime/**',
	'src/db/**',
	'src/drupal/**',
	'src/ops/**'
];

const DEFAULT_SEAM = 'vendor/static-free-v1/php8.3-worker.mjs';
const PRISTINE_GLUE = '.interp/php8.5-worker.mjs';
const SHIPPING_WASM = '.interp/php8.5.wasm';

/**
 * The TUNED glue, which is what `src/runtime/php-binary-85.ts` imports.
 *
 * Emitted here when it is missing so the gate cannot run a different heap-growth policy from
 * production. That divergence has happened before at this exact seam -- CLAUDE.md records the whole
 * life of the project running PHP 8.3 in the test lane and 8.5 on the edge, because a wrangler
 * alias applied to one and not the other.
 */
const SHIPPING_GLUE = TUNED_GLUE;
if (!existsSync(SHIPPING_GLUE) && existsSync(PRISTINE_GLUE)) {
	emitTunedGlue(process.cwd());
}

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

// `.ts` rather than the repo's usual `.js` specifier: this file is loaded by vite's own config
// loader, which resolves the path literally and warns on an extensionless one
import { ARTIFACT_SPECS } from './tests/artifact-specs.ts';

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

/**
 * A pointer-ABI arm, selected by env so P26 is scored against the SAME specs as wasm32.
 *
 * `DRUPFLARE_ABI=wasm64` points the seam at `.interp/php8.5-wasm64.{wasm,-worker.mjs}`, which
 * `phasm` builds from `src/rc/wasm64.rc.pending` -- the control rc with the ABI changed and nothing
 * else, so pointer width is the only variable. Unset is the shipping wasm32.
 *
 * It overrides the growth arm rather than composing with it: each ABI is tuned from its OWN glue,
 * so pairing one with the other's module would run mismatched pointer widths.
 *
 * **The arm runs the TUNED wasm64 glue.** Emscripten emits 0.20 and the built artifact carries it,
 * which reads 138.44 MiB on the install and auth arms and does not fit; the shipping 0.05 reads
 * 123.00 MiB. Substituting that by hand is how the gate and production come to run different growth
 * policies, which has happened at this exact seam before.
 */
const abi = process.env.DRUPFLARE_ABI as Abi | undefined;
const ABI_ARMS = ['wasm64', 'long64', 'emmalloc', 'bulkmem', 'impmem', 'zendalloc'];
if (abi !== undefined && !ABI_ARMS.includes(abi)) {
	throw new Error(`DRUPFLARE_ABI must be one of ${ABI_ARMS.join(', ')} when set; got ${abi}`);
}
const abiWasm = abi ? `.interp/php8.5-${abi}.wasm` : null;
const abiPristine = abi ? glueFor(abi) : null;
if (abiWasm && abiPristine && !(existsSync(abiWasm) && existsSync(abiPristine))) {
	throw new Error(
		`DRUPFLARE_ABI=${abi} but ${abiWasm} or ${abiPristine} is absent; build the variant in phasm ` +
			'and copy both files into .interp/'
	);
}
const abiGlue = abi ? tunedGlueFor(abi) : null;
if (abiGlue && !existsSync(abiGlue)) emitTunedGlue(process.cwd(), abi as Abi);

const activeWasm = abiWasm ?? SHIPPING_WASM;
const activeGlue = abiGlue ?? growthGlue ?? SHIPPING_GLUE;
const haveShipping = existsSync(activeWasm) && existsSync(activeGlue);
const haveBinary = haveShipping || existsSync(DEFAULT_SEAM);

const havePack = existsSync(PACK_INDEX);
const haveStatic = existsSync(STATIC_TREE);
const haveArtifacts = haveBinary && havePack && haveStatic;

// stderr, not stdout: `vitest list --json` is parsed by the metrics collector, and a banner on
// stdout made every run answer `JSON Parse error: Unexpected identifier "vitest"`
if (haveShipping && abi) {
	console.error(`[vitest] PHP 8.5 on the ${abi} pointer ABI from .interp/`);
} else if (haveShipping && growthGlue) {
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

/**
 * THE GATE NOW LOADS THE MODULE THAT SHIPS, which it could not do before 2026-09-07.
 *
 * `wrangler.jsonc` aliases `./runtime/php-binary.js` to a seam, vite does not apply that alias, and
 * the seam that shipped inflated a brotli frame and called `new WebAssembly.Module` at module scope.
 * That is legal at worker STARTUP and forbidden at request time, and a vitest spec is evaluated
 * inside a fetch handler -- so the shipping seam could never be loaded here and the lane aliased
 * around it. For the life of the project the gate ran PHP 8.3 from `vendor/` while production ran 8.5.
 *
 * Cloudflare removed the compressed bundle limit on 2026-09-04, so the interpreter now ships as a
 * raw `CompiledWasm` import: pre-compiled by the platform, no inflate, no codegen anywhere. Both
 * lanes can therefore resolve the same module, and this alias is the same one wrangler applies.
 *
 * The arm aliases still repoint the raw seam's OWN two imports, so `DRUPFLARE_ABI` and
 * `DRUPFLARE_GROWTH_STEP` keep working; with no arm selected they resolve to the files the seam
 * already names and the substitution is a no-op.
 */
const SHIPPING_SEAM = 'src/runtime/php-binary-raw.ts';
const shippingSeamAlias = {
	find: './runtime/php-binary.js',
	replacement: resolve(import.meta.dirname, SHIPPING_SEAM)
};

const binaryAlias = haveShipping
	? [
			shippingSeamAlias,
			seamAlias(SHIPPING_WASM, activeWasm),
			seamAlias(TUNED_GLUE, activeGlue),
			seamAlias(`${DEFAULT_SEAM}.wasm`, activeWasm),
			seamAlias(DEFAULT_SEAM, activeGlue)
		]
	: haveBinary
		? []
		: [
				seamAlias(`${DEFAULT_SEAM}.wasm`, 'tests/helpers/php-wasm-absent.ts'),
				seamAlias(DEFAULT_SEAM, 'tests/helpers/php-binary-absent.ts')
			];

/**
 * How many workerd isolates the `workers` project may run at once.
 *
 * MEMORY is the binding constraint, not cores: every lane instantiates PHP, and the shipping build
 * reaches a 113,770,496-byte linear memory on an authenticated render. Budgeting 400 MiB a lane
 * covers that plus V8's own overhead, and half of physical memory keeps the machine usable.
 *
 * CI stays at 1 by default. A hosted runner is 4 cores against a workload that is 12 MB of wasm per
 * lane, and a lane that OOMs there fails the whole gate rather than one file.
 * `DRUPFLARE_TEST_WORKERS` overrides either way.
 */
const MIB = 1_048_576;

/**
 * WHAT A WORKER-LOADING SPEC COSTS, AND WHY IT IS NOT THE APPLICATION GRAPH.
 *
 * Measured: a leaf import is 34 ms, six large `src/ops/*` modules together are 96 ms, and
 * `src/site.ts` is 2.60 s -- so the whole per-file cost is the 12,218,393-byte interpreter
 * instantiating into a fresh isolate. 68 of 142 spec files pay it, at 3.3 s alone and ~6.5 s under
 * eight contending lanes, which is 444 s of the suite's 280 s wall clock.
 *
 * Both obvious remedies are refused rather than untried. Consolidating the 58 integration specs
 * breaks the one-spec-file-per-domain rule and the failure attribution that comes with it.
 * Importing the seam dynamically WOULD work here, because the gate aliases a pre-compiled
 * `CompiledWasm`, and would break production, where workerd forbids request-time codegen -- a lane
 * divergence at the exact seam that already ran 8.3 in the gate against 8.5 on the edge.
 */
function workerLanes(): number {
	const explicit = Number(process.env.DRUPFLARE_TEST_WORKERS);
	if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
	if (process.env.CI) return 1;
	const byMemory = Math.floor((totalmem() * 0.5) / (400 * MIB));
	// leave two cores for the host, and cap at 8: past that the lanes contend on the same SQLite
	const byCores = availableParallelism() - 2;
	return Math.max(2, Math.min(byCores, byMemory, 8));
}

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						remoteBindings: false,
						wrangler: { configPath: './wrangler.jsonc' },
						miniflare: {
							// **THE SHIPPING CONFIG NO LONGER DECLARES `FILES`, AND THE TEST LANE
							// STILL HAS TO.** `r2_buckets` was removed from `wrangler.jsonc` because
							// naming a bucket makes a fresh free account refuse the whole deploy --
							// R2 must be enabled from the dashboard first, measured as
							// `code: 10042`. Miniflare's R2 is local and needs no account, so the
							// tier stays exercised here while the deploy button works there.
							r2Buckets: ['FILES'],
							// DRUPFLARE_MEASURE gates the wall-clock instruments, which cannot be
							// hermetic; forwarded because the pool has its own env
							bindings: {
								PW_DIAGNOSTICS: '1',
								DRUPFLARE_MEASURE: process.env.DRUPFLARE_MEASURE ?? '0',
								DRUPFLARE_PLAN_ON_DPC: process.env.DRUPFLARE_PLAN_ON_DPC ?? '0',
								DRUPFLARE_PLAN_ROUTES: process.env.DRUPFLARE_PLAN_ROUTES ?? '0',
								DRUPFLARE_PLAN_TIMING_N: process.env.DRUPFLARE_PLAN_TIMING_N ?? '15'
							},
							// costs nothing measurable: `false` moved a four-file run 12.08s -> 11.77s,
							// inside the noise, because the isolate is rebuilt per FILE either way
							isolatedStorage: true
						}
					})
				],
				resolve: { alias: binaryAlias },
				// workerd has no `process.env`, so a spec cannot read the ABI arm the way this
				// config did -- an env-gated `skipIf` inside the isolate is always true and the
				// spec silently never runs. Injecting it is the only way the two sides agree.
				define: { __DRUPFLARE_ABI__: JSON.stringify(abi ?? '') },
				test: {
					name: 'workers',
					include: ['tests/unit/**/*.spec.ts', 'tests/integration/**/*.spec.ts'],
					exclude: haveArtifacts || listAll ? [] : ARTIFACT_SPECS,
					maxWorkers: workerLanes(),
					// 30s, not 15s: a worker-loading spec imports the interpreter in ~6.5 s under
					// eight contending lanes, so 15 s left specs that do no real work timing out as
					// `STACK_TRACE_ERROR` whenever the machine was also busy. The ones that boot PHP
					// set their own 900 s, so this bounds the cheap specs and hides no real hang
					testTimeout: 30000
				}
			},
			{
				test: {
					name: 'node',
					environment: 'node',
					include: ['tests/node/**/*.spec.ts'],
					// THE SAME EXCLUSION THE WORKERS PROJECT GETS, which this project did not have.
					// `ARTIFACT_SPECS` names `tests/node/**` files -- they read the pack's manifest
					// through `packVersionsHash()` rather than rendering -- and listing one here did
					// nothing at all, so a clean checkout stayed red on them however carefully the
					// list was maintained.
					exclude: haveArtifacts || listAll ? [] : ARTIFACT_SPECS,
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
