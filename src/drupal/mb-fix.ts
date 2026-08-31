import { UNICODE_TABLES } from './unicode-tables.js';

/**
 * Closes the mb_substr() content-loss bug in PHP, without a rebuild.
 *
 * The bug. In wasm there is no mbstring extension, so Symfony's polyfill provides
 * mb_*. Its mb_substr() is `return (string) iconv_substr(...)`, its mb_strlen()
 * is `if (false !== $len = @iconv_strlen(...))`, and Symfony's *iconv* polyfill
 * returns FALSE for any string that is not valid UTF-8. `(string) false` is `''`.
 * So a stored value carrying one bad byte comes back BLANK where native PHP
 * returns the text with the bad bytes replaced by '?'. Core calls mb_substr 50
 * times and mb_strtolower 66 times.
 *
 * The prescribed fix is wrong.
 * AGENT-TECHNICAL_REPORT.md TASK C says "compile the real iconv extension into the wasm
 * build" and calls it cheap. It would not work. Measured on native PHP 8.5.7 with
 * the REAL iconv extension loaded:
 *
 *   iconv_substr("abc\xff\xfedef", 0, 100, 'UTF-8')  ->  false
 *   iconv_strlen("abc\xff\xfedef", 'UTF-8')          ->  false
 *   mb_substr("abc\xff\xfedef", 0, 100)              ->  'abc??def'
 *
 * Real iconv fails on invalid UTF-8 exactly like the polyfill does. It is real
 * MBSTRING that substitutes. So compiling iconv in leaves the polyfill's
 * `(string) false` intact and changes nothing.
 *
 * What this does: defines the affected mb_* functions BEFORE the polyfill's
 * bootstrap runs, so its own function_exists() guards skip. Each one replaces
 * invalid UTF-8 with '?' -- byte for byte what native mbstring's substitute
 * character does -- and then delegates to the polyfill class for the real work.
 * No vendor file is edited and no rebuild is needed.
 *
 * What it does not touch: mb_check_encoding() and
 * mb_detect_encoding() must keep seeing the original bytes: sanitising first
 * would make mb_check_encoding() answer TRUE for input that is invalid, which
 * turns a correct answer into a wrong one. Both already agree with native.
 *
 * Compiling real mbstring in (--enable-mbstring --disable-mbregex) remains the
 * durable fix; this is the one that works today and it is what the tests pin.
 */

/**
 * The sanitiser, on its own, so a gate test can drive it against native mbstring
 * as the oracle without needing a wasm build.
 */
export const MB_SANITIZE = String.raw`
if (!function_exists('cfw_mb_sanitize')) { eval('
/**
 * Replaces every ill-formed UTF-8 sequence with "?".
 *
 * Matches native mbstring byte for byte, and the rule is NOT one "?" per bad
 * byte -- that was measured, not assumed. Native emits ONE "?" per maximal valid
 * PREFIX it consumed, then resumes at the byte that broke the sequence:
 *
 * $sub exists for one caller: mb_convert_case TITLE, which needs the substituted run to
 * be a case-IGNORABLE character rather than "?" while the word boundaries are found.
 *
 *   "abc\xe4\xbddef"      -> abc?def     one "?", two bytes consumed
 *   "abc\xe4\xbd"         -> abc?        same at end of string
 *   "abc\xed\xa0\x80def"  -> abc???def   ED is a valid lead but A0 is out of its
 *                                        range, so ED alone is one "?" and A0 and
 *                                        80 are then lone continuations
 *   "abc\xc0\xafdef"      -> abc??def    C0 is never a valid lead
 *   "abc\xf5\x80\x80\x80def" -> abc????def
 *
 * A first version advanced one byte at a time on failure and got the truncated
 * cases wrong (abc??  for abc?). The oracle is native mb_substr(); the gate test
 * pins every case above against it.
 */
function cfw_mb_sanitize($s, $sub = "?") {
  if (!is_string($s) || $s === "") { return $s; }
  // fast path: already well-formed
  if (preg_match("//u", $s) === 1) { return $s; }

  $out = "";
  $len = strlen($s);
  $i = 0;
  while ($i < $len) {
    $b = ord($s[$i]);
    if ($b < 0x80) { $out .= $s[$i]; $i++; continue; }

    // per-lead continuation ranges; the second byte carries the overlong and
    // surrogate bounds, which is why this is not a flat 0x80-0xBF test
    if ($b >= 0xC2 && $b <= 0xDF)      { $need = 1; $lo1 = 0x80; $hi1 = 0xBF; }
    elseif ($b === 0xE0)               { $need = 2; $lo1 = 0xA0; $hi1 = 0xBF; }
    elseif ($b >= 0xE1 && $b <= 0xEC)  { $need = 2; $lo1 = 0x80; $hi1 = 0xBF; }
    elseif ($b === 0xED)               { $need = 2; $lo1 = 0x80; $hi1 = 0x9F; }
    elseif ($b >= 0xEE && $b <= 0xEF)  { $need = 2; $lo1 = 0x80; $hi1 = 0xBF; }
    elseif ($b === 0xF0)               { $need = 3; $lo1 = 0x90; $hi1 = 0xBF; }
    elseif ($b >= 0xF1 && $b <= 0xF3)  { $need = 3; $lo1 = 0x80; $hi1 = 0xBF; }
    elseif ($b === 0xF4)               { $need = 3; $lo1 = 0x80; $hi1 = 0x8F; }
    else { $out .= $sub; $i++; continue; }

    $consumed = 1;
    $ok = TRUE;
    for ($k = 1; $k <= $need; $k++) {
      if ($i + $k >= $len) { $ok = FALSE; break; }
      $c = ord($s[$i + $k]);
      $lo = ($k === 1) ? $lo1 : 0x80;
      $hi = ($k === 1) ? $hi1 : 0xBF;
      if ($c < $lo || $c > $hi) { $ok = FALSE; break; }
      $consumed++;
    }

    if ($ok) { $out .= substr($s, $i, $need + 1); $i += $need + 1; }
    else { $out .= $sub; $i += $consumed; }
  }

  return $out;
}
'); }
`;

/**
 * The corrections that need no host call and no generated table, kept separate from
 * the wrappers so `scripts/measure/mb-parity.ts` can price each on its own.
 *
 * THE ASCII FAST PATH is not only a speed lever, though it is a large one -- the
 * polyfill routes every call through iconv even for bytes it cannot possibly
 * change. Drupal's hot `mb_strtolower` inputs are machine names, field names,
 * langcodes and header names, all ASCII.
 *
 * `strtolower()` is safe to substitute only because this is PHP 8: it became
 * locale-insensitive and ASCII-only in 8.2, so the C-locale trap that made this
 * wrong on older builds is gone.
 *
 * THE FINAL SIGMA post-pass closes the divergence that has been on record longest.
 * Lowercasing a word-final capital sigma must give U+03C2, and the polyfill's flat
 * table gives U+03C3, so a Greek title produces a different search key, sort order
 * and URL alias in wasm than on a normal host. The rule is contextual rather than
 * per-codepoint, which is why a table cannot express it: sigma is final when a
 * letter precedes it and none follows.
 */
export const MB_ASCII = String.raw`
// NO eval(), unlike the wrappers below: these two names are ours, so they cannot collide
// with an internal function and nothing has to be deferred to runtime. Plain PHP is what
// lets tests/node/php-fragments.spec.ts see inside the body.
if (!function_exists('cfw_mb_ascii')) {
	/** true when no byte is >= 0x80, so the single-byte string functions are exact */
	function cfw_mb_ascii($s) {
		return is_string($s) && !preg_match('/[\x80-\xff]/', $s);
	}

	/**
	 * Applies Unicode SpecialCasing final-sigma to an ALREADY-lowercased string.
	 *
	 * Not applied to mb_strtoupper: there is no uppercase counterpart and
	 * running it there would corrupt correct output. The strpos() guard is the common
	 * case -- a string with no sigma in it cannot need this.
	 */
	function cfw_mb_final_sigma($lo) {
		if (strpos($lo, "\xcf\x83") === false) { return $lo; }
		return preg_replace(
			'/(?<=\p{Ll}|\p{Lu}|\p{Lt}|\p{Lm}|\p{Lo})\x{03C3}(?!\p{L})/u',
			"\xcf\x82",
			$lo
		);
	}

	/** the case tables are keyed by utf-8, so a caller naming another encoding must not reach them */
	function cfw_mb_utf8($encoding) {
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
	 */
	function cfw_mb_title_regexp() {
		static $re = false;
		if ($re === false) {
			$re = null;
			$cls = 'Symfony\\Polyfill\\Mbstring\\Mbstring';
			$file = class_exists($cls) ? (new ReflectionClass($cls))->getFileName() : false;
			$path = $file === false ? '' : dirname($file) . '/Resources/unidata/titleCaseRegexp.php';
			if ($path !== '' && is_file($path)) { $re = require $path; }
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
	 */
	function cfw_mb_title_word($m) {
		$mb = 'Symfony\\Polyfill\\Mbstring\\Mbstring';
		$title = cfw_mb_title_char($m[1]);
		// 0 and 1 rather than MB_CASE_UPPER / MB_CASE_LOWER: this fragment is installed before
		// the polyfill's bootstrap, which is what defines those constants
		$head = $title !== null ? $title : $mb::mb_convert_case(cfw_mb_patch($m[1], 'upper'), 0, 'UTF-8');
		return $head . $mb::mb_convert_case(cfw_mb_patch($m[2], 'lower'), 1, 'UTF-8');
	}

	/**
	 * Case-insensitive search on the ORIGINAL haystack.
	 *
	 * The polyfill returns a slice of its own lowercased copy, so a haystack containing a
	 * character that lowercases to two comes back with different bytes than went in.
	 */
	/**
	 * Replaces every character the TARGET encoding cannot represent with "?", which is what
	 * native mb_convert_encoding does and what the polyfill does not.
	 *
	 * The polyfill converts with //IGNORE, so an unmappable character is DROPPED: a Cyrillic
	 * sentence converted to ISO-8859-1 comes back as its spaces. One whole-string probe
	 * decides -- iconv without //IGNORE answers false only when something is unmappable -- so
	 * the per-character loop is paid by the strings that actually need it.
	 */
	function cfw_mb_encode_subst($s, $to) {
		$iconv = 'Symfony\\Polyfill\\Iconv\\Iconv';
		if ($s === '' || !class_exists($iconv)) { return $s; }
		// a target iconv does not know (BASE64, HTML-ENTITIES) fails on ASCII too; leave those
		// to the polyfill, which handles them before it ever reaches a charset conversion
		if (@$iconv::iconv('UTF-8', $to, 'a') !== 'a') { return $s; }
		if (@$iconv::iconv('UTF-8', $to, $s) !== false) { return $s; }
		$out = '';
		foreach (preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY) as $ch) {
			$out .= @$iconv::iconv('UTF-8', $to, $ch) === false ? '?' : $ch;
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
	 */
	function cfw_mb_iconv_label($enc) {
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
		return is_string($enc) ? ($alias[strtolower($enc)] ?? $enc) : $enc;
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
	 */
	function cfw_mb_decode_subst($s, $from) {
		$iconv = 'Symfony\\Polyfill\\Iconv\\Iconv';
		$from = cfw_mb_iconv_label($from);
		if ($s === '' || !class_exists($iconv)) { return null; }
		if (@$iconv::iconv($from, 'UTF-8', 'a') !== 'a') { return null; }
		if (@$iconv::iconv($from, 'UTF-8', $s) !== false) { return null; }
		$out = '';
		$len = strlen($s);
		$i = 0;
		while ($i < $len) {
			$one = (string) @$iconv::iconv($from, 'UTF-8//IGNORE', $s[$i]);
			if ($i + 1 < $len) {
				$pair = (string) @$iconv::iconv($from, 'UTF-8//IGNORE', substr($s, $i, 2));
				$next = (string) @$iconv::iconv($from, 'UTF-8//IGNORE', $s[$i + 1]);
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

	function cfw_mb_isubpart($haystack, $pos, $before, $encoding) {
		$mb = 'Symfony\\Polyfill\\Mbstring\\Mbstring';
		if ($pos === false) { return false; }
		return $before
			? $mb::mb_substr($haystack, 0, $pos, $encoding)
			: $mb::mb_substr($haystack, $pos, null, $encoding);
	}
}
`;

/**
 * The wrappers. Each is defined only if the real extension is absent, so this is
 * inert on a build that has mbstring compiled in.
 */
export const MB_FIX = String.raw`
${MB_SANITIZE}
${MB_ASCII}
${UNICODE_TABLES}
if (!extension_loaded('mbstring') && !function_exists('cfw_mb_installed')) { eval('
function cfw_mb_installed() { return true; }

function mb_substr($string, $start, $length = null, $encoding = null) {
  if (cfw_mb_ascii($string)) { return substr($string, $start, $length); }
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_substr(cfw_mb_sanitize($string), $start, $length, $encoding);
}
function mb_strlen($string, $encoding = null) {
  if (cfw_mb_ascii($string)) { return strlen($string); }
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strlen(cfw_mb_sanitize($string), $encoding);
}
function mb_strtolower($string, $encoding = null) {
  if (cfw_mb_ascii($string)) { return strtolower($string); }
  $s = cfw_mb_sanitize($string);
  if (cfw_mb_utf8($encoding)) { $s = cfw_mb_patch($s, "lower"); }
  return cfw_mb_final_sigma(\\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strtolower($s, $encoding));
}
function mb_strtoupper($string, $encoding = null) {
  if (cfw_mb_ascii($string)) { return strtoupper($string); }
  $s = cfw_mb_sanitize($string);
  if (cfw_mb_utf8($encoding)) { $s = cfw_mb_patch($s, "upper"); }
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strtoupper($s, $encoding);
}
function mb_convert_case($string, $mode, $encoding = null) {
  // 0 UPPER, 1 LOWER, 2 TITLE, 3 FOLD, spelled as ints because the constants are defined by
  // the polyfill bootstrap that this fragment runs before
  $s = cfw_mb_sanitize($string);
  $mode = (int) $mode;
  $utf8 = cfw_mb_utf8($encoding);
  $re = $mode === 2 && $utf8 ? cfw_mb_title_regexp() : null;
  if ($re !== null) {
    // a substituted byte does NOT break a word natively -- mbstring carries an error marker
    // through the casing pass and only renders "?" on output -- so the word split runs over a
    // case-IGNORABLE stand-in. U+E0001 is on the polyfill\'s own lookbehind list, and the path
    // is taken only for input that is already invalid and provably does not contain it
    $tag = "\\xf3\\xa0\\x80\\x81";
    $tagged = $s !== $string && strpos((string) $string, $tag) === false;
    $out = preg_replace_callback($re, "cfw_mb_title_word", $tagged ? cfw_mb_sanitize($string, $tag) : $s);
    if ($tagged) { $out = str_replace($tag, "?", $out); }
  } else {
    // FOLD is left unpatched: the table is a case delta and folding is a third operation
    if ($utf8 && ($mode === 0 || $mode === 1)) {
      $s = cfw_mb_patch($s, $mode === 0 ? "upper" : "lower");
    }
    $out = \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_convert_case($s, $mode, $encoding);
  }
  // UPPER has no final-sigma rule; LOWER and TITLE both do
  return $mode === 0 ? $out : cfw_mb_final_sigma($out);
}
function mb_strpos($haystack, $needle, $offset = 0, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strpos(cfw_mb_sanitize($haystack), cfw_mb_sanitize($needle), $offset, $encoding);
}
function mb_stripos($haystack, $needle, $offset = 0, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_stripos(cfw_mb_fold_safe(cfw_mb_sanitize($haystack)), cfw_mb_fold_safe(cfw_mb_sanitize($needle)), $offset, $encoding);
}
function mb_strripos($haystack, $needle, $offset = 0, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strripos(cfw_mb_fold_safe(cfw_mb_sanitize($haystack)), cfw_mb_fold_safe(cfw_mb_sanitize($needle)), $offset, $encoding);
}
function mb_strrpos($haystack, $needle, $offset = 0, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strrpos(cfw_mb_sanitize($haystack), cfw_mb_sanitize($needle), $offset, $encoding);
}
function mb_str_split($string, $length = 1, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_str_split(cfw_mb_sanitize($string), $length, $encoding);
}
function mb_substr_count($haystack, $needle, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_substr_count(cfw_mb_sanitize($haystack), cfw_mb_sanitize($needle), $encoding);
}
function mb_strstr($haystack, $needle, $before_needle = false, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strstr(cfw_mb_sanitize($haystack), cfw_mb_sanitize($needle), $before_needle, $encoding);
}
function mb_stristr($haystack, $needle, $before_needle = false, $encoding = null) {
  $h = cfw_mb_sanitize($haystack);
  $pos = \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_stripos(cfw_mb_fold_safe($h), cfw_mb_fold_safe(cfw_mb_sanitize($needle)), 0, $encoding);
  return cfw_mb_isubpart($h, $pos, $before_needle, $encoding);
}
function mb_strrchr($haystack, $needle, $before_needle = false, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strrchr(cfw_mb_sanitize($haystack), cfw_mb_sanitize($needle), $before_needle, $encoding);
}
function mb_strrichr($haystack, $needle, $before_needle = false, $encoding = null) {
  $h = cfw_mb_sanitize($haystack);
  $n = \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_substr(cfw_mb_sanitize($needle), 0, 1, $encoding);
  $pos = \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strripos(cfw_mb_fold_safe($h), cfw_mb_fold_safe($n), 0, $encoding);
  return cfw_mb_isubpart($h, $pos, $before_needle, $encoding);
}
function mb_strwidth($string, $encoding = null) {
  $s = cfw_mb_sanitize($string);
  $re = cfw_mb_wide_regexp();
  if ($re === null || !cfw_mb_utf8($encoding)) {
    return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strwidth($s, $encoding);
  }
  return cfw_mb_width($s, $re);
}
function mb_chr($codepoint, $encoding = null) {
  $cp = (int) $codepoint;
  // the polyfill takes $code %= 0x200000 and encodes whatever falls out, so a surrogate,
  // a negative and anything past the last plane all come back as bytes native refuses
  if ($cp < 0 || $cp > 0x10FFFF || ($cp >= 0xD800 && $cp <= 0xDFFF)) { return false; }
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_chr($cp, $encoding);
}
function mb_ord($string, $encoding = null) {
  if ((string) $string === "") {
    // single quotes: a double-quoted PHP string would interpolate the $string in the message
    throw new \\ValueError(\'mb_ord(): Argument #1 ($string) must not be empty\');
  }
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_ord($string, $encoding);
}
function mb_scrub($string, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_scrub(cfw_mb_sanitize($string), $encoding);
}
function mb_encode_numericentity($string, $map, $encoding = null, $hex = false) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_encode_numericentity(cfw_mb_sanitize($string), $map, $encoding, $hex);
}
function mb_convert_encoding($string, $to_encoding, $from_encoding = null) {
  // SANITISE ONLY WHEN THE SOURCE IS UTF-8. cfw_mb_sanitize reads its input as UTF-8, so running
  // it over SJIS or ISO-8859-1 bytes replaces legal ones with "?" before the conversion starts
  $utf8In = cfw_mb_utf8($from_encoding) && !is_array($from_encoding);
  $one = function ($v) use ($utf8In, $to_encoding, $from_encoding) {
    if (!is_string($v)) { return $v; }
    if ($utf8In) {
      $v = cfw_mb_sanitize($v);
      // the substitution is keyed by utf-8 character, so this arm needs a utf-8 source
      return is_string($to_encoding) ? cfw_mb_encode_subst($v, $to_encoding) : $v;
    }
    if (!cfw_mb_utf8($to_encoding) || is_array($from_encoding) || !is_string($from_encoding)) { return $v; }
    $subst = cfw_mb_decode_subst($v, $from_encoding);
    return $subst === null ? $v : $subst;
  };
  $clean = is_array($string) ? array_map($one, $string) : $one($string);
  // a decoded arm already carries its "?" as utf-8, so say so rather than let the polyfill walk
  // the source a second time with //IGNORE; otherwise hand it a label its alias table knows
  $decoded = !$utf8In && is_string($clean) && cfw_mb_utf8($to_encoding) && $clean !== $string;
  $from = $decoded ? "UTF-8" : ($utf8In ? $from_encoding : cfw_mb_iconv_label($from_encoding));
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_convert_encoding($clean, $to_encoding, $from);
}
'); }
`;
