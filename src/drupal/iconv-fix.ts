/**
 * Corrects `iconv_strrpos()` in symfony/polyfill-iconv, which returns the wrong
 * index whenever the last match sits at the start of the string.
 *
 * `Iconv.php:495` measures the wrong slice:
 *
 *     return false === $pos ? false
 *       : self::iconv_strlen($pos ? substr($haystack, 0, $pos) : $haystack, 'utf-8');
 *
 * `$pos` is an OFFSET, so a match at index 0 is falsy and the ternary measures the
 * whole haystack instead of an empty prefix. It answers `strlen()` where the
 * extension answers 0. Measured on 8.5.7 against the real extension:
 *
 *     iconv_strrpos('a', 'a')            native 0   polyfill 1
 *     iconv_strrpos('ab\0cd', 'a')       native 0   polyfill 5
 *     iconv_strrpos('AbC-123_xyz', 'A')  native 0   polyfill 11
 *
 * `iconv_strpos()` twelve lines above has the same ternary written the other way
 * round and is correct, which is what makes this a slip rather than a policy.
 * Present on upstream `main` as of 2026-08-21, in v1.37.0.
 *
 * It reaches this project because the wasm build has neither extension:
 * polyfill-mbstring's `mb_strrpos()`, `mb_strripos()`, `mb_strrchr()` and
 * `mb_strrichr()` are all thin wrappers over `iconv_strrpos()`, so all four are
 * wrong at index 0. No Drupal core path calls them -- the only non-test caller in
 * the tree is `symfony/string`'s `CodePointString::indexOfLast()`, which core does
 * not reach -- so this is a correctness fix for contrib rather than a live defect.
 */

/**
 * The corrected implementation, outside the extension guard so a gate test and
 * `scripts/measure/mb-parity.ts` can drive it on a build that HAS iconv.
 *
 * The `$iconv` indirection is not style: this fragment is injected before
 * composer's autoloader exists, so the class has to be resolved at call time.
 */
export const ICONV_STRRPOS = String.raw`
if (!function_exists('cfw_iconv_strrpos')) {
	function cfw_iconv_strrpos($haystack, $needle, $encoding = null) {
		$iconv = Iconv::class;
		if ($encoding === null) { $encoding = $iconv::$internalEncoding; }
		if (stripos($encoding, 'utf-8') !== 0) {
			$haystack = $iconv::iconv($encoding, 'utf-8', $haystack);
			if ($haystack === false) { return false; }
			$needle = $iconv::iconv($encoding, 'utf-8', $needle);
			if ($needle === false) { return false; }
		}
		$pos = isset($needle[0]) ? strrpos($haystack, $needle) : false;
		if ($pos === false) { return false; }
		// upstream writes the ternary the other way round, which measures the whole
		// string when the match is at 0
		return $pos === 0 ? 0 : $iconv::iconv_strlen(substr($haystack, 0, $pos), 'utf-8');
	}
}
`;

/**
 * Claims the global name before polyfill-iconv's bootstrap can, the same way
 * `MB_FIX` claims the `mb_*` names.
 *
 * No `eval()`, following `ZLIB_FIX`: a conditional declaration that collides with
 * an internal function is bound at runtime, so this compiles clean on a build that
 * has iconv and the branch never runs. That is what lets
 * `tests/node/php-fragments.spec.ts` lint the body.
 */
export const ICONV_FIX = String.raw`
use Symfony\Polyfill\Iconv\Iconv;

${ICONV_STRRPOS}

if (!extension_loaded('iconv')) {
	function iconv_strrpos($haystack, $needle, $encoding = null) {
		return cfw_iconv_strrpos($haystack, $needle, $encoding);
	}
}
`;
