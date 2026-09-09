import {
	createPrivateKey,
	createPublicKey,
	createSign,
	createVerify,
	generateKeyPairSync,
	privateEncrypt,
	publicDecrypt
} from 'node:crypto';
import { base64ToBytes, bytesToBase64 } from '../db/file-store.js';

/**
 * `openssl_sign()` and `openssl_verify()` over `node:crypto`, synchronously.
 *
 * The premise this was scoped under was wrong. It read "crypto.subtle covers RS256/ES256 but is
 * **async**, so it takes the queue/read-later pair", which would have made every signature a
 * two-invocation round trip through a deferred queue. Measured 2026-08-23 in workerd: `node:crypto`
 * exposes `createSign`/`createVerify` and they are SYNCHRONOUS -- a 2048-bit RS256 signature comes
 * back in-line, 256 bytes. So this is an ordinary bridge like `cfwZlib`, not a deferred one.
 *
 * WHY `openssl_*` RATHER THAN A NEW `cfwSign()` FUNCTION. An unmodified module is the whole
 * claim. `firebase/php-jwt`, Google's auth client and Stripe's webhook verifier all call
 * `openssl_sign()`/`openssl_verify()` directly, so shimming the names PHP already uses makes them
 * work untouched. A new function would have required every one of them to be patched.
 *
 * WHAT IS HERE NOW, AND WHY IT GREW. The scope above was two functions and a note that the rest had
 * "no caller in this project". Three of the four names `ShimRegistry` refused turned out to have a
 * measured synchronous primitive behind them AND a named caller -- `openssl_pkey_get_public()` is
 * what turns a JWKS entry into something `openssl_verify()` accepts, which is the missing step in
 * every OIDC library. Measured in workerd, every call synchronous: `generateKeyPairSync` produced an
 * RSA-2048 SPKI PEM of 451 bytes, `createPublicKey({key: jwk, format: 'jwk'}).export()` returned
 * bytes IDENTICAL to that PEM, and `privateEncrypt` returned 256.
 *
 * WHAT IS STILL NOT HERE. `openssl_csr_new` and the PKCS#7/CMS family. `node:crypto` has no
 * certificate-request primitive at all, so that one is absent rather than unimplemented, and it
 * stays refused with the reason named.
 */

/** the Module key the PHP half resolves through `vrzno_env()` */
export const SIGN_BRIDGE = 'cfwSign';

/**
 * PHP's `OPENSSL_ALGO_*` values mapped to the digest names `node:crypto` takes.
 *
 * The numbers are ext-openssl's own and are stable; they are spelled as literals because the
 * extension is absent, so the constants do not exist to read. `getHashes()` in workerd reports
 * sha1/sha224/sha256/sha384/sha512 among others, so every entry here is backed.
 */
export const OPENSSL_ALGOS: Record<number, string> = {
	1: 'sha1',
	2: 'md5',
	3: 'md4',
	6: 'sha256',
	7: 'sha384',
	8: 'sha512',
	9: 'sha224'
};

/** what the PHP half sends */
export type SignRequest = {
	op?: string;
	/** base64 of the bytes to sign or verify */
	b64?: string;
	/** the PEM key; private to sign, public or a certificate to verify */
	key?: string;
	/** an `OPENSSL_ALGO_*` value */
	algo?: number;
	/** base64 of the signature, for verify */
	sigB64?: string;
	/** RSA modulus size for `pkeyNew`, in bits */
	bits?: number;
	/** a JWK, for `pkeyGetPublic` when the caller has a key set rather than a PEM */
	jwk?: Record<string, unknown>;
};

/** what it gets back */
export type SignReply =
	| { ok: true; sigB64: string }
	| { ok: true; valid: boolean }
	| { ok: true; pem: string }
	| { ok: true; privatePem: string; publicPem: string }
	| { ok: true; b64: string }
	| { ok: false; error: string };

/**
 * One sign or verify, decoded.
 *
 * Exported so the gate can drive both ops without a Durable Object.
 *
 * @internal
 */
export function signHostCall(req: SignRequest): SignReply {
	try {
		// the ops that take no digest, answered before the algorithm lookup: a key operation has no
		// algorithm and rejecting one for an absent digest would be a confusing lie
		if (req.op === 'pkeyNew') {
			const bits = Number(req.bits ?? 2048);
			if (!Number.isInteger(bits) || bits < 512 || bits > 8192) {
				return { ok: false, error: `unsupported key size ${String(req.bits)}` };
			}
			const pair = generateKeyPairSync('rsa', {
				modulusLength: bits,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
			});
			return { ok: true, privatePem: pair.privateKey, publicPem: pair.publicKey };
		}
		if (req.op === 'pkeyGetPublic') {
			// A JWKS ENTRY OR A PEM, and the first is the reason this exists: every OIDC library
			// fetches a key SET and hands the entry to `openssl_verify()`, which takes a PEM
			const source =
				req.jwk !== undefined
					? createPublicKey({ key: req.jwk as never, format: 'jwk' })
					: createPublicKey(String(req.key ?? ''));
			return { ok: true, pem: source.export({ type: 'spki', format: 'pem' }) as string };
		}
		if (req.op === 'pkeyExport') {
			const key = createPrivateKey(String(req.key ?? ''));
			return { ok: true, pem: key.export({ type: 'pkcs8', format: 'pem' }) as string };
		}
		if (req.op === 'privateEncrypt') {
			const out = privateEncrypt(String(req.key ?? ''), base64ToBytes(String(req.b64 ?? '')));
			return { ok: true, b64: bytesToBase64(new Uint8Array(out)) };
		}
		if (req.op === 'publicDecrypt') {
			const out = publicDecrypt(String(req.key ?? ''), base64ToBytes(String(req.b64 ?? '')));
			return { ok: true, b64: bytesToBase64(new Uint8Array(out)) };
		}

		const digest = OPENSSL_ALGOS[Number(req.algo ?? 6)];
		if (!digest) return { ok: false, error: `unsupported algorithm ${String(req.algo)}` };

		const key = String(req.key ?? '');
		if (key === '') return { ok: false, error: 'no key supplied' };
		const data = base64ToBytes(String(req.b64 ?? ''));

		if (req.op === 'verify') {
			const v = createVerify(digest);
			v.update(data);
			// `end()` before `verify()`; node throws "Digest already called" otherwise, which
			// would read as a bad key rather than as a misuse of the stream
			v.end();
			return { ok: true, valid: v.verify(key, base64ToBytes(String(req.sigB64 ?? ''))) };
		}

		const s = createSign(digest);
		s.update(data);
		s.end();
		return { ok: true, sigB64: bytesToBase64(new Uint8Array(s.sign(key))) };
	} catch (e: any) {
		// a bad key or a bad signature is a normal outcome for these functions, not a fault:
		// `openssl_verify()` answers -1 on error and FALSE is what `openssl_sign()` returns
		return { ok: false, error: String(e?.message ?? e) };
	}
}

/** the shape `installSign` needs of a PHP binary, so it can be driven from a test */
export type SignBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module.
 *
 * Masked for the same reason the zlib bridge is: an RSA signature is a long synchronous JavaScript
 * frame under the PHP stack, and that is exactly the window a slice interrupt must not suspend
 * across.
 */
export function installSign(binary: SignBinary, withMask: <R>(fn: () => R) => R): SignBinary {
	binary[SIGN_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: SignRequest;
			try {
				req = JSON.parse(json) as SignRequest;
			} catch (e: any) {
				return JSON.stringify({ ok: false, error: `unparseable request: ${e?.message}` });
			}
			return JSON.stringify(signHostCall(req));
		});
	return binary;
}

const algoDefines = Object.entries({
	OPENSSL_ALGO_SHA1: 1,
	OPENSSL_ALGO_MD5: 2,
	OPENSSL_ALGO_MD4: 3,
	OPENSSL_ALGO_SHA256: 6,
	OPENSSL_ALGO_SHA384: 7,
	OPENSSL_ALGO_SHA512: 8,
	OPENSSL_ALGO_SHA224: 9
})
	.map(([name, value]) => `\t\tif (!defined('${name}')) { define('${name}', ${value}); }`)
	.join('\n');

/**
 * The PHP half: the two functions and the seven algorithm constants.
 *
 * No `eval()`, like `zlib-fix`: a conditional declaration binds at runtime, so this compiles clean
 * on a build that HAS ext-openssl and the branch never runs. That is what lets
 * `tests/node/php-fragments.spec.ts` lint the body.
 *
 * `openssl_sign()` takes its signature by REFERENCE and returns a bool, which is the shape callers
 * check; `openssl_verify()` returns 1, 0 or -1, where -1 is "an error occurred" rather than
 * "invalid". Getting that tri-state wrong would make a failed verification look like a successful
 * rejection, so the three are kept distinct.
 */
export const OPENSSL_FIX = String.raw`
if (!extension_loaded('openssl') && !function_exists('cfw_openssl_installed')) {
	$__cfw_sign = function_exists('vrzno_env') ? vrzno_env('${SIGN_BRIDGE}') : null;
	if ($__cfw_sign !== null) {
		$GLOBALS['__cfw_sign'] = $__cfw_sign;

${algoDefines}

		function cfw_openssl_installed() { return true; }

		/**
		 * Runs one op over the bridge.
		 *
		 * @return array
		 *   The decoded reply, always with an 'ok' key.
		 */
		function cfw_sign_call($payload) {
			$fn = $GLOBALS['__cfw_sign'];
			$reply = json_decode($fn(json_encode($payload)), true);
			if (!is_array($reply)) { return ['ok' => false, 'error' => 'unreadable reply']; }
			return $reply;
		}

		/**
		 * Declares a failure to the operator, the way curl-fix.ts does.
		 *
		 * A per-call trigger_error reaches the log and never the status report, and a failed verify
		 * had neither -- so a caller misreading -1 as "forged" was invisible from outside.
		 */
		function cfw_openssl_degraded($capability, $why) {
			if (class_exists('Drupal\drupflare\Degradation')) {
				Drupal\drupflare\Degradation::record($capability, $why);
			}
		}

		function openssl_sign($data, &$signature, $private_key, $algorithm = 6) {
			$r = cfw_sign_call([
				'op' => 'sign',
				'b64' => base64_encode((string) $data),
				'key' => is_string($private_key) ? $private_key : (string) $private_key,
				'algo' => (int) $algorithm,
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_sign(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				cfw_openssl_degraded('openssl signing', 'a signature could not be produced: ' . (string) ($r['error'] ?? 'no reason given'));
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
		 */
		function openssl_verify($data, $signature, $public_key, $algorithm = 6) {
			$r = cfw_sign_call([
				'op' => 'verify',
				'b64' => base64_encode((string) $data),
				'sigB64' => base64_encode((string) $signature),
				'key' => is_string($public_key) ? $public_key : (string) $public_key,
				'algo' => (int) $algorithm,
			]);
			if (($r['ok'] ?? false) !== true) {
				cfw_openssl_degraded('openssl verification', 'a signature could not be checked, so callers see -1 rather than a verdict: ' . (string) ($r['error'] ?? 'no reason given'));
				return -1;
			}
			return ($r['valid'] ?? false) === true ? 1 : 0;
		}

		/**
		 * Turns a PEM, a certificate or a JWKS entry into something openssl_verify() accepts.
		 *
		 * THE MISSING STEP IN EVERY OIDC LIBRARY. A provider publishes a key SET, the library reads
		 * the entry it needs and hands it here, and what comes back is what the verify shim takes.
		 * ext-openssl returns a resource; this returns the PEM, which every caller in this project
		 * passes straight back into openssl_verify() and which is a string there too.
		 *
		 * @return string|false
		 *   The public key as PEM, or FALSE.
		 */
		function openssl_pkey_get_public($key) {
			$payload = ['op' => 'pkeyGetPublic'];
			if (is_array($key)) {
				$payload['jwk'] = $key;
			} else {
				$payload['key'] = (string) $key;
			}
			$r = cfw_sign_call($payload);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_pkey_get_public(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			return (string) ($r['pem'] ?? '');
		}

		/**
		 * The private half is what a caller keeps; the public half rides along.
		 *
		 * ext-openssl hands back a resource and makes the caller run openssl_pkey_export() to see
		 * the private key. Here both halves are already strings, so the array carries them and
		 * openssl_pkey_export() below simply reads one out.
		 *
		 * @return array|false
		 *   Keys 'private' and 'public' as PEM, or FALSE.
		 */
		function openssl_pkey_new($options = []) {
			$bits = 2048;
			if (is_array($options) && isset($options['private_key_bits'])) {
				$bits = (int) $options['private_key_bits'];
			}
			$r = cfw_sign_call(['op' => 'pkeyNew', 'bits' => $bits]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_pkey_new(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			return ['private' => (string) ($r['privatePem'] ?? ''), 'public' => (string) ($r['publicPem'] ?? '')];
		}

		/**
		 * Writes a private key out as PEM.
		 *
		 * PASSPHRASES ARE REFUSED rather than ignored. ext-openssl encrypts the output when one is
		 * given, and answering with an UNENCRYPTED key to a caller who asked for an encrypted one
		 * would hand them a secret they believe is protected.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_pkey_export($key, &$out, $passphrase = null) {
			if ($passphrase !== null && $passphrase !== '') {
				trigger_error('openssl_pkey_export(): a passphrase is not supported here', E_USER_WARNING);
				return false;
			}
			$source = is_array($key) ? (string) ($key['private'] ?? '') : (string) $key;
			$r = cfw_sign_call(['op' => 'pkeyExport', 'key' => $source]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_pkey_export(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			$out = (string) ($r['pem'] ?? '');
			return $out !== '';
		}

		/**
		 * RSA sign-with-private, which is what a legacy licence check or an older SSO handshake uses.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_private_encrypt($data, &$out, $private_key, $padding = 1) {
			$r = cfw_sign_call([
				'op' => 'privateEncrypt',
				'b64' => base64_encode((string) $data),
				'key' => is_array($private_key) ? (string) ($private_key['private'] ?? '') : (string) $private_key,
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_private_encrypt(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			$out = base64_decode((string) ($r['b64'] ?? ''), true);
			return $out !== false;
		}

		/**
		 * The other half of the pair above.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_public_decrypt($data, &$out, $public_key, $padding = 1) {
			$r = cfw_sign_call([
				'op' => 'publicDecrypt',
				'b64' => base64_encode((string) $data),
				'key' => is_array($public_key) ? (string) ($public_key['public'] ?? '') : (string) $public_key,
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_public_decrypt(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			$out = base64_decode((string) ($r['b64'] ?? ''), true);
			return $out !== false;
		}
	}
}
`;
