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
 * somewhere in a 19.25 MiB interval" into a reading.
 */

const PAGE = 65_536;

/** the shipping glue, and the only input; the `.wasm` is untouched because it holds no policy */
export const SHIPPING_GLUE = '.interp/php8.5-worker.mjs';

/** every pointer ABI a glue is emitted for; `null` is wasm32, which needs no suffix */
export type Abi = null | 'wasm64' | 'long64' | 'wasm32';

/** the pristine glue for an ABI, as `phasm` publishes it */
export function glueFor(abi: Abi): string {
	return abi === null ? SHIPPING_GLUE : `.interp/php8.5-${abi}-worker.mjs`;
}

/** where the tuned copy for an ABI is written */
export function tunedGlueFor(abi: Abi): string {
	return abi === null ? TUNED_GLUE : `.interp/php8.5-${abi}-worker.tuned.mjs`;
}

/**
 * The geometric step as emscripten emits it.
 *
 * Anchored on `cutDown` rather than on the bare number: `.2` occurs all over a 12 MB glue file and
 * this expression occurs once, which a spec asserts before any rewrite happens.
 *
 * The step itself is matched loosely because not every published glue is emscripten-fresh: phasm's
 * LP64 patch rewrites `growMemory` on the wasm64 build and emits `0.05` there, so an anchor on `.2`
 * refuses the one arm that most needs re-emitting.
 */
const STEP_SITE = /oldSize\*\(1\+[0-9.]+\/cutDown\)/;

/** where a variant is written, keyed by step so a ladder run leaves every arm on disk */
export function variantPath(step: number): string {
	return `.interp/php8.5-worker.growth-${String(step).replace('.', 'p')}.mjs`;
}

/**
 * The geometric growth step the shipping glue is emitted at.
 *
 * A peak is a STEP FUNCTION of the step -- `newSize = align(max(demand, oldSize * (1 + step)))` --
 * so it is flat across a range and then jumps, and interpolating between two arms is invalid. What
 * decides an arm is which rung first exceeds the AUTHENTICATED demand, which is the binding
 * workload; a plain render reads 96.00 MiB on every arm and answers nothing.
 *
 * 0.13 ships because long64 does. Its demand brackets to (111,738,880, 112,787,456], and 0.12
 * reaches that in one grow with ZERO pages of margin -- the trap 0.069 demonstrated on wasm32, where
 * a rung equal to the demand fit on three readings of four. 0.13 takes the rung above: one grow to
 * 113,770,496, 19.50 MiB clear of the 128 MiB isolate.
 *
 * **Margin is a fourth metric and it overrules the Pareto frontier**, because demand MOVES. The full
 * wasm32 sweep behind that rule -- every hundredth to 0.20 plus thousandths across the breakpoint --
 * is in `TECHNICAL_REPORT.md` rather than here.
 */ export const SHIPPING_STEP = 0.13;

/**
 * The step per ABI, because the optimum is a property of that ABI's demand.
 *
 * `wasm32` is the OFF arm and keeps its own 0.08; reading 0.13 onto it costs 4.81 MiB for nothing.
 * wasm64 falls back deliberately -- its sweep ran at 0.05 and a number here would be invented.
 */
const STEP_BY_ABI: Record<string, number> = { wasm32: 0.08 };

export function stepFor(abi: Abi): number {
	return (abi !== null && STEP_BY_ABI[abi]) || SHIPPING_STEP;
}

/** the tuned glue the shipping seam imports; emitted after the pristine one is sha256-verified */
export const TUNED_GLUE = '.interp/php8.5-worker.tuned.mjs';

/**
 * Emits the glue for an ABI at {@link stepFor}.
 *
 * Written BESIDE the pristine file rather than over it. `restore-artifacts.ts` verifies the
 * download against `cdn-manifest.json`, so rewriting in place would either break that check or
 * force the hash to cover a file this repo edits -- and a hash that covers a locally-mutated file
 * guarantees nothing.
 */
export function emitTunedGlue(root = process.cwd(), abi: Abi = null): string {
	const from = glueFor(abi);
	const source = resolve(root, from);
	if (!existsSync(source)) throw new Error(`no shipping glue at ${from}`);
	const glue = readFileSync(source, 'utf8');
	if (!STEP_SITE.test(glue)) {
		throw new Error(`growth site not found in ${from}; emscripten changed its emitted form`);
	}
	const out = resolve(root, tunedGlueFor(abi));
	writeFileSync(out, glue.replace(STEP_SITE, `oldSize*(1+${stepFor(abi)}/cutDown)`));
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
	if (!steps.length || steps.some((s: number) => !Number.isFinite(s) || s < 0)) {
		console.error('usage: bun scripts/measure/growth-glue.ts <step> [step ...]');
		process.exit(1);
	}
	for (const step of steps) console.log(`${step} -> ${emitVariant(step)}`);
}
