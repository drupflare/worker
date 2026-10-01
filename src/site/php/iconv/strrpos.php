<?php

use Symfony\Polyfill\Iconv\Iconv;

if (!function_exists('cfw_iconv_strrpos')) {
	/**
	 * @param string $haystack
	 *   The text to search.
	 * @param string $needle
	 *   What to look for.
	 * @param string|null $encoding
	 *   The charset of both, or NULL for the polyfill's internal one.
	 *
	 * @return int|false
	 *   The character offset of the last match.
	 */
	function cfw_iconv_strrpos($haystack, $needle, $encoding = null)
	{
		if ($encoding === null) {
			$encoding = Iconv::$internalEncoding;
		}
		if (stripos($encoding, 'utf-8') !== 0) {
			$haystack = Iconv::iconv($encoding, 'utf-8', $haystack);
			if ($haystack === false) {
				return false;
			}
			$needle = Iconv::iconv($encoding, 'utf-8', $needle);
			if ($needle === false) {
				return false;
			}
		}
		$pos = isset($needle[0]) ? strrpos($haystack, $needle) : false;
		if ($pos === false) {
			return false;
		}
		// upstream writes the ternary the other way round, which measures the whole
		// string when the match is at 0
		return $pos === 0 ? 0 : Iconv::iconv_strlen(substr($haystack, 0, $pos), 'utf-8');
	}
}
