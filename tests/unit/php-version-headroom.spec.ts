import { describe, expect, it } from 'vitest';
import {
	CONTROL_BINARY_GZ,
	FREE_BUNDLE_CEILING,
	STOCK_BINARY_GZ,
	TRIM_SAVING_GZ,
	controlTotalGz,
	measuredVerdict,
	stockBinaryGz,
	versionVerdict
} from '../../scripts/measure/php-version-headroom';

/**
 * The bundle-ceiling arithmetic, which was wrong by hand.
 *
 * The original verdict was "PHP 8.4 fits comfortably", derived against **268,873 B** of headroom.
 * That is the headroom of the `static-o2` wasm BINARY, not of the deployed BUNDLE, and the free-plan
 * ceiling applies to the bundle. The mistake was worth more than the entire cost of the bump, so it
 * is now a function with tests instead of a paragraph.
 */

/** the bundle measured with the canonical config plus assets/.assetsignore */
const CURRENT_BUNDLE = 3_006_761;

describe('the basis matters more than the method', () => {
	it('reports 8.4 as NOT fitting against the real bundle headroom', () => {
		const v = versionVerdict('8.4', CURRENT_BUNDLE);
		expect(v.fits).toBe(false);
		// both methods over is what makes this a verdict rather than a coin flip
		expect(v.absoluteOverBy).toBeGreaterThan(0);
		expect(v.proportionalOverBy).toBeGreaterThan(0);
	});

	it('would have reported 8.4 as fitting against the BINARY headroom, which is the original bug', () => {
		// the regression test for the reasoning error: feed it a bundle figure that leaves the
		// binary's 268,873 B of room and the same function says "fits", proving the verdict was
		// driven by the basis rather than by the estimate
		const asIfBinary = FREE_BUNDLE_CEILING - 268_873;
		const v = versionVerdict('8.4', asIfBinary);
		expect(v.proportionalOverBy).toBeLessThan(0);
		expect(v.absoluteOverBy).toBeLessThan(0);
		expect(v.fits).toBe(true);
	});

	it('is far over on 8.5, by an order of magnitude more than 8.4', () => {
		const v = versionVerdict('8.5', CURRENT_BUNDLE);
		expect(v.fits).toBe(false);
		// ext/uri arrives mandatory in 8.5 and statically bundles uriparser and lexbor, so the
		// step is nothing like the 8.3 -> 8.4 one. Both methods are unreliable here -- see the
		// GROWTH_PER_MINOR docblock -- which is why only a built 8.5 settles the product question
		expect(v.proportionalOverBy).toBeGreaterThan(600_000);
	});
});

describe('fitting requires BOTH methods, because the truth is between them', () => {
	it('a bundle where only the proportional method fits does not count as fitting', () => {
		const v8 = versionVerdict('8.4', CURRENT_BUNDLE);
		// pick a bundle that lands between the two estimates
		const between = FREE_BUNDLE_CEILING - v8.absoluteDeltaGz + 1;
		const v = versionVerdict('8.4', between);
		expect(v.absoluteOverBy).toBeGreaterThan(0);
		expect(v.proportionalOverBy).toBeLessThan(0);
		expect(v.fits).toBe(false);
	});

	it('proportional is always the smaller delta, since the trim removes a fraction', () => {
		for (const version of ['8.4', '8.5']) {
			const v = versionVerdict(version, CURRENT_BUNDLE);
			expect(v.proportionalDeltaGz).toBeLessThan(v.absoluteDeltaGz);
		}
	});
});

describe('stock sizes are measured where known and flagged where not', () => {
	it('marks 8.4 and 8.5 measured, since both stock builds were gzipped', () => {
		expect(stockBinaryGz('8.4')).toEqual({ bytes: STOCK_BINARY_GZ['8.4'], measured: true });
		expect(stockBinaryGz('8.5')).toEqual({ bytes: STOCK_BINARY_GZ['8.5'], measured: true });
	});

	it('still extrapolates a version with no stock build, upward from the highest measured', () => {
		const eight5 = stockBinaryGz('8.6').bytes;
		expect(eight5).toBeGreaterThan(STOCK_BINARY_GZ['8.5'] as number);
	});

	it('refuses to extrapolate downward, which would invent a smaller build', () => {
		expect(() => stockBinaryGz('8.2')).toThrow(/not above the measured/);
	});

	it('keeps the trim saving below the 8.3 binary it was measured on', () => {
		// a saving larger than the binary would make keptFraction negative and flip every verdict
		expect(TRIM_SAVING_GZ).toBeLessThan(STOCK_BINARY_GZ['8.3'] as number);
		expect(TRIM_SAVING_GZ).toBeGreaterThan(0);
	});
});

/**
 * The built control binaries, which replace the estimate. These are regression tests for the
 * REASONING, not for arithmetic: each one pins a fact the estimator got wrong, so a future edit
 * that quietly reintroduces an extrapolation for 8.4 or 8.5 fails here.
 */
describe('measured control binaries beat both estimates', () => {
	it('costs 5.8x the pessimistic estimate on 8.4, which is why the estimator is superseded', () => {
		const estimated = versionVerdict('8.4', CURRENT_BUNDLE);
		const measured = measuredVerdict('8.4', CURRENT_BUNDLE);
		// the estimator bracketed +144,935..+173,830; measured is +1,002,391
		expect(measured.deltaGz).toBeGreaterThan(estimated.absoluteDeltaGz * 5);
		expect(measured.deltaGz).toBe(1_002_391);
	});

	it('is SMALLER on 8.5 than on 8.4, which no version of the estimator can produce', () => {
		// 8.5 promotes lexbor out of ext/dom and drops the CJK encoding tables on the way, which
		// pays for the whole of ext/uri including uriparser. The estimator only ever climbs, so a
		// negative step is the cleanest proof that a built binary was required
		const four = measuredVerdict('8.4', CURRENT_BUNDLE);
		const five = measuredVerdict('8.5', CURRENT_BUNDLE);
		expect(five.controlTotalGz).toBeLessThan(four.controlTotalGz);
		expect(five.deltaGz).toBeLessThan(four.deltaGz);
		expect(versionVerdict('8.5', CURRENT_BUNDLE).absoluteDeltaGz).toBeGreaterThan(
			versionVerdict('8.4', CURRENT_BUNDLE).absoluteDeltaGz
		);
	});

	it('reports both versions as not fitting, on the measured figures', () => {
		for (const version of ['8.4', '8.5']) {
			expect(measuredVerdict(version, CURRENT_BUNDLE).fits).toBe(false);
		}
	});

	it('clears the ceiling on the WASM ALONE, so no bundle accounting can rescue either', () => {
		// the decisive form of the verdict: positive here means the version cannot fit even with a
		// zero-byte worker, so arguing about the non-binary overhead cannot change the answer
		for (const version of ['8.4', '8.5']) {
			expect(measuredVerdict(version, CURRENT_BUNDLE).wasmAloneOverBy).toBeGreaterThan(0);
		}
		expect(CONTROL_BINARY_GZ['8.3']?.wasm).toBeLessThan(FREE_BUNDLE_CEILING);
	});

	it('has a zero delta against itself, so 8.3 is the stated baseline', () => {
		expect(measuredVerdict('8.3', CURRENT_BUNDLE).deltaGz).toBe(0);
		expect(controlTotalGz('8.3')).toBe(2_876_855);
	});

	it('refuses a version with no built binary rather than extrapolating one', () => {
		expect(controlTotalGz('8.6')).toBeUndefined();
		expect(() => measuredVerdict('8.6', CURRENT_BUNDLE)).toThrow(/no built control binary/);
	});
});
