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
export type Abi = null | 'wasm64';

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
 */
const STEP_SITE = /oldSize\*\(1\+\.2\/cutDown\)/;

/** where a variant is written, keyed by step so a ladder run leaves every arm on disk */
export function variantPath(step: number): string {
	return `.interp/php8.5-worker.growth-${String(step).replace('.', 'p')}.mjs`;
}

/**
 * The step the SHIPPING glue is tuned to, and why it is neither emscripten's 0.20 nor the 0.05 that
 * shipped until 2026-08-24.
 *
 * MEASURED 2026-08-24 with `bun scripts/measure/growth-ladder.ts <steps>`: 0 plus every hundredth to
 * 0.20, plus thousandths across the one breakpoint. n=2 on every arm, n=3 on 0.05, n=4 on 0.069 and
 * 0.07, n=6 on the step-0 demand. Bytes only -- a grow COPIES the heap, so its cost is reported as
 * bytes copied rather than as a duration, which RULE 0 forbids reading off a local clock.
 *
 * THE PEAK IS A STEP FUNCTION OF THE STEP: `newSize = align(max(demand, oldSize*(1+step)), 64 KiB)`,
 * so what sets it is which RUNG first covers demand. Install demand is 101,580,800 on all 6 samples;
 * AUTH DEMAND IS BIMODAL, 107,610,112 and 107,675,648 three times each -- exactly one page apart,
 * and that page is what the choice below turns on.
 *
 * A render never grows the heap on any arm (96.00 MiB / 100,663,296). The AUTHENTICATED render is
 * the binding workload on every arm, so `worst` below is its peak.
 *
 * | step  | worst-case peak | MiB    | headroom   | MiB   | events | bytes copied |
 * | ----- | --------------- | ------ | ---------- | ----- | ------ | ------------ |
 * | 0     | 107,675,648     | 102.69 | 26,542,080 | 25.31 | many   | n/a          |
 * | 0.01  | 108,134,400     | 103.13 | 26,083,328 | 24.88 | 7      | 726,728,704  |
 * | 0.02  | 109,051,904     | 104.00 | 25,165,824 | 24.00 | 4      | 415,039,488  |
 * | 0.03  | 110,100,480     | 105.00 | 24,117,248 | 23.00 | 3      | 311,296,000  |
 * | 0.04  | 108,920,832     | 103.88 | 25,296,896 | 24.13 | 2      | 205,389,824  |
 * | 0.05  | 111,017,984     | 105.88 | 23,199,744 | 22.13 | 2      | 206,372,864  |
 * | 0.06  | 113,180,672     | 107.94 | 21,037,056 | 20.06 | 2      | 207,421,440  |
 * | 0.07  | 107,741,184     | 102.75 | 26,476,544 | 25.25 | 1      | 100,663,296  |
 * | 0.08  | 108,724,224     | 103.69 | 25,493,504 | 24.31 | 1      | 100,663,296  |
 * | 0.09  | 109,772,800     | 104.69 | 24,444,928 | 23.31 | 1      | 100,663,296  |
 * | 0.10  | 110,755,840     | 105.63 | 23,461,888 | 22.38 | 1      | 100,663,296  |
 * | 0.11  | 111,738,880     | 106.56 | 22,478,848 | 21.44 | 1      | 100,663,296  |
 * | 0.12  | 112,787,456     | 107.56 | 21,430,272 | 20.44 | 1      | 100,663,296  |
 * | 0.13  | 113,770,496     | 108.50 | 20,447,232 | 19.50 | 1      | 100,663,296  |
 * | 0.14  | 114,819,072     | 109.50 | 19,398,656 | 18.50 | 1      | 100,663,296  |
 * | 0.15  | 115,802,112     | 110.44 | 18,415,616 | 17.56 | 1      | 100,663,296  |
 * | 0.16  | 116,785,152     | 111.38 | 17,432,576 | 16.63 | 1      | 100,663,296  |
 * | 0.17  | 117,833,728     | 112.38 | 16,384,000 | 15.63 | 1      | 100,663,296  |
 * | 0.18  | 118,816,768     | 113.31 | 15,400,960 | 14.69 | 1      | 100,663,296  |
 * | 0.19  | 119,799,808     | 114.25 | 14,417,920 | 13.75 | 1      | 100,663,296  |
 * | 0.20  | 120,848,384     | 115.25 | 13,369,344 | 12.75 | 1      | 100,663,296  |
 *
 * THE BREAKPOINT IS BETWEEN 0.068 AND 0.069, and it is a 7,274,496-byte cliff: 0.068 peaks at
 * 114,884,608 in two events, 0.069 at 107,610,112 in one. Every thousandth from 0.061 to 0.068 sits
 * on the wrong side of it and is dominated. There are no plateaus at hundredth resolution -- 1,536
 * pages times 0.01 is ~15 pages, so every hundredth resolves its own rung and the thousandth
 * refinement moved the verdict rather than tying.
 *
 * THE PARETO FRONTIER on headroom + events + bytes copied + spare events is 0.01, 0.02, 0.03, 0.04
 * and 0.07. No two frontier arms tie on all four, so the frontier is nowhere flat. 0.05 is DOMINATED
 * by 0.04 and 0.08-0.20 are all dominated by 0.07.
 *
 * MARGIN IS THE FOURTH MEASUREMENT AND IT IS WHY THE FRONTIER ARM DOES NOT SHIP. A rung is only
 * worth its headroom if demand stays under it, and auth demand MOVES: 107,610,112 and 107,675,648
 * three times each today, and 107,544,576 recorded on 2026-08-23 -- a 2-page observed span, drifting
 * up. Margin over the highest observed demand is 1 page at 0.07, 16 at 0.08, 32 at 0.09.
 *
 * 0.069 IS THE DEMONSTRATION. Its rung EQUALS the lower demand, so it fits only on that reading:
 * over 4 samples it answered 107,610,112 three times and 115,081,216 once, a 7,471,104-byte swing on
 * one arm. 0.07 held 107,741,184 on all 4 -- but its 1 page of margin is INSIDE the span demand has
 * already been observed to move, so it is the same trap one page further out.
 *
 * 0.08 SHIPS, off the frontier and deliberately. Against 0.07 it gives up 983,040 bytes of headroom
 * to buy 16x the margin, and the trade is asymmetric: overshooting 0.07's rung costs 7,602,176 bytes,
 * so 983,040 is bought against a 7.7x loss. Against the previous default 0.05 it gives up nothing --
 * 2,293,760 bytes MORE headroom, one grow event rather than two, 105,709,568 fewer bytes copied.
 * 0.05 was dominated by both 0.04 and 0.08, which no earlier table scored because neither 0.04 nor
 * anything between 0.05 and 0.10 had ever been run.
 */
export const SHIPPING_STEP = 0.08;

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
export function emitTunedGlue(root = process.cwd(), abi: Abi = null): string {
	const from = glueFor(abi);
	const source = resolve(root, from);
	if (!existsSync(source)) throw new Error(`no shipping glue at ${from}`);
	const glue = readFileSync(source, 'utf8');
	if (!STEP_SITE.test(glue)) {
		throw new Error(`growth site not found in ${from}; emscripten changed its emitted form`);
	}
	const out = resolve(root, tunedGlueFor(abi));
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
