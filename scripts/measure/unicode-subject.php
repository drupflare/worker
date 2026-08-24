<?php

/**
 * Sweeps every Unicode scalar value through the SHIPPING mb_* stack and prints the
 * answers in the same shape unicode-corpus.php prints the extension's.
 *
 * The subject is not the wasm build. It is the same PHP the wasm build runs --
 * symfony/polyfill-mbstring over symfony/polyfill-iconv, plus this repo's
 * cfw_mb_sanitize, cfw_mb_patch and the generated tables -- reproduced in a native
 * process so the oracle is available in the same run.
 *
 * Both arms are emitted. `bare` is the polyfill on its own, which is what a figure
 * like "mb_strwidth is wrong on 9,733 codepoints" measures; `ship` is what the
 * wrappers answer, which is the number that has to reach zero.
 *
 * Driven by scripts/measure/unicode-corpus.ts, which generates the stack file out of
 * mb-fix.ts. Run that, not this.
 */

namespace Symfony\Polyfill\Mbstring {
	use Symfony\Polyfill\Iconv\Iconv as IconvPolyfill;

	// Mbstring.php calls iconv_*() unqualified from inside this namespace, so these shadow
	// the extension and force the same two-polyfill stack the edge runs
	function iconv($from, $to, $s)
	{
		return IconvPolyfill::iconv($from, $to, $s);
	}
	function iconv_strlen($s, $encoding = null)
	{
		return IconvPolyfill::iconv_strlen($s, $encoding);
	}
	function iconv_strpos($haystack, $needle, $offset = 0, $encoding = null)
	{
		return IconvPolyfill::iconv_strpos($haystack, $needle, $offset, $encoding);
	}
	function iconv_strrpos($haystack, $needle, $encoding = null)
	{
		return function_exists('cfw_iconv_strrpos')
			? \cfw_iconv_strrpos($haystack, $needle, $encoding)
			: IconvPolyfill::iconv_strrpos($haystack, $needle, $encoding);
	}
	function iconv_substr($s, $start, $length = 2147483647, $encoding = null)
	{
		return IconvPolyfill::iconv_substr($s, $start, $length, $encoding);
	}
	function iconv_mime_decode($s, $mode = 0, $encoding = null)
	{
		return IconvPolyfill::iconv_mime_decode($s, $mode, $encoding);
	}
}

namespace {
	use Symfony\Polyfill\Mbstring\Mbstring as P;

	$opt = function (string $name, ?string $default = null) use ($argv): ?string {
		foreach ($argv as $a) {
			if (str_starts_with($a, "--{$name}=")) {
				return substr($a, strlen($name) + 3);
			}
		}
		return $default;
	};

	$root = $opt('root', __DIR__ . '/../../drupal-src');
	$vendor = $root . '/vendor/symfony';
	foreach (['polyfill-iconv/Iconv.php', 'polyfill-mbstring/Mbstring.php'] as $rel) {
		if (!is_file($vendor . '/' . $rel)) {
			fwrite(STDERR, "missing {$vendor}/{$rel}\n");
			exit(2);
		}
		require_once $vendor . '/' . $rel;
	}

	if (!extension_loaded('mbstring')) {
		fwrite(STDERR, "the sweep needs mb_chr from the extension to build its inputs\n");
		exit(2);
	}

	$stack = $opt('stack');
	if ($stack === null || !is_file($stack)) {
		fwrite(STDERR, "run scripts/measure/unicode-corpus.ts; --stack= is generated\n");
		exit(2);
	}
	require_once $stack;

	// #region encoding

	$toCodepoints = function (string $s): array {
		$out = [];
		$len = strlen($s);
		for ($i = 0; $i < $len; ) {
			$b = ord($s[$i]);
			if ($b < 0x80) {
				$out[] = $b;
				$i += 1;
			} elseif ($b < 0xe0) {
				$out[] = (($b & 0x1f) << 6) | (ord($s[$i + 1] ?? "\0") & 0x3f);
				$i += 2;
			} elseif ($b < 0xf0) {
				$out[] =
					(($b & 0x0f) << 12) |
					((ord($s[$i + 1] ?? "\0") & 0x3f) << 6) |
					(ord($s[$i + 2] ?? "\0") & 0x3f);
				$i += 3;
			} else {
				$out[] =
					(($b & 0x07) << 18) |
					((ord($s[$i + 1] ?? "\0") & 0x3f) << 12) |
					((ord($s[$i + 2] ?? "\0") & 0x3f) << 6) |
					(ord($s[$i + 3] ?? "\0") & 0x3f);
				$i += 4;
			}
		}
		return $out;
	};

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

	// #region sweep

	/** the shipping wrapper when MB_FIX declares one, the bare polyfill when it does not */
	$ship = function (string $fn, array $args) {
		$w = 'CfwShip\\' . $fn;
		$c = function_exists($w) ? $w : [P::class, $fn];
		return $c(...$args);
	};
	$bare = function (string $fn, array $args) {
		$c = [P::class, $fn];
		return $c(...$args);
	};

	$arms = ['bare' => $bare, 'ship' => $ship];
	$out = [];

	foreach ($arms as $arm => $call) {
		$lower = [];
		$upper = [];
		$title = [];
		$width = [];
		for ($cp = 0; $cp <= 0x10ffff; $cp++) {
			if ($cp >= 0xd800 && $cp <= 0xdfff) {
				continue;
			}
			$ch = mb_chr($cp, 'UTF-8');

			$v = (string) $call('mb_strtolower', [$ch, 'UTF-8']);
			if ($v !== $ch) {
				$lower[$cp] = $toCodepoints($v);
			}
			$v = (string) $call('mb_strtoupper', [$ch, 'UTF-8']);
			if ($v !== $ch) {
				$upper[$cp] = $toCodepoints($v);
			}
			$v = (string) $call('mb_convert_case', [$ch, MB_CASE_TITLE, 'UTF-8']);
			if ($v !== $ch) {
				$title[$cp] = $toCodepoints($v);
			}
			$w = (int) $call('mb_strwidth', [$ch, 'UTF-8']);
			if ($w !== 1) {
				$width[$cp] = $w;
			}
		}
		$out[$arm] = [
			'case' => [
				'lower' => $pack($lower),
				'upper' => $pack($upper),
				'title' => $pack($title),
			],
			'width' => $packInt($width),
		];
	}

	// #endregion

	echo json_encode($out, JSON_UNESCAPED_SLASHES), "\n";
}
