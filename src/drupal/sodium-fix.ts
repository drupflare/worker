import { blake2bFinal, blake2bInit, blake2bUpdate, type Blake2bCTX } from 'blakejs';
import { base64ToBytes, bytesToBase64 } from '../db/file-store';

/**
 * Replaces the `sodium_crypto_generichash*` family, which no build here can provide.
 *
 * P42.1. BLAKE2b IS ABSENT FROM EVERY LAYER, MEASURED RATHER THAN ASSUMED. The shipping binary
 * loads 25 extensions and `sodium` is not one of them, so `sodium_crypto_generichash()` is an
 * undefined function. `ext-hash` IS loaded and offers 62 algorithms with no `blake*` among them --
 * and that is a property of PHP rather than of this build, since native 8.5.7 with the full
 * extension reports the same 0. workerd has none either: `node:crypto` answers "Digest method not
 * supported" for `blake2b512` and `crypto.subtle` answers "Unrecognized or unimplemented digest
 * algorithm". So there is nothing to fall back to and the digest has to be computed in JavaScript.
 *
 * WHY IT BLOCKS AN INSTALL RATHER THAN A FEATURE. `Drupal\strata\Cas\Hash::ALGORITHM` is
 * `blake2b-256` and it is written into every frame header, so the digest is strata's CONTENT
 * ADDRESS. A different algorithm is not a downgrade, it is a different store, so substituting
 * sha256 would be a silent format change rather than a workaround.
 *
 * `blakejs` is 12 KB of pure JavaScript with no dependencies, and synchronous -- the constraint
 * `zlib-fix` names applies unchanged: the shipping build sets `ASYNCIFY=0`, so a host function
 * that returned a Promise would hand PHP an object it can only stringify.
 *
 * WHAT THIS DOES NOT CLOSE. strata also calls
 * `sodium_crypto_aead_xchacha20poly1305_ietf_encrypt()`/`_decrypt()`, which is a cipher rather than
 * a digest and shares no mechanism with this. Shimming the hash does not make ext-sodium present;
 * `extension_loaded('sodium')` stays FALSE and must, because the rest of the extension is not here.
 */

/** the Module key the PHP half resolves through `vrzno_env()` */
export const BLAKE2B_BRIDGE = 'cfwBlake2b';

/** what the PHP half sends */
export type Blake2bRequest = {
	op?: string;
	/** the message, base64 */
	b64?: string;
	/** the key, base64; an empty string means unkeyed */
	key64?: string;
	/** digest length in bytes */
	len?: number;
	/** an incremental state minted by `init` */
	state?: number;
};

/** what it gets back */
export type Blake2bReply =
	{ ok: true; b64?: string; state?: number } | { ok: false; error: string };

/** libsodium's own bounds, and the shim refuses outside them the way ext-sodium does */
export const GENERICHASH_BYTES_MIN = 16;
export const GENERICHASH_BYTES_MAX = 64;
export const GENERICHASH_KEYBYTES_MIN = 16;
export const GENERICHASH_KEYBYTES_MAX = 64;

/**
 * How many incremental digests may be open at once.
 *
 * A state that is never finalised leaks its context for the life of the object, and a Durable
 * Object outlives many requests. Refusing past the cap rather than evicting the oldest is the
 * deliberate half: an evicted context would make a later `final()` answer a digest computed over
 * part of the message, and a wrong content address is worse than a failed one.
 */
export const MAX_OPEN_STATES = 64;

/** an open incremental digest, held here rather than in PHP because the context is 64-bit */
type OpenState = { ctx: Blake2bCTX; len: number };

/**
 * The store an `installBlake2b` bridge keeps its incremental contexts in.
 *
 * Exported so the gate can drive `blake2bHostCall()` across several calls without a Durable
 * Object, which is the only way to test that `init`/`update`/`final` share one context.
 *
 * @internal
 */
export type Blake2bStates = { next: number; open: Map<number, OpenState> };

/** a fresh, empty state table */
export function emptyStates(): Blake2bStates {
	return { next: 1, open: new Map() };
}

/**
 * Checks a digest length against libsodium's range.
 *
 * @internal
 */
export function validLength(len: unknown): boolean {
	const n = Number(len);
	return Number.isInteger(n) && n >= GENERICHASH_BYTES_MIN && n <= GENERICHASH_BYTES_MAX;
}

/**
 * The key bytes, or an error string.
 *
 * An empty key is unkeyed and is NOT the same as a 16-byte key of zeros. Anything between 1 and 15
 * bytes is refused, matching ext-sodium, which answers "unsupported key length" rather than padding.
 *
 * @internal
 */
export function readKey(key64: unknown): Uint8Array | undefined | string {
	const raw = String(key64 ?? '');
	if (raw === '') return undefined;
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(raw);
	} catch (e: any) {
		return `key was not base64: ${String(e?.message ?? e)}`;
	}
	if (bytes.length === 0) return undefined;
	if (bytes.length < GENERICHASH_KEYBYTES_MIN || bytes.length > GENERICHASH_KEYBYTES_MAX) {
		return 'unsupported key length';
	}
	return bytes;
}

/**
 * One BLAKE2b operation, decoded.
 *
 * Four ops rather than one, because `Hash::ofStream()` digests a 256 MiB object a megabyte at a
 * time and must never hold the whole thing: `hash` is the one-shot, and `init`/`update`/`final`
 * are the streaming form. The context stays here behind an integer handle for the reason
 * `CurlShim` keeps a handle at all -- there is nothing for PHP to hold. Unlike CurlShim's array,
 * this one cannot be a PHP value: a BLAKE2b context is eight 64-bit words plus a 128-byte buffer,
 * and `PHP_INT_SIZE` is 4 here, so a context that crossed the bridge would have to be re-encoded
 * on every 1 MiB chunk.
 *
 * A failure is a reply rather than a throw; the PHP half turns it into the `SodiumException`
 * ext-sodium raises.
 *
 * @internal
 */
export function blake2bHostCall(req: Blake2bRequest, states: Blake2bStates): Blake2bReply {
	try {
		const op = String(req.op ?? '');
		const len = Number(req.len ?? 32);

		if (op === 'hash' || op === 'init') {
			if (!validLength(len)) return { ok: false, error: 'unsupported output length' };
			const key = readKey(req.key64);
			if (typeof key === 'string') return { ok: false, error: key };
			if (op === 'init') {
				if (states.open.size >= MAX_OPEN_STATES) {
					return {
						ok: false,
						error: `more than ${MAX_OPEN_STATES} incremental digests open`
					};
				}
				const id = states.next++;
				states.open.set(id, { ctx: blake2bInit(len, key), len });
				return { ok: true, state: id };
			}
			const ctx = blake2bInit(len, key);
			blake2bUpdate(ctx, base64ToBytes(String(req.b64 ?? '')));
			return { ok: true, b64: bytesToBase64(blake2bFinal(ctx)) };
		}

		if (op === 'update' || op === 'final') {
			const id = Number(req.state ?? 0);
			const entry = states.open.get(id);
			if (entry === undefined) return { ok: false, error: 'incorrect state length' };
			if (op === 'update') {
				blake2bUpdate(entry.ctx, base64ToBytes(String(req.b64 ?? '')));
				return { ok: true };
			}
			// libsodium fixes the digest length in the parameter block at init, so a different
			// length here cannot produce that digest. ext-sodium answers 64 bytes anyway -- measured
			// on 8.5.7, final($state, 64) on a state inited at 32 returns the 32-byte digest
			// followed by 32 bytes of adjacent memory -- so this REFUSES where native leaks
			if (len !== entry.len) {
				states.open.delete(id);
				return { ok: false, error: 'unsupported output length' };
			}
			states.open.delete(id);
			return { ok: true, b64: bytesToBase64(blake2bFinal(entry.ctx)) };
		}

		return { ok: false, error: `unknown blake2b op '${op}'` };
	} catch (e: any) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

/** the shape `installBlake2b` needs of a PHP binary, so it can be driven from a test */
export type Blake2bBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module.
 *
 * Masked for the same reason `installZlib` is: a BLAKE2b pass over a megabyte is a long JavaScript
 * frame under the PHP stack, which is the window a slice interrupt must not try to suspend across.
 *
 * @param binary
 *   The instantiated PHP module.
 * @param withMask
 *   The mask wrapper; injected rather than imported so the gate can assert that the call really
 *   happens inside it.
 */
export function installBlake2b(
	binary: Blake2bBinary,
	withMask: <R>(fn: () => R) => R
): Blake2bBinary {
	const states = emptyStates();
	binary[BLAKE2B_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: Blake2bRequest;
			try {
				req = JSON.parse(json) as Blake2bRequest;
			} catch (e: any) {
				const why = String(e?.message ?? e);
				return JSON.stringify({ ok: false, error: `unparseable request: ${why}` });
			}
			return JSON.stringify(blake2bHostCall(req, states));
		});
	return binary;
}

/**
 * The PHP half: the four functions, the six constants and `SodiumException`.
 *
 * Which functions: every `sodium_*` call site in strata, found by grep over the module. Six calls
 * to `sodium_crypto_generichash()` and one each to `_init`, `_update` and `_final` -- so the
 * one-shot and the streaming form are both reached, and `Hash::ofFile()` reaches the streaming one
 * on every captured file.
 *
 * `extension_loaded('sodium')` STAYS FALSE, deliberately. It is the guard this fragment is itself
 * written under, and a stub extension entry is the exact shape that took the isolate down at exit
 * 139 when it was tried for mbstring. A caller testing for the extension gets an honest no; a
 * caller calling the function gets a digest.
 *
 * NO `eval()`, following `zlib-fix` and `curl-fix`: a conditional declaration colliding with an
 * internal function is deferred to runtime, so this compiles clean on a build that HAS ext-sodium
 * and the branch never runs. That is what lets `tests/node/php-fragments.spec.ts` run `php -l` over
 * the body rather than over a string literal.
 */
export const SODIUM_FIX = String.raw`
if (!extension_loaded('sodium') && !function_exists('cfw_sodium_installed')) {
	$__cfw_blake2b = function_exists('vrzno_env') ? vrzno_env('${BLAKE2B_BRIDGE}') : null;
	if ($__cfw_blake2b !== null) {
		$GLOBALS['__cfw_blake2b'] = $__cfw_blake2b;

		// ext-sodium declares these; strata reads KEYBYTES_MAX, KEYBYTES and BYTES_MIN by name, and
		// an undefined constant is a fatal Error in PHP 8 rather than a warning
		if (!defined('SODIUM_CRYPTO_GENERICHASH_BYTES')) { define('SODIUM_CRYPTO_GENERICHASH_BYTES', 32); }
		if (!defined('SODIUM_CRYPTO_GENERICHASH_BYTES_MIN')) { define('SODIUM_CRYPTO_GENERICHASH_BYTES_MIN', ${GENERICHASH_BYTES_MIN}); }
		if (!defined('SODIUM_CRYPTO_GENERICHASH_BYTES_MAX')) { define('SODIUM_CRYPTO_GENERICHASH_BYTES_MAX', ${GENERICHASH_BYTES_MAX}); }
		if (!defined('SODIUM_CRYPTO_GENERICHASH_KEYBYTES')) { define('SODIUM_CRYPTO_GENERICHASH_KEYBYTES', 32); }
		if (!defined('SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MIN')) { define('SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MIN', ${GENERICHASH_KEYBYTES_MIN}); }
		if (!defined('SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MAX')) { define('SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MAX', ${GENERICHASH_KEYBYTES_MAX}); }

		// ext-sodium ships this class, so callers catch it by name; sodium_compat declares the same
		if (!class_exists('SodiumException')) { class SodiumException extends Exception {} }

		function cfw_sodium_installed() { return true; }

		/**
		 * Runs one op over the bridge.
		 *
		 * @return array
		 *   ['ok' => true, ...] or ['ok' => false, 'error' => string].
		 */
		function cfw_blake2b(array $payload) {
			$fn = $GLOBALS['__cfw_blake2b'];
			$reply = json_decode($fn(json_encode($payload)), true);
			if (!is_array($reply) || ($reply['ok'] ?? false) !== true) {
				$why = is_array($reply) ? (string) ($reply['error'] ?? 'no reason given') : 'unreadable reply';
				return ['ok' => false, 'error' => $why];
			}
			return $reply;
		}

		/**
		 * Raises what ext-sodium raises. Every one of these functions throws rather than returning
		 * FALSE, so a caller cannot mistake a refusal for a digest.
		 */
		function cfw_blake2b_fail($reason) {
			throw new SodiumException($reason);
		}

		/**
		 * The raw digest bytes out of a reply.
		 */
		function cfw_blake2b_bytes(array $reply) {
			$out = base64_decode((string) ($reply['b64'] ?? ''), true);
			if ($out === false) { cfw_blake2b_fail('reply was not base64'); }
			return $out;
		}

		function sodium_crypto_generichash($message, $key = '', $length = 32) {
			$r = cfw_blake2b([
				'op' => 'hash',
				'b64' => base64_encode((string) $message),
				'key64' => base64_encode((string) $key),
				'len' => (int) $length,
			]);
			if (!$r['ok']) { cfw_blake2b_fail($r['error']); }
			return cfw_blake2b_bytes($r);
		}

		/**
		 * Mints an incremental state.
		 *
		 * ext-sodium returns a 384-byte binary string holding the context itself. This returns an
		 * opaque token instead, because the context lives in JavaScript -- see the bridge docblock.
		 * Every caller treats the value as opaque, which is what makes the substitution safe.
		 */
		function sodium_crypto_generichash_init($key = '', $length = 32) {
			$r = cfw_blake2b([
				'op' => 'init',
				'key64' => base64_encode((string) $key),
				'len' => (int) $length,
			]);
			if (!$r['ok']) { cfw_blake2b_fail($r['error']); }
			return 'cfwb2b:' . (int) ($r['state'] ?? 0);
		}

		/**
		 * Reads a state token, refusing anything that is not one.
		 *
		 * "incorrect state length" is ext-sodium's own message for a string that is not a state,
		 * measured on 8.5.7, so a caller matching on it keeps working.
		 */
		function cfw_blake2b_state($state) {
			if (!is_string($state) || strncmp($state, 'cfwb2b:', 7) !== 0) {
				cfw_blake2b_fail('incorrect state length');
			}
			return (int) substr($state, 7);
		}

		function sodium_crypto_generichash_update(&$state, $message) {
			$r = cfw_blake2b([
				'op' => 'update',
				'state' => cfw_blake2b_state($state),
				'b64' => base64_encode((string) $message),
			]);
			if (!$r['ok']) { cfw_blake2b_fail($r['error']); }
			return true;
		}

		/**
		 * Finishes the digest and voids the state, the way ext-sodium does.
		 *
		 * The void is not tidiness: measured on 8.5.7, native leaves $state NULL and a later
		 * update() on it answers "must be a reference to a state". Leaving the token live here
		 * would make that same call succeed against a context this side has already released.
		 */
		function sodium_crypto_generichash_final(&$state, $length = 32) {
			$r = cfw_blake2b([
				'op' => 'final',
				'state' => cfw_blake2b_state($state),
				'len' => (int) $length,
			]);
			$state = null;
			if (!$r['ok']) { cfw_blake2b_fail($r['error']); }
			return cfw_blake2b_bytes($r);
		}
	}
}
`;
