<?php

use Symfony\Polyfill\Mbstring\Mbstring;

function cfw_mb_installed(): bool
{
	return true;
}

function mb_substr($string, $start, $length = null, $encoding = null)
{
	if (cfw_mb_ascii($string)) {
		return substr($string, $start, $length);
	}
	return Mbstring::mb_substr(cfw_mb_sanitize($string), $start, $length, $encoding);
}
function mb_strlen($string, $encoding = null)
{
	if (cfw_mb_ascii($string)) {
		return strlen($string);
	}
	return Mbstring::mb_strlen(cfw_mb_sanitize($string), $encoding);
}
function mb_strtolower($string, $encoding = null)
{
	if (cfw_mb_ascii($string)) {
		return strtolower($string);
	}
	$s = cfw_mb_sanitize($string);
	if (cfw_mb_utf8($encoding)) {
		$s = cfw_mb_patch($s, 'lower');
	}
	return cfw_mb_final_sigma(Mbstring::mb_strtolower($s, $encoding));
}
function mb_strtoupper($string, $encoding = null)
{
	if (cfw_mb_ascii($string)) {
		return strtoupper($string);
	}
	$s = cfw_mb_sanitize($string);
	if (cfw_mb_utf8($encoding)) {
		$s = cfw_mb_patch($s, 'upper');
	}
	return Mbstring::mb_strtoupper($s, $encoding);
}
function mb_convert_case($string, $mode, $encoding = null)
{
	// 0 UPPER, 1 LOWER, 2 TITLE, 3 FOLD, spelled as ints because the constants are defined by
	// the polyfill bootstrap that this fragment runs before
	$s = cfw_mb_sanitize($string);
	$mode = (int) $mode;
	$utf8 = cfw_mb_utf8($encoding);
	$re = $mode === 2 && $utf8 ? cfw_mb_title_regexp() : null;
	if ($re !== null) {
		// a substituted byte does NOT break a word natively -- mbstring carries an error marker
		// through the casing pass and only renders "?" on output -- so the word split runs over a
		// case-IGNORABLE stand-in. U+E0001 is on the polyfill's own lookbehind list, and the path
		// is taken only for input that is already invalid and provably does not contain it
		$tag = "\xf3\xa0\x80\x81";
		$tagged = $s !== $string && strpos((string) $string, $tag) === false;
		$out = preg_replace_callback(
			$re,
			'cfw_mb_title_word',
			$tagged ? cfw_mb_sanitize($string, $tag) : $s,
		);
		if ($tagged) {
			$out = str_replace($tag, '?', $out);
		}
	} else {
		// FOLD is left unpatched: the table is a case delta and folding is a third operation
		if ($utf8 && ($mode === 0 || $mode === 1)) {
			$s = cfw_mb_patch($s, $mode === 0 ? 'upper' : 'lower');
		}
		$out = Mbstring::mb_convert_case($s, $mode, $encoding);
	}
	// UPPER has no final-sigma rule; LOWER and TITLE both do
	return $mode === 0 ? $out : cfw_mb_final_sigma($out);
}
function mb_strpos($haystack, $needle, $offset = 0, $encoding = null)
{
	return Mbstring::mb_strpos(
		cfw_mb_sanitize($haystack),
		cfw_mb_sanitize($needle),
		$offset,
		$encoding,
	);
}
function mb_stripos($haystack, $needle, $offset = 0, $encoding = null)
{
	return Mbstring::mb_stripos(
		cfw_mb_fold_safe(cfw_mb_sanitize($haystack)),
		cfw_mb_fold_safe(cfw_mb_sanitize($needle)),
		$offset,
		$encoding,
	);
}
function mb_strripos($haystack, $needle, $offset = 0, $encoding = null)
{
	return Mbstring::mb_strripos(
		cfw_mb_fold_safe(cfw_mb_sanitize($haystack)),
		cfw_mb_fold_safe(cfw_mb_sanitize($needle)),
		$offset,
		$encoding,
	);
}
function mb_strrpos($haystack, $needle, $offset = 0, $encoding = null)
{
	return Mbstring::mb_strrpos(
		cfw_mb_sanitize($haystack),
		cfw_mb_sanitize($needle),
		$offset,
		$encoding,
	);
}
function mb_str_split($string, $length = 1, $encoding = null)
{
	return Mbstring::mb_str_split(cfw_mb_sanitize($string), $length, $encoding);
}
function mb_substr_count($haystack, $needle, $encoding = null)
{
	return Mbstring::mb_substr_count(
		cfw_mb_sanitize($haystack),
		cfw_mb_sanitize($needle),
		$encoding,
	);
}
function mb_strstr($haystack, $needle, $before_needle = false, $encoding = null)
{
	return Mbstring::mb_strstr(
		cfw_mb_sanitize($haystack),
		cfw_mb_sanitize($needle),
		$before_needle,
		$encoding,
	);
}
function mb_stristr($haystack, $needle, $before_needle = false, $encoding = null)
{
	$h = cfw_mb_sanitize($haystack);
	$pos = Mbstring::mb_stripos(
		cfw_mb_fold_safe($h),
		cfw_mb_fold_safe(cfw_mb_sanitize($needle)),
		0,
		$encoding,
	);
	return cfw_mb_isubpart($h, $pos, $before_needle, $encoding);
}
function mb_strrchr($haystack, $needle, $before_needle = false, $encoding = null)
{
	return Mbstring::mb_strrchr(
		cfw_mb_sanitize($haystack),
		cfw_mb_sanitize($needle),
		$before_needle,
		$encoding,
	);
}
function mb_strrichr($haystack, $needle, $before_needle = false, $encoding = null)
{
	$h = cfw_mb_sanitize($haystack);
	$n = Mbstring::mb_substr(cfw_mb_sanitize($needle), 0, 1, $encoding);
	$pos = Mbstring::mb_strripos(cfw_mb_fold_safe($h), cfw_mb_fold_safe($n), 0, $encoding);
	return cfw_mb_isubpart($h, $pos, $before_needle, $encoding);
}
function mb_strwidth($string, $encoding = null)
{
	$s = cfw_mb_sanitize($string);
	$re = cfw_mb_wide_regexp();
	if ($re === null || !cfw_mb_utf8($encoding)) {
		return Mbstring::mb_strwidth($s, $encoding);
	}
	return cfw_mb_width($s, $re);
}
function mb_chr($codepoint, $encoding = null)
{
	$cp = (int) $codepoint;
	// the polyfill takes $code %= 0x200000 and encodes whatever falls out, so a surrogate,
	// a negative and anything past the last plane all come back as bytes native refuses
	if ($cp < 0 || $cp > 0x10ffff || ($cp >= 0xd800 && $cp <= 0xdfff)) {
		return false;
	}
	return Mbstring::mb_chr($cp, $encoding);
}
function mb_ord($string, $encoding = null)
{
	if ((string) $string === '') {
		// single quotes: a double-quoted PHP string would interpolate the $string in the message
		throw new ValueError('mb_ord(): Argument #1 ($string) must not be empty');
	}
	return Mbstring::mb_ord($string, $encoding);
}
function mb_scrub($string, $encoding = null)
{
	return Mbstring::mb_scrub(cfw_mb_sanitize($string), $encoding);
}
function mb_encode_numericentity($string, $map, $encoding = null, $hex = false)
{
	return Mbstring::mb_encode_numericentity(cfw_mb_sanitize($string), $map, $encoding, $hex);
}
function mb_convert_encoding($string, $to_encoding, $from_encoding = null)
{
	// SANITISE ONLY WHEN THE SOURCE IS UTF-8. cfw_mb_sanitize reads its input as UTF-8, so running
	// it over SJIS or ISO-8859-1 bytes replaces legal ones with "?" before the conversion starts
	$utf8In = cfw_mb_utf8($from_encoding) && !is_array($from_encoding);
	$one = function ($v) use ($utf8In, $to_encoding, $from_encoding) {
		if (!is_string($v)) {
			return $v;
		}
		if ($utf8In) {
			$v = cfw_mb_sanitize($v);
			// the substitution is keyed by utf-8 character, so this arm needs a utf-8 source
			return is_string($to_encoding) ? cfw_mb_encode_subst($v, $to_encoding) : $v;
		}
		if (!cfw_mb_utf8($to_encoding) || is_array($from_encoding) || !is_string($from_encoding)) {
			return $v;
		}
		$subst = cfw_mb_decode_subst($v, $from_encoding);
		return $subst ?? $v;
	};
	$clean = is_array($string) ? array_map($one, $string) : $one($string);
	// a decoded arm already carries its "?" as utf-8, so say so rather than let the polyfill walk
	// the source a second time with //IGNORE; otherwise hand it a label its alias table knows
	$decoded = !$utf8In && is_string($clean) && cfw_mb_utf8($to_encoding) && $clean !== $string;
	$from = $decoded ? 'UTF-8' : ($utf8In ? $from_encoding : cfw_mb_iconv_label($from_encoding));
	return Mbstring::mb_convert_encoding($clean, $to_encoding, $from);
}
