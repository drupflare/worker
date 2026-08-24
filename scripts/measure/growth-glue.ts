import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Emscripten's heap-growth policy, re-emitted at a chosen step.
 *
 * THE POLICY IS JAVASCRIPT, NOT A LINK-TIME CONSTANT, and that is the whole reason this script can
 * exist. `MEMORY_GROWTH_GEOMETRIC_STEP` is documented as a `-s` setting, so the backlog recorded it
 * as needing a phasm rebuild to test. It does not: emscripten bakes it into `_emscripten_resize_heap`
 * in the glue as the literal `.2`, and the wasm binary carries no growth policy at all. One
 * interpreter, N glue variants, no relink.
 *
 * WHY A STEP OF 0 IS THE MEASUREMENT AND NOT JUST THE FLOOR. With the step at 0 the over-grown
 * candidate collapses to `oldSize`, so `newSize` is `align(requestedSize, 64 KiB)` -- the heap stops
 * being a geometric series and becomes live demand rounded up to a page. That converts "demand is
 * somewhere in a 19.25 MiB interval" into a reading, which is the open half of P16.
 */

const PAGE = 65_536;

/** the shipping glue, and the only input; the `.wasm` is untouched because it holds no policy */
export const SHIPPING_GLUE = '.interp/php8.5-worker.mjs';

/**
 * The geometric step as emscripten emits it.
 *
 * Anchored on `cutDown` rather than on the bare number: `.2` occurs all over a 12 MB glue file and
 * this expression occurs once, which a spec asserts before any rewrite happens.
 */
const STEP_SITE = /oldSize\*\(1\+\.2\/cutDown\)/;

/** where a variant is written, keyed by step so a ladder run leaves every arm on disk */
export function variantPath(step: number): string {
	return `.interp/php8.5-worker.growth-${String(step).replace('.', 'p')}.mjs`;
}

/**
 * The step the SHIPPING glue is tuned to, and why it is not emscripten's 0.20.
 *
 * Measured 2026-08-23 across three workloads, and re-measured after P30 turned opcache off. Both
 * tables are here because the difference between them is the finding.
 *
 * WITH OPCACHE ON, which is what shipped until 2026-08-23:
 *
 * | step | render MiB | install MiB | auth MiB | worst  | headroom to 128 MiB |
 * | ---- | ---------- | ----------- | -------- | ------ | ------------------- |
 * | 0.20 | 115.25     | 115.25      | 138.31   | 138.31 | **-10.31**          |
 * | 0.05 | 100.81     | 111.19      | 116.75   | 116.75 | 11.25               |
 *
 * WITH OPCACHE OFF, which is what ships now:
 *
 * | step | render MiB | install MiB | auth MiB | worst  | headroom to 128 MiB | grow events |
 * | ---- | ---------- | ----------- | -------- | ------ | ------------------- | ----------- |
 * | 0.20 | 96.00      | 115.25      | 115.25   | 115.25 | 12.75               | 1           |
 * | 0.10 | 96.00      | 105.63      | 105.63   | 105.63 | 22.38               | 1           |
 * | 0.05 | 96.00      | 100.81      | 105.88   | 105.88 | 22.13               | 2           |
 * | 0.01 | 96.00      | 97.00       | 103.13   | 103.13 | 24.88               | ~7          |
 * | 0    | 96.00      | 96.69       | 102.56   | 102.56 | 25.44               | many        |
 *
 * **THE AUTHENTICATED RENDER IS THE BINDING WORKLOAD**, and adding it is what made the step worth
 * changing at all. Scored on an anonymous render and an install the answer was "worth about 1%"; a
 * logged-in render -- the workload P7 exists to serve -- is where the peak actually lives.
 *
 * **AND THE FIRST TABLE'S HEADLINE DID NOT SURVIVE ITS OWN RE-MEASUREMENT.** It read "emscripten's
 * default does not fit a logged-in render inside the isolate AT ALL", which was true of the build it
 * was taken on and false of the one that ships: with opcache off, 0.20 peaks at 115.25 MiB with
 * 12.75 MiB to spare. P30 removed 23 MiB of that peak on its own. Neither change is worth its full
 * headline alone, and quoting either in isolation overstates it.
 *
 * 0.05 RATHER THAN 0.01 OR 0, on the current table. Those two buy 2.75 and 3.31 MiB more, and a grow
 * event COPIES the heap: 0.05 reaches the binding peak in 2 events against roughly 7 and
 * unbounded-many. The grow counts are derived from the series rather than counted, and labelled that
 * way because RULE 0 forbids reading the CPU cost off a local clock.
 *
 * A RENDER NO LONGER GROWS THE HEAP ON ANY ARM. 96.00 MiB across the whole column is not a broken
 * instrument -- it is what removing opcache's compile-time working set did, and the install and auth
 * columns still separate the arms, which is what makes the table a measurement rather than a control
 * repeated five times.
 */
export const SHIPPING_STEP = 0.05;

/** the tuned glue the shipping seam imports; emitted after the pristine one is sha256-verified */
export const TUNED_GLUE = '.interp/php8.5-worker.tuned.mjs';

/**
 * Emits the shipping glue at {@link SHIPPING_STEP}.
 *
 * Written BESIDE the pristine file rather than over it. `restore-artifacts.ts` verifies the
 * download against `cdn-manifest.json`, so rewriting in place would either break that check or
 * force the hash to cover a file this repo edits -- and a hash that covers a locally-mutated file
 * guarantees nothing.
 */
export function emitTunedGlue(root = process.cwd()): string {
	const source = resolve(root, SHIPPING_GLUE);
	if (!existsSync(source)) throw new Error(`no shipping glue at ${SHIPPING_GLUE}`);
	const glue = readFileSync(source, 'utf8');
	if (!STEP_SITE.test(glue)) {
		throw new Error('growth site not found in the glue; emscripten changed its emitted form');
	}
	const out = resolve(root, TUNED_GLUE);
	writeFileSync(out, glue.replace(STEP_SITE, `oldSize*(1+${SHIPPING_STEP}/cutDown)`));
	return out;
}

/** the sizes emscripten will try, in order, for one growth event */
export function growthLadder(oldSize: number, requestedSize: number, step: number): number[] {
	const tries: number[] = [];
	for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
		const overGrown = Math.min(oldSize * (1 + step / cutDown), requestedSize + 100_663_296);
		tries.push(Math.ceil(Math.max(requestedSize, overGrown) / PAGE) * PAGE);
	}
	return tries;
}

/**
 * Rewrite the glue at `step` and return where it was written.
 *
 * Fails loudly on a miss. A silent no-op here would produce a ladder whose arms are all the control,
 * which reads as "the step does not matter" -- the exact instrument error RULE 0 is about.
 */
export function emitVariant(step: number, root = process.cwd()): string {
	const source = resolve(root, SHIPPING_GLUE);
	if (!existsSync(source)) throw new Error(`no shipping glue at ${SHIPPING_GLUE}`);

	const glue = readFileSync(source, 'utf8');
	if (!STEP_SITE.test(glue)) {
		throw new Error('growth site not found in the glue; emscripten changed its emitted form');
	}

	const out = resolve(root, variantPath(step));
	writeFileSync(out, glue.replace(STEP_SITE, `oldSize*(1+${step}/cutDown)`));
	return out;
}

if (import.meta.main) {
	const steps = process.argv.slice(2).map(Number);
	if (!steps.length || steps.some((s) => !Number.isFinite(s) || s < 0)) {
		console.error('usage: bun scripts/measure/growth-glue.ts <step> [step ...]');
		process.exit(1);
	}
	for (const step of steps) console.log(`${step} -> ${emitVariant(step)}`);
}
