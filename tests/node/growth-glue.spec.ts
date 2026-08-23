import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	emitVariant,
	growthLadder,
	SHIPPING_GLUE,
	variantPath
} from '../../scripts/measure/growth-glue.js';

/**
 * The heap-growth rewrite, and the guard that stops it becoming a silent no-op.
 *
 * THE FAILURE THIS EXISTS FOR is the one this repository keeps hitting: a rewrite that matches
 * nothing still produces an output file, so a ladder run would emit N arms that are all the control
 * and read as "the growth step does not matter". `emitVariant` throws on a miss and this pins that.
 *
 * IT ALSO PINS EMSCRIPTEN'S EMITTED FORM, which is the real fragility. The growth policy is glue
 * JavaScript rather than anything in the `.wasm`, so an interpreter rebuild that ships a newer
 * emscripten can change `oldSize*(1+.2/cutDown)` without changing a single thing this project wrote.
 * Failing here is how that gets noticed.
 *
 * SKIPPED WITHOUT THE INTERPRETER. `.interp/` is a build artifact a clean checkout does not have;
 * `growthLadder` is pure arithmetic and is asserted either way.
 */

const have = existsSync(resolve(process.cwd(), SHIPPING_GLUE));
const PAGE = 65_536;

describe('emscripten growth arithmetic', () => {
	it('reproduces the shipping peak from INITIAL_MEMORY in one step', () => {
		// 100,663,296 grown once at 0.20 is the measured 120,848,384, to the byte
		expect(growthLadder(100_663_296, 100_663_297, 0.2)[0]).toBe(120_848_384);
	});

	it('degrades through THREE tries, so the cap is not a cliff', () => {
		// `for (cutDown = 1; cutDown <= 4; cutDown *= 2)` gives 0.20, 0.10, 0.05. When the first
		// grow throws, emscripten retries smaller rather than aborting -- which is why "one growth
		// event from OOM" was the wrong reading of the same arithmetic
		const tries = growthLadder(120_848_384, 120_848_385, 0.2);
		expect(tries).toHaveLength(3);
		expect(tries[0]).toBeGreaterThan(128 * 1_048_576);
		expect(tries[2]).toBeLessThan(128 * 1_048_576);
		// strictly decreasing, so each retry is a real second chance rather than the same size
		expect(tries[1]).toBeLessThan(tries[0]!);
		expect(tries[2]).toBeLessThan(tries[1]!);
	});

	it('collapses to demand rounded to a page at a step of 0', () => {
		const demand = 110_000_001;
		const [only] = growthLadder(100_663_296, demand, 0);
		expect(only).toBe(Math.ceil(demand / PAGE) * PAGE);
	});

	it('never returns a size below the request, at any step', () => {
		for (const step of [0, 0.01, 0.05, 0.2, 1]) {
			for (const size of growthLadder(100_663_296, 130_000_000, step)) {
				expect(size).toBeGreaterThanOrEqual(130_000_000);
			}
		}
	});
});

describe.skipIf(!have)('rewriting the shipping glue', () => {
	it('emits a variant whose growth site carries the requested step', () => {
		const out = variantPath(0.05);
		try {
			emitVariant(0.05);
			const glue = readFileSync(resolve(process.cwd(), out), 'utf8');
			expect(glue).toContain('oldSize*(1+0.05/cutDown)');
			expect(glue).not.toContain('oldSize*(1+.2/cutDown)');
			// byte-identical everywhere else, so an arm differs from the control in the growth
			// policy and in nothing else. A length bound would pass on a truncated variant
			const source = readFileSync(resolve(process.cwd(), SHIPPING_GLUE), 'utf8');
			expect(glue.replace('oldSize*(1+0.05/cutDown)', 'oldSize*(1+.2/cutDown)')).toBe(source);
		} finally {
			rmSync(resolve(process.cwd(), out), { force: true });
		}
	});

	it('throws rather than emitting a control arm when the site is gone', () => {
		expect(() => emitVariant(0.1, '/nonexistent-root')).toThrow(/no shipping glue/);
	});
});
