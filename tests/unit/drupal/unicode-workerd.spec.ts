import { describe, expect, it } from 'vitest';
import corpus from '../../fixtures/unicode-corpus.json';

/**
 * The same casing sweep the corpus generator runs, executed INSIDE workerd.
 *
 * The shipping tables come from mbstring and never from a JavaScript engine, so this is not the
 * generator. It is the control that makes "which ICU is in the loop" a measured thing rather than
 * an assumption: the corpus says what the extension answers, and this says what the runtime the
 * site executes in answers for the same 1,112,064 scalar values.
 *
 * A failure here is not a broken table. It means workerd's ICU moved, and the honest response is
 * to re-measure and update the number in the assertion rather than to change the tables -- the
 * oracle is `scripts/measure/unicode-corpus.php`, which does not run in this lane at all.
 *
 * Needs no PHP and no build artifact, so it runs on every commit.
 */

type Packed = { ranges: [number, number, number][]; map: Record<string, number[]> };

function expand(p: Packed): Map<number, string> {
	const out = new Map<number, string>();
	for (const [lo, hi, delta] of p.ranges) {
		for (let cp = lo; cp <= hi; cp++) out.set(cp, String.fromCodePoint(cp + delta));
	}
	for (const [cp, res] of Object.entries(p.map))
		out.set(Number(cp), String.fromCodePoint(...res));
	return out;
}

/** every scalar where the engine and the extension disagree, identity counting as absent */
function sweep(expected: Map<number, string>, fold: (s: string) => string): number[] {
	const out: number[] = [];
	for (let cp = 0; cp <= 0x10ffff; cp++) {
		if (cp >= 0xd800 && cp <= 0xdfff) continue;
		const ch = String.fromCodePoint(cp);
		if (fold(ch) !== (expected.get(cp) ?? ch)) out.push(cp);
	}
	return out;
}

describe("workerd's case mappings against mbstring", () => {
	it('agrees on every scalar value, which is why a workerd-generated table would look fine', () => {
		// through unknown: the JSON import types `ranges` as number[][], which is the same data
		const lower = sweep(expand(corpus.case.lower as unknown as Packed), (s) => s.toLowerCase());
		const upper = sweep(expand(corpus.case.upper as unknown as Packed), (s) => s.toUpperCase());
		expect(lower.map((cp) => cp.toString(16))).toEqual([]);
		expect(upper.map((cp) => cp.toString(16))).toEqual([]);
	}, 60_000);

	it('sweeps the whole scalar space, not a plane of it', () => {
		// the guard on the guard: a loop that stopped at U+FFFF would report 0 diffs too
		expect(corpus.provenance.scalars).toBe(0x110000 - 2048);
		expect(String.fromCodePoint(0x10400).toLowerCase()).toBe(String.fromCodePoint(0x10428));
	});
});
