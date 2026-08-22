import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ICONV_STRRPOS } from '../../src/drupal/iconv-fix';
import { MB_ASCII, MB_SANITIZE } from '../../src/drupal/mb-fix';

/**
 * The two controls the workers project CANNOT run, recovered.
 *
 * `tests/unit/drupal/mb-fix.spec.ts` had to drop these when it moved into workerd, because
 * `node:child_process` is not implemented there -- `execFileSync` fails with "The
 * child_process.execFileSync method is not implemented". They need a real PHP process with the
 * real iconv extension, so they live in the `node` project instead. This is the whole reason
 * that project exists.
 *
 * These are controls rather than tests. They assert something about the PLATFORM, not
 * about our code, and the platform fact is what justifies the fix existing at all:
 *
 * `mb_substr()` returned `''` on invalid UTF-8 in wasm, blanking user content. The diagnosis
 * pointed at the iconv polyfill, and the obvious prescription was "compile real iconv into the
 * build". **That prescription is wrong**, and this file is what proves it: real
 * `iconv_substr()` fails on invalid UTF-8 exactly like the polyfill does, so the polyfill's
 * `(string) iconv_substr(...)` would still yield `''`. It is real *mbstring* that substitutes,
 * not real iconv.
 *
 * That is why the bug was closed in `src/drupal/mb-fix.js` rather than by a rebuild. If these
 * assertions ever flip, the reasoning behind that decision no longer holds and the JS fix
 * should be re-examined.
 *
 * Skipped rather than failed when no `php` is on PATH: a contributor without PHP should not
 * see a red suite for a control about someone else's runtime.
 */

function php(code: string): string {
	return execFileSync('php', ['-d', 'error_reporting=0', '-r', code], {
		encoding: 'utf8'
	}).trim();
}

function hasPhpWithIconv(): boolean {
	try {
		return php('echo extension_loaded("iconv") ? "1" : "0";') === '1';
	} catch {
		return false;
	}
}

const available = hasPhpWithIconv();
const describeIfPhp = available ? describe : describe.skip;

describeIfPhp('CONTROL: real iconv is not the fix', () => {
	// the malformed input from the original bug report: two stray continuation bytes
	const BAD = 'abc\\xff\\xfedef';

	it('real iconv_substr() returns false on invalid UTF-8, exactly like the polyfill', () => {
		const out = php(`var_export(@iconv_substr("${BAD}", 0, 100, "UTF-8"));`);
		expect(out).toBe('false');
	});

	it('and (string) false is the empty string, which is the content loss', () => {
		const out = php(`var_export((string) @iconv_substr("${BAD}", 0, 100, "UTF-8"));`);
		expect(out).toBe("''");
	});

	it('real mbstring DOES substitute, which is what the JS fix reproduces', () => {
		// native mb_substr replaces each ill-formed sequence with `?` rather than failing
		const out = php(`echo mb_substr("${BAD}", 0, 100);`);
		expect(out).toBe('abc??def');
	});

	it('sanitising first makes iconv_substr succeed, confirming the ordering of the fix', () => {
		// the sanitiser runs BEFORE the polyfill sees the string; this proves that ordering is
		// what makes the polyfill path work rather than any change to iconv
		const out = php(`echo @iconv_substr(mb_substr("${BAD}", 0, 100), 0, 100, "UTF-8");`);
		expect(out).toBe('abc??def');
	});
});

/**
 * The cases that separate the upstream line from the corrected one. Every entry is
 * a match at index 0 except the two controls, because index 0 is the only input the
 * falsy-ternary reaches.
 */
const STRRPOS_CASES: [string, string][] = [
	['a', 'a'],
	['ab\\0cd', 'a'],
	['AbC-123_xyz', 'A'],
	['caf\\xc3\\xa9x', 'c'],
	['Hello World', 'o'],
	['Hello', 'z']
];

/**
 * Drives `cfw_iconv_strrpos` against the extension, and the upstream line beside it.
 *
 * The `Iconv` stand-in implements only `iconv()` and `iconv_strlen()`, over the real
 * extension. That is deliberate rather than a shortcut: those two helpers were never
 * what was wrong, the fix is one index expression, and depending on the vendored
 * polyfill would mean depending on `drupal-src`, which is gitignored -- so this spec
 * would land in `ARTIFACT_SPECS` and stop running on a clean checkout. The wide
 * comparison against the REAL polyfill is `scripts/measure/mb-parity.ts`.
 */
function runStrrposProbe(): { input: string; native: string; fixed: string; upstream: string }[] {
	const rows = STRRPOS_CASES.map(([h, n]) => `["${h}", "${n}"]`).join(', ');
	const src = `<?php
namespace Symfony\\Polyfill\\Iconv {
	class Iconv {
		public static $internalEncoding = 'utf-8';
		public static function iconv($f, $t, $s) { return \\iconv($f, $t, $s); }
		public static function iconv_strlen($s, $e = null) { return \\iconv_strlen($s, $e ?? 'utf-8'); }
	}
}
namespace {
	use Symfony\\Polyfill\\Iconv\\Iconv;
${ICONV_STRRPOS}
	// symfony/polyfill-iconv v1.37.0 Iconv.php:495, verbatim
	function upstream_strrpos($haystack, $needle, $encoding = null) {
		$pos = isset($needle[0]) ? strrpos($haystack, $needle) : false;
		return false === $pos
			? false
			: Iconv::iconv_strlen($pos ? substr($haystack, 0, $pos) : $haystack, 'utf-8');
	}
	$out = [];
	foreach ([${rows}] as [$h, $n]) {
		$out[] = [
			'input' => $h,
			'native' => var_export(@iconv_strrpos($h, $n, 'UTF-8'), true),
			'fixed' => var_export(@cfw_iconv_strrpos($h, $n, 'UTF-8'), true),
			'upstream' => var_export(@upstream_strrpos($h, $n), true),
		];
	}
	echo json_encode($out);
}
`;
	return JSON.parse(
		execFileSync(
			'php',
			['-d', 'error_reporting=0', '-d', 'opcache.enable_cli=0', '-r', src.slice(6)],
			{
				encoding: 'utf8'
			}
		)
	);
}

describeIfPhp('REGRESSION: iconv_strrpos reports 0 for a match at index 0', () => {
	const rows = available ? runStrrposProbe() : [];

	it('the corrected copy agrees with the extension on every case', () => {
		expect(rows.map((r) => [r.input, r.fixed])).toEqual(rows.map((r) => [r.input, r.native]));
	});

	it('the upstream line does NOT, which is what makes this a regression test', () => {
		// falsification: remove the fix and these four come back. If this ever passes,
		// upstream has fixed it and ICONV_FIX can be deleted rather than carried
		const wrong = rows.filter((r) => r.upstream !== r.native);
		expect(wrong.length).toBe(4);
		expect(wrong.every((r) => r.native === '0')).toBe(true);
	});

	it('answers false for a needle that is absent, not 0', () => {
		const miss = rows.find((r) => r.input === 'Hello');
		expect(miss?.native).toBe('false');
		expect(miss?.fixed).toBe('false');
	});
});

/**
 * The two corrections in `MB_ASCII`, driven against the extension.
 *
 * Both are pure PHP, so they can be sourced straight into a native process and
 * compared with the real thing. `cfw_mb_final_sigma` is fed the value the POLYFILL
 * produces -- spelled here as an explicit U+03C3 rather than obtained from the
 * polyfill -- so this needs no `drupal-src`.
 */
describeIfPhp('MB_ASCII: the ASCII fast path and the final-sigma rule', () => {
	function probe(body: string): string {
		return execFileSync('php', ['-d', 'error_reporting=0', '-r', `${MB_ASCII}\n${body}`], {
			encoding: 'utf8'
		}).trim();
	}

	it('the ASCII fast path agrees with mbstring on every ASCII byte', () => {
		// the substitution is only legal because strtolower() became locale-insensitive
		// in PHP 8.2; on an older build this test is what would have caught it
		const out = probe(`
			$bad = 0;
			for ($i = 0; $i < 128; $i++) {
				$c = chr($i);
				if (strtolower($c) !== mb_strtolower($c)) { $bad++; }
				if (strtoupper($c) !== mb_strtoupper($c)) { $bad++; }
				if (strlen($c) !== mb_strlen($c)) { $bad++; }
			}
			echo $bad;
		`);
		expect(out).toBe('0');
	});

	it('classifies ASCII and non-ASCII correctly, including the empty string', () => {
		const out = probe(`
			$cases = ['' => 1, 'abc' => 1, "a\\x7f" => 1, "caf\\xc3\\xa9" => 0, "\\xff" => 0];
			$bad = [];
			foreach ($cases as $s => $want) {
				if (cfw_mb_ascii($s) !== (bool) $want) { $bad[] = bin2hex($s); }
			}
			echo implode(',', $bad);
		`);
		expect(out).toBe('');
	});

	it('turns the polyfill sigma into the extension sigma, in context', () => {
		// U+03C3 where native yields U+03C2, plus the cases that must NOT change
		const out = probe(`
			$cases = [
				"\\u{3bf}\\u{3b4}\\u{3bf}\\u{3c3}" => "\\u{3bf}\\u{3b4}\\u{3bf}\\u{3c2}",
				"\\u{3c3}\\u{3bf}\\u{3c6}\\u{3bf}\\u{3c3}" => "\\u{3c3}\\u{3bf}\\u{3c6}\\u{3bf}\\u{3c2}",
				"\\u{3b1}\\u{3c3}\\u{3b1}" => "\\u{3b1}\\u{3c3}\\u{3b1}",
				"\\u{3c3}" => "\\u{3c3}",
				"abc" => "abc"
			];
			$bad = [];
			foreach ($cases as $in => $want) {
				if (cfw_mb_final_sigma($in) !== $want) { $bad[] = bin2hex($in); }
			}
			echo implode(',', $bad);
		`);
		expect(out).toBe('');
	});

	it('agrees with the extension end to end on a Greek phrase', () => {
		// the falsification: the polyfill's answer is asserted to be WRONG in the same run
		const out = probe(`
			$upper = "\\u{39f}\\u{394}\\u{39f}\\u{3a3} \\u{3a3}\\u{39f}\\u{3a6}\\u{39f}\\u{3a3}";
			$polyfillWould = "\\u{3bf}\\u{3b4}\\u{3bf}\\u{3c3} \\u{3c3}\\u{3bf}\\u{3c6}\\u{3bf}\\u{3c3}";
			echo (cfw_mb_final_sigma($polyfillWould) === mb_strtolower($upper) ? 'fixed' : 'BROKEN'),
				',',
				($polyfillWould === mb_strtolower($upper) ? 'NOT-A-BUG' : 'bug-real');
		`);
		expect(out).toBe('fixed,bug-real');
	});
});

describe('MB_SANITIZE stays in step with the control', () => {
	// asserted against the real exported source, so it runs with or without php
	it('wraps mb_substr, which is the function the control is about', () => {
		expect(MB_SANITIZE).toContain('mb_substr');
	});

	it('does NOT sanitise mb_check_encoding, which would report invalid input as valid', () => {
		expect(MB_SANITIZE).not.toContain('function mb_check_encoding');
	});

	it('reports whether the php-backed controls actually ran', () => {
		// not an assertion about behaviour: it makes a silent skip visible in the output, so
		// "green" cannot quietly mean "the controls never executed"
		if (!available) {
			console.log('  note: php with iconv not found, the platform controls were SKIPPED');
		}
		expect(typeof available).toBe('boolean');
	});
});
