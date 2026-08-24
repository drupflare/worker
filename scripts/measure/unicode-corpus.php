<?php

/**
 * Sweeps every Unicode scalar value through the REAL mbstring extension and prints
 * the answers as deltas from identity.
 *
 * This is the oracle half of the corpus. The 1,232 hand-chosen cases in
 * mb-parity.php cannot see a wrong table -- they sample. A sweep of all 1,112,064
 * scalars is what found 95 lower, 95 upper and 273 titlecase mappings wrong in the
 * polyfill, and mb_strwidth wrong on 9,733.
 *
 * Emitted as ranges plus an exceptions map rather than 1.1M rows, because casing IS
 * mostly identity and a dump of mostly-nothing is not reviewable. The byte section
 * is the other half: every malformed UTF-8 family the sanitiser has to agree with.
 *
 * Driven by scripts/measure/unicode-corpus.ts, which pairs it with the workerd
 * casing sweep. Run that, not this.
 */

namespace {
	if (!extension_loaded('mbstring')) {
		fwrite(STDERR, "the oracle is the real extension; this php has no mbstring\n");
		exit(2);
	}

	const SURROGATE_LO = 0xd800;
	const SURROGATE_HI = 0xdfff;
	const MAX_SCALAR = 0x10ffff;

	/** encodes $cp in exactly $n bytes, which is ill-formed whenever $n is more than needed */
	$overlong = function (int $cp, int $n): string {
		if ($n === 2) {
			return chr(0xc0 | ($cp >> 6)) . chr(0x80 | ($cp & 0x3f));
		}
		if ($n === 3) {
			return chr(0xe0 | ($cp >> 12)) .
				chr(0x80 | (($cp >> 6) & 0x3f)) .
				chr(0x80 | ($cp & 0x3f));
		}
		if ($n === 4) {
			return chr(0xf0 | ($cp >> 18)) .
				chr(0x80 | (($cp >> 12) & 0x3f)) .
				chr(0x80 | (($cp >> 6) & 0x3f)) .
				chr(0x80 | ($cp & 0x3f));
		}
		return chr(0xf8 | ($cp >> 24)) .
			chr(0x80 | (($cp >> 18) & 0x3f)) .
			chr(0x80 | (($cp >> 12) & 0x3f)) .
			chr(0x80 | (($cp >> 6) & 0x3f)) .
			chr(0x80 | ($cp & 0x3f));
	};

	/** every scalar value, so the sweep is a property of Unicode rather than of a sample */
	$scalars = function (): \Generator {
		for ($cp = 0; $cp <= MAX_SCALAR; $cp++) {
			if ($cp >= SURROGATE_LO && $cp <= SURROGATE_HI) {
				continue;
			}
			yield $cp;
		}
	};

	/** utf-8 bytes to the codepoint list they encode; input is always well-formed here */
	$toCodepoints = function (string $s): array {
		$out = [];
		$len = strlen($s);
		for ($i = 0; $i < $len; ) {
			$b = ord($s[$i]);
			if ($b < 0x80) {
				$out[] = $b;
				$i += 1;
			} elseif ($b < 0xe0) {
				$out[] = (($b & 0x1f) << 6) | (ord($s[$i + 1]) & 0x3f);
				$i += 2;
			} elseif ($b < 0xf0) {
				$out[] =
					(($b & 0x0f) << 12) |
					((ord($s[$i + 1]) & 0x3f) << 6) |
					(ord($s[$i + 2]) & 0x3f);
				$i += 3;
			} else {
				$out[] =
					(($b & 0x07) << 18) |
					((ord($s[$i + 1]) & 0x3f) << 12) |
					((ord($s[$i + 2]) & 0x3f) << 6) |
					(ord($s[$i + 3]) & 0x3f);
				$i += 4;
			}
		}
		return $out;
	};

	// #region encoding

	/**
	 * Packs {cp => [cp']} into constant-delta runs and leaves everything else in a map.
	 *
	 * A run is what makes the artifact reviewable: `[65, 90, 32]` says A-Z lowercase by
	 * +32 in one line where 26 rows would say nothing extra. Multi-codepoint results
	 * (Fer -> FFL, sharp s -> SS) can never be a delta and always land in `map`.
	 */
	$pack = function (array $delta): array {
		$ranges = [];
		$map = [];
		$run = null;
		foreach ($delta as $cp => $res) {
			if (count($res) !== 1) {
				$map[(string) $cp] = $res;
				continue;
			}
			$d = $res[0] - $cp;
			if ($run !== null && $run[2] === $d && $run[1] + 1 === $cp) {
				$run[1] = $cp;
				continue;
			}
			if ($run !== null) {
				$ranges[] = $run;
			}
			$run = [$cp, $cp, $d];
		}
		if ($run !== null) {
			$ranges[] = $run;
		}
		return ['ranges' => $ranges, 'map' => $map];
	};

	/** packs {cp => int} into [lo, hi, value] runs; used for the width table */
	$packInt = function (array $values): array {
		$ranges = [];
		$run = null;
		foreach ($values as $cp => $v) {
			if ($run !== null && $run[2] === $v && $run[1] + 1 === $cp) {
				$run[1] = $cp;
				continue;
			}
			if ($run !== null) {
				$ranges[] = $run;
			}
			$run = [$cp, $cp, $v];
		}
		if ($run !== null) {
			$ranges[] = $run;
		}
		return $ranges;
	};

	// #endregion

	// #region casing sweep

	$lower = [];
	$upper = [];
	$title = [];
	$fold = [];
	$width = [];
	$titleExtra = [];

	foreach ($scalars() as $cp) {
		$ch = mb_chr($cp, 'UTF-8');
		if ($ch === false) {
			fwrite(STDERR, 'mb_chr refused U+' . strtoupper(dechex($cp)) . "\n");
			exit(2);
		}

		$lo = mb_strtolower($ch, 'UTF-8');
		if ($lo !== $ch) {
			$lower[$cp] = $toCodepoints($lo);
		}
		$up = mb_strtoupper($ch, 'UTF-8');
		if ($up !== $ch) {
			$upper[$cp] = $toCodepoints($up);
		}
		$ti = mb_convert_case($ch, MB_CASE_TITLE, 'UTF-8');
		if ($ti !== $ch) {
			$title[$cp] = $toCodepoints($ti);
			// the polyfill's word pattern is (\pL)(\pL*+), so a character mbstring titlecases
			// that PCRE does not call a letter -- roman numerals, circled letters -- is never
			// offered to the callback at all. Measured with the engine that runs the pattern
			if (preg_match('/\pL/u', $ch) !== 1) {
				$titleExtra[$cp] = 1;
			}
		}
		$fo = mb_convert_case($ch, MB_CASE_FOLD, 'UTF-8');
		if ($fo !== $ch) {
			$fold[$cp] = $toCodepoints($fo);
		}
		$w = mb_strwidth($ch, 'UTF-8');
		if ($w !== 1) {
			$width[$cp] = $w;
		}
	}

	// #endregion

	// #region byte families

	/**
	 * Every ill-formed UTF-8 family the sanitiser has to agree with, generated rather
	 * than listed: lone bytes, every lead crossed with the continuation values that sit
	 * on its legal boundary, truncations, overlongs, surrogate encodings and
	 * out-of-range four-byte forms.
	 *
	 * The oracle is mb_scrub, which is where native's substitution rule lives -- one
	 * "?" per maximal valid prefix consumed, not one per bad byte.
	 */
	$bytes = [];
	$seen = [];
	$record = function (string $s) use (&$bytes, &$seen) {
		$key = bin2hex($s);
		if (isset($seen[$key])) {
			return;
		}
		$seen[$key] = true;
		// positional, not keyed: 2,781 copies of four key names is 67 KB of nothing
		$bytes[] = [
			$key,
			bin2hex((string) mb_scrub($s, 'UTF-8')),
			mb_check_encoding($s, 'UTF-8') ? 1 : 0,
			mb_strlen($s, 'UTF-8'),
		];
	};

	for ($b = 0; $b <= 0xff; $b++) {
		$record(chr($b));
		$record('a' . chr($b) . 'z');
	}
	// the boundary continuation values: below, at, inside, at and above each lead's range
	$edges = [0x00, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xff];
	for ($lead = 0xc0; $lead <= 0xf7; $lead++) {
		foreach ($edges as $c1) {
			$record(chr($lead) . chr($c1));
			$record(chr($lead) . chr($c1) . chr(0x80));
			$record(chr($lead) . chr($c1) . chr(0x80) . chr(0x80));
			$record('a' . chr($lead) . chr($c1) . 'z');
		}
		// truncation: a lead with nothing after it, and with one continuation short
		$record(chr($lead));
		$record(chr($lead) . chr(0x80));
	}
	// overlongs of the same scalar at every length that can express it; a length whose
	// payload cannot hold the value is not an overlong of it, it is a different string
	$payloadBits = [2 => 11, 3 => 16, 4 => 21, 5 => 26];
	foreach ([0x00, 0x2f, 0x7f, 0x80, 0x7ff, 0x800, 0xffff] as $cp) {
		for ($n = 2; $n <= 4; $n++) {
			if ($cp >> $payloadBits[$n] === 0) {
				$record($overlong($cp, $n));
			}
		}
	}
	// every surrogate encoded as if it were a scalar, plus the ends of the out-of-range space
	foreach ([0xd800, 0xdbff, 0xdc00, 0xdfff] as $cp) {
		$record($overlong($cp, 3));
		$record('a' . $overlong($cp, 3) . 'z');
	}
	foreach ([0x110000, 0x1fffff, 0x200000] as $cp) {
		$record($overlong($cp, $cp > 0x1fffff ? 5 : 4));
	}
	// a valid sequence with its last byte cut, at every length, which is the family a
	// first version of cfw_mb_sanitize got wrong
	foreach (["\u{e9}", "\u{4e00}", "\u{1f600}"] as $ch) {
		for ($k = 1; $k < strlen($ch); $k++) {
			$record(substr($ch, 0, $k));
			$record('abc' . substr($ch, 0, $k) . 'def');
		}
	}

	// #endregion

	// #region offsets

	/**
	 * Boundary offsets on a string whose characters are 1, 2, 3 and 4 bytes wide, so a
	 * substr implementation that counts bytes disagrees with one that counts characters
	 * at every index rather than only past the first multibyte character.
	 */
	$mixed = "a\u{e9}\u{4e00}\u{1f600}b\u{e9}\u{4e00}\u{1f600}";
	$offsets = [];
	$n = mb_strlen($mixed, 'UTF-8');
	for ($start = -$n - 1; $start <= $n + 1; $start++) {
		foreach ([null, 0, 1, 2, $n, -1, -$n] as $len) {
			$offsets[] = [
				'start' => $start,
				'len' => $len,
				'out' => bin2hex((string) mb_substr($mixed, $start, $len, 'UTF-8')),
			];
		}
	}

	// #endregion

	$doc = [
		'provenance' => [
			'php' => PHP_VERSION,
			'mbstring' => phpversion('mbstring') ?: null,
			// mbstring does not report the Unicode version of its own case tables, so this
			// is the closest pin available and it is NOT that version -- oniguruma is the
			// regex engine. ext-intl's answer is recorded beside it when the build has one
			'oniguruma' => defined('MB_ONIGURUMA_VERSION') ? MB_ONIGURUMA_VERSION : null,
			'icuUnicode' => class_exists('IntlChar') ? \IntlChar::getUnicodeVersion() : null,
			'scalars' => 0x110000 - (SURROGATE_HI - SURROGATE_LO + 1),
		],
		'case' => [
			'lower' => $pack($lower),
			'upper' => $pack($upper),
			'title' => $pack($title),
			'fold' => $pack($fold),
		],
		'width' => $packInt($width),
		'titleExtra' => $packInt($titleExtra),
		'bytes' => $bytes,
		'offsets' => ['subject' => bin2hex($mixed), 'cases' => $offsets],
	];

	echo json_encode($doc, JSON_UNESCAPED_SLASHES), "\n";
}
