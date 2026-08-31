import { createSign, createVerify } from 'node:crypto';
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
 * WHAT IS NOT HERE. Key GENERATION, certificate parsing, `openssl_encrypt`, and the
 * PKCS#7/CMS family. Signing and verification are what JWS and service-account JWTs need; the rest
 * is a much larger surface with no caller in this project, and shipping it unused would be the
 * [[tested-but-never-called]] failure this bridge exists to end for curl.
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
};

/** what it gets back */
export type SignReply =
	{ ok: true; sigB64: string } | { ok: true; valid: boolean } | { ok: false; error: string };

/**
 * One sign or verify, decoded.
 *
 * Exported so the gate can drive both ops without a Durable Object.
 *
 * @internal
 */
export function signHostCall(req: SignRequest): SignReply {
	try {
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
	}
}
`;
