<?php

use Drupal\drupflare\Degradation;

if (!extension_loaded('openssl') && !function_exists('cfw_openssl_installed')) {
	$__cfw_sign = function_exists('vrzno_env') ? vrzno_env('cfwSign') : null;
	if ($__cfw_sign !== null) {
		$GLOBALS['__cfw_sign'] = $__cfw_sign;
		$GLOBALS['__cfw_openssl_errors'] = [];

		// __CFW_OPENSSL_DEFINES__
		if (!defined('OPENSSL_VERSION_TEXT')) {
			define('OPENSSL_VERSION_TEXT', 'BoringSSL (node:crypto)');
		}

		if (!class_exists('OpenSSLAsymmetricKey', false)) {
			/**
			 * A key, holding PEM text rather than a native handle.
			 */
			final class OpenSSLAsymmetricKey
			{
				public function __construct(
					public readonly string $cfwPublicPem,
					public readonly string $cfwPrivatePem = '',
				) {}
			}
		}
		if (!class_exists('OpenSSLCertificate', false)) {
			/**
			 * A certificate, holding its PEM text.
			 */
			final class OpenSSLCertificate
			{
				public function __construct(public readonly string $cfwPem) {}
			}
		}

		function cfw_openssl_installed(): bool
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
		 *   The decoded reply, always with an 'ok' key.
		 */
		function cfw_sign_call($payload): array
		{
			$fn = $GLOBALS['__cfw_sign'];
			$reply = json_decode($fn(json_encode($payload)), true);
			if (!is_array($reply)) {
				$reply = ['ok' => false, 'error' => 'unreadable reply'];
			}
			if (($reply['ok'] ?? false) !== true) {
				$GLOBALS['__cfw_openssl_errors'][] = (string) ($reply['error'] ?? 'failed');
			}
			return $reply;
		}

		/**
		 * Declares a failure to the operator, the way curl-fix.ts does.
		 *
		 * A per-call trigger_error reaches the log and never the status report, and a failed verify
		 * had neither -- so a caller misreading -1 as "forged" was invisible from outside.
		 *
		 * @param string $capability
		 *   The capability that degraded.
		 * @param string $why
		 *   Why it did.
		 */
		function cfw_openssl_degraded($capability, $why): void
		{
			if (class_exists(Degradation::class)) {
				Degradation::record($capability, $why);
			}
		}

		/**
		 * The PEM text for whatever ext-openssl would accept as a key or certificate.
		 *
		 * @param OpenSSLAsymmetricKey|OpenSSLCertificate|array<int|string, string>|string $key
		 *   A key object, a certificate object, a two-key array, a PEM or a file:// path.
		 * @param string $want
		 *   'private' for the private half, 'public' for the public half or a certificate.
		 */
		function cfw_openssl_pem($key, $want): string
		{
			if ($key instanceof OpenSSLAsymmetricKey) {
				return $want === 'private' && $key->cfwPrivatePem !== ''
					? $key->cfwPrivatePem
					: $key->cfwPublicPem;
			}
			if ($key instanceof OpenSSLCertificate) {
				return $key->cfwPem;
			}
			if (is_array($key) && (isset($key['private']) || isset($key['public']))) {
				return (string) ($key[$want] ?? ($key['private'] ?? ''));
			}
			if (is_array($key)) {
				$key = $key[0] ?? '';
			}
			$key = (string) $key;
			if (str_starts_with($key, 'file://')) {
				$read = @file_get_contents(substr($key, 7));
				return $read === false ? '' : $read;
			}
			return $key;
		}

		/** @return string|false */
		function openssl_error_string()
		{
			return array_shift($GLOBALS['__cfw_openssl_errors']) ?? false;
		}

		/**
		 * @param int $length
		 *   The number of bytes.
		 * @param bool|null $strong_result
		 *   Set to TRUE, since the bytes come from random_bytes().
		 * @param-out true $strong_result
		 */
		function openssl_random_pseudo_bytes($length, &$strong_result = null): string
		{
			$strong_result = true;
			return random_bytes(max(1, (int) $length));
		}

		/**
		 * @param bool $aliases
		 *   Ignored; there are no aliases here.
		 *
		 * @return list<string>
		 */
		function openssl_get_cipher_methods($aliases = false): array
		{
			$out = [];
			foreach ([128, 192, 256] as $bits) {
				foreach (['cbc', 'ctr', 'ecb', 'gcm'] as $mode) {
					$out[] = 'aes-' . $bits . '-' . $mode;
				}
			}
			return $out;
		}

		/**
		 * Key and IV length for a supported cipher, or NULL.
		 *
		 * @param string $cipher
		 *   A cipher name.
		 *
		 * @return array{0: int, 1: int, 2: string}|null
		 *   [key bytes, iv bytes, mode].
		 */
		function cfw_openssl_cipher($cipher): ?array
		{
			if (
				!preg_match(
					'/^aes-(128|192|256)-(cbc|ctr|ecb|gcm)$/',
					strtolower((string) $cipher),
					$m,
				)
			) {
				return null;
			}
			$iv = ['cbc' => 16, 'ctr' => 16, 'ecb' => 0, 'gcm' => 12][$m[2]];
			return [intdiv((int) $m[1], 8), $iv, $m[2]];
		}

		/**
		 * @param string $cipher_algo
		 *   A cipher name.
		 *
		 * @return int|false
		 */
		function openssl_cipher_iv_length($cipher_algo)
		{
			$c = cfw_openssl_cipher($cipher_algo);
			if ($c === null) {
				trigger_error(
					'openssl_cipher_iv_length(): Unknown cipher algorithm',
					E_USER_WARNING,
				);
				return false;
			}
			return $c[1];
		}

		/**
		 * @param string $cipher_algo
		 *   A cipher name.
		 *
		 * @return int|false
		 */
		function openssl_cipher_key_length($cipher_algo)
		{
			$c = cfw_openssl_cipher($cipher_algo);
			if ($c === null) {
				trigger_error(
					'openssl_cipher_key_length(): Unknown cipher algorithm',
					E_USER_WARNING,
				);
				return false;
			}
			return $c[0];
		}

		/**
		 * The shared half of encrypt and decrypt: key and IV sized the way ext-openssl sizes them.
		 *
		 * A short key is padded with NUL and a long one truncated, silently, as ext-openssl does.
		 * A short IV is padded with a warning; a GCM IV keeps whatever length the caller gave.
		 *
		 * @param string $dir
		 *   'enc' or 'dec'.
		 * @param string $data
		 *   The plaintext, or the ciphertext.
		 * @param string $cipher_algo
		 *   A cipher name.
		 * @param string $passphrase
		 *   The key material.
		 * @param int $options
		 *   OPENSSL_RAW_DATA and OPENSSL_ZERO_PADDING flags.
		 * @param string $iv
		 *   The initialisation vector.
		 * @param string|false|null $tag
		 *   The GCM tag, on decrypt.
		 * @param string $aad
		 *   Additional authenticated data, for GCM.
		 * @param int $tag_length
		 *   The GCM tag length in bytes.
		 *
		 * @return array<string, mixed>|false
		 *   The bridge reply, or FALSE for an unknown cipher or a malformed ciphertext.
		 */
		function cfw_openssl_crypt(
			$dir,
			$data,
			$cipher_algo,
			$passphrase,
			$options,
			$iv,
			$tag,
			$aad,
			$tag_length,
		) {
			$c = cfw_openssl_cipher($cipher_algo);
			if ($c === null) {
				trigger_error(
					'openssl_' .
						($dir === 'enc' ? 'encrypt' : 'decrypt') .
						'(): Unknown cipher algorithm',
					E_USER_WARNING,
				);
				return false;
			}
			[$keyLen, $ivLen, $mode] = $c;
			$key = substr(str_pad((string) $passphrase, $keyLen, "\0"), 0, $keyLen);
			$iv = (string) $iv;
			if ($mode !== 'gcm' && strlen($iv) !== $ivLen) {
				if ($ivLen > 0 && strlen($iv) < $ivLen) {
					trigger_error(
						'openssl_' .
							($dir === 'enc' ? 'encrypt' : 'decrypt') .
							'(): IV passed is only ' .
							strlen($iv) .
							' bytes long, cipher expects an IV of precisely ' .
							$ivLen .
							' bytes, padding with \\0',
						E_USER_WARNING,
					);
				}
				$iv = substr(str_pad($iv, $ivLen, "\0"), 0, $ivLen);
			}
			$raw = (bool) ((int) $options & 1);
			$bytes = (string) $data;
			if ($dir === 'dec' && !$raw) {
				$bytes = base64_decode($bytes, true);
				if ($bytes === false) {
					return false;
				}
			}
			$payload = [
				'op' => 'cipher',
				'dir' => $dir,
				'cipher' => strtolower((string) $cipher_algo),
				'b64' => base64_encode($bytes),
				'keyB64' => base64_encode($key),
				'ivB64' => base64_encode($iv),
				'padding' => !((int) $options & 2),
				'tagLength' => (int) $tag_length,
			];
			if ($mode === 'gcm') {
				if ((string) $aad !== '') {
					$payload['aadB64'] = base64_encode((string) $aad);
				}
				if ($dir === 'dec') {
					$payload['tagB64'] = base64_encode((string) $tag);
				}
			}
			return cfw_sign_call($payload);
		}

		/**
		 * @param string $data
		 *   The plaintext.
		 * @param string $cipher_algo
		 *   A cipher name.
		 * @param string $passphrase
		 *   The key material.
		 * @param int $options
		 *   OPENSSL_RAW_DATA and OPENSSL_ZERO_PADDING flags.
		 * @param string $iv
		 *   The initialisation vector.
		 * @param string|false|null $tag
		 *   Set to the GCM tag.
		 * @param string $aad
		 *   Additional authenticated data, for GCM.
		 * @param int $tag_length
		 *   The GCM tag length in bytes.
		 *
		 * @return string|false
		 */
		function openssl_encrypt(
			$data,
			$cipher_algo,
			$passphrase,
			$options = 0,
			$iv = '',
			&$tag = null,
			$aad = '',
			$tag_length = 16,
		) {
			$r = cfw_openssl_crypt(
				'enc',
				$data,
				$cipher_algo,
				$passphrase,
				$options,
				$iv,
				null,
				$aad,
				$tag_length,
			);
			if (!is_array($r) || ($r['ok'] ?? false) !== true) {
				return false;
			}
			if (isset($r['tagB64'])) {
				$tag = base64_decode((string) $r['tagB64'], true);
			}
			$out = base64_decode((string) ($r['b64'] ?? ''), true);
			if ($out === false) {
				return false;
			}
			return (int) $options & 1 ? $out : base64_encode($out);
		}

		/**
		 * @param string $data
		 *   The ciphertext.
		 * @param string $cipher_algo
		 *   A cipher name.
		 * @param string $passphrase
		 *   The key material.
		 * @param int $options
		 *   OPENSSL_RAW_DATA and OPENSSL_ZERO_PADDING flags.
		 * @param string $iv
		 *   The initialisation vector.
		 * @param string|false|null $tag
		 *   The GCM tag.
		 * @param string $aad
		 *   Additional authenticated data, for GCM.
		 *
		 * @return string|false
		 */
		function openssl_decrypt(
			$data,
			$cipher_algo,
			$passphrase,
			$options = 0,
			$iv = '',
			$tag = null,
			$aad = '',
		) {
			$r = cfw_openssl_crypt(
				'dec',
				$data,
				$cipher_algo,
				$passphrase,
				$options,
				$iv,
				$tag,
				$aad,
				$tag === null ? 16 : strlen((string) $tag),
			);
			if (!is_array($r) || ($r['ok'] ?? false) !== true) {
				return false;
			}
			return base64_decode((string) ($r['b64'] ?? ''), true);
		}

		/**
		 * @param string $data
		 *   The bytes to sign.
		 * @param string|false|null $signature
		 *   Set to the raw signature.
		 * @param OpenSSLAsymmetricKey|array<int|string, string>|string $private_key
		 *   The signing key.
		 * @param int $algorithm
		 *   An OPENSSL_ALGO_* value.
		 */
		function openssl_sign($data, &$signature, $private_key, $algorithm = 6): bool
		{
			$r = cfw_sign_call([
				'op' => 'sign',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($private_key, 'private'),
				'algo' => (int) $algorithm,
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error(
					'openssl_sign(): ' . (string) ($r['error'] ?? 'failed'),
					E_USER_WARNING,
				);
				cfw_openssl_degraded(
					'openssl signing',
					'a signature could not be produced: ' .
						(string) ($r['error'] ?? 'no reason given'),
				);
				return false;
			}
			$signature = base64_decode((string) ($r['sigB64'] ?? ''), true);
			return $signature !== false;
		}

		/**
		 * Answers 1, 0 or -1, matching ext-openssl.
		 *
		 * -1 means the call itself failed -- an unreadable key, an unsupported digest -- and is NOT
		 * the same as 0, which means the signature was read and did not match. A caller treating
		 * -1 as "invalid" would report a broken key as a forged token.
		 *
		 * @param string $data
		 *   The signed bytes.
		 * @param string $signature
		 *   The raw signature.
		 * @param OpenSSLAsymmetricKey|OpenSSLCertificate|array<int|string, string>|string $public_key
		 *   The verification key.
		 * @param int $algorithm
		 *   An OPENSSL_ALGO_* value.
		 */
		function openssl_verify($data, $signature, $public_key, $algorithm = 6): int
		{
			$r = cfw_sign_call([
				'op' => 'verify',
				'b64' => base64_encode((string) $data),
				'sigB64' => base64_encode((string) $signature),
				'key' => cfw_openssl_pem($public_key, 'public'),
				'algo' => (int) $algorithm,
			]);
			if (($r['ok'] ?? false) !== true) {
				cfw_openssl_degraded(
					'openssl verification',
					'a signature could not be checked, so callers see -1 rather than a verdict: ' .
						(string) ($r['error'] ?? 'no reason given'),
				);
				return -1;
			}
			return ($r['valid'] ?? false) === true ? 1 : 0;
		}

		/**
		 * Turns a PEM, a certificate or a JWKS entry into a public key openssl_verify() accepts.
		 *
		 * THE MISSING STEP IN EVERY OIDC LIBRARY. A provider publishes a key SET, the library reads
		 * the entry it needs and hands it here.
		 *
		 * @param OpenSSLAsymmetricKey|OpenSSLCertificate|array<int|string, mixed>|string $public_key
		 *   A PEM, a certificate, a file:// path or a JWK array.
		 *
		 * @return OpenSSLAsymmetricKey|false
		 *   The public key, or FALSE.
		 */
		function openssl_pkey_get_public($public_key)
		{
			$payload = ['op' => 'pkeyGetPublic'];
			if (is_array($public_key) && isset($public_key['kty'])) {
				$payload['jwk'] = $public_key;
			} else {
				$payload['key'] = cfw_openssl_pem($public_key, 'public');
			}
			$r = cfw_sign_call($payload);
			if (($r['ok'] ?? false) !== true) {
				trigger_error(
					'openssl_pkey_get_public(): ' . (string) ($r['error'] ?? 'failed'),
					E_USER_WARNING,
				);
				return false;
			}
			return new OpenSSLAsymmetricKey((string) ($r['pem'] ?? ''));
		}

		/**
		 * @param OpenSSLAsymmetricKey|OpenSSLCertificate|array<int|string, mixed>|string $public_key
		 *   A PEM, a certificate, a file:// path or a JWK array.
		 *
		 * @return OpenSSLAsymmetricKey|false
		 */
		function openssl_get_publickey($public_key)
		{
			return openssl_pkey_get_public($public_key);
		}

		/**
		 * Reads a private key, decrypting it with the passphrase when one was used to write it.
		 *
		 * @param OpenSSLAsymmetricKey|array<int|string, string>|string $private_key
		 *   A PEM, a key object or a file:// path.
		 * @param string|null $passphrase
		 *   The passphrase the PEM was written with.
		 *
		 * @return OpenSSLAsymmetricKey|false
		 *   The key, or FALSE.
		 */
		function openssl_pkey_get_private($private_key, $passphrase = null)
		{
			$payload = [
				'op' => 'pkeyGetPrivate',
				'key' => cfw_openssl_pem($private_key, 'private'),
			];
			if ($passphrase !== null && $passphrase !== '') {
				$payload['passphrase'] = (string) $passphrase;
			}
			$r = cfw_sign_call($payload);
			if (($r['ok'] ?? false) !== true) {
				return false;
			}
			return new OpenSSLAsymmetricKey(
				(string) ($r['publicPem'] ?? ''),
				(string) ($r['privatePem'] ?? ''),
			);
		}

		/**
		 * @param OpenSSLAsymmetricKey|array<int|string, string>|string $private_key
		 *   A PEM, a key object or a file:// path.
		 * @param string|null $passphrase
		 *   The passphrase the PEM was written with.
		 *
		 * @return OpenSSLAsymmetricKey|false
		 */
		function openssl_get_privatekey($private_key, $passphrase = null)
		{
			return openssl_pkey_get_private($private_key, $passphrase);
		}

		/**
		 * What ext-openssl reports about a key: bits, the public PEM, the type and its parameters.
		 *
		 * @param OpenSSLAsymmetricKey|array<int|string, string>|string $key
		 *   The key to describe.
		 *
		 * @return array<string, mixed>|false
		 *   The details, or FALSE.
		 */
		function openssl_pkey_get_details($key)
		{
			$pem = cfw_openssl_pem($key, 'private');
			$r = cfw_sign_call(['op' => 'pkeyDetails', 'key' => $pem]);
			if (($r['ok'] ?? false) !== true) {
				return false;
			}
			$d = (array) ($r['details'] ?? []);
			$types = ['rsa' => 0, 'dsa' => 1, 'dh' => 2, 'ec' => 3];
			$out = [
				'bits' => (int) ($d['bits'] ?? 0),
				'key' => (string) ($d['publicPem'] ?? ''),
				'type' => $types[(string) ($d['keyType'] ?? '')] ?? -1,
			];
			foreach (['rsa', 'ec'] as $family) {
				if (isset($d[$family]) && is_array($d[$family])) {
					$params = [];
					foreach ($d[$family] as $k => $v) {
						$params[$k] = in_array($k, ['curve_name', 'curve_oid'], true)
							? (string) $v
							: base64_decode((string) $v, true);
					}
					$out[$family] = $params;
				}
			}
			return $out;
		}

		/**
		 * A new RSA or EC key pair.
		 *
		 * @param array<string, mixed>|null $options
		 *   private_key_bits, private_key_type or curve_name.
		 *
		 * @return OpenSSLAsymmetricKey|false
		 *   The key, or FALSE.
		 */
		function openssl_pkey_new($options = null)
		{
			$options = is_array($options) ? $options : [];
			$payload = ['op' => 'pkeyNew', 'bits' => (int) ($options['private_key_bits'] ?? 2048)];
			if (($options['private_key_type'] ?? 0) === 3 || isset($options['curve_name'])) {
				$payload['type'] = 'ec';
				$payload['curve'] = (string) ($options['curve_name'] ?? 'prime256v1');
			}
			$r = cfw_sign_call($payload);
			if (($r['ok'] ?? false) !== true) {
				trigger_error(
					'openssl_pkey_new(): ' . (string) ($r['error'] ?? 'failed'),
					E_USER_WARNING,
				);
				return false;
			}
			return new OpenSSLAsymmetricKey(
				(string) ($r['publicPem'] ?? ''),
				(string) ($r['privatePem'] ?? ''),
			);
		}

		/**
		 * Writes a private key out as PEM.
		 *
		 * PASSPHRASES ARE REFUSED rather than ignored. ext-openssl encrypts the output when one is
		 * given, and answering with an UNENCRYPTED key to a caller who asked for an encrypted one
		 * would hand them a secret they believe is protected.
		 *
		 * @param OpenSSLAsymmetricKey|array<int|string, string>|string $key
		 *   The key to export.
		 * @param string|null $out
		 *   Set to the PEM.
		 * @param string|null $passphrase
		 *   Refused when not empty.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_pkey_export($key, &$out, $passphrase = null): bool
		{
			if ($passphrase !== null && $passphrase !== '') {
				trigger_error(
					'openssl_pkey_export(): a passphrase is not supported here',
					E_USER_WARNING,
				);
				return false;
			}
			$r = cfw_sign_call(['op' => 'pkeyExport', 'key' => cfw_openssl_pem($key, 'private')]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error(
					'openssl_pkey_export(): ' . (string) ($r['error'] ?? 'failed'),
					E_USER_WARNING,
				);
				return false;
			}
			$out = (string) ($r['pem'] ?? '');
			return $out !== '';
		}

		/**
		 * ECDH: the shared secret between a private key and a peer public key.
		 *
		 * @param OpenSSLAsymmetricKey|OpenSSLCertificate|array<int|string, string>|string $public_key
		 *   The peer's public key.
		 * @param OpenSSLAsymmetricKey|array<int|string, string>|string $private_key
		 *   This side's private key.
		 * @param int $key_length
		 *   Truncate the secret to this many bytes, or 0 for all of it.
		 *
		 * @return string|false
		 *   The secret, or FALSE.
		 */
		function openssl_pkey_derive($public_key, $private_key, $key_length = 0)
		{
			$r = cfw_sign_call([
				'op' => 'derive',
				'peer' => cfw_openssl_pem($public_key, 'public'),
				'key' => cfw_openssl_pem($private_key, 'private'),
			]);
			if (($r['ok'] ?? false) !== true) {
				return false;
			}
			$out = base64_decode((string) ($r['b64'] ?? ''), true);
			return $out !== false && $key_length > 0 ? substr($out, 0, (int) $key_length) : $out;
		}

		/** @param OpenSSLAsymmetricKey $key */
		function openssl_pkey_free($key): void {}
		/** @param OpenSSLAsymmetricKey $key */
		function openssl_free_key($key): void {}
		/** @param OpenSSLCertificate $certificate */
		function openssl_x509_free($certificate): void {}

		/**
		 * RSA sign-with-private, which is what a legacy licence check or an older SSO handshake uses.
		 *
		 * @param string $data
		 *   The bytes to encrypt.
		 * @param string|false|null $encrypted_data
		 *   Set to the result.
		 * @param OpenSSLAsymmetricKey|array<int|string, string>|string $private_key
		 *   The key.
		 * @param int $padding
		 *   An OPENSSL_*_PADDING value; ignored here.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_private_encrypt($data, &$encrypted_data, $private_key, $padding = 1): bool
		{
			$r = cfw_sign_call([
				'op' => 'privateEncrypt',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($private_key, 'private'),
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error(
					'openssl_private_encrypt(): ' . (string) ($r['error'] ?? 'failed'),
					E_USER_WARNING,
				);
				return false;
			}
			$encrypted_data = base64_decode((string) ($r['b64'] ?? ''), true);
			return $encrypted_data !== false;
		}

		/**
		 * The other half of the pair above.
		 *
		 * @param string $data
		 *   The bytes to decrypt.
		 * @param string|false|null $decrypted_data
		 *   Set to the result.
		 * @param OpenSSLAsymmetricKey|OpenSSLCertificate|array<int|string, string>|string $public_key
		 *   The key.
		 * @param int $padding
		 *   An OPENSSL_*_PADDING value; ignored here.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_public_decrypt($data, &$decrypted_data, $public_key, $padding = 1): bool
		{
			$r = cfw_sign_call([
				'op' => 'publicDecrypt',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($public_key, 'public'),
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error(
					'openssl_public_decrypt(): ' . (string) ($r['error'] ?? 'failed'),
					E_USER_WARNING,
				);
				return false;
			}
			$decrypted_data = base64_decode((string) ($r['b64'] ?? ''), true);
			return $decrypted_data !== false;
		}

		/**
		 * Encrypt to a public key, PKCS#1 v1.5 or OAEP, which is how XML encryption wraps its key.
		 *
		 * @param string $data
		 *   The bytes to encrypt.
		 * @param string|false|null $encrypted_data
		 *   Set to the result.
		 * @param OpenSSLAsymmetricKey|OpenSSLCertificate|array<int|string, string>|string $public_key
		 *   The key.
		 * @param int $padding
		 *   OPENSSL_PKCS1_PADDING or OPENSSL_PKCS1_OAEP_PADDING.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_public_encrypt($data, &$encrypted_data, $public_key, $padding = 1): bool
		{
			$r = cfw_sign_call([
				'op' => 'publicEncrypt',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($public_key, 'public'),
				'pad' => (int) $padding,
			]);
			if (($r['ok'] ?? false) !== true) {
				return false;
			}
			$encrypted_data = base64_decode((string) ($r['b64'] ?? ''), true);
			return $encrypted_data !== false;
		}

		/**
		 * @param string $data
		 *   The bytes to decrypt.
		 * @param string|false|null $decrypted_data
		 *   Set to the result.
		 * @param OpenSSLAsymmetricKey|array<int|string, string>|string $private_key
		 *   The key.
		 * @param int $padding
		 *   OPENSSL_PKCS1_PADDING or OPENSSL_PKCS1_OAEP_PADDING.
		 *
		 * @return bool
		 */
		function openssl_private_decrypt($data, &$decrypted_data, $private_key, $padding = 1): bool
		{
			$r = cfw_sign_call([
				'op' => 'privateDecrypt',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($private_key, 'private'),
				'pad' => (int) $padding,
			]);
			if (($r['ok'] ?? false) !== true) {
				return false;
			}
			$decrypted_data = base64_decode((string) ($r['b64'] ?? ''), true);
			return $decrypted_data !== false;
		}

		/**
		 * Reads a certificate from PEM, a file:// path or another certificate.
		 *
		 * @param OpenSSLCertificate|string $certificate
		 *   A PEM, a file:// path or a certificate object.
		 *
		 * @return OpenSSLCertificate|false
		 *   The certificate, or FALSE.
		 */
		function openssl_x509_read($certificate)
		{
			$r = cfw_sign_call([
				'op' => 'x509Export',
				'key' => cfw_openssl_pem($certificate, 'public'),
			]);
			if (($r['ok'] ?? false) !== true) {
				return false;
			}
			return new OpenSSLCertificate((string) ($r['pem'] ?? ''));
		}

		/**
		 * @param OpenSSLCertificate|string $certificate
		 *   A PEM, a file:// path or a certificate object.
		 * @param string|null $output
		 *   Set to the PEM.
		 * @param bool $no_text
		 *   Ignored.
		 */
		function openssl_x509_export($certificate, &$output, $no_text = true): bool
		{
			$cert = openssl_x509_read($certificate);
			if ($cert === false) {
				return false;
			}
			$output = $cert->cfwPem;
			return true;
		}

		/**
		 * @param OpenSSLCertificate|string $certificate
		 *   A PEM, a file:// path or a certificate object.
		 * @param string $digest_algo
		 *   A digest name.
		 * @param bool $binary
		 *   Return raw bytes instead of hex.
		 *
		 * @return string|false
		 */
		function openssl_x509_fingerprint($certificate, $digest_algo = 'sha1', $binary = false)
		{
			$r = cfw_sign_call([
				'op' => 'x509Fingerprint',
				'key' => cfw_openssl_pem($certificate, 'public'),
				'digest' => strtolower((string) $digest_algo),
			]);
			if (($r['ok'] ?? false) !== true) {
				return false;
			}
			$hex = (string) ($r['hex'] ?? '');
			return $binary ? hex2bin($hex) : $hex;
		}

		/**
		 * The fields of a certificate that node:crypto exposes, under ext-openssl's key names.
		 *
		 * @param OpenSSLCertificate|string $certificate
		 *   A PEM, a file:// path or a certificate object.
		 * @param bool $short_names
		 *   Ignored.
		 *
		 * @return array<string, mixed>|false
		 *   The parsed certificate, or FALSE.
		 */
		function openssl_x509_parse($certificate, $short_names = true)
		{
			$r = cfw_sign_call([
				'op' => 'x509Parse',
				'key' => cfw_openssl_pem($certificate, 'public'),
			]);
			if (($r['ok'] ?? false) !== true) {
				return false;
			}
			return (array) ($r['parsed'] ?? []);
		}

		/**
		 * Purpose checking needs a trust store and purpose table this runtime does not carry.
		 *
		 * @param OpenSSLCertificate|string $certificate
		 *   The certificate to check.
		 * @param int $purpose
		 *   An X509_PURPOSE_* value.
		 * @param array<int, string> $ca_info
		 *   Trusted CA locations.
		 * @param string|null $untrusted_certificates_file
		 *   Intermediate certificates.
		 *
		 * @return int
		 *   -1, which ext-openssl uses for "could not be determined".
		 */
		function openssl_x509_checkpurpose(
			$certificate,
			$purpose,
			$ca_info = [],
			$untrusted_certificates_file = null,
		): int {
			cfw_openssl_degraded(
				'openssl_x509_checkpurpose',
				'there is no trust store or purpose table here, so the answer is -1 (undetermined)',
			);
			return -1;
		}
	}
}
