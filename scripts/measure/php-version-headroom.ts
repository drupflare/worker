/**
 * Whether a PHP minor-version bump fits under the free-plan bundle ceiling.
 *
 *   bun scripts/measure/php-version-headroom.ts [--bundle=3006761]
 *
 * A script rather than a paragraph. This is arithmetic, so it is the same answer every time it is
 * asked and it does not belong in prose that has to be re-derived by hand. It already went wrong
 * once by hand: the bump was reported as "8.4 fits comfortably" against **268,873 B** of headroom, which
 * is the headroom of the **BINARY** (`static-o2`, 2,876,855 gz) rather than of the deployed
 * **BUNDLE**. The ceiling applies to the bundle -- binary plus worker JS plus everything else -- so
 * a binary-only figure overstates the room by more than the entire cost of the bump.
 *
 * The three figures the report carried, and what each actually measures:
 *
 * | figure    | measures                                             | usable for a fit decision? |
 * | --------- | ---------------------------------------------------- | -------------------------- |
 * | 268,873 B | the `static-o2` wasm binary alone against the ceiling | **no** -- not a bundle     |
 * | 165,776 B | a bundle built from a STAGED-asset config             | no -- not the shipping one |
 * | 143,299 B | the deployed bundle, as of the previous deploy        | superseded                 |
 *
 * The only usable number is the CURRENT bundle's, from
 * `bunx wrangler deploy --dry-run -c wrangler.jsonc`.
 *
 * The two estimation methods disagree and both are reported. Absolute assumes the trim
 * saves the same bytes on a bigger binary; proportional assumes it saves the same fraction. The
 * truth is between them, so a bump only counts as fitting when BOTH say it fits.
 */

/** the free-plan gzipped worker bundle ceiling, 3 MiB */
export const FREE_BUNDLE_CEILING = 3_145_728;

/**
 * BUILT control binaries, `gzip -9`, from `phasm/src/rc/control{,84,85}.rc` -- the same extension
 * selection at three PHP versions, so the deltas are attributable to php-src and nothing else.
 *
 * These supersede the estimator below for 8.4 and 8.5. Both methods there were wrong, and not by a
 * little: for 8.4 they predicted +173,830 (absolute) / +144,935 (proportional) and the measured
 * cost is **+1,002,391** -- 5.8x the pessimistic one. The cause is that neither method knew what
 * the delta was MADE of. 8.4 vendors lexbor inside `ext/dom` for `Dom\HTMLDocument`, and Drupal
 * requires ext-dom, so a trim cannot reach it: measured as LTO bitcode, `ext/dom/lexbor` is
 * 4,195,780 B in 8.4 against 0 in 8.3, while Zend, ext/standard and main each move under 2%.
 *
 * And 8.5 is smaller than 8.4, which no version of the estimator can produce because it only
 * climbs. 8.5 promotes lexbor to its own always-on `ext/lexbor` and drops the CJK encoding tables
 * on the way (`gb18030` 767,216 + `big5` 615,108 + `euc_kr` 600,052 + `jis0208` 254,996 +
 * `jis0212` 194,244 B of bitcode, replaced by one 825,364 B `multi.o`). That pays for all of
 * `ext/uri`, uriparser included, with change left over.
 *
 * Provenance: `phasm/vendor/static-o2` (8.3.11, the shipping binary), `static-control84` (8.4.1),
 * `static-control85` (8.5.2). Every one passed
 * `inspect-build.sh --expect-static --expect-rc`, so each is known to carry every extension its rc
 * asked for rather than to have silently dropped the ones needing a library.
 */
export const CONTROL_BINARY_GZ: Record<string, { wasm: number; glue: number }> = {
	'8.3': { wasm: 2_757_693, glue: 119_162 },
	'8.4': { wasm: 3_756_464, glue: 122_782 },
	'8.5': { wasm: 3_686_964, glue: 146_358 }
};

/** stock upstream builds, gzipped, measured -- not the trimmed binaries that ship */
export const STOCK_BINARY_GZ: Record<string, number> = {
	'8.3': 3_332_177,
	'8.4': 3_506_007,
	// measured on php-wasm's own stock 8.5 build, not extrapolated
	'8.5': 4_260_565
};

/** what the trim plus `-O2` plus the static link is worth on the 8.3 binary, gzipped */
export const TRIM_SAVING_GZ = 553_016;

/**
 * Observed growth per PHP minor, used only where a stock build has not been measured.
 *
 * Does not hold across 8.4 -> 8.5. PHP 8.5 makes `ext/uri` a mandatory always-on extension that
 * statically bundles uriparser and lexbor, so the step is +962,588 gz against 8.3 where this
 * constant predicts +356,142 -- wrong by 2.7x. Both `keptFraction` methods below are also
 * unreliable across that step: the delta is new extension bulk rather than proportionally
 * shrinkable interpreter mass, so proportional errs optimistic and absolute errs pessimistic.
 * Only a built-and-gzipped 8.5 settles it.
 */
export const GROWTH_PER_MINOR = 0.052;

export type MeasuredVerdict = {
	version: string;
	/** wasm + glue, both `gzip -9`, from the built control binary */
	controlTotalGz: number;
	/** the bump's real cost against the shipping 8.3 control */
	deltaGz: number;
	bundleGz: number;
	overBy: number;
	fits: boolean;
	/**
	 * By how much the WASM ALONE clears the ceiling, before the glue and before a byte of worker
	 * JS. Reported separately because it is the figure no bundle-accounting argument can move: if
	 * this is positive, the version cannot fit however small the rest of the bundle gets.
	 */
	wasmAloneOverBy: number;
};

/** wasm + glue, gzipped, for a version with a BUILT control binary; undefined when none exists */
export function controlTotalGz(version: string): number | undefined {
	const built = CONTROL_BINARY_GZ[version];
	return built === undefined ? undefined : built.wasm + built.glue;
}

/**
 * The measured verdict for a version that has a built control binary.
 *
 * Prefer this over {@link versionVerdict} whenever it returns a value: it substitutes one measured
 * total for two estimates that bracketed the wrong number by 5.8x on 8.4.
 *
 * @param version the target PHP minor, e.g. `'8.5'`
 * @param currentBundleGz the CURRENT deployed bundle, gzipped, from `wrangler deploy --dry-run`
 * @throws RangeError when no control binary has been built for `version`
 */
export function measuredVerdict(version: string, currentBundleGz: number): MeasuredVerdict {
	const total = controlTotalGz(version);
	const base = controlTotalGz('8.3');
	if (total === undefined || base === undefined) {
		throw new RangeError(`no built control binary for PHP ${version}`);
	}
	const deltaGz = total - base;
	const bundleGz = currentBundleGz + deltaGz;
	const wasm = (CONTROL_BINARY_GZ[version] as { wasm: number }).wasm;
	return {
		version,
		controlTotalGz: total,
		deltaGz,
		bundleGz,
		overBy: bundleGz - FREE_BUNDLE_CEILING,
		fits: bundleGz <= FREE_BUNDLE_CEILING,
		wasmAloneOverBy: wasm - FREE_BUNDLE_CEILING
	};
}

export type Verdict = {
	version: string;
	stockGz: number;
	/** the bump's cost if the trim saves the same BYTES on the larger binary */
	absoluteDeltaGz: number;
	/** the bump's cost if the trim saves the same FRACTION */
	proportionalDeltaGz: number;
	absoluteBundleGz: number;
	proportionalBundleGz: number;
	absoluteOverBy: number;
	proportionalOverBy: number;
	/** fits only when BOTH methods fit; the truth lies between them */
	fits: boolean;
	measured: boolean;
};

/** the stock gzipped size of a version, measured where known and extrapolated where not */
export function stockBinaryGz(version: string): { bytes: number; measured: boolean } {
	const known = STOCK_BINARY_GZ[version];
	if (known !== undefined) return { bytes: known, measured: true };

	// extrapolate from the highest measured version at the observed per-minor growth
	const measuredVersions = Object.keys(STOCK_BINARY_GZ).sort();
	const highest = measuredVersions[measuredVersions.length - 1] as string;
	const [hMajor, hMinor] = highest.split('.').map(Number) as [number, number];
	const [vMajor, vMinor] = version.split('.').map(Number) as [number, number];
	const steps = (vMajor - hMajor) * 100 + (vMinor - hMinor);
	if (steps <= 0) throw new RangeError(`${version} is not above the measured ${highest}`);
	const base = STOCK_BINARY_GZ[highest] as number;
	return { bytes: Math.round(base * Math.pow(1 + GROWTH_PER_MINOR, steps)), measured: false };
}

/**
 * Whether swapping the shipping 8.3 binary for `version` keeps the bundle under the ceiling.
 *
 * @param version the target PHP minor, e.g. `'8.4'`
 * @param currentBundleGz the CURRENT deployed bundle, gzipped, from `wrangler deploy --dry-run`
 */
export function versionVerdict(version: string, currentBundleGz: number): Verdict {
	const { bytes: stockGz, measured } = stockBinaryGz(version);
	const base = STOCK_BINARY_GZ['8.3'] as number;
	const rawDelta = stockGz - base;
	// the trim removed this fraction of the 8.3 binary; proportional assumes it removes the same
	// fraction of the bigger one
	const keptFraction = 1 - TRIM_SAVING_GZ / base;

	const absoluteDeltaGz = rawDelta;
	const proportionalDeltaGz = Math.round(rawDelta * keptFraction);
	const absoluteBundleGz = currentBundleGz + absoluteDeltaGz;
	const proportionalBundleGz = currentBundleGz + proportionalDeltaGz;

	return {
		version,
		stockGz,
		absoluteDeltaGz,
		proportionalDeltaGz,
		absoluteBundleGz,
		proportionalBundleGz,
		absoluteOverBy: absoluteBundleGz - FREE_BUNDLE_CEILING,
		proportionalOverBy: proportionalBundleGz - FREE_BUNDLE_CEILING,
		fits:
			absoluteBundleGz <= FREE_BUNDLE_CEILING && proportionalBundleGz <= FREE_BUNDLE_CEILING,
		measured
	};
}

if (import.meta.main) {
	const arg = process.argv.find((a: string) => a.startsWith('--bundle='));
	// A SNAPSHOT, NOT A FACT. Measured 3,006,761 and then 3,018,014 eleven thousand bytes later, from
	// ordinary source growth in between -- so a quoted headroom is stale the next time anyone adds a
	// line of TypeScript. Always pass the freshly measured figure at the moment of the decision.
	const SNAPSHOT_BUNDLE_GZ = 3_018_014;
	const bundle = arg ? Number(arg.slice('--bundle='.length)) : SNAPSHOT_BUNDLE_GZ;
	if (!arg) {
		console.log(
			'NOTE: using a SNAPSHOT bundle size. Re-measure with\n' +
				'  bunx wrangler deploy --dry-run -c wrangler.jsonc\n' +
				'and pass --bundle=<gzip bytes>, because this figure drifts.\n'
		);
	}
	const headroom = FREE_BUNDLE_CEILING - bundle;

	console.log(`current bundle      ${bundle.toLocaleString()} gz`);
	console.log(`free ceiling        ${FREE_BUNDLE_CEILING.toLocaleString()}`);
	console.log(`headroom            ${headroom.toLocaleString()} B\n`);

	for (const version of ['8.4', '8.5']) {
		const v = versionVerdict(version, bundle);
		const label = v.measured ? 'measured stock' : 'extrapolated stock';
		console.log(`PHP ${version} (${label} ${v.stockGz.toLocaleString()} gz)`);
		console.log(
			`  absolute      +${v.absoluteDeltaGz.toLocaleString()} -> ${v.absoluteBundleGz.toLocaleString()}` +
				`  ${v.absoluteOverBy > 0 ? `${v.absoluteOverBy.toLocaleString()} OVER` : `${(-v.absoluteOverBy).toLocaleString()} under`}`
		);
		console.log(
			`  proportional  +${v.proportionalDeltaGz.toLocaleString()} -> ${v.proportionalBundleGz.toLocaleString()}` +
				`  ${v.proportionalOverBy > 0 ? `${v.proportionalOverBy.toLocaleString()} OVER` : `${(-v.proportionalOverBy).toLocaleString()} under`}`
		);
		console.log(`  verdict       ${v.fits ? 'FITS on both methods' : 'DOES NOT FIT'}\n`);
	}

	// the estimates above are kept only so the two can be read against each other; where a control
	// binary exists the measured line is the answer and the bracket is noise
	console.log('MEASURED, from built control binaries:\n');
	for (const version of Object.keys(CONTROL_BINARY_GZ)) {
		if (version === '8.3') continue;
		const m = measuredVerdict(version, bundle);
		console.log(
			`PHP ${version} (control ${m.controlTotalGz.toLocaleString()} gz wasm+glue)` +
				`  delta ${m.deltaGz >= 0 ? '+' : ''}${m.deltaGz.toLocaleString()}`
		);
		console.log(
			`  bundle        ${m.bundleGz.toLocaleString()}` +
				`  ${m.overBy > 0 ? `${m.overBy.toLocaleString()} OVER` : `${(-m.overBy).toLocaleString()} under`}`
		);
		console.log(
			`  wasm alone    ${m.wasmAloneOverBy > 0 ? `${m.wasmAloneOverBy.toLocaleString()} OVER the ceiling before the glue` : `${(-m.wasmAloneOverBy).toLocaleString()} under`}`
		);
		console.log(`  verdict       ${m.fits ? 'FITS' : 'DOES NOT FIT'}\n`);
	}
}
