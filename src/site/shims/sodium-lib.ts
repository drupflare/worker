/**
 * The host half of the sodium stand-in: every `sodium_*` function the PHP extension has, over
 * synchronous JavaScript.
 *
 * The bridge is synchronous because the build has no Asyncify, which rules WebCrypto out
 * (`crypto.subtle` is Promise-based and would need one Zend park per call). Each function is backed
 * by the first of these that holds: `@noble/ciphers` and `@noble/hashes` (installed), `blakejs`
 * (installed, used for the BLAKE2b state), then the noble curve wrappers in `sodium-curve.ts`
 * and the AEGIS code in `sodium-aegis.ts`. Randomness is `crypto.getRandomValues`, which is synchronous.
 *
 * The PHP half passes each argument as base64 (strings) or a number (ints) and gets back a tagged
 * value; a refusal is a reply the PHP half raises as the exception ext-sodium raises.
 *
 * @module
 */
import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { gcm } from '@noble/ciphers/aes.js';
import {
	chacha20,
	chacha20orig,
	chacha20poly1305,
	hchacha,
	xchacha20,
	xchacha20poly1305
} from '@noble/ciphers/chacha.js';
import { hsalsa, secretbox, xsalsa20 } from '@noble/ciphers/salsa.js';
import { numberToBytesLE } from '@noble/curves/utils.js';
import { argon2i, argon2id } from '@noble/hashes/argon2.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { blake2bFinal, blake2bInit, blake2bUpdate, type Blake2bCTX } from 'blakejs';
import { base64ToBytes, bytesToBase64 } from '../../db/file-store';
import { errorMessage } from '../../util/errors';
import { SODIUM_API } from '../generated/sodium-api';
import { aegisOpen, aegisSeal } from './sodium-aegis';
import {
	ed25519FromSeed,
	ed25519PublicToCurve,
	ed25519SecretToCurve,
	ed25519Sign,
	ed25519Verify,
	ristrettoAdd,
	ristrettoFromHash,
	ristrettoIsValid,
	ristrettoMul,
	scalar,
	scalarReduce,
	x25519Base,
	x25519Shared
} from './sodium-curve';

/** the Module key the PHP half resolves through `vrzno_env()` */
export const SODIUM_BRIDGE = 'cfwSodium';

/**
 * The largest memory a password hash may ask for. The arena is a transient JS allocation and the
 * isolate has roughly 20 MiB spare on a large site, so a request above this is refused the way
 * libsodium refuses an allocation it cannot make.
 */
export const PWHASH_MEMORY_CAP = 67_108_864;

/**
 * The most argon2 work (passes times KiB) one call may do, the SENSITIVE profile's 4 passes over
 * 64 MiB. A hash string is attacker-supplied, and its pass count is otherwise unbounded.
 */
export const PWHASH_WORK_CAP = 4 * 65_536;

/** the most scrypt work (N times r times p) one call may do, four passes over 64 MiB */
export const SCRYPT_WORK_CAP = 4 * 65_536 * 8;

type Value = Uint8Array | boolean | number | null | undefined | Value[];
type Ctx = { refs: Record<number, Uint8Array | null>; raw: unknown[] };
type Run = (a: any[], c: Ctx) => Value;

/** a refusal; `cls` names the exception the PHP half raises */
class Refusal extends Error {
	constructor(
		readonly cls: 'SodiumException' | 'TypeError' | 'ValueError',
		message: string
	) {
		super(message);
	}
}

const constants = SODIUM_API.constants as Record<string, number | string>;
const num = (name: string): number => Number(constants[`SODIUM_${name}`]);

const paramNames = new Map<string, string[]>(
	SODIUM_API.functions.map((f) => [f.name, f.params.map((p) => p.name)])
);

const refuse = (message: string): never => {
	throw new Refusal('SodiumException', message);
};

const argError = (fn: string, at: number, why: string): never =>
	refuse(`${fn}(): Argument #${at + 1} ($${paramNames.get(fn)?.[at] ?? '?'}) ${why}`);

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

const random = (n: number): Uint8Array => {
	const out = new Uint8Array(n);
	for (let at = 0; at < n; at += 65_536) crypto.getRandomValues(out.subarray(at, at + 65_536));
	return out;
};

const same = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
};

const isZero = (a: Uint8Array): boolean => a.every((x) => x === 0);

const u32 = (b: Uint8Array): Uint32Array => {
	const out = new Uint32Array(b.length / 4);
	new Uint8Array(out.buffer).set(b);
	return out;
};

const SIGMA = u32(new TextEncoder().encode('expand 32-byte k'));

/** HSalsa20 over a 32-byte key and a 16-byte input */
function hsalsa20(key: Uint8Array, input: Uint8Array): Uint8Array {
	const out = new Uint32Array(8);
	hsalsa(SIGMA, u32(key), u32(input), out);
	return new Uint8Array(out.buffer);
}

const dataView = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.length);

// #region registry

const registry = new Map<string, { v: (string | undefined)[]; run: Run }>();

/** `v` names the *_BYTES constant each argument must match, or '' for an unchecked one */
function def(name: string, v: (string | undefined)[], run: Run): void {
	registry.set(`sodium_${name}`, { v, run });
}

// #endregion

// #region generichash and the state it keeps

const STATE_BYTES = 384;
const STATE_MAGIC = 0x62776643;

function packState(ctx: Blake2bCTX): Uint8Array {
	const out = new Uint8Array(STATE_BYTES);
	const dv = dataView(out);
	dv.setUint32(0, STATE_MAGIC, true);
	out[4] = ctx.outlen;
	out[5] = ctx.c;
	dv.setBigUint64(8, BigInt(ctx.t), true);
	out.set(new Uint8Array(ctx.h.buffer, ctx.h.byteOffset, 64), 16);
	out.set(ctx.b, 80);
	return out;
}

function unpackState(state: Uint8Array): Blake2bCTX {
	const dv = dataView(state);
	if (state.length !== STATE_BYTES || dv.getUint32(0, true) !== STATE_MAGIC) {
		refuse('incorrect state length');
	}
	const ctx = blake2bInit(state[4]!);
	ctx.c = state[5]!;
	ctx.t = Number(dv.getBigUint64(8, true));
	new Uint8Array(ctx.h.buffer, ctx.h.byteOffset, 64).set(state.subarray(16, 80));
	ctx.b.set(state.subarray(80, 208));
	return ctx;
}

function hashLength(fn: string, at: number, len: number): void {
	if (!Number.isInteger(len) || len < num('CRYPTO_GENERICHASH_BYTES_MIN')) {
		refuse('unsupported output length');
	}
	if (len > num('CRYPTO_GENERICHASH_BYTES_MAX')) refuse('unsupported output length');
	void fn;
	void at;
}

function hashKey(key: Uint8Array): Uint8Array | undefined {
	if (key.length === 0) return undefined;
	if (
		key.length < num('CRYPTO_GENERICHASH_KEYBYTES_MIN') ||
		key.length > num('CRYPTO_GENERICHASH_KEYBYTES_MAX')
	) {
		refuse('unsupported key length');
	}
	return key;
}

def('crypto_generichash', [, , undefined], ([m, key, len]) => {
	hashLength('crypto_generichash', 2, len);
	const ctx = blake2bInit(len, hashKey(key));
	blake2bUpdate(ctx, m);
	return blake2bFinal(ctx);
});
def('crypto_generichash_keygen', [], () => random(num('CRYPTO_GENERICHASH_KEYBYTES')));
def('crypto_generichash_init', [, undefined], ([key, len]) => {
	hashLength('crypto_generichash_init', 1, len);
	return packState(blake2bInit(len, hashKey(key)));
});
def('crypto_generichash_update', [], ([state, m], c) => {
	const ctx = unpackState(state);
	blake2bUpdate(ctx, m);
	c.refs[0] = packState(ctx);
	return true;
});
def('crypto_generichash_final', [], ([state, len], c) => {
	const ctx = unpackState(state);
	hashLength('crypto_generichash_final', 1, len);
	blake2bFinal(ctx);
	// the chaining value past the digest is what libsodium copies for a longer request
	const all = new Uint8Array(ctx.h.buffer, ctx.h.byteOffset, 64);
	c.refs[0] = null;
	return Uint8Array.from(all.subarray(0, len));
});

// #endregion

// #region aead

type AeadSpec = {
	name: string;
	key: number;
	npub: number;
	abytes: number;
	seal: (m: Uint8Array, ad: Uint8Array, n: Uint8Array, k: Uint8Array) => Uint8Array;
	open: (c: Uint8Array, ad: Uint8Array, n: Uint8Array, k: Uint8Array) => Uint8Array | undefined;
};

function chachaOrigMac(
	key: Uint8Array,
	nonce: Uint8Array,
	ad: Uint8Array,
	ct: Uint8Array
): Uint8Array {
	const polyKey = chacha20orig(key, nonce, new Uint8Array(32));
	const mac = poly1305.create(polyKey);
	const len = new Uint8Array(8);
	mac.update(ad);
	dataView(len).setBigUint64(0, BigInt(ad.length), true);
	mac.update(len);
	mac.update(ct);
	dataView(len).setBigUint64(0, BigInt(ct.length), true);
	mac.update(len);
	return mac.digest();
}

const noAd = (ad: Uint8Array): Uint8Array | undefined => (ad.length === 0 ? undefined : ad);

const AEADS: AeadSpec[] = [
	{
		name: 'aes256gcm',
		key: 32,
		npub: 12,
		abytes: 16,
		seal: (m, ad, n, k) => gcm(k, n, noAd(ad)).encrypt(m),
		open: (c, ad, n, k) => {
			try {
				return gcm(k, n, noAd(ad)).decrypt(c);
			} catch {
				return undefined;
			}
		}
	},
	{
		name: 'aegis128l',
		key: 16,
		npub: 16,
		abytes: 32,
		seal: (m, ad, n, k) => aegisSeal('128l', m, ad, n, k),
		open: (c, ad, n, k) => aegisOpen('128l', c, ad, n, k)
	},
	{
		name: 'aegis256',
		key: 32,
		npub: 32,
		abytes: 32,
		seal: (m, ad, n, k) => aegisSeal('256', m, ad, n, k),
		open: (c, ad, n, k) => aegisOpen('256', c, ad, n, k)
	},
	{
		name: 'chacha20poly1305',
		key: 32,
		npub: 8,
		abytes: 16,
		seal: (m, ad, n, k) => {
			const ct = chacha20orig(k, n, m, undefined, 1);
			return concat(ct, chachaOrigMac(k, n, ad, ct));
		},
		open: (c, ad, n, k) => {
			if (c.length < 16) return undefined;
			const ct = c.subarray(0, c.length - 16);
			if (!same(chachaOrigMac(k, n, ad, ct), c.subarray(c.length - 16))) return undefined;
			return chacha20orig(k, n, ct, undefined, 1);
		}
	},
	{
		name: 'chacha20poly1305_ietf',
		key: 32,
		npub: 12,
		abytes: 16,
		seal: (m, ad, n, k) => chacha20poly1305(k, n, noAd(ad)).encrypt(m),
		open: (c, ad, n, k) => {
			try {
				return chacha20poly1305(k, n, noAd(ad)).decrypt(c);
			} catch {
				return undefined;
			}
		}
	},
	{
		name: 'xchacha20poly1305_ietf',
		key: 32,
		npub: 24,
		abytes: 16,
		seal: (m, ad, n, k) => xchachaAead(k, n, ad).encrypt(m),
		open: (c, ad, n, k) => {
			try {
				return xchachaAead(k, n, ad).decrypt(c);
			} catch {
				return undefined;
			}
		}
	}
];

const xchachaAead = (k: Uint8Array, n: Uint8Array, ad: Uint8Array) =>
	xchacha20poly1305(k, n, noAd(ad));

for (const a of AEADS) {
	const up = a.name.toUpperCase();
	const fn = `crypto_aead_${a.name}`;
	const keyC = `CRYPTO_AEAD_${up}_KEYBYTES`;
	const npubC = `CRYPTO_AEAD_${up}_NPUBBYTES`;
	def(`${fn}_keygen`, [], () => random(a.key));
	def(`${fn}_encrypt`, [, , npubC, keyC], ([m, ad, n, k]) => a.seal(m, ad, n, k));
	def(`${fn}_decrypt`, [, , npubC, keyC], ([c, ad, n, k]) => {
		if (c.length < a.abytes) return false;
		return a.open(c, ad, n, k) ?? false;
	});
}
def('crypto_aead_aes256gcm_is_available', [], () => true);

// #endregion

// #region secretbox, stream, auth, shorthash, kdf

def('crypto_secretbox_keygen', [], () => random(32));
def(
	'crypto_secretbox',
	[, 'CRYPTO_SECRETBOX_NONCEBYTES', 'CRYPTO_SECRETBOX_KEYBYTES'],
	([m, n, k]) => secretbox(k, n).seal(m)
);
def(
	'crypto_secretbox_open',
	[, 'CRYPTO_SECRETBOX_NONCEBYTES', 'CRYPTO_SECRETBOX_KEYBYTES'],
	([c, n, k]) => {
		if (c.length < 16) return false;
		try {
			return secretbox(k, n).open(c);
		} catch {
			return false;
		}
	}
);

const ROUNDS = (s: Uint32Array, a: number, b: number, c: number, d: number): void => {
	s[a]! += s[b]!;
	s[d] = ((s[d]! ^ s[a]!) << 16) | ((s[d]! ^ s[a]!) >>> 16);
	s[c]! += s[d]!;
	s[b] = ((s[b]! ^ s[c]!) << 12) | ((s[b]! ^ s[c]!) >>> 20);
	s[a]! += s[b]!;
	s[d] = ((s[d]! ^ s[a]!) << 8) | ((s[d]! ^ s[a]!) >>> 24);
	s[c]! += s[d]!;
	s[b] = ((s[b]! ^ s[c]!) << 7) | ((s[b]! ^ s[c]!) >>> 25);
};

/** one ChaCha20 block with libsodium's 64-bit counter and 8-byte nonce */
function chachaBlock(key: Uint32Array, nonce: Uint32Array, counter: bigint): Uint8Array {
	const s = new Uint32Array(16);
	s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574], 0);
	s.set(key, 4);
	s[12] = Number(counter & 0xffffffffn);
	s[13] = Number(counter >> 32n);
	s.set(nonce, 14);
	const x = Uint32Array.from(s);
	for (let i = 0; i < 10; i++) {
		ROUNDS(x, 0, 4, 8, 12);
		ROUNDS(x, 1, 5, 9, 13);
		ROUNDS(x, 2, 6, 10, 14);
		ROUNDS(x, 3, 7, 11, 15);
		ROUNDS(x, 0, 5, 10, 15);
		ROUNDS(x, 1, 6, 11, 12);
		ROUNDS(x, 2, 7, 8, 13);
		ROUNDS(x, 3, 4, 9, 14);
	}
	for (let i = 0; i < 16; i++) x[i]! += s[i]!;
	return new Uint8Array(x.buffer);
}

/** XChaCha20 xor from a 64-bit block counter; noble stops at 32 bits, libsodium does not */
function xchachaXorIc(m: Uint8Array, nonce: Uint8Array, counter: bigint, key: Uint8Array) {
	const blocks = BigInt(Math.ceil(m.length / 64));
	if (counter + blocks < 1n << 32n) return xchacha20(key, nonce, m, undefined, Number(counter));
	const sub = new Uint32Array(8);
	hchacha(u32(CHACHA_SIGMA), u32(key), u32(nonce.subarray(0, 16)), sub);
	const n8 = u32(nonce.subarray(16, 24));
	const out = new Uint8Array(m.length);
	for (let at = 0; at < m.length; at += 64) {
		const ks = chachaBlock(sub, n8, BigInt.asUintN(64, counter + BigInt(at / 64)));
		for (let i = 0; i < 64 && at + i < m.length; i++) out[at + i] = m[at + i]! ^ ks[i]!;
	}
	return out;
}

const CHACHA_SIGMA = new TextEncoder().encode('expand 32-byte k');

const streamLength = (fn: string, len: number): void => {
	if (!(len > 0)) argError(fn, 0, 'must be greater than 0');
};

def('crypto_stream_keygen', [], () => random(32));
def('crypto_stream', [, 'CRYPTO_STREAM_NONCEBYTES', 'CRYPTO_STREAM_KEYBYTES'], ([len, n, k]) => {
	streamLength('sodium_crypto_stream', len);
	return xsalsa20(k, n, new Uint8Array(len));
});
def('crypto_stream_xor', [, 'CRYPTO_STREAM_NONCEBYTES', 'CRYPTO_STREAM_KEYBYTES'], ([m, n, k]) =>
	xsalsa20(k, n, m)
);
def('crypto_stream_xchacha20_keygen', [], () => random(32));
def(
	'crypto_stream_xchacha20',
	[, 'CRYPTO_STREAM_XCHACHA20_NONCEBYTES', 'CRYPTO_STREAM_XCHACHA20_KEYBYTES'],
	([len, n, k]) => {
		streamLength('sodium_crypto_stream_xchacha20', len);
		return xchacha20(k, n, new Uint8Array(len));
	}
);
def(
	'crypto_stream_xchacha20_xor',
	[, 'CRYPTO_STREAM_XCHACHA20_NONCEBYTES', 'CRYPTO_STREAM_XCHACHA20_KEYBYTES'],
	([m, n, k]) => xchacha20(k, n, m)
);
def(
	'crypto_stream_xchacha20_xor_ic',
	[, 'CRYPTO_STREAM_XCHACHA20_NONCEBYTES'],
	([m, n, , k], c) => {
		// php-src reports a short key as argument 3, the counter, and so does this
		if (k.length !== 32) {
			argError(
				'sodium_crypto_stream_xchacha20_xor_ic',
				2,
				'must be SODIUM_CRYPTO_STREAM_XCHACHA20_KEYBYTES bytes long'
			);
		}
		return xchachaXorIc(m, n, BigInt.asUintN(64, BigInt(String(c.raw[2]))), k);
	}
);

def('crypto_auth_keygen', [], () => random(32));
def('crypto_auth', [, 'CRYPTO_AUTH_KEYBYTES'], ([m, k]) => hmac(sha512, k, m).subarray(0, 32));
def('crypto_auth_verify', ['CRYPTO_AUTH_BYTES', , 'CRYPTO_AUTH_KEYBYTES'], ([mac, m, k]) =>
	same(mac, hmac(sha512, k, m).subarray(0, 32))
);

const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, b: bigint): bigint => ((x << b) | (x >> (64n - b))) & M64;

/** SipHash-2-4 with a 16-byte key and an 8-byte result */
function siphash24(key: Uint8Array, msg: Uint8Array): Uint8Array {
	const k0 = dataView(key).getBigUint64(0, true);
	const k1 = dataView(key).getBigUint64(8, true);
	let v0 = k0 ^ 0x736f6d6570736575n;
	let v1 = k1 ^ 0x646f72616e646f6dn;
	let v2 = k0 ^ 0x6c7967656e657261n;
	let v3 = k1 ^ 0x7465646279746573n;
	const round = () => {
		v0 = (v0 + v1) & M64;
		v1 = rotl(v1, 13n) ^ v0;
		v0 = rotl(v0, 32n);
		v2 = (v2 + v3) & M64;
		v3 = rotl(v3, 16n) ^ v2;
		v0 = (v0 + v3) & M64;
		v3 = rotl(v3, 21n) ^ v0;
		v2 = (v2 + v1) & M64;
		v1 = rotl(v1, 17n) ^ v2;
		v2 = rotl(v2, 32n);
	};
	const end = msg.length - (msg.length % 8);
	for (let i = 0; i < end; i += 8) {
		const m = dataView(msg).getBigUint64(i, true);
		v3 ^= m;
		round();
		round();
		v0 ^= m;
	}
	let last = BigInt(msg.length & 0xff) << 56n;
	for (let i = 0; i < msg.length - end; i++) last |= BigInt(msg[end + i]!) << BigInt(8 * i);
	v3 ^= last;
	round();
	round();
	v0 ^= last;
	v2 ^= 0xffn;
	for (let i = 0; i < 4; i++) round();
	return numberToBytesLE(BigInt.asUintN(64, v0 ^ v1 ^ v2 ^ v3), 8);
}

def('crypto_shorthash_keygen', [], () => random(16));
def('crypto_shorthash', [, 'CRYPTO_SHORTHASH_KEYBYTES'], ([m, k]) => siphash24(k, m));

def('crypto_kdf_keygen', [], () => random(32));
def(
	'crypto_kdf_derive_from_key',
	[, , 'CRYPTO_KDF_CONTEXTBYTES', 'CRYPTO_KDF_KEYBYTES'],
	([len, , ctx, key], c) => {
		const fn = 'sodium_crypto_kdf_derive_from_key';
		if (len < num('CRYPTO_KDF_BYTES_MIN')) {
			argError(fn, 0, 'must be greater than or equal to SODIUM_CRYPTO_KDF_BYTES_MIN');
		}
		if (len > num('CRYPTO_KDF_BYTES_MAX')) {
			argError(fn, 0, 'must be less than or equal to SODIUM_CRYPTO_KDF_BYTES_MAX');
		}
		const id = BigInt(String(c.raw[1]));
		if (id < 0n) argError(fn, 1, 'must be greater than or equal to 0');
		const salt = new Uint8Array(16);
		dataView(salt).setBigUint64(0, id, true);
		const personal = new Uint8Array(16);
		personal.set(ctx);
		return blake2b(new Uint8Array(0), { dkLen: len, key, salt, personalization: personal });
	}
);

// #endregion

// #region box, sign, kx and the curve functions

const BOXK = ['CRYPTO_BOX_KEYPAIRBYTES'] as const;

function zeroGuard(shared: Uint8Array | undefined): Uint8Array {
	if (shared === undefined || isZero(shared)) return refuse('internal error');
	return shared;
}

/** the crypto_box precomputed key: HSalsa20 of the X25519 shared secret */
const boxKey = (sk: Uint8Array, pk: Uint8Array): Uint8Array =>
	hsalsa20(zeroGuard(x25519Shared(sk, pk)), new Uint8Array(16));

const boxPair = (sk: Uint8Array): Uint8Array => concat(sk, x25519Base(sk));

def('crypto_box_keypair', [], () => boxPair(random(32)));
def('crypto_box_seed_keypair', ['CRYPTO_BOX_SEEDBYTES'], ([seed]) =>
	boxPair(sha512(seed).subarray(0, 32))
);
def(
	'crypto_box_keypair_from_secretkey_and_publickey',
	['CRYPTO_BOX_SECRETKEYBYTES', 'CRYPTO_BOX_PUBLICKEYBYTES'],
	([sk, pk]) => concat(sk, pk)
);
def('crypto_box_publickey', [...BOXK], ([kp]) => kp.subarray(32, 64));
def('crypto_box_secretkey', [...BOXK], ([kp]) => kp.subarray(0, 32));
def('crypto_box_publickey_from_secretkey', ['CRYPTO_BOX_SECRETKEYBYTES'], ([sk]) => x25519Base(sk));
def('crypto_box', [, 'CRYPTO_BOX_NONCEBYTES', ...BOXK], ([m, n, kp]) =>
	secretbox(boxKey(kp.subarray(0, 32), kp.subarray(32, 64)), n).seal(m)
);
def('crypto_box_open', [, 'CRYPTO_BOX_NONCEBYTES', ...BOXK], ([c, n, kp]) => {
	if (c.length < 16) return false;
	try {
		return secretbox(boxKey(kp.subarray(0, 32), kp.subarray(32, 64)), n).open(c);
	} catch (e) {
		if (e instanceof Refusal) throw e;
		return false;
	}
});

const sealNonce = (epk: Uint8Array, pk: Uint8Array): Uint8Array =>
	blake2b(concat(epk, pk), { dkLen: 24 });

def('crypto_box_seal', [, 'CRYPTO_BOX_PUBLICKEYBYTES'], ([m, pk]) => {
	const esk = random(32);
	const epk = x25519Base(esk);
	return concat(epk, secretbox(boxKey(esk, pk), sealNonce(epk, pk)).seal(m));
});
def('crypto_box_seal_open', [, ...BOXK], ([c, kp]) => {
	if (c.length < num('CRYPTO_BOX_SEALBYTES')) return false;
	const epk = c.subarray(0, 32);
	const pk = kp.subarray(32, 64);
	try {
		return secretbox(boxKey(kp.subarray(0, 32), epk), sealNonce(epk, pk)).open(c.subarray(32));
	} catch (e) {
		if (e instanceof Refusal) throw e;
		return false;
	}
});

def('crypto_scalarmult_base', ['CRYPTO_BOX_SECRETKEYBYTES'], ([sk]) => {
	return zeroGuard(x25519Base(sk));
});
def('crypto_scalarmult', ['CRYPTO_SCALARMULT_SCALARBYTES', 'CRYPTO_SCALARMULT_BYTES'], ([n, p]) =>
	zeroGuard(x25519Shared(n, p))
);

def('crypto_kx_keypair', [], () => boxPair(random(32)));
def('crypto_kx_seed_keypair', ['CRYPTO_KX_SEEDBYTES'], ([seed]) =>
	boxPair(blake2b(seed, { dkLen: 32 }))
);
def('crypto_kx_publickey', ['CRYPTO_KX_KEYPAIRBYTES'], ([kp]) => kp.subarray(32, 64));
def('crypto_kx_secretkey', ['CRYPTO_KX_KEYPAIRBYTES'], ([kp]) => kp.subarray(0, 32));

function kxKeys(mine: Uint8Array, theirPk: Uint8Array, client: boolean): [Uint8Array, Uint8Array] {
	const sk = mine.subarray(0, 32);
	const pk = mine.subarray(32, 64);
	const q = zeroGuard(x25519Shared(sk, theirPk));
	const h = blake2b(client ? concat(q, pk, theirPk) : concat(q, theirPk, pk), { dkLen: 64 });
	return client
		? [h.subarray(0, 32), h.subarray(32, 64)]
		: [h.subarray(32, 64), h.subarray(0, 32)];
}
def(
	'crypto_kx_client_session_keys',
	['CRYPTO_KX_KEYPAIRBYTES', 'CRYPTO_KX_PUBLICKEYBYTES'],
	([kp, pk]) => kxKeys(kp, pk, true)
);
def(
	'crypto_kx_server_session_keys',
	['CRYPTO_KX_KEYPAIRBYTES', 'CRYPTO_KX_PUBLICKEYBYTES'],
	([kp, pk]) => kxKeys(kp, pk, false)
);

const SIGN_SK = 'CRYPTO_SIGN_SECRETKEYBYTES';
const SIGN_PK = 'CRYPTO_SIGN_PUBLICKEYBYTES';

def('crypto_sign_keypair', [], () => {
	const { secret, pub } = ed25519FromSeed(random(32));
	return concat(secret, pub);
});
def('crypto_sign_seed_keypair', ['CRYPTO_SIGN_SEEDBYTES'], ([seed]) => {
	const { secret, pub } = ed25519FromSeed(seed);
	return concat(secret, pub);
});
def('crypto_sign_keypair_from_secretkey_and_publickey', [SIGN_SK, SIGN_PK], ([sk, pk]) =>
	concat(sk, pk)
);
def('crypto_sign_publickey', ['CRYPTO_SIGN_KEYPAIRBYTES'], ([kp]) => kp.subarray(64, 96));
def('crypto_sign_secretkey', ['CRYPTO_SIGN_KEYPAIRBYTES'], ([kp]) => kp.subarray(0, 64));
def('crypto_sign_publickey_from_secretkey', [SIGN_SK], ([sk]) => sk.subarray(32, 64));
def('crypto_sign_detached', [, SIGN_SK], ([m, sk]) => ed25519Sign(m, sk));
def('crypto_sign', [, SIGN_SK], ([m, sk]) => concat(ed25519Sign(m, sk), m));
def('crypto_sign_verify_detached', ['CRYPTO_SIGN_BYTES', , SIGN_PK], ([sig, m, pk]) =>
	ed25519Verify(sig, m, pk)
);
def('crypto_sign_open', [, SIGN_PK], ([sm, pk]) => {
	if (sm.length < 64) return false;
	const m = sm.subarray(64);
	return ed25519Verify(sm.subarray(0, 64), m, pk) ? m : false;
});
def('crypto_sign_ed25519_pk_to_curve25519', [SIGN_PK], ([pk]) => {
	const out = ed25519PublicToCurve(pk);
	if (!out) refuse('conversion failed');
	return out;
});
def('crypto_sign_ed25519_sk_to_curve25519', [SIGN_SK], ([sk]) => ed25519SecretToCurve(sk));

// #endregion

// #region ristretto255

const RB = 'CRYPTO_CORE_RISTRETTO255_BYTES';
const RS = 'CRYPTO_CORE_RISTRETTO255_SCALARBYTES';

def('crypto_core_ristretto255_random', [], () => {
	const p = ristrettoFromHash(random(64));
	return p;
});
def('crypto_core_ristretto255_from_hash', ['CRYPTO_CORE_RISTRETTO255_HASHBYTES'], ([h]) =>
	ristrettoFromHash(h)
);
def('crypto_core_ristretto255_is_valid_point', [RB], ([p]) => ristrettoIsValid(p));
def('crypto_core_ristretto255_add', [RB, RB], ([p, q]) => {
	return ristrettoAdd(p, q) ?? refuse('internal error');
});
def('crypto_core_ristretto255_sub', [RB, RB], ([p, q]) => {
	return ristrettoAdd(p, q, true) ?? refuse('internal error');
});
def('crypto_core_ristretto255_scalar_random', [], () => scalarReduce(random(64)));
def(
	'crypto_core_ristretto255_scalar_reduce',
	['CRYPTO_CORE_RISTRETTO255_NONREDUCEDSCALARBYTES'],
	([s]) => scalarReduce(s)
);
def('crypto_core_ristretto255_scalar_invert', [RS], ([s]) => {
	return scalar.invert(s) ?? refuse('internal error');
});
def('crypto_core_ristretto255_scalar_negate', [RS], ([s]) => scalar.negate(s));
def('crypto_core_ristretto255_scalar_complement', [RS], ([s]) => scalar.complement(s));
def('crypto_core_ristretto255_scalar_add', [RS, RS], ([x, y]) => scalar.add(x, y));
def('crypto_core_ristretto255_scalar_sub', [RS, RS], ([x, y]) => scalar.sub(x, y));
def('crypto_core_ristretto255_scalar_mul', [RS, RS], ([x, y]) => scalar.mul(x, y));
def(
	'crypto_scalarmult_ristretto255',
	['CRYPTO_SCALARMULT_RISTRETTO255_SCALARBYTES', 'CRYPTO_SCALARMULT_RISTRETTO255_BYTES'],
	([n, p]) => {
		const out = ristrettoMul(n, p);
		if (!out) refuse('Result is identity element');
		return out;
	}
);
def(
	'crypto_scalarmult_ristretto255_base',
	['CRYPTO_SCALARMULT_RISTRETTO255_SCALARBYTES'],
	([n]) => {
		const out = ristrettoMul(n);
		if (!out) argError('sodium_crypto_scalarmult_ristretto255_base', 0, 'must not be zero');
		return out;
	}
);

// #endregion

// #region pwhash

const b64np = (b: Uint8Array): string => bytesToBase64(b).replace(/=+$/, '');
const unb64np = (s: string): Uint8Array | undefined => {
	if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) return undefined;
	return base64ToBytes(s + '='.repeat((4 - (s.length % 4)) % 4));
};

function argonHash(
	algo: number,
	len: number,
	pw: Uint8Array,
	salt: Uint8Array,
	t: number,
	m: number
): Uint8Array {
	if (m * 1024 > PWHASH_MEMORY_CAP || t * m > PWHASH_WORK_CAP) refuse('internal error');
	const opts = { t, m, p: 1, dkLen: len, maxmem: PWHASH_MEMORY_CAP + 1_048_576 };
	return (algo === num('CRYPTO_PWHASH_ALG_ARGON2I13') ? argon2i : argon2id)(pw, salt, opts);
}

def('crypto_pwhash', [, , 'CRYPTO_PWHASH_SALTBYTES', , ,], ([len, pw, salt, ops, mem, algo]) => {
	const fn = 'sodium_crypto_pwhash';
	if (len <= 0 || len >= 0xffffffff) argError(fn, 0, 'must be greater than 0');
	if (ops <= 0) argError(fn, 3, 'must be greater than 0');
	if (mem <= 0) argError(fn, 4, 'must be greater than 0');
	if (
		algo !== num('CRYPTO_PWHASH_ALG_ARGON2I13') &&
		algo !== num('CRYPTO_PWHASH_ALG_ARGON2ID13')
	) {
		refuse('unsupported password hashing algorithm');
	}
	if (len < 16 || mem < 8192 || ops > 0xffffffff) refuse('internal error');
	// argon2i's floor is three passes
	if (algo === num('CRYPTO_PWHASH_ALG_ARGON2I13') && ops < 3) refuse('internal error');
	return argonHash(algo, len, pw, salt, ops, Math.floor(mem / 1024));
});

def('crypto_pwhash_str', [], ([pw, ops, mem]) => {
	const fn = 'sodium_crypto_pwhash_str';
	if (ops <= 0) argError(fn, 1, 'must be greater than 0');
	if (mem <= 0) argError(fn, 2, 'must be greater than 0');
	if (mem < 8192) refuse('internal error');
	const salt = random(16);
	const m = Math.floor(mem / 1024);
	const hash = argonHash(num('CRYPTO_PWHASH_ALG_ARGON2ID13'), 32, pw, salt, ops, m);
	return new TextEncoder().encode(
		`$argon2id$v=19$m=${m},t=${ops},p=1$${b64np(salt)}$${b64np(hash)}`
	);
});

type ArgonString = { algo: number; m: number; t: number; salt: Uint8Array; hash: Uint8Array };

function parseArgon(str: string): ArgonString | undefined {
	const x =
		/^\$(argon2id|argon2i)\$v=19\$m=(\d+),t=(\d+),p=1\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
			str
		);
	if (!x) return undefined;
	const salt = unb64np(x[4]!);
	const hash = unb64np(x[5]!);
	if (!salt || !hash) return undefined;
	const algo = num(
		x[1] === 'argon2id' ? 'CRYPTO_PWHASH_ALG_ARGON2ID13' : 'CRYPTO_PWHASH_ALG_ARGON2I13'
	);
	return { algo, m: Number(x[2]), t: Number(x[3]), salt, hash };
}

const text = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

def('crypto_pwhash_str_verify', [], ([hash, pw]) => {
	const p = parseArgon(text(hash));
	if (!p || p.m * 1024 > PWHASH_MEMORY_CAP || p.t * p.m > PWHASH_WORK_CAP) return false;
	if (p.t < 1 || p.m < 8) return false;
	try {
		return same(argonHash(p.algo, p.hash.length, pw, p.salt, p.t, p.m), p.hash);
	} catch (e) {
		if (e instanceof Refusal) return false;
		return false;
	}
});

def('crypto_pwhash_str_needs_rehash', [], ([hash, ops, mem]) => {
	const p = parseArgon(text(hash));
	if (!p || p.algo !== num('CRYPTO_PWHASH_ALG_ARGON2ID13')) return true;
	return p.t !== ops || p.m !== Math.floor(mem / 1024);
});

/** the N, r and p libsodium's `pickparams` derives from the limits */
function scryptParams(opslimit: number, memlimit: number): { n: number; r: number; p: number } {
	const ops = Math.max(opslimit, 32768);
	const r = 8;
	let log2 = 1;
	let p: number;
	if (ops < memlimit / 32) {
		p = 1;
		const maxN = Math.floor(ops / (r * 4));
		while (log2 < 63 && 2 ** log2 <= Math.floor(maxN / 2)) log2++;
	} else {
		const maxN = Math.floor(memlimit / (r * 128));
		while (log2 < 63 && 2 ** log2 <= Math.floor(maxN / 2)) log2++;
		const maxrp = Math.min(Math.floor(Math.floor(ops / 4) / 2 ** log2), 0x3fffffff);
		p = Math.floor(maxrp / r);
	}
	return { n: 2 ** log2, r, p };
}

function scryptRun(
	len: number,
	pw: Uint8Array,
	salt: Uint8Array,
	prm: { n: number; r: number; p: number }
): Uint8Array {
	if (128 * prm.n * prm.r > PWHASH_MEMORY_CAP || prm.p < 1) refuse('internal error');
	if (prm.n * prm.r * prm.p > SCRYPT_WORK_CAP) refuse('internal error');
	return scrypt(pw, salt, {
		N: prm.n,
		r: prm.r,
		p: prm.p,
		dkLen: len,
		maxmem: PWHASH_MEMORY_CAP + 4_194_304
	});
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function encode64(src: Uint8Array): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		let value = 0;
		let bits = 0;
		do {
			value |= src[i++]! << bits;
			bits += 8;
		} while (bits < 24 && i < src.length);
		do {
			out += ITOA64[value & 0x3f];
			value >>>= 6;
			bits -= 6;
		} while (bits > 0);
	}
	return out;
}

function decode64(s: string): Uint8Array | undefined {
	const out: number[] = [];
	let i = 0;
	while (i < s.length) {
		let value = 0;
		let bits = 0;
		do {
			const d = ITOA64.indexOf(s[i++]!);
			if (d < 0) return undefined;
			value |= d << bits;
			bits += 6;
		} while (bits < 24 && i < s.length);
		for (let b = 0; b + 8 <= bits; b += 8) out.push((value >>> b) & 0xff);
	}
	return Uint8Array.from(out);
}

const enc30 = (v: number): string => {
	let out = '';
	for (let i = 0; i < 30; i += 6) out += ITOA64[(v >>> i) & 0x3f];
	return out;
};
const dec30 = (s: string): number => {
	let v = 0;
	for (let i = 0; i < 5; i++) {
		const d = ITOA64.indexOf(s[i]!);
		if (d < 0) return -1;
		v |= d << (6 * i);
	}
	return v;
};

def(
	'crypto_pwhash_scryptsalsa208sha256',
	[, , 'CRYPTO_PWHASH_SCRYPTSALSA208SHA256_SALTBYTES', ,],
	([len, pw, salt, ops, mem]) => {
		const fn = 'sodium_crypto_pwhash_scryptsalsa208sha256';
		if (len <= 0 || len >= 0xffffffff) argError(fn, 0, 'must be greater than 0');
		if (ops <= 0) argError(fn, 3, 'must be greater than 0');
		if (mem <= 0) argError(fn, 4, 'must be greater than 0');
		const minOps = num('CRYPTO_PWHASH_SCRYPTSALSA208SHA256_OPSLIMIT_INTERACTIVE');
		const minMem = num('CRYPTO_PWHASH_SCRYPTSALSA208SHA256_MEMLIMIT_INTERACTIVE');
		if (ops < minOps) argError(fn, 3, `must be greater than or equal to ${minOps}`);
		if (mem < minMem) argError(fn, 4, `must be greater than or equal to ${minMem}`);
		if (len < 16) refuse('internal error');
		return scryptRun(len, pw, salt, scryptParams(ops, mem));
	}
);

def('crypto_pwhash_scryptsalsa208sha256_str', [], ([pw, ops, mem]) => {
	const fn = 'sodium_crypto_pwhash_scryptsalsa208sha256_str';
	const minOps = num('CRYPTO_PWHASH_SCRYPTSALSA208SHA256_OPSLIMIT_INTERACTIVE');
	const minMem = num('CRYPTO_PWHASH_SCRYPTSALSA208SHA256_MEMLIMIT_INTERACTIVE');
	if (ops <= 0) argError(fn, 1, 'must be greater than 0');
	if (mem <= 0) argError(fn, 2, 'must be greater than 0');
	if (ops < minOps) {
		argError(fn, 1, `must be greater than or equal to ${minOps}`);
	}
	if (mem < minMem) {
		argError(fn, 2, `must be greater than or equal to ${minMem}`);
	}
	const prm = scryptParams(ops, mem);
	const salt = encode64(random(32));
	// the key derivation salt is the encoded salt text, not the 32 bytes behind it
	const hash = scryptRun(32, pw, new TextEncoder().encode(salt), prm);
	const head = `$7$${ITOA64[Math.log2(prm.n)]}${enc30(prm.r)}${enc30(prm.p)}${salt}`;
	return new TextEncoder().encode(`${head}$${encode64(hash)}`);
});

def('crypto_pwhash_scryptsalsa208sha256_str_verify', [], ([hash, pw]) => {
	const x = /^\$7\$(.)(.{5})(.{5})([./0-9A-Za-z]+)\$([./0-9A-Za-z]+)$/.exec(text(hash));
	if (!x) return false;
	const log2 = ITOA64.indexOf(x[1]!);
	const r = dec30(x[2]!);
	const p = dec30(x[3]!);
	const want = decode64(x[5]!);
	const salt = new TextEncoder().encode(x[4]!);
	if (log2 < 1 || r < 1 || p < 1 || !decode64(x[4]!) || !want) return false;
	const prm = { n: 2 ** log2, r, p };
	if (128 * prm.n * prm.r > PWHASH_MEMORY_CAP) return false;
	return same(scryptRun(want.length, pw, salt, prm), want);
});

// #endregion

// #region secretstream

const SS_STATE = 52;
const SS_ABYTES = 17;
const ssName = (s: string): string => `sodium_crypto_secretstream_xchacha20poly1305_${s}`;

/** ChaCha20-IETF keystream xor at a block counter, as `crypto_stream_chacha20_ietf_xor_ic` */
const ietfXor = (data: Uint8Array, nonce: Uint8Array, counter: number, key: Uint8Array) =>
	chacha20(key, nonce, data, undefined, counter);

function ssRekey(state: Uint8Array): void {
	const material = concat(state.subarray(0, 32), state.subarray(36, 44));
	const next = ietfXor(material, state.subarray(32, 44), 0, state.subarray(0, 32));
	state.set(next.subarray(0, 32), 0);
	state.set(next.subarray(32, 40), 36);
	state.set([1, 0, 0, 0], 32);
}

function ssIncrement(state: Uint8Array): boolean {
	for (let i = 32; i < 36; i++) {
		state[i] = (state[i]! + 1) & 0xff;
		if (state[i] !== 0) return false;
	}
	return true;
}

function ssMac(state: Uint8Array, ad: Uint8Array, block: Uint8Array, ct: Uint8Array): Uint8Array {
	const key = state.subarray(0, 32);
	const nonce = state.subarray(32, 44);
	const mac = poly1305.create(ietfXor(new Uint8Array(32), nonce, 0, key));
	const pad = (n: number) => new Uint8Array((16 - (n % 16)) % 16);
	mac.update(ad);
	mac.update(pad(ad.length));
	mac.update(block);
	mac.update(ct);
	// libsodium pads the body by its length mod 16, not by the complement
	mac.update(new Uint8Array(ct.length % 16));
	const lens = new Uint8Array(16);
	dataView(lens).setBigUint64(0, BigInt(ad.length), true);
	dataView(lens).setBigUint64(8, BigInt(64 + ct.length), true);
	mac.update(lens);
	return mac.digest();
}

const ssState = (fn: string, s: unknown, wrongLength: () => never): Uint8Array => {
	void fn;
	if (!(s instanceof Uint8Array) || s.length !== SS_STATE) wrongLength();
	return Uint8Array.from(s as Uint8Array);
};

def('crypto_secretstream_xchacha20poly1305_keygen', [], () => random(32));
def(
	'crypto_secretstream_xchacha20poly1305_init_push',
	['CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_KEYBYTES'],
	([key]) => {
		const header = random(24);
		const state = new Uint8Array(SS_STATE);
		const sub = new Uint32Array(8);
		hchachaInto(key, header.subarray(0, 16), sub);
		state.set(new Uint8Array(sub.buffer), 0);
		state.set([1, 0, 0, 0], 32);
		state.set(header.subarray(16, 24), 36);
		return [state, header];
	}
);

function hchachaInto(key: Uint8Array, input: Uint8Array, out: Uint32Array): void {
	hchacha(u32(new TextEncoder().encode('expand 32-byte k')), u32(key), u32(input), out);
}

def(
	'crypto_secretstream_xchacha20poly1305_init_pull',
	[
		'CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_HEADERBYTES',
		'CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_KEYBYTES'
	],
	([header, key]) => {
		const state = new Uint8Array(SS_STATE);
		const sub = new Uint32Array(8);
		hchachaInto(key, header.subarray(0, 16), sub);
		state.set(new Uint8Array(sub.buffer), 0);
		state.set([1, 0, 0, 0], 32);
		state.set(header.subarray(16, 24), 36);
		return state;
	}
);

def('crypto_secretstream_xchacha20poly1305_push', [], ([stateIn, m, ad, tag], c) => {
	const fn = ssName('push');
	if (tag < 0 || tag > 255) argError(fn, 3, 'must be in the range of 0-255');
	const state = ssState(fn, stateIn, () => argError(fn, 0, 'must have a correct length'));
	const nonce = state.subarray(32, 44);
	const block = new Uint8Array(64);
	block[0] = tag;
	const sealedBlock = ietfXor(block, nonce, 1, state.subarray(0, 32));
	const ct = ietfXor(m, nonce, 2, state.subarray(0, 32));
	const mac = ssMac(state, ad, sealedBlock, ct);
	for (let i = 0; i < 8; i++) state[36 + i]! ^= mac[i]!;
	const wrapped = ssIncrement(state);
	if ((tag & 2) !== 0 || wrapped) ssRekey(state);
	c.refs[0] = state;
	return concat(Uint8Array.of(sealedBlock[0]!), ct, mac);
});

def('crypto_secretstream_xchacha20poly1305_pull', [], ([stateIn, ct, ad], c) => {
	const state = ssState(ssName('pull'), stateIn, () => refuse('incorrect state length'));
	if (ct.length < SS_ABYTES) return false;
	const mlen = ct.length - SS_ABYTES;
	const nonce = state.subarray(32, 44);
	const key = state.subarray(0, 32);
	const block = new Uint8Array(64);
	block[0] = ct[0]!;
	const opened = ietfXor(block, nonce, 1, key);
	const tag = opened[0]!;
	const sealedBlock = Uint8Array.from(opened);
	sealedBlock[0] = ct[0]!;
	const body = ct.subarray(1, 1 + mlen);
	const mac = ssMac(state, ad, sealedBlock, body);
	if (!same(mac, ct.subarray(1 + mlen))) return false;
	const plain = ietfXor(body, nonce, 2, key);
	for (let i = 0; i < 8; i++) state[36 + i]! ^= mac[i]!;
	const wrapped = ssIncrement(state);
	if ((tag & 2) !== 0 || wrapped) ssRekey(state);
	c.refs[0] = state;
	return [plain, tag];
});

def('crypto_secretstream_xchacha20poly1305_rekey', [], ([stateIn], c) => {
	const state = ssState(ssName('rekey'), stateIn, () => refuse('incorrect state length'));
	ssRekey(state);
	c.refs[0] = state;
	return undefined;
});

// #endregion

// #region host entry

/** what the PHP half sends */
export type SodiumRequest = { f?: string; a?: unknown[] };

/** one tagged value: s string (base64), b bool, i int, n null, l list */
export type SodiumValue =
	{ s: string } | { b: boolean } | { i: number } | { n: 1 } | { l: SodiumValue[] };

/** what the host answers; `refs` carries the new value of a by-reference string argument */
export type SodiumReply =
	| { ok: true; r: SodiumValue; refs?: Record<number, string | null> }
	| { ok: false; c: 'SodiumException' | 'TypeError' | 'ValueError'; m: string };

function encodeValue(v: Value): SodiumValue {
	if (v instanceof Uint8Array) return { s: bytesToBase64(v) };
	if (typeof v === 'boolean') return { b: v };
	if (typeof v === 'number') return { i: v };
	if (Array.isArray(v)) return { l: v.map(encodeValue) };
	return { n: 1 };
}

/** the sodium functions this host backs, for the gate */
export const sodiumFunctions = (): string[] => [...registry.keys()];

/**
 * One call. Length checks run before the function, in argument order, with the message ext-sodium
 * gives; anything else a function refuses it refuses itself.
 *
 * @internal
 */
export function sodiumHostCall(req: SodiumRequest): SodiumReply {
	try {
		const name = String(req.f ?? '');
		const entry = registry.get(name);
		if (!entry) return { ok: false, c: 'SodiumException', m: `unknown function ${name}` };
		const params = SODIUM_API.functions.find((f) => f.name === name)!.params;
		const raw = req.a ?? [];
		const args = params.map((p, i) => {
			const v = raw[i];
			if (p.type === 'string') return typeof v === 'string' ? base64ToBytes(v) : v;
			return typeof v === 'string' ? Number(v) : v;
		});
		entry.v.forEach((constant, i) => {
			if (constant === undefined) return;
			const want = num(constant);
			if ((args[i] as Uint8Array).length !== want) {
				argError(name, i, `must be SODIUM_${constant} bytes long`);
			}
		});
		const ctx: Ctx = { refs: {}, raw };
		const out = entry.run(args, ctx);
		const refs: Record<number, string | null> | undefined = Object.keys(ctx.refs).length
			? Object.fromEntries(
					Object.entries(ctx.refs).map(([k, v]) => [Number(k), v && bytesToBase64(v)])
				)
			: undefined;
		return { ok: true, r: encodeValue(out), ...(refs ? { refs } : {}) };
	} catch (e) {
		if (e instanceof Refusal) return { ok: false, c: e.cls, m: e.message };
		return { ok: false, c: 'SodiumException', m: errorMessage(e) };
	}
}

/** installs the bridge on the PHP Module, masked because a hash can be a long JS frame */
export function installSodium(
	binary: Record<string, unknown>,
	withMask: <R>(fn: () => R) => R
): Record<string, unknown> {
	binary[SODIUM_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: SodiumRequest;
			try {
				req = JSON.parse(json) as SodiumRequest;
			} catch (e) {
				return JSON.stringify({
					ok: false,
					c: 'SodiumException',
					m: `unparseable request: ${errorMessage(e)}`
				});
			}
			return JSON.stringify(sodiumHostCall(req));
		});
	return binary;
}

// #endregion
