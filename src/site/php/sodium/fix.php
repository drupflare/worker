<?php

if (!extension_loaded('sodium') && !function_exists('cfw_sodium_installed')) {
	$__cfw_blake2b = function_exists('vrzno_env') ? vrzno_env('cfwBlake2b') : null;
	if ($__cfw_blake2b !== null) {
		$GLOBALS['__cfw_blake2b'] = $__cfw_blake2b;

		// ext-sodium declares these, and a caller reads KEYBYTES_MAX, KEYBYTES and BYTES_MIN by name;
		// an undefined constant is a fatal Error in PHP 8 rather than a warning
		if (!defined('SODIUM_CRYPTO_GENERICHASH_BYTES')) {
			define('SODIUM_CRYPTO_GENERICHASH_BYTES', 32);
		}
		if (!defined('SODIUM_CRYPTO_GENERICHASH_BYTES_MIN')) {
			define('SODIUM_CRYPTO_GENERICHASH_BYTES_MIN', 16);
		}
		if (!defined('SODIUM_CRYPTO_GENERICHASH_BYTES_MAX')) {
			define('SODIUM_CRYPTO_GENERICHASH_BYTES_MAX', 64);
		}
		if (!defined('SODIUM_CRYPTO_GENERICHASH_KEYBYTES')) {
			define('SODIUM_CRYPTO_GENERICHASH_KEYBYTES', 32);
		}
		if (!defined('SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MIN')) {
			define('SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MIN', 16);
		}
		if (!defined('SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MAX')) {
			define('SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MAX', 64);
		}

		// ext-sodium ships this class, so callers catch it by name; sodium_compat declares the same
		if (!class_exists('SodiumException')) {
			class SodiumException extends Exception {}
		}

		function cfw_sodium_installed(): bool
		{
			return true;
		}

		/**
		 * Runs one op over the bridge.
		 *
		 * @param array<string, mixed> $payload
		 *   The request, including its `op`.
		 *
		 * @return array<string, mixed>
		 *   ['ok' => true, ...] or ['ok' => false, 'error' => string].
		 */
		function cfw_blake2b(array $payload): array
		{
			$fn = $GLOBALS['__cfw_blake2b'];
			$reply = json_decode($fn(json_encode($payload)), true);
			if (!is_array($reply) || ($reply['ok'] ?? false) !== true) {
				$why = is_array($reply)
					? (string) ($reply['error'] ?? 'no reason given')
					: 'unreadable reply';
				return ['ok' => false, 'error' => $why];
			}
			return $reply;
		}

		/**
		 * Raises what ext-sodium raises. Every one of these functions throws rather than returning
		 * FALSE, so a caller cannot mistake a refusal for a digest.
		 *
		 * @param string $reason
		 *   The refusal.
		 *
		 * @throws SodiumException
		 */
		function cfw_blake2b_fail($reason): never
		{
			throw new SodiumException($reason);
		}

		/**
		 * The raw digest bytes out of a reply.
		 *
		 * @param array<string, mixed> $reply
		 *   A successful bridge reply.
		 */
		function cfw_blake2b_bytes(array $reply): string
		{
			$out = base64_decode((string) ($reply['b64'] ?? ''), true);
			if ($out === false) {
				cfw_blake2b_fail('reply was not base64');
			}
			return $out;
		}

		/**
		 * @param string $message
		 *   The bytes to digest.
		 * @param string $key
		 *   The key, or an empty string for none.
		 * @param int $length
		 *   The digest length in bytes.
		 */
		function sodium_crypto_generichash($message, $key = '', $length = 32): string
		{
			$r = cfw_blake2b([
				'op' => 'hash',
				'b64' => base64_encode((string) $message),
				'key64' => base64_encode((string) $key),
				'len' => (int) $length,
			]);
			if (!$r['ok']) {
				cfw_blake2b_fail($r['error']);
			}
			return cfw_blake2b_bytes($r);
		}

		/**
		 * Mints an incremental state.
		 *
		 * ext-sodium returns a 384-byte binary string holding the context itself. This returns an
		 * opaque token instead, because the context lives in JavaScript -- see the bridge docblock.
		 * Every caller treats the value as opaque, which is what makes the substitution safe.
		 *
		 * @param string $key
		 *   The key, or an empty string for none.
		 * @param int $length
		 *   The digest length in bytes.
		 */
		function sodium_crypto_generichash_init($key = '', $length = 32): string
		{
			$r = cfw_blake2b([
				'op' => 'init',
				'key64' => base64_encode((string) $key),
				'len' => (int) $length,
			]);
			if (!$r['ok']) {
				cfw_blake2b_fail($r['error']);
			}
			return 'cfwb2b:' . (int) ($r['state'] ?? 0);
		}

		/**
		 * Reads a state token, refusing anything that is not one.
		 *
		 * "incorrect state length" is ext-sodium's own message for a string that is not a state,
		 * measured on 8.5.7, so a caller matching on it keeps working.
		 *
		 * @param string|null $state
		 *   A token sodium_crypto_generichash_init() returned.
		 */
		function cfw_blake2b_state($state): int
		{
			if (!is_string($state) || strncmp($state, 'cfwb2b:', 7) !== 0) {
				cfw_blake2b_fail('incorrect state length');
			}
			return (int) substr($state, 7);
		}

		/**
		 * @param string|null $state
		 *   A token sodium_crypto_generichash_init() returned.
		 * @param string $message
		 *   The bytes to add.
		 */
		function sodium_crypto_generichash_update(&$state, $message): bool
		{
			$r = cfw_blake2b([
				'op' => 'update',
				'state' => cfw_blake2b_state($state),
				'b64' => base64_encode((string) $message),
			]);
			if (!$r['ok']) {
				cfw_blake2b_fail($r['error']);
			}
			return true;
		}

		/**
		 * Finishes the digest and voids the state, the way ext-sodium does.
		 *
		 * The void is not tidiness: measured on 8.5.7, native leaves $state NULL and a later
		 * update() on it answers "must be a reference to a state". Leaving the token live here
		 * would make that same call succeed against a context this side has already released.
		 *
		 * @param string|null $state
		 *   A token sodium_crypto_generichash_init() returned; set to NULL.
		 * @param-out null $state
		 * @param int $length
		 *   The digest length in bytes.
		 */
		function sodium_crypto_generichash_final(&$state, $length = 32): string
		{
			$r = cfw_blake2b([
				'op' => 'final',
				'state' => cfw_blake2b_state($state),
				'len' => (int) $length,
			]);
			$state = null;
			if (!$r['ok']) {
				cfw_blake2b_fail($r['error']);
			}
			return cfw_blake2b_bytes($r);
		}

		if (!defined('SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES')) {
			define('SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES', 32);
		}
		if (!defined('SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES')) {
			define('SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES', 24);
		}
		if (!defined('SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_ABYTES')) {
			define('SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_ABYTES', 16);
		}

		$__cfw_aead = function_exists('vrzno_env') ? vrzno_env('cfwAead') : null;
		if ($__cfw_aead !== null) {
			$GLOBALS['__cfw_aead'] = $__cfw_aead;

			/**
			 * Runs one AEAD op over its own bridge.
			 *
			 * @param array<string, mixed> $payload
			 *   The request, including its `op`.
			 *
			 * @return array<string, mixed>
			 *   ['ok' => true, 'b64' => string] or ['ok' => false, 'error' => string, 'auth' => bool].
			 */
			function cfw_aead(array $payload): array
			{
				$fn = $GLOBALS['__cfw_aead'];
				$reply = json_decode($fn(json_encode($payload)), true);
				if (!is_array($reply)) {
					return ['ok' => false, 'error' => 'unreadable reply', 'auth' => false];
				}
				return $reply;
			}

			function sodium_crypto_aead_xchacha20poly1305_ietf_keygen(): string
			{
				return random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES);
			}

			/**
			 * @param string $message
			 *   The plaintext.
			 * @param string $additional_data
			 *   Authenticated data that is not encrypted.
			 * @param string $nonce
			 *   The 24-byte nonce.
			 * @param string $key
			 *   The 32-byte key.
			 */
			function sodium_crypto_aead_xchacha20poly1305_ietf_encrypt(
				$message,
				$additional_data,
				$nonce,
				$key,
			): string {
				$r = cfw_aead([
					'op' => 'encrypt',
					'b64' => base64_encode((string) $message),
					'aad64' => base64_encode((string) $additional_data),
					'nonce64' => base64_encode((string) $nonce),
					'key64' => base64_encode((string) $key),
				]);
				// ext-sodium THROWS on a bad argument here; it has no FALSE return at all
				if (($r['ok'] ?? false) !== true) {
					throw new SodiumException((string) ($r['error'] ?? 'aead encrypt failed'));
				}
				$out = base64_decode((string) ($r['b64'] ?? ''), true);
				if ($out === false) {
					throw new SodiumException('aead reply was not base64');
				}
				return $out;
			}

			/**
			 * Answers FALSE on a failed tag and THROWS on a bad argument, which is ext-sodium's
			 * split a caller reads: a FALSE is a failed tag and the frame should be swept, a throw is
			 * frame.aead_fail, a throw is a programming error. Collapsing them would sweep a
			 * healthy store over a mis-sized key.
			 *
			 * @param string $ciphertext
			 *   The sealed frame.
			 * @param string $additional_data
			 *   Authenticated data that is not encrypted.
			 * @param string $nonce
			 *   The 24-byte nonce.
			 * @param string $key
			 *   The 32-byte key.
			 *
			 * @return string|false
			 */
			function sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
				$ciphertext,
				$additional_data,
				$nonce,
				$key,
			) {
				$r = cfw_aead([
					'op' => 'decrypt',
					'b64' => base64_encode((string) $ciphertext),
					'aad64' => base64_encode((string) $additional_data),
					'nonce64' => base64_encode((string) $nonce),
					'key64' => base64_encode((string) $key),
				]);
				if (($r['ok'] ?? false) !== true) {
					if (($r['auth'] ?? false) === true) {
						return false;
					}
					throw new SodiumException((string) ($r['error'] ?? 'aead decrypt failed'));
				}
				$out = base64_decode((string) ($r['b64'] ?? ''), true);
				if ($out === false) {
					throw new SodiumException('aead reply was not base64');
				}
				return $out;
			}
		}
	}
}
