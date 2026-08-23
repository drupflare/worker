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
