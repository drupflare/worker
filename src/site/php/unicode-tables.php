<?php

// no eval(): every name here is ours, so nothing collides with an internal function and
// tests/node/php-fragments.spec.ts can lint the body

use Symfony\Polyfill\Mbstring\Mbstring;

if (!function_exists('cfw_mb_unicode_data')) {
	/**
	 * The table, or an empty one.
	 *
	 * An empty table is not a failure mode, it is the polyfill unchanged: every lookup misses,
	 * cfw_mb_patch returns its input and both generated patterns come back null, so a site with
	 * no driver pack answers exactly what it answered before the table existed.
	 *
	 * @return array<string, mixed>
	 *   The case, width and lead-byte tables keyed by name.
	 */
	function cfw_mb_unicode_data()
	{
		static $d = null;
		if ($d === null) {
			// the harness in scripts/measure/ points this at the sibling checkout; the edge
			// leaves it undefined and takes the mounted path
			$path = defined('CFW_UNICODE_TABLES')
				? CFW_UNICODE_TABLES
				: '/drupal/modules/custom/drupflare/src/unicode-tables.php';
			$d = is_file($path) ? require $path : null;
			if (!is_array($d)) {
				$empty = ['lower' => '', 'upper' => '', 'title' => '', 'fold' => ''];
				$d = [
					'lower' => [],
					'upper' => [],
					'title' => [],
					'fold' => [],
					'leads' => $empty,
					'wide' => [],
					'titleExtra' => [],
				];
			}
		}
		return $d;
	}

	/**
	 * Pre-maps the codepoints the polyfill would answer wrongly, so its own pass then sees a
	 * character it already agrees with.
	 *
	 * Pre and not post: the polyfill's wrong answer is ambiguous -- three characters share one
	 * stale uppercase -- so a table keyed on its OUTPUT cannot recover the input it came from.
	 * strpbrk first, because a string carrying none of the keys' lead bytes cannot need the strtr.
	 *
	 * @param string $s
	 *   Well-formed UTF-8.
	 * @param string $which
	 *   lower or upper.
	 *
	 * @return string
	 */
	function cfw_mb_patch($s, $which)
	{
		$d = cfw_mb_unicode_data();
		if ($d['leads'][$which] === '' || strpbrk($s, $d['leads'][$which]) === false) {
			return $s;
		}
		return strtr($s, $d[$which]);
	}

	/**
	 * The titlecase of a word-initial character, or null where the polyfill is already right.
	 *
	 * @param string $ch
	 *   One character.
	 */
	function cfw_mb_title_char($ch): ?string
	{
		$d = cfw_mb_unicode_data();
		return $d['title'][$ch] ?? null;
	}

	/**
	 * A length-PRESERVING fold, which is what the case-insensitive searches need.
	 *
	 * The polyfill lowercases first, and one codepoint lowercases to two (U+0130 gives i plus a
	 * combining dot), so every index past it shifts and mb_stripos answers an offset into a
	 * string the caller never passed.
	 *
	 * @param string $s
	 *   Well-formed UTF-8.
	 *
	 * @return string
	 */
	function cfw_mb_fold_safe($s)
	{
		$d = cfw_mb_unicode_data();
		if ($d['leads']['fold'] === '' || strpbrk($s, $d['leads']['fold']) === false) {
			return $s;
		}
		return strtr($s, $d['fold']);
	}

	/**
	 * East asian width from mbstring's table; null when the pack is absent.
	 */
	function cfw_mb_wide_regexp(): ?string
	{
		static $re = false;
		if ($re === false) {
			$w = cfw_mb_unicode_data()['wide'];
			$re = $w === [] ? null : '/[' . implode('', $w) . ']/u';
		}
		return $re;
	}

	/**
	 * @param string $s
	 *   Well-formed UTF-8.
	 * @param string $re
	 *   The pattern from cfw_mb_wide_regexp().
	 */
	function cfw_mb_width($s, $re): int
	{
		$stripped = preg_replace($re, '', $s, -1, $wide);
		return ($wide << 1) + Mbstring::mb_strlen((string) $stripped, 'UTF-8');
	}

	/**
	 * The class body spliced into the word pattern, empty when the pack is absent.
	 */
	function cfw_mb_title_extra(): string
	{
		return implode('', cfw_mb_unicode_data()['titleExtra']);
	}
}
