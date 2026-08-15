import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MB_SANITIZE } from '../../src/drupal/mb-fix';

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
