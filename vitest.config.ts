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
import { PRISTINE_WASM, TUNED_WASM, emitTunedWasm } from './scripts/measure/initial-memory.js';

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
const PRISTINE_WASM_PATH = PRISTINE_WASM;

/**
 * The TUNED binary, which is what `src/runtime/php-binary-raw.ts` imports.
 *
 * Emitted here when it is missing for the same reason as the glue below: INITIAL_MEMORY lives in the
 * module's memory section, so a gate running the pristine 96 MiB while production runs 80 is a lane
 * divergence at the one seam this project has already had one at.
 */
const SHIPPING_WASM = TUNED_WASM;
if (!existsSync(SHIPPING_WASM) && existsSync(PRISTINE_WASM_PATH)) {
	emitTunedWasm(process.cwd());
}

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
import { GATE_WAIT_MS } from './tests/e2e/helpers/endpoint.ts';

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

/**
 * Specs that import an artifact of their own at COLLECTION time, and the file that has to exist.
 *
 * `ARTIFACT_SPECS` is the pack boundary and these are not on it: a tree can hold the whole pack and
 * still not hold these, because nothing in this repository produces them. A top-level
 * `import ...?raw` fails collection, so `describe.skipIf` cannot reach it and the spec's own
 * `DRUPFLARE_MEASURE` gate never gets a chance to decline.
 *
 * Measured rather than assumed: the pack lane builds every artifact and still read
 * `ENOENT: '../../assets/probe/pw-probe.php'`.
 */
const PROBE_IMPORTS: Record<string, string> = {
	'tests/integration/render-buckets.spec.ts': 'assets/probe/pw-probe.php',
	'tests/integration/render-plan-arms.spec.ts': 'scripts/bench/pw-plan-replay.php'
};
/**
 * NOT GATED ON `listAll`, AND THAT COUPLING LOST A METRIC ON EVERY RUN.
 *
 * The two guards answer different questions. `ARTIFACT_SPECS` is "this machine cannot RUN the
 * spec", so `DRUPFLARE_LIST_ALL=1` correctly overrides it -- a listing is a property of the
 * repository and collection only imports. `PROBE_IMPORTS` is "this machine cannot COLLECT the
 * spec", because a top-level `import ...?raw` of an absent file throws before any gate is reached.
 * Forcing the first override onto the second made `vitest list` throw on exactly the lane that
 * forces it, so `collect-metrics.ts` -- whose whole reason for setting the flag is to count the
 * repository rather than the machine -- got no count at all.
 */
const missingProbeSpecs = Object.entries(PROBE_IMPORTS)
	.filter(([, file]) => !existsSync(resolve(import.meta.dirname, file)))
	.map(([spec]) => spec);

const excludedSpecs = [...(haveArtifacts || listAll ? [] : ARTIFACT_SPECS), ...missingProbeSpecs];

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
 * **CI USED TO PIN THIS AT 1 AND THAT IS THE WHOLE HOUR.** `Run the Gate With the Pack Asserted`
 * took 3,410 s of a 3,479 s Pack Suites run on 2026-09-12 -- every other step totalled 69 s -- and
 * the breakdown says why: 2,583 s of tests plus 597 s of import against 3,410 s of wall clock is a
 * single lane. The same suite locally runs 2,169 s of tests in 651 s.
 *
 * The pin was set against a memory worry the runner does not have. `ubuntu-24.04` is 4 cores and
 * 16 GB, so this function's OWN budget allows 20 lanes there and the cores allow 3. Computing it
 * from the runner rather than hardcoding 1 keeps the budget honest if the runner ever shrinks, and
 * `DRUPFLARE_TEST_WORKERS` still overrides either way.
 */
const MIB = 1_048_576;

/**
 * WHAT A WORKER-LOADING SPEC COSTS, AND WHY IT IS NOT THE APPLICATION GRAPH.
 *
 * Measured: a leaf import is 34 ms, six large `src/ops/*` modules together are 96 ms, and
 * `src/site.ts` is 2.60 s -- so the whole per-file cost is the 12,218,393-byte interpreter
 * instantiating into a fresh isolate. A spec whose graph reaches `cloudflare:test`,
 * `src/site.ts` or `src/site-do.ts` pays roughly 60x what one outside that set does: 52 ms for
 * `cdn-absorption.spec.ts` against 3.19 s for `shell-default.spec.ts`, n=3 each.
 *
 * **RE-MEASURED 2026-09-14: 152 of 251 spec files, 7.78 s each under eight contending lanes, which
 * is 1,188 s of lane-work in a 510 s workers run.** The figures this paragraph carried -- 68 of
 * 142, 444 s against a 280 s wall -- had drifted with the suite in both terms. Import is 34% of
 * all lane-work and it is charged per FILE, which is why adding spec files is not free and
 * splitting one to parallelise it is a net loss: `7.78 / lanes * efficiency` is ~1.1 s of wall per
 * extra file, for nothing.
 *
 * Both obvious remedies are refused rather than untried. Consolidating the integration specs
 * breaks the one-spec-file-per-domain rule and the failure attribution that comes with it.
 * Importing the seam dynamically WOULD work here, because the gate aliases a pre-compiled
 * `CompiledWasm`, and would break production, where workerd forbids request-time codegen -- a lane
 * divergence at the exact seam that already ran 8.3 in the gate against 8.5 on the edge.
 */
function workerLanes(): number {
	const explicit = Number(process.env.DRUPFLARE_TEST_WORKERS);
	if (Number.isFinite(explicit) && explicit >= 1) return Math.floor(explicit);
	const ci = process.env.CI !== undefined;
	const byMemory = Math.floor((totalmem() * 0.5) / (400 * MIB));
	// one core for the runner, two for a developer's machine. THE CAP OF 8 IS UNMEASURED: its
	// stated reason, that the lanes contend on the same SQLite, has no reading behind it, and on a
	// 12-core machine `byCores` is 10 and `byMemory` is 20, so this is the only thing holding it
	// down. A balanced-floor estimate puts 10 lanes at 349 s against 436 s -- worth an arm, on a
	// machine that is not swapping. `DRUPFLARE_TEST_WORKERS=10` runs it
	const byCores = availableParallelism() - (ci ? 1 : 2);
	return Math.max(ci ? 1 : 2, Math.min(byCores, byMemory, 8));
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
							// `FLEET_DB` IS IN `wrangler.jsonc` AND THE POOL DOES NOT CREATE IT, so
							// `env.FLEET_DB` was undefined here and `reportToFleet()` returned at its
							// first line on every test that ever reached an alarm. The inventory had a
							// production caller and no lane that could observe one. Miniflare's D1 is
							// local and needs no account, the same argument `FILES` above makes.
							d1Databases: ['FLEET_DB'],
							// AND THE SAME ARGUMENT FOR THE TWO KV NAMESPACES. `wrangler.jsonc` declares
							// both and the pool does not create either, so `env.PAGE_KV` was undefined
							// here: `pageKvEnabled()` returns false on a missing binding, which means the
							// KV page tier AND the stale-generation serve on top of it were unreachable in
							// every lane. `readStalePage()` returning null at its first line is the same
							// shape as `reportToFleet()` above, one binding over
							kvNamespaces: ['PAGE_KV', 'CONFIG_KV'],
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
				// workerd has no `process.env`, so `builtFromSource()` cannot be read inside the
				// isolate the way the node project reads it -- see the ABI note above
				define: {
					__DRUPFLARE_ABI__: JSON.stringify(abi ?? ''),
					__DRUPFLARE_PACK_FROM_SOURCE__: JSON.stringify(
						process.env.PACK_FROM_SOURCE === '1'
					)
				},
				test: {
					name: 'workers',
					include: ['tests/unit/**/*.spec.ts', 'tests/integration/**/*.spec.ts'],
					exclude: excludedSpecs,
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
					exclude: excludedSpecs,
					// THESE SHELL OUT TO PHP AND READ THE FILESYSTEM, so `fileParallelism` stays
					// off: two files building a pack or writing a temp tree at once is a race the
					// failure output cannot attribute. What was over-tight is `maxWorkers: 1`,
					// which also serialised the CASES inside one file -- `php -l` over 98
					// fragments and a `bun` subprocess per reachability scan are subprocess waits,
					// not CPU, and nothing in a single file shares the tree it writes
					maxWorkers: workerLanes(),
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
					testTimeout: 60000,
					// AND THE HOOK NEEDS ITS OWN, because vitest's default is 10 s and nine specs
					// call `e2eGate()` from `beforeAll`. That gate waits `GATE_WAIT_MS` -- 90 s, set
					// deliberately to outlast a `wrangler dev` Durable Object restart -- so the hook
					// died at 10 s on exactly the event the gate exists to absorb, and reported it as
					// `Hook timed out in 10000ms` rather than as a restart. Derived from the gate's
					// own constant so the two cannot drift; the margin is for the request in flight
					// when the wait expires.
					hookTimeout: GATE_WAIT_MS + 30_000
				}
			}
		],
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'json', 'lcov', 'clover'],
			reportsDirectory: './coverage',
			include: SHIPPING_CODE,
			exclude: ['src/probes/**', 'tests/**', '**/*.d.ts'],
			// RE-DERIVED 2026-09-14 FROM A RUN OF THE WIDENED LANE, not raised by guess. The old
			// four were calibrated on a lane that dropped 104 spec files for want of the pack, and
			// `coverage.yml` now builds it: a full local run with the artifacts present read
			// 90.19 stmts / 79.58 branch / 94.4 funcs / 91.61 lines, against 74.45 / 63.9 / 80.97 /
			// 75.06 on the narrowed lane. Every one of these is ~1.5 under its reading, which is
			// margin for CI's own build rather than headroom to spend: the old lines gate cleared by
			// 0.06 and the next spec to join `ARTIFACT_SPECS` would have taken it red on its own.
			thresholds: {
				lines: 90,
				functions: 92,
				branches: 77,
				statements: 88
			}
		}
	}
});
