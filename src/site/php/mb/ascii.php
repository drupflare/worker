<?php

// NO eval(), unlike the wrappers below: these two names are ours, so they cannot collide
// with an internal function and nothing has to be deferred to runtime. Plain PHP is what
// lets tests/node/php-fragments.spec.ts see inside the body.

use Symfony\Polyfill\Iconv\Iconv;
use Symfony\Polyfill\Mbstring\Mbstring;

if (!function_exists('cfw_mb_ascii')) {
	/**
	 * True when no byte is >= 0x80, so the single-byte string functions are exact.
	 *
	 * @param mixed $s
	 *   The value to test.
	 */
	function cfw_mb_ascii($s): bool
	{
		return is_string($s) && !preg_match('/[\x80-\xff]/', $s);
	}

	/**
	 * Applies Unicode SpecialCasing final-sigma to an ALREADY-lowercased string.
	 *
	 * Not applied to mb_strtoupper: there is no uppercase counterpart and
	 * running it there would corrupt correct output. The strpos() guard is the common
	 * case -- a string with no sigma in it cannot need this.
	 *
	 * @param string $lo
	 *   The lowercased text.
	 *
	 * @return string|null
	 *   The text with final sigmas applied, or NULL when the pattern failed.
	 */
	function cfw_mb_final_sigma($lo)
	{
		if (strpos($lo, "\xcf\x83") === false) {
			return $lo;
		}
		return preg_replace(
			'/(?<=\p{Ll}|\p{Lu}|\p{Lt}|\p{Lm}|\p{Lo})\x{03C3}(?!\p{L})/u',
			"\xcf\x82",
			$lo,
		);
	}

	/**
	 * The case tables are keyed by utf-8, so a caller naming another encoding must not reach them.
	 *
	 * @param string|null $encoding
	 *   The encoding the caller named.
	 */
	function cfw_mb_utf8($encoding): bool
	{
		return $encoding === null ||
			strcasecmp($encoding, 'UTF-8') === 0 ||
			strcasecmp($encoding, 'UTF8') === 0;
	}

	/**
	 * The word-boundary pattern for titlecasing, built from the polyfill's Case_Ignorable data.
	 *
	 * The 6,201-byte character class is READ from the package rather than copied, so upstream
	 * keeps owning the Unicode half; the two-line grammar around it is replaced, because
	 * upstream's lookbehind-then-two-letter-groups is wrong in both directions. It blocks a
	 * match on the letter after an ignorable and then RE-ENTERS on the letter after that, so
	 * "abc<SHY>def" comes out "Abc<SHY>dEf" where mbstring gives "Abc<SHY>def". Consuming
	 * ignorables in the word TAIL fixes it: a character inside a match is never offered a
	 * second start.
	 *
	 * null means the package moved and every caller falls back to the polyfill's own title path.
	 *
	 * @return string|null
	 *   The pattern, or NULL when the polyfill's data file is not where it was.
	 */
	function cfw_mb_title_regexp()
	{
		static $re = false;
		if ($re === false) {
			$re = null;
			$file = class_exists(Mbstring::class)
				? (new ReflectionClass(Mbstring::class))->getFileName()
				: false;
			$path =
				$file === false ? '' : dirname($file) . '/Resources/unidata/titleCaseRegexp.php';
			if ($path !== '' && is_file($path)) {
				$re = require $path;
			}
			$end = $re === null ? false : strpos($re, '])(\pL)(\pL*+)/u');
			if ($end !== false && strpos($re, '/(?<![') === 0) {
				$ignorable = substr($re, 6, $end - 6);
				// mbstring titlecases roman numerals and circled letters; PCRE does not call
				// them letters, so the polyfill never offers them to the callback at all
				$word = '\pL' . cfw_mb_title_extra();
				$re = '/(?<![' . $word . '])([' . $word . '])([' . $word . $ignorable . ']*+)/u';
			}
		}
		return $re;
	}

	/**
	 * One word: its first character titlecased, the rest lowercased.
	 *
	 * The polyfill UPPERCASES the first character, which is a different operation for the 31
	 * Lt digraphs and for every ligature that expands (native titlecases U+FB01 to "Fi", the
	 * polyfill uppercases it to "FI").
	 *
	 * @param array<int, string> $m
	 *   The match: the whole word, its first character, and its tail.
	 */
	function cfw_mb_title_word($m): string
	{
		$title = cfw_mb_title_char($m[1]);
		// 0 and 1 rather than MB_CASE_UPPER / MB_CASE_LOWER: this fragment is installed before
		// the polyfill's bootstrap, which is what defines those constants
		$head = $title ?? Mbstring::mb_convert_case(cfw_mb_patch($m[1], 'upper'), 0, 'UTF-8');
		return $head . Mbstring::mb_convert_case(cfw_mb_patch($m[2], 'lower'), 1, 'UTF-8');
	}

	/**
	 * Replaces every character the TARGET encoding cannot represent with "?", which is what
	 * native mb_convert_encoding does and what the polyfill does not.
	 *
	 * The polyfill converts with //IGNORE, so an unmappable character is DROPPED: a Cyrillic
	 * sentence converted to ISO-8859-1 comes back as its spaces. One whole-string probe
	 * decides -- iconv without //IGNORE answers false only when something is unmappable -- so
	 * the per-character loop is paid by the strings that actually need it.
	 *
	 * @param string $s
	 *   Well-formed UTF-8.
	 * @param string $to
	 *   The target charset.
	 */
	function cfw_mb_encode_subst($s, $to): string
	{
		if ($s === '' || !class_exists(Iconv::class)) {
			return $s;
		}
		// a target iconv does not know (BASE64, HTML-ENTITIES) fails on ASCII too; leave those
		// to the polyfill, which handles them before it ever reaches a charset conversion
		if (@Iconv::iconv('UTF-8', $to, 'a') !== 'a') {
			return $s;
		}
		if (@Iconv::iconv('UTF-8', $to, $s) !== false) {
			return $s;
		}
		$out = '';
		foreach (preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) as $ch) {
			$out .= @Iconv::iconv('UTF-8', $to, $ch) === false ? '?' : $ch;
		}
		return $out;
	}

	/**
	 * Spells a charset the way symfony/polyfill-iconv's alias table spells it.
	 *
	 * THE CHARMAPS ARE PRESENT AND THE NAMES ARE NOT. Measured against the polyfill rather than
	 * against the real extension: SJIS, GBK, BIG5 and EUC-KR are all REFUSED outright, while
	 * Shift_JIS, CP936, CP950 and CP949 decode -- out of the same 55 from.*.php files. So the gap
	 * that looked like missing capability is six alias entries.
	 *
	 * CP950 and CP949 are SUPERSETS of Big5 and EUC-KR, so those two decode every assigned byte
	 * correctly and additionally decode bytes the narrower charset leaves unassigned, where
	 * mbstring substitutes. That is a real difference and it is why they are named here rather
	 * than presented as exact. EUC-JP and ISO-2022-JP ship no charmap at all and stay refused.
	 *
	 * @param mixed $enc
	 *   The charset the caller named.
	 *
	 * @return mixed
	 *   The polyfill's spelling, or the input when it is not a string or needs no alias.
	 */
	function cfw_mb_iconv_label($enc)
	{
		static $alias = [
			'sjis' => 'Shift_JIS',
			'sjis-win' => 'CP932',
			'ms_kanji' => 'CP932',
			'gbk' => 'CP936',
			'big5' => 'CP950',
			'big-5' => 'CP950',
			'euc-kr' => 'CP949',
			'uhc' => 'CP949',
		];
		return is_string($enc) ? $alias[strtolower($enc)] ?? $enc : $enc;
	}

	/**
	 * The same substitution in the DECODE direction: a source byte the charmap does not know
	 * becomes "?" instead of vanishing.
	 *
	 * Walks the source the way the polyfill's own mapToUtf8 does -- a two-byte key first, then a
	 * one-byte key -- so it is right for SJIS and Big5 as well as for the single-byte charsets.
	 * The pair was used exactly when its answer is not the two singles concatenated; where those
	 * agree, either choice produces the same bytes.
	 *
	 * Returns null when it does not apply, which leaves the polyfill's answer alone: an unknown
	 * charset (no charmap ships for EUC-JP) and a source with nothing unmappable both take that
	 * path, and the second is the common one.
	 *
	 * @param string $s
	 *   Source bytes in the named charset.
	 * @param string $from
	 *   The charset the bytes are in.
	 */
	function cfw_mb_decode_subst($s, $from): ?string
	{
		$from = cfw_mb_iconv_label($from);
		if ($s === '' || !class_exists(Iconv::class)) {
			return null;
		}
		if (@Iconv::iconv($from, 'UTF-8', 'a') !== 'a') {
			return null;
		}
		if (@Iconv::iconv($from, 'UTF-8', $s) !== false) {
			return null;
		}
		$out = '';
		$len = strlen($s);
		$i = 0;
		while ($i < $len) {
			$one = (string) @Iconv::iconv($from, 'UTF-8//IGNORE', $s[$i]);
			if ($i + 1 < $len) {
				$pair = (string) @Iconv::iconv($from, 'UTF-8//IGNORE', substr($s, $i, 2));
				$next = (string) @Iconv::iconv($from, 'UTF-8//IGNORE', $s[$i + 1]);
				if ($pair !== '' && $pair !== $one . $next) {
					$out .= $pair;
					$i += 2;
					continue;
				}
			}
			$out .= $one === '' ? '?' : $one;
			$i++;
		}
		return $out;
	}

	/**
	 * Case-insensitive search on the ORIGINAL haystack.
	 *
	 * The polyfill returns a slice of its own lowercased copy, so a haystack containing a
	 * character that lowercases to two comes back with different bytes than went in.
	 *
	 * @param string $haystack
	 *   The original text.
	 * @param int|false $pos
	 *   Where the needle was found, or FALSE.
	 * @param bool $before
	 *   Return the part before the match rather than from it.
	 * @param string|null $encoding
	 *   The encoding the caller named.
	 *
	 * @return string|false
	 */
	function cfw_mb_isubpart($haystack, $pos, $before, $encoding)
	{
		if ($pos === false) {
			return false;
		}
		return $before
			? Mbstring::mb_substr($haystack, 0, $pos, $encoding)
			: Mbstring::mb_substr($haystack, $pos, null, $encoding);
	}
}
