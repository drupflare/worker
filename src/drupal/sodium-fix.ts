/**
 * Replaces `sodium_crypto_generichash*` and the XChaCha20-Poly1305 AEAD in JavaScript.
 *
 * BLAKE2b exists in no layer here (no `sodium`, no `blake*` in `ext-hash`, none in workerd), and a
 * content-addressed store needs it as the address. Both libraries are synchronous because the
 * build has no Asyncify. `extension_loaded('sodium')` stays false: a stub extension entry crashed
 * the isolate.
 *
 * @module
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { blake2bFinal, blake2bInit, blake2bUpdate, type Blake2bCTX } from 'blakejs';
import { base64ToBytes, bytesToBase64 } from '../db/file-store';
import { SODIUM_FIX_PHP } from '../site/generated/assets';
import { errorMessage } from '../util/errors';

/** the Module key the PHP half resolves through `vrzno_env()` for BLAKE2b */
export const BLAKE2B_BRIDGE = 'cfwBlake2b';

/** the AEAD's own bridge; separate because a cipher and a digest fail for different reasons */
export const AEAD_BRIDGE = 'cfwAead';

/** XChaCha20-Poly1305 key size in bytes */
export const AEAD_KEYBYTES = 32;
/** XChaCha20-Poly1305 nonce size in bytes */
export const AEAD_NPUBBYTES = 24;
/** XChaCha20-Poly1305 tag size in bytes */
export const AEAD_ABYTES = 16;

/** what the PHP half sends the AEAD */
export type AeadRequest = {
	op?: string;
	/** the message or the sealed frame, base64 */
	b64?: string;
	/** additional authenticated data, base64 */
	aad64?: string;
	/** the 24-byte nonce, base64 */
	nonce64?: string;
	/** the 32-byte key, base64 */
	key64?: string;
};

/** what it gets back; `ok: false` with `auth: true` is a failed tag rather than a bad argument */
export type AeadReply = { ok: true; b64: string } | { ok: false; error: string; auth?: boolean };

/**
 * One AEAD operation. A failed tag (`auth: true`, PHP returns false) and a bad argument (PHP
 * throws) stay apart, or a mis-sized key would read as a tampered frame and get swept.
 *
 * @internal
 */
export function aeadHostCall(req: AeadRequest): AeadReply {
	try {
		const op = String(req.op ?? '');
		if (op !== 'encrypt' && op !== 'decrypt') {
			return { ok: false, error: `unknown aead op '${op}'` };
		}

		const key = base64ToBytes(String(req.key64 ?? ''));
		if (key.length !== AEAD_KEYBYTES) {
			return {
				ok: false,
				error: 'key size should be crypto_aead_xchacha20poly1305_KEYBYTES'
			};
		}
		const nonce = base64ToBytes(String(req.nonce64 ?? ''));
		if (nonce.length !== AEAD_NPUBBYTES) {
			return {
				ok: false,
				error: 'public nonce size should be crypto_aead_xchacha20poly1305_NPUBBYTES'
			};
		}

		const aad = base64ToBytes(String(req.aad64 ?? ''));
		const data = base64ToBytes(String(req.b64 ?? ''));
		// noble takes an empty AAD as undefined; passing a zero-length array changes the tag
		const cipher = xchacha20poly1305(key, nonce, aad.length === 0 ? undefined : aad);

		if (op === 'encrypt') return { ok: true, b64: bytesToBase64(cipher.encrypt(data)) };

		if (data.length < AEAD_ABYTES) {
			// shorter than the tag: an auth failure, since a truncated frame is a broken frame
			return {
				ok: false,
				error: 'ciphertext is shorter than the authentication tag',
				auth: true
			};
		}
		return { ok: true, b64: bytesToBase64(cipher.decrypt(data)) };
	} catch (e) {
		// the size checks already returned, so a decrypt throw here is the tag
		const why = errorMessage(e);
		return { ok: false, error: why, auth: String(req.op ?? '') === 'decrypt' };
	}
}

/**
 * Installs the AEAD bridge on the PHP Module, masked because sealing is a long JS frame under the
 * PHP stack.
 */
export function installAead(
	binary: Record<string, unknown>,
	withMask: <R>(fn: () => R) => R
): Record<string, unknown> {
	binary[AEAD_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: AeadRequest;
			try {
				req = JSON.parse(json) as AeadRequest;
			} catch (e) {
				const why = errorMessage(e);
				return JSON.stringify({ ok: false, error: `unparseable request: ${why}` });
			}
			return JSON.stringify(aeadHostCall(req));
		});
	return binary;
}

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

/** libsodium's minimum digest length; refused below it as ext-sodium does */
export const GENERICHASH_BYTES_MIN = 16;
/** libsodium's maximum digest length */
export const GENERICHASH_BYTES_MAX = 64;
/** libsodium's minimum key length */
export const GENERICHASH_KEYBYTES_MIN = 16;
/** libsodium's maximum key length */
export const GENERICHASH_KEYBYTES_MAX = 64;

/**
 * How many incremental digests may be open at once. Past it `init` refuses rather than evicting,
 * since an evicted context would yield a wrong digest instead of a failed one.
 */
export const MAX_OPEN_STATES = 64;

/** an open incremental digest, held here rather than in PHP because the context is 64-bit */
type OpenState = { ctx: Blake2bCTX; len: number };

/**
 * The store an `installBlake2b` bridge keeps its incremental contexts in; exported so a test can
 * drive `init`/`update`/`final` across calls.
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
 * The key bytes, undefined for unkeyed (empty), or an error string; 1-15 bytes is refused as
 * ext-sodium does, never padded.
 *
 * @internal
 */
export function readKey(key64: unknown): Uint8Array | undefined | string {
	const raw = String(key64 ?? '');
	if (raw === '') return undefined;
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(raw);
	} catch (e) {
		return `key was not base64: ${errorMessage(e)}`;
	}
	if (bytes.length === 0) return undefined;
	if (bytes.length < GENERICHASH_KEYBYTES_MIN || bytes.length > GENERICHASH_KEYBYTES_MAX) {
		return 'unsupported key length';
	}
	return bytes;
}

/**
 * One BLAKE2b operation: `hash` one-shot, or streaming `init`/`update`/`final` with the context
 * held here behind an integer handle. A failure is a reply the PHP half turns into an exception.
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
			// the length is fixed at init; refused here where native 8.5.7 leaks adjacent memory
			if (len !== entry.len) {
				states.open.delete(id);
				return { ok: false, error: 'unsupported output length' };
			}
			states.open.delete(id);
			return { ok: true, b64: bytesToBase64(blake2bFinal(entry.ctx)) };
		}

		return { ok: false, error: `unknown blake2b op '${op}'` };
	} catch (e) {
		return { ok: false, error: errorMessage(e) };
	}
}

/** the shape `installBlake2b` needs of a PHP binary, so it can be driven from a test */
export type Blake2bBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module, masked because a pass over a megabyte is a long JS frame
 * under the PHP stack.
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
			} catch (e) {
				const why = errorMessage(e);
				return JSON.stringify({ ok: false, error: `unparseable request: ${why}` });
			}
			return JSON.stringify(blake2bHostCall(req, states));
		});
	return binary;
}

/**
 * The PHP half: the generichash functions, the AEAD, their constants and `SodiumException`,
 * declared conditionally (no `eval()`) so `php -l` can lint it.
 */
export const SODIUM_FIX = SODIUM_FIX_PHP;
