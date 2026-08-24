import { describe, expect, it } from 'vitest';
import { MB_FIX, MB_SANITIZE } from '../../../src/drupal/mb-fix';

/**
 * Ported from `scripts/test-mb-fix.mjs` (25 hand-rolled assertions; 26 tests here).
 *
 * What changed in the port, which is the load-bearing part. The old script shelled out
 * to native PHP and used the REAL mbstring extension as its oracle: whatever
 * `mb_substr()` does to a malformed string is by definition right, since the point of the
 * fix is to make the wasm build agree with a native one. Vitest here runs inside workerd,
 * where `node:child_process` is not implemented (`execFileSync` throws
 * "The child_process.execFileSync method is not implemented"), so native PHP cannot be
 * invoked at test time.
 *
 * So the oracle is RECORDED rather than live. Every `oracle` below is
 * `bin2hex(mb_substr($raw, 0, 100000))` measured on native PHP 8.5.7 with real mbstring
 * loaded, and `chars` is `mb_strlen($raw)` from the same run. `sanitize()` is a byte-for-byte
 * transliteration of the shipped `cfw_mb_sanitize()` in `src/drupal/mb-fix.js`, and the
 * "mirrors the shipped PHP" test below pins the two together: the PHP decision table is
 * read out of `MB_SANITIZE` and compared against what this file implements, so a range
 * edited in the PHP without being mirrored here fails the suite instead of drifting.
 *
 * One control was not carried over. The old script's two iconv controls needed the real `iconv`
 * extension -- `iconv_substr("abc\xff\xfedef", 0, 100, 'UTF-8')` returns FALSE, and
 * `(string) false` is `''`, which is the actual bug and the evidence that compiling iconv
 * into the wasm build is NOT the fix. There is no iconv (and no PHP) in the workerd test
 * isolate, so that control cannot execute here. It is kept as the recorded measurement
 * above and in `src/drupal/mb-fix.js`'s docblock; reproduce it with:
 *
 *   php -r 'var_export(@iconv_substr("abc\xff\xfedef", 0, 100, "UTF-8"));'   // => false
 *
 * The anti-vacuity job that control did is taken over by the two tests in
 * "mb-fix: the controls" -- the naive one-?-per-bad-byte rule is asserted to be WRONG, and
 * `mb_check_encoding()` is asserted to stay unsanitised.
 */

/** hex string -> bytes, so the fixtures read the way `bin2hex()` printed them */
const fromHex = (hex: string): Uint8Array =>
	new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

const toHex = (bytes: Uint8Array): string =>
	[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Transliteration of `cfw_mb_sanitize()` from `src/drupal/mb-fix.js`. The rule is ONE `?`
 * per maximal valid prefix consumed, then resume at the byte that broke the sequence -- not
 * one `?` per bad byte. The lead-byte table carries the overlong and surrogate bounds in the
 * SECOND byte, which is why it is not a flat 0x80-0xBF test.
 */
function sanitize(input: Uint8Array): Uint8Array {
	const len = input.length;
	const out: number[] = [];
	let i = 0;
	while (i < len) {
		const b = input[i] as number;
		if (b < 0x80) {
			out.push(b);
			i++;
			continue;
		}

		let need: number;
		let lo1: number;
		let hi1: number;
		if (b >= 0xc2 && b <= 0xdf) {
			need = 1;
			lo1 = 0x80;
			hi1 = 0xbf;
		} else if (b === 0xe0) {
			need = 2;
			lo1 = 0xa0;
			hi1 = 0xbf;
		} else if (b >= 0xe1 && b <= 0xec) {
			need = 2;
			lo1 = 0x80;
			hi1 = 0xbf;
		} else if (b === 0xed) {
			need = 2;
			lo1 = 0x80;
			hi1 = 0x9f;
		} else if (b >= 0xee && b <= 0xef) {
			need = 2;
			lo1 = 0x80;
			hi1 = 0xbf;
		} else if (b === 0xf0) {
			need = 3;
			lo1 = 0x90;
			hi1 = 0xbf;
		} else if (b >= 0xf1 && b <= 0xf3) {
			need = 3;
			lo1 = 0x80;
			hi1 = 0xbf;
		} else if (b === 0xf4) {
			need = 3;
			lo1 = 0x80;
			hi1 = 0x8f;
		} else {
			out.push(0x3f);
			i++;
			continue;
		}

		let consumed = 1;
		let ok = true;
		for (let k = 1; k <= need; k++) {
			if (i + k >= len) {
				ok = false;
				break;
			}
			const c = input[i + k] as number;
			const lo = k === 1 ? lo1 : 0x80;
			const hi = k === 1 ? hi1 : 0xbf;
			if (c < lo || c > hi) {
				ok = false;
				break;
			}
			consumed++;
		}

		if (ok) {
			for (let k = 0; k <= need; k++) out.push(input[i + k] as number);
			i += need + 1;
		} else {
			out.push(0x3f);
			i += consumed;
		}
	}
	return new Uint8Array(out);
}

/** the naive rule a first implementation shipped: one `?` per byte that fails to decode */
function sanitizePerByte(input: Uint8Array): Uint8Array {
	const out: number[] = [];
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	let i = 0;
	while (i < input.length) {
		let taken = 0;
		for (const width of [1, 2, 3, 4]) {
			try {
				decoder.decode(input.subarray(i, i + width));
				taken = width;
				break;
			} catch {
				// keep widening
			}
		}
		if (taken === 0) {
			out.push(0x3f);
			i++;
		} else {
			for (let k = 0; k < taken; k++) out.push(input[i + k] as number);
			i += taken;
		}
	}
	return new Uint8Array(out);
}

/** code point count, the JS equivalent of `mb_strlen()` on valid UTF-8 */
const chars = (bytes: Uint8Array): number => [...new TextDecoder().decode(bytes)].length;

const isValidUtf8 = (bytes: Uint8Array): boolean => {
	try {
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
		return true;
	} catch {
		return false;
	}
};

/**
 * label, input bytes, native mb_substr() output, native mb_strlen() of the INPUT. Recorded
 * from native PHP 8.5.7 + real mbstring; all 23 are the cases the old script carried.
 */
const CASES: ReadonlyArray<readonly [string, string, string, number]> = [
	['ascii', '616263', '616263', 3],
	['empty', '', '', 0],
	['valid accented', '636166c3a9', '636166c3a9', 4],
	['valid CJK', 'e4bda0e5a5bd', 'e4bda0e5a5bd', 2],
	['valid astral emoji', 'f09f9880', 'f09f9880', 1],
	['valid combining', '65cc81', '65cc81', 2],
	['two bad bytes', '616263fffe646566', '6162633f3f646566', 8],
	['lone continuation', '61626380646566', '6162633f646566', 7],
	['truncated 3-byte end', '616263e4bd', '6162633f', 4],
	['truncated 3-byte mid', '616263e4bd646566', '6162633f646566', 7],
	['overlong C0', '616263c0af646566', '6162633f3f646566', 8],
	['surrogate ED A0 80', '616263eda080646566', '6162633f3f3f646566', 9],
	['truncated 4-byte mid', '616263f09f646566', '6162633f646566', 7],
	['truncated 4-byte end', '616263f09f98', '6162633f', 4],
	['F5 out of range', '616263f5808080646566', '6162633f3f3f3f646566', 10],
	['lone C2 at end', 'c2', '3f', 1],
	['lone E0 at end', 'e0', '3f', 1],
	['E0 80 overlong', '616263e08080646566', '6162633f3f3f646566', 9],
	['F4 90 too high', '616263f4908080646566', '6162633f3f3f3f646566', 10],
	['C1 never a lead', '616263c1bf646566', '6162633f3f646566', 8],
	['all bad', 'ffffff', '3f3f3f', 3],
	['bad then valid', 'ff636166c3a9', '3f636166c3a9', 5],
	['valid then bad', '636166c3a9ff', '636166c3a93f', 5]
];

describe('mb-fix: sanitised output matches native mbstring', () => {
	it.each(CASES)('%s', (_label, inHex, oracleHex, len) => {
		const got = sanitize(fromHex(inHex));
		expect(toHex(got)).toBe(oracleHex);
		// after sanitising, the polyfill's iconv path sees valid UTF-8, so the character
		// count has to agree with native's count of the ORIGINAL bytes too
		expect(chars(got)).toBe(len);
		expect(isValidUtf8(got)).toBe(true);
	});
});

describe('mb-fix: the controls', () => {
	// this is the measured rule, and the reason the truncated cases above are the ones that
	// carry weight: a first version advanced one byte at a time and produced abc?? for abc?.
	// If the naive rule ever agreed with the recorded oracle, the table would prove nothing
	it('the naive one-?-per-bad-byte rule disagrees on the truncated cases', () => {
		const truncated = ['616263e4bd', '616263e4bd646566', '616263f09f646566', '616263f09f98'];
		for (const hex of truncated) {
			const oracle = CASES.find((c) => c[1] === hex)?.[2];
			expect(toHex(sanitize(fromHex(hex)))).toBe(oracle);
			expect(toHex(sanitizePerByte(fromHex(hex)))).not.toBe(oracle);
		}
	});

	// mb_check_encoding() and mb_detect_encoding() must keep seeing the original bytes;
	// sanitising first would make them answer "valid" for input that is invalid
	it('mb_check_encoding and mb_detect_encoding are NOT wrapped', () => {
		expect(MB_FIX).not.toContain('function mb_check_encoding');
		expect(MB_FIX).not.toContain('function mb_detect_encoding');
		// and the ones that ARE wrapped all route through the sanitiser
		for (const fn of ['mb_substr', 'mb_strlen', 'mb_strtolower', 'mb_strtoupper']) {
			expect(MB_FIX).toContain(`function ${fn}(`);
		}
		expect(MB_FIX).toContain('cfw_mb_sanitize($string)');
	});

	// WHICH functions are wrapped is a measured decision, not a taste. Every name below
	// was added because `bun run measure:mb-parity` showed sanitising STRICTLY reduced
	// its divergence from native mbstring. Do not quote a total here -- an earlier
	// version of this comment named one and it was stale within the hour; run the tool.
	it('wraps every function the parity harness showed sanitising improves', () => {
		for (const fn of [
			'mb_strstr',
			'mb_stristr',
			'mb_strrchr',
			'mb_strrichr',
			'mb_strwidth',
			'mb_scrub',
			'mb_encode_numericentity',
			'mb_convert_encoding'
		]) {
			expect(MB_FIX, fn).toContain(`function ${fn}(`);
		}
	});

	// the P24 additions, each closing a divergence a table alone could not: mb_chr and mb_ord
	// have no range validation in the polyfill at all, and the four case-insensitive searches
	// return an index into the polyfill's own lowercased copy rather than into the haystack
	it('wraps the functions P24 added, and routes the searches through the safe fold', () => {
		for (const fn of ['mb_chr', 'mb_ord', 'mb_stripos', 'mb_strripos', 'mb_stristr']) {
			expect(MB_FIX, fn).toContain(`function ${fn}(`);
		}
		expect(MB_FIX).toContain('cfw_mb_fold_safe');
		expect(MB_FIX).toContain('cfw_mb_patch');
	});

	// the other direction, and the one that is easy to get wrong: sanitising is NOT a
	// free win everywhere. Native mb_str_pad pads to a width it measures on the RAW
	// bytes, and the two detectors must see the original, so wrapping these three
	// turns 19 passing cases into failures. Measured, not assumed.
	it('leaves the three functions sanitising would BREAK alone', () => {
		for (const fn of ['mb_check_encoding', 'mb_detect_encoding', 'mb_str_pad']) {
			expect(MB_FIX, fn).not.toContain(`function ${fn}(`);
		}
	});

	// the sync guard that replaces the live PHP oracle: sanitize() above is a copy, so pin
	// it to the shipped PHP's decision table rather than trusting the copy to stay in sync
	it('mirrors the shipped PHP lead-byte table', () => {
		const src = MB_SANITIZE.replace(/\s+/g, ' ');
		const table = [
			'($b >= 0xC2 && $b <= 0xDF) { $need = 1; $lo1 = 0x80; $hi1 = 0xBF; }',
			'($b === 0xE0) { $need = 2; $lo1 = 0xA0; $hi1 = 0xBF; }',
			'($b >= 0xE1 && $b <= 0xEC) { $need = 2; $lo1 = 0x80; $hi1 = 0xBF; }',
			'($b === 0xED) { $need = 2; $lo1 = 0x80; $hi1 = 0x9F; }',
			'($b >= 0xEE && $b <= 0xEF) { $need = 2; $lo1 = 0x80; $hi1 = 0xBF; }',
			'($b === 0xF0) { $need = 3; $lo1 = 0x90; $hi1 = 0xBF; }',
			'($b >= 0xF1 && $b <= 0xF3) { $need = 3; $lo1 = 0x80; $hi1 = 0xBF; }',
			'($b === 0xF4) { $need = 3; $lo1 = 0x80; $hi1 = 0x8F; }'
		];
		for (const branch of table) expect(src).toContain(branch);
		// a NEW lead range added to the PHP without being mirrored here fails on this count
		expect(src.match(/\$need = \d/g)?.length).toBe(table.length);
		// and the resume rule itself: one "?" then advance by what was consumed
		// $sub defaults to "?" and is only ever passed by the TITLE path, which needs the
		// substituted run to be case-IGNORABLE while the word boundaries are found
		expect(src).toContain('function cfw_mb_sanitize($s, $sub = "?")');
		expect(src).toContain('else { $out .= $sub; $i += $consumed; }');
	});
});
