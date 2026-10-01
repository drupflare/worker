<?php

if (!function_exists('cfw_argon2_available')) {
	$__cfw_argon2 = function_exists('vrzno_env') ? vrzno_env('cfwArgon2') : null;
	if ($__cfw_argon2 !== null) {
		$GLOBALS['__cfw_argon2'] = $__cfw_argon2;

		function cfw_argon2_available(): bool
		{
			return true;
		}

		/**
		 * unpadded base64, which is what PHP's own argon2 encoding uses
		 *
		 * @param string $raw
		 *   The bytes to encode.
		 */
		function cfw_argon2_b64($raw): string
		{
			return rtrim(base64_encode($raw), '=');
		}

		/**
		 * @param string $password
		 *   The password bytes.
		 * @param string $salt
		 *   The salt bytes.
		 * @param int $m
		 *   Memory cost in KiB.
		 * @param int $t
		 *   Time cost.
		 * @param int $p
		 *   Lanes.
		 * @param int $tagLen
		 *   Output length in bytes.
		 *
		 * @return string|false|null
		 *   The raw tag, FALSE when the reply was not base64, or NULL when the host refused.
		 */
		function cfw_argon2_raw($password, $salt, $m, $t, $p, $tagLen = 32)
		{
			$fn = $GLOBALS['__cfw_argon2'];
			$reply = json_decode(
				$fn(
					json_encode([
						'op' => 'hash',
						'passB64' => base64_encode((string) $password),
						'saltB64' => base64_encode((string) $salt),
						'm' => (int) $m,
						't' => (int) $t,
						'p' => (int) $p,
						'tagLen' => (int) $tagLen,
					]),
				),
				true,
			);
			if (!is_array($reply) || ($reply['ok'] ?? false) !== true) {
				return null;
			}
			return base64_decode((string) ($reply['tagB64'] ?? ''), true);
		}

		/**
		 * Hashes into PHP's own encoded form.
		 *
		 * @param string $password
		 *   The password to hash.
		 * @param int $m
		 *   Memory cost in KiB.
		 * @param int $t
		 *   Time cost.
		 * @param int $p
		 *   Lanes.
		 *
		 * @return string|null
		 *   The encoded hash, or NULL when the host refused.
		 */
		function cfw_argon2_hash($password, $m = 19456, $t = 2, $p = 1)
		{
			$salt = random_bytes(16);
			$raw = cfw_argon2_raw($password, $salt, $m, $t, $p);
			if ($raw === null || $raw === false) {
				return null;
			}
			return sprintf(
				'$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s',
				19,
				(int) $m,
				(int) $t,
				(int) $p,
				cfw_argon2_b64($salt),
				cfw_argon2_b64($raw),
			);
		}

		/**
		 * Verifies against an encoded hash, in constant time.
		 *
		 * hash_equals() rather than ===, because a byte-at-a-time comparison of a password digest
		 * is a timing oracle even when the digest itself is memory-hard.
		 *
		 * @param string $password
		 *   The password to check.
		 * @param string $encoded
		 *   A hash cfw_argon2_hash() or PHP's own password_hash() wrote.
		 */
		function cfw_argon2_verify($password, $encoded): bool
		{
			$parts = explode('$', (string) $encoded);
			if (count($parts) !== 6 || $parts[1] !== 'argon2id') {
				return false;
			}
			$params = [];
			foreach (explode(',', $parts[3]) as $pair) {
				$kv = explode('=', $pair, 2);
				if (count($kv) === 2) {
					$params[$kv[0]] = (int) $kv[1];
				}
			}
			$salt = base64_decode(strtr($parts[4], '-_', '+/'), false);
			$want = base64_decode(strtr($parts[5], '-_', '+/'), false);
			if ($salt === false || $want === false || $want === '') {
				return false;
			}
			$raw = cfw_argon2_raw(
				$password,
				$salt,
				$params['m'] ?? 19456,
				$params['t'] ?? 2,
				$params['p'] ?? 1,
				strlen($want),
			);
			if ($raw === null || $raw === false) {
				return false;
			}
			return hash_equals($want, $raw);
		}

		/**
		 * whether an existing encoded hash was written with weaker parameters than today's
		 *
		 * @param string $encoded
		 *   The stored hash.
		 * @param int $m
		 *   Memory cost in KiB.
		 * @param int $t
		 *   Time cost.
		 * @param int $p
		 *   Lanes.
		 */
		function cfw_argon2_needs_rehash($encoded, $m = 19456, $t = 2, $p = 1): bool
		{
			$parts = explode('$', (string) $encoded);
			if (count($parts) !== 6 || $parts[1] !== 'argon2id') {
				return true;
			}
			$params = [];
			foreach (explode(',', $parts[3]) as $pair) {
				$kv = explode('=', $pair, 2);
				if (count($kv) === 2) {
					$params[$kv[0]] = (int) $kv[1];
				}
			}
			return ($params['m'] ?? 0) < (int) $m ||
				($params['t'] ?? 0) < (int) $t ||
				($params['p'] ?? 0) !== (int) $p;
		}
	}
}
