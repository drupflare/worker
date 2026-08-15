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
function cfw_mb_sanitize($s) {
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
    else { $out .= "?"; $i++; continue; }

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
    else { $out .= "?"; $i += $consumed; }
  }

  return $out;
}
'); }
`;

/**
 * The wrappers. Each is defined only if the real extension is absent, so this is
 * inert on a build that has mbstring compiled in.
 */
export const MB_FIX = String.raw`
${MB_SANITIZE}
if (!extension_loaded('mbstring') && !function_exists('cfw_mb_installed')) { eval('
function cfw_mb_installed() { return true; }

function mb_substr($string, $start, $length = null, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_substr(cfw_mb_sanitize($string), $start, $length, $encoding);
}
function mb_strlen($string, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strlen(cfw_mb_sanitize($string), $encoding);
}
function mb_strtolower($string, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strtolower(cfw_mb_sanitize($string), $encoding);
}
function mb_strtoupper($string, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strtoupper(cfw_mb_sanitize($string), $encoding);
}
function mb_convert_case($string, $mode, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_convert_case(cfw_mb_sanitize($string), $mode, $encoding);
}
function mb_strpos($haystack, $needle, $offset = 0, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_strpos(cfw_mb_sanitize($haystack), cfw_mb_sanitize($needle), $offset, $encoding);
}
function mb_stripos($haystack, $needle, $offset = 0, $encoding = null) {
  return \\Symfony\\Polyfill\\Mbstring\\Mbstring::mb_stripos(cfw_mb_sanitize($haystack), cfw_mb_sanitize($needle), $offset, $encoding);
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
'); }
`;
