<?php

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
 *
 * @param mixed $s
 *   The string to clean; anything else is returned as it came.
 * @param string $sub
 *   What replaces each ill-formed run.
 *
 * @return mixed
 *   The cleaned string, or the input when it was not a string.
 */
function cfw_mb_sanitize($s, $sub = '?')
{
	if (!is_string($s) || $s === '') {
		return $s;
	}
	// fast path: already well-formed
	if (preg_match('//u', $s) === 1) {
		return $s;
	}

	$out = '';
	$len = strlen($s);
	$i = 0;
	while ($i < $len) {
		$b = ord($s[$i]);
		if ($b < 0x80) {
			$out .= $s[$i];
			$i++;
			continue;
		}

		// per-lead continuation ranges; the second byte carries the overlong and
		// surrogate bounds, which is why this is not a flat 0x80-0xBF test
		if ($b >= 0xc2 && $b <= 0xdf) {
			$need = 1;
			$lo1 = 0x80;
			$hi1 = 0xbf;
		} elseif ($b === 0xe0) {
			$need = 2;
			$lo1 = 0xa0;
			$hi1 = 0xbf;
		} elseif ($b >= 0xe1 && $b <= 0xec) {
			$need = 2;
			$lo1 = 0x80;
			$hi1 = 0xbf;
		} elseif ($b === 0xed) {
			$need = 2;
			$lo1 = 0x80;
			$hi1 = 0x9f;
		} elseif ($b >= 0xee && $b <= 0xef) {
			$need = 2;
			$lo1 = 0x80;
			$hi1 = 0xbf;
		} elseif ($b === 0xf0) {
			$need = 3;
			$lo1 = 0x90;
			$hi1 = 0xbf;
		} elseif ($b >= 0xf1 && $b <= 0xf3) {
			$need = 3;
			$lo1 = 0x80;
			$hi1 = 0xbf;
		} elseif ($b === 0xf4) {
			$need = 3;
			$lo1 = 0x80;
			$hi1 = 0x8f;
		} else {
			$out .= $sub;
			$i++;
			continue;
		}

		$consumed = 1;
		$ok = true;
		for ($k = 1; $k <= $need; $k++) {
			if ($i + $k >= $len) {
				$ok = false;
				break;
			}
			$c = ord($s[$i + $k]);
			$lo = $k === 1 ? $lo1 : 0x80;
			$hi = $k === 1 ? $hi1 : 0xbf;
			if ($c < $lo || $c > $hi) {
				$ok = false;
				break;
			}
			$consumed++;
		}

		if ($ok) {
			$out .= substr($s, $i, $need + 1);
			$i += $need + 1;
		} else {
			$out .= $sub;
			$i += $consumed;
		}
	}

	return $out;
}
