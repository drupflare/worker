<?php

if (!function_exists('cfw_sodium_installed')) {
	$__cfw_sodium = function_exists('vrzno_env') ? vrzno_env('cfwSodium') : null;
	if ($__cfw_sodium !== null) {
		$GLOBALS['__cfw_sodium'] = $__cfw_sodium;

		if (!class_exists('SodiumException')) {
			class SodiumException extends Exception {}
		}

		function cfw_sodium_installed(): bool
		{
			return true;
		}

		// __CFW_SODIUM_CONSTANTS__

		/**
		 * Raises what ext-sodium raises.
		 *
		 * @param string $why
		 *   The message.
		 *
		 * @throws SodiumException
		 */
		function cfw_sodium_fail($why): never
		{
			throw new SodiumException($why);
		}

		/**
		 * A string argument as the base64 the host reads, coerced the way an internal function
		 * coerces it.
		 *
		 * @param string $fn
		 *   The function name, for the message.
		 * @param int $at
		 *   The argument's zero-based position.
		 * @param string $name
		 *   The parameter name.
		 * @param mixed $v
		 *   What the caller passed.
		 */
		function cfw_sodium_str($fn, $at, $name, $v): string
		{
			if (is_string($v)) {
				return base64_encode($v);
			}
			if (is_int($v) || is_float($v) || is_bool($v) || $v === null) {
				return base64_encode((string) $v);
			}
			if (is_object($v) && method_exists($v, '__toString')) {
				return base64_encode((string) $v);
			}
			throw new TypeError(
				sprintf(
					'%s(): Argument #%d ($%s) must be of type string, %s given',
					$fn,
					$at + 1,
					$name,
					get_debug_type($v),
				),
			);
		}

		/**
		 * An int argument as the decimal string the host reads.
		 *
		 * @param string $fn
		 *   The function name, for the message.
		 * @param int $at
		 *   The argument's zero-based position.
		 * @param string $name
		 *   The parameter name.
		 * @param mixed $v
		 *   What the caller passed.
		 */
		function cfw_sodium_int($fn, $at, $name, $v): string
		{
			if (is_int($v)) {
				return (string) $v;
			}
			if (is_bool($v) || $v === null) {
				return (string) (int) $v;
			}
			if (is_float($v) && is_finite($v) && floor($v) === $v) {
				return (string) (int) $v;
			}
			if (is_string($v) && is_numeric($v) && (string) (int) $v === trim($v)) {
				return (string) (int) $v;
			}
			throw new TypeError(
				sprintf(
					'%s(): Argument #%d ($%s) must be of type int, %s given',
					$fn,
					$at + 1,
					$name,
					get_debug_type($v),
				),
			);
		}

		/**
		 * A by-reference state argument; anything but a string is not a state.
		 *
		 * @param string $fn
		 *   The function name, for the message.
		 * @param int $at
		 *   The argument's zero-based position.
		 * @param string $name
		 *   The parameter name.
		 * @param mixed $v
		 *   What the caller passed.
		 */
		function cfw_sodium_ref($fn, $at, $name, $v): string
		{
			if (!is_string($v)) {
				cfw_sodium_fail(
					sprintf(
						'%s(): Argument #%d ($%s) must be a reference to a state',
						$fn,
						$at + 1,
						$name,
					),
				);
			}
			return base64_encode($v);
		}

		/**
		 * Reads one tagged value out of a reply.
		 *
		 * @param array<string, mixed> $v
		 *   The tagged value.
		 */
		function cfw_sodium_dec($v)
		{
			if (array_key_exists('s', $v)) {
				$out = base64_decode((string) $v['s'], true);
				if ($out === false) {
					cfw_sodium_fail('reply was not base64');
				}
				return $out;
			}
			if (array_key_exists('b', $v)) {
				return (bool) $v['b'];
			}
			if (array_key_exists('i', $v)) {
				return (int) $v['i'];
			}
			if (array_key_exists('l', $v)) {
				return array_map('cfw_sodium_dec', $v['l']);
			}
			return null;
		}

		/**
		 * One call over the bridge.
		 *
		 * @param string $fn
		 *   The sodium function.
		 * @param array<int, string> $args
		 *   Its arguments, already base64 or decimal.
		 *
		 * @return array<string, mixed>
		 *   The successful reply.
		 */
		function cfw_sodium_exchange($fn, array $args): array
		{
			$bridge = $GLOBALS['__cfw_sodium'];
			$reply = json_decode($bridge(json_encode(['f' => $fn, 'a' => $args])), true);
			if (!is_array($reply)) {
				cfw_sodium_fail('unreadable reply');
			}
			if (($reply['ok'] ?? false) !== true) {
				$why = (string) ($reply['m'] ?? 'no reason given');
				switch ($reply['c'] ?? '') {
					case 'TypeError':
						throw new TypeError($why);

					case 'ValueError':
						throw new ValueError($why);

					default:
						throw new SodiumException($why);
				}
			}
			return $reply;
		}

		/**
		 * Runs one wrapper's call: coerces each argument by its declared kind, crosses the bridge,
		 * and writes back any by-reference state.
		 *
		 * @param string $fn
		 *   The sodium function, from __FUNCTION__.
		 * @param array<int, mixed> $args
		 *   The wrapper's arguments, by reference where the function takes a state.
		 */
		function cfw_sodium_go($fn, array $args)
		{
			[$kinds, $names] = $GLOBALS['__cfw_sodium_sig'][$fn];
			$names = explode(',', $names);
			$wire = [];
			foreach ($args as $at => $v) {
				$kind = $kinds[$at];
				$wire[] =
					$kind === 'i'
						? cfw_sodium_int($fn, $at, $names[$at], $v)
						: ($kind === 'r'
							? cfw_sodium_ref($fn, $at, $names[$at], $v)
							: cfw_sodium_str($fn, $at, $names[$at], $v));
			}
			$reply = cfw_sodium_exchange($fn, $wire);
			foreach ($reply['refs'] ?? [] as $at => $value) {
				$args[(int) $at] = $value === null ? null : base64_decode((string) $value, true);
			}
			return cfw_sodium_dec($reply['r']);
		}

		/**
		 * The message for a by-reference argument that is not a string.
		 *
		 * @param mixed $v
		 *   The argument.
		 */
		function cfw_sodium_string_ref($v): string
		{
			if (!is_string($v)) {
				cfw_sodium_fail('a PHP string is required');
			}
			return $v;
		}

		/**
		 * Two same-length arguments, or the refusal ext-sodium gives.
		 *
		 * @param string $fn
		 *   The function name.
		 * @param string $a
		 *   The first string.
		 * @param string $b
		 *   The second string.
		 */
		function cfw_sodium_same_length($fn, $a, $b): void
		{
			if (strlen($a) !== strlen($b)) {
				cfw_sodium_fail(
					$fn .
						'(): Argument #1 ($string1) and argument #2 ($string_2) must have the same length',
				);
			}
		}

		// #region the functions that need no host

		function sodium_bin2hex(#[\SensitiveParameter] $string)
		{
			return bin2hex(cfw_sodium_arg('sodium_bin2hex', 0, 'string', $string));
		}

		/**
		 * A string argument, coerced.
		 *
		 * @param string $fn
		 *   The function name.
		 * @param int $at
		 *   The argument's zero-based position.
		 * @param string $name
		 *   The parameter name.
		 * @param mixed $v
		 *   The argument.
		 */
		function cfw_sodium_arg($fn, $at, $name, $v): string
		{
			return base64_decode(cfw_sodium_str($fn, $at, $name, $v), true);
		}

		function sodium_hex2bin(#[\SensitiveParameter] $string, $ignore = '')
		{
			$fn = 'sodium_hex2bin';
			$string = cfw_sodium_arg($fn, 0, 'string', $string);
			$ignore = cfw_sodium_arg($fn, 1, 'ignore', $ignore);
			$out = '';
			$high = null;
			for ($i = 0, $n = strlen($string); $i < $n; $i++) {
				$c = $string[$i];
				if (ctype_xdigit($c)) {
					$v = hexdec($c);
					if ($high === null) {
						$high = $v;
					} else {
						$out .= chr(($high << 4) | $v);
						$high = null;
					}
					continue;
				}
				if ($high === null && $ignore !== '' && strpos($ignore, $c) !== false) {
					continue;
				}
				$high = 0;
				$i = $n + 1;
			}
			if ($high !== null) {
				cfw_sodium_fail(
					$fn . '(): Argument #1 ($string) must be a valid hexadecimal string',
				);
			}
			return $out;
		}

		/**
		 * The base64 variant flags: padded, URL-safe.
		 *
		 * @param string $fn
		 *   The function name.
		 * @param mixed $id
		 *   The caller's variant.
		 *
		 * @return array{0: bool, 1: bool}
		 */
		function cfw_sodium_variant($fn, $id): array
		{
			$id = (int) cfw_sodium_int($fn, 1, 'id', $id);
			if ($id !== 1 && $id !== 3 && $id !== 5 && $id !== 7) {
				cfw_sodium_fail(
					$fn . '(): Argument #2 ($id) must be a valid base64 variant identifier',
				);
			}
			return [($id & 2) === 0, ($id & 4) !== 0];
		}

		function sodium_bin2base64(#[\SensitiveParameter] $string, $id)
		{
			$fn = 'sodium_bin2base64';
			$string = cfw_sodium_arg($fn, 0, 'string', $string);
			[$padded, $urlsafe] = cfw_sodium_variant($fn, $id);
			$out = base64_encode($string);
			if ($urlsafe) {
				$out = strtr($out, '+/', '-_');
			}
			return $padded ? $out : rtrim($out, '=');
		}

		function sodium_base642bin(#[\SensitiveParameter] $string, $id, $ignore = '')
		{
			$fn = 'sodium_base642bin';
			$string = cfw_sodium_arg($fn, 0, 'string', $string);
			[$padded, $urlsafe] = cfw_sodium_variant($fn, $id);
			$ignore = cfw_sodium_arg($fn, 2, 'ignore', $ignore);
			$alphabet =
				'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' .
				($urlsafe ? '-_' : '+/');
			$bad = $fn . '(): Argument #1 ($string) must be a valid base64 string';
			$out = '';
			$acc = 0;
			$bits = 0;
			$i = 0;
			$n = strlen($string);
			for (; $i < $n; $i++) {
				$d = strpos($alphabet, $string[$i]);
				if ($d === false) {
					if ($ignore !== '' && strpos($ignore, $string[$i]) !== false) {
						continue;
					}
					break;
				}
				$acc = (($acc << 6) | $d) & 0xffff;
				$bits += 6;
				if ($bits >= 8) {
					$bits -= 8;
					$out .= chr(($acc >> $bits) & 0xff);
				}
			}
			if ($bits > 4 || ($acc & ((1 << $bits) - 1)) !== 0) {
				cfw_sodium_fail($bad);
			}
			if ($padded && $bits !== 0) {
				$want = intdiv($bits, 2);
				for (; $i < $n; $i++) {
					if ($string[$i] === '=' && $want > 0) {
						$want--;
					} elseif ($ignore === '' || strpos($ignore, $string[$i]) === false) {
						break;
					}
				}
				if ($want !== 0) {
					cfw_sodium_fail($bad);
				}
			}
			if ($i < $n) {
				cfw_sodium_fail($bad);
			}
			return $out;
		}

		function sodium_pad(#[\SensitiveParameter] $string, $block_size)
		{
			$fn = 'sodium_pad';
			$string = cfw_sodium_arg($fn, 0, 'string', $string);
			$size = (int) cfw_sodium_int($fn, 1, 'block_size', $block_size);
			if ($size <= 0) {
				cfw_sodium_fail($fn . '(): Argument #2 ($block_size) must be greater than 0');
			}
			$extra = $size - 1 - (strlen($string) % $size);
			return $string . "\x80" . str_repeat("\0", $extra);
		}

		function sodium_unpad(#[\SensitiveParameter] $string, $block_size)
		{
			$fn = 'sodium_unpad';
			$string = cfw_sodium_arg($fn, 0, 'string', $string);
			$size = (int) cfw_sodium_int($fn, 1, 'block_size', $block_size);
			if ($size <= 0) {
				cfw_sodium_fail($fn . '(): Argument #2 ($block_size) must be greater than 0');
			}
			$len = strlen($string);
			if ($len < $size) {
				cfw_sodium_fail(
					$fn . '(): Argument #1 ($string) must be at least as long as the block size',
				);
			}
			for ($i = 0; $i < $size; $i++) {
				$c = ord($string[$len - 1 - $i]);
				if ($c === 0) {
					continue;
				}
				if ($c === 0x80) {
					return substr($string, 0, $len - 1 - $i);
				}
				break;
			}
			cfw_sodium_fail('invalid padding');
		}

		function sodium_memzero(#[\SensitiveParameter] &$string)
		{
			cfw_sodium_string_ref($string);
			$string = null;
		}

		function sodium_memcmp(#[\SensitiveParameter] $string1, #[\SensitiveParameter] $string2)
		{
			$fn = 'sodium_memcmp';
			$a = cfw_sodium_arg($fn, 0, 'string1', $string1);
			$b = cfw_sodium_arg($fn, 1, 'string2', $string2);
			cfw_sodium_same_length($fn, $a, $b);
			return hash_equals($a, $b) ? 0 : -1;
		}

		function sodium_compare(#[\SensitiveParameter] $string1, #[\SensitiveParameter] $string2)
		{
			$fn = 'sodium_compare';
			$a = cfw_sodium_arg($fn, 0, 'string1', $string1);
			$b = cfw_sodium_arg($fn, 1, 'string2', $string2);
			cfw_sodium_same_length($fn, $a, $b);
			for ($i = strlen($a) - 1; $i >= 0; $i--) {
				if ($a[$i] !== $b[$i]) {
					return ord($a[$i]) < ord($b[$i]) ? -1 : 1;
				}
			}
			return 0;
		}

		function sodium_increment(&$string)
		{
			$s = cfw_sodium_string_ref($string);
			for ($i = 0, $n = strlen($s); $i < $n; $i++) {
				$v = (ord($s[$i]) + 1) & 0xff;
				$s[$i] = chr($v);
				if ($v !== 0) {
					break;
				}
			}
			$string = $s;
		}

		function sodium_add(&$string1, $string2)
		{
			$fn = 'sodium_add';
			if (!is_string($string1)) {
				cfw_sodium_fail('PHP strings are required');
			}
			$a = $string1;
			$b = cfw_sodium_arg($fn, 1, 'string2', $string2);
			cfw_sodium_same_length($fn, $a, $b);
			$carry = 0;
			for ($i = 0, $n = strlen($a); $i < $n; $i++) {
				$sum = ord($a[$i]) + ord($b[$i]) + $carry;
				$a[$i] = chr($sum & 0xff);
				$carry = $sum >> 8;
			}
			$string1 = $a;
		}

		// #endregion

		// __CFW_SODIUM_SIGNATURES__

		// __CFW_SODIUM_FUNCTIONS__
	}
}
