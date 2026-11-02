import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { chacha20, xchacha20 } from '@noble/ciphers/chacha.js';
import { blake2b } from 'blakejs';
import { createHash, createHmac, scryptSync } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { SODIUM_API } from '../../../src/site/generated/sodium-api';
import {
	PHP_ONLY_FUNCTIONS,
	SODIUM_FIX,
	sodiumConstantsPhp
} from '../../../src/site/shims/sodium-fix';
import {
	installSodium,
	PWHASH_MEMORY_CAP,
	SODIUM_BRIDGE,
	sodiumFunctions,
	sodiumHostCall,
	type SodiumReply,
	type SodiumValue
} from '../../../src/site/shims/sodium-lib';

/**
 * The host half of the sodium bridge and the text of the PHP half.
 *
 * Every function is compared with native libsodium by `tests/node/sodium-conformance.spec.ts`; the
 * published vectors below give this file an oracle of its own, so a machine with no PHP still
 * fails if the bridge stops computing BLAKE2b.
 */

const enc = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const hexOf = (b64: string) => Buffer.from(b64, 'base64').toString('hex');

function call(f: string, ...a: unknown[]): SodiumReply {
	return sodiumHostCall({ f, a });
}

function str(r: SodiumReply): string {
	if (!r.ok) throw new Error(r.m);
	if (!('s' in r.r)) throw new Error('not a string');
	return r.r.s;
}

/** published BLAKE2b digests; the 512-bit one is RFC 7693 Appendix A */
const VECTORS = [
	{
		msg: 'abc',
		len: 64,
		hex:
			'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
			'7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
	},
	{
		msg: 'abc',
		len: 32,
		hex: 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319'
	},
	{
		msg: '',
		len: 32,
		hex: '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8'
	}
];

describe('generichash is BLAKE2b', () => {
	it.each(VECTORS)('blake2b-$len of "$msg"', ({ msg, len, hex }) => {
		expect(hexOf(str(call('sodium_crypto_generichash', enc(msg), '', String(len))))).toBe(hex);
	});

	it('gives a different digest at a different length, because outlen is in the parameter block', () => {
		const a = hexOf(str(call('sodium_crypto_generichash', enc('abc'), '', '64')));
		const b = hexOf(str(call('sodium_crypto_generichash', enc('abc'), '', '32')));
		expect(a.slice(0, 64)).not.toBe(b);
	});

	it('digests bytes that are not valid UTF-8, which is why the bridge is base64', () => {
		const raw = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x00]);
		const key = enc(Buffer.alloc(32, 0x6b));
		const plain = str(call('sodium_crypto_generichash', enc(raw), '', '32'));
		expect(plain).not.toBe(str(call('sodium_crypto_generichash', enc(raw), key, '32')));
	});
});

describe('the incremental state is a value, not a handle', () => {
	const init = () => str(call('sodium_crypto_generichash_init', '', '32'));

	function update(state: string, part: string): string {
		const r = call('sodium_crypto_generichash_update', state, enc(part));
		if (!r.ok) throw new Error(r.m);
		return String(r.refs?.[0]);
	}

	it('chunked agrees with the one-shot, which is what Hash::ofStream() relies on', () => {
		let state = init();
		for (const part of ['a', 'b', 'c']) state = update(state, part);
		const fin = call('sodium_crypto_generichash_final', state, '32');
		expect(hexOf(str(fin))).toBe(VECTORS[1]!.hex);
		expect(fin.ok && fin.refs?.[0]).toBeNull();
	});

	it('is 384 bytes, as ext-sodium reports', () => {
		expect(Buffer.from(init(), 'base64').length).toBe(384);
	});

	it('lets two copies of one state go on separately, which a handle table could not', () => {
		const base = update(init(), 'ab');
		const left = update(base, 'c');
		const right = update(base, 'z');
		const a = hexOf(str(call('sodium_crypto_generichash_final', left, '32')));
		const b = hexOf(str(call('sodium_crypto_generichash_final', right, '32')));
		expect(a).toBe(VECTORS[1]!.hex);
		expect(b).toBe(hexOf(str(call('sodium_crypto_generichash', enc('abz'), '', '32'))));
	});

	it('holds no context between calls, so there is nothing to leak or to cap', () => {
		for (let i = 0; i < 200; i++) init();
		expect(hexOf(str(call('sodium_crypto_generichash_final', init(), '32')))).toBe(
			VECTORS[2]!.hex
		);
	});

	it('finishes at a length other than the init length the way libsodium does', () => {
		// libsodium keeps the init length in the parameter block and copies the chaining value out
		const state = init();
		const short = hexOf(str(call('sodium_crypto_generichash_final', state, '16')));
		expect(short).toBe(VECTORS[2]!.hex.slice(0, 32));
	});

	it.each([enc(new Uint8Array(10)), enc(new Uint8Array(383))])(
		'refuses a state that is not one',
		(s) => {
			expect(call('sodium_crypto_generichash_update', s, enc('x'))).toEqual({
				ok: false,
				c: 'SodiumException',
				m: 'incorrect state length'
			});
		}
	);
});

describe('the bridge refuses what ext-sodium refuses', () => {
	it.each([0, 1, 15, 65, 128])('an output length of %s', (len) => {
		expect(call('sodium_crypto_generichash', enc('x'), '', String(len))).toEqual({
			ok: false,
			c: 'SodiumException',
			m: 'unsupported output length'
		});
	});

	it.each([1, 15, 65])('a key of %s bytes', (n) => {
		expect(call('sodium_crypto_generichash', enc('x'), enc(Buffer.alloc(n, 1)), '32')).toEqual({
			ok: false,
			c: 'SodiumException',
			m: 'unsupported key length'
		});
	});

	it('treats an empty key as unkeyed rather than as sixteen zero bytes', () => {
		expect(hexOf(str(call('sodium_crypto_generichash', enc('abc'), '', '32')))).toBe(
			VECTORS[1]!.hex
		);
	});

	it('names an unknown function instead of guessing one', () => {
		expect(call('sodium_nothing')).toEqual({
			ok: false,
			c: 'SodiumException',
			m: 'unknown function sodium_nothing'
		});
	});

	it('words a wrong length the way ext-sodium does, with the constant name', () => {
		expect(call('sodium_crypto_secretbox', enc('m'), enc('n'), enc(Buffer.alloc(32)))).toEqual({
			ok: false,
			c: 'SodiumException',
			m: 'sodium_crypto_secretbox(): Argument #2 ($nonce) must be SODIUM_CRYPTO_SECRETBOX_NONCEBYTES bytes long'
		});
	});

	it('refuses a password hash past the memory cap the way libsodium refuses an allocation', () => {
		const m = PWHASH_MEMORY_CAP / 1024 + 1;
		expect(
			call(
				'sodium_crypto_pwhash',
				'32',
				enc('pw'),
				enc(Buffer.alloc(16)),
				'1',
				String(m * 1024),
				'2'
			)
		).toEqual({ ok: false, c: 'SodiumException', m: 'internal error' });
	});
});

describe('every function of the inventory has a host or a PHP half', () => {
	it('backs all 110 functions, 11 of them in PHP alone', () => {
		const names = SODIUM_API.functions.map((f) => f.name);
		expect(names.length).toBe(110);
		const host = new Set(sodiumFunctions());
		expect(names.filter((n) => !host.has(n) && !PHP_ONLY_FUNCTIONS.has(n))).toEqual([]);
		expect(PHP_ONLY_FUNCTIONS.size).toBe(11);
	});
});

describe('installing it on a PHP module', () => {
	it('hangs the bridge on the key the PHP half resolves', () => {
		const binary: Record<string, unknown> = {};
		installSodium(binary, (fn) => fn());
		expect(typeof binary[SODIUM_BRIDGE]).toBe('function');
		expect(SODIUM_FIX).toContain(`vrzno_env('${SODIUM_BRIDGE}')`);
	});

	it('runs inside the mask, because a hash is a long synchronous frame under the PHP stack', () => {
		let masked = 0;
		const binary: Record<string, unknown> = {};
		installSodium(binary, (fn) => {
			masked++;
			return fn();
		});
		const run = binary[SODIUM_BRIDGE] as (json: string) => string;
		run(JSON.stringify({ f: 'sodium_crypto_generichash', a: [enc('abc'), '', '32'] }));
		expect(masked).toBe(1);
	});

	it('answers rather than throwing on a request that is not JSON', () => {
		const binary: Record<string, unknown> = {};
		installSodium(binary, (fn) => fn());
		const out = JSON.parse((binary[SODIUM_BRIDGE] as (json: string) => string)('not json'));
		expect(out.ok).toBe(false);
		expect(String(out.m)).toContain('unparseable request');
	});
});

// #region helpers for the function groups

const CONST = SODIUM_API.constants as Record<string, number | string>;
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const seq = (n: number, mul = 1, add = 0) =>
	Uint8Array.from({ length: n }, (_, i) => (i * mul + add) & 255);
const raw = (r: SodiumReply) => Uint8Array.from(Buffer.from(str(r), 'base64'));
const hexOfReply = (r: SodiumReply) => Buffer.from(raw(r)).toString('hex');
const flag = (r: SodiumReply): boolean => {
	if (!r.ok || !('b' in r.r)) throw new Error(JSON.stringify(r));
	return r.r.b;
};
const refused = (r: SodiumReply): string => {
	if (r.ok) throw new Error('expected a refusal');
	return r.m;
};
const listOf = (r: SodiumReply): SodiumValue[] => {
	if (!r.ok || !('l' in r.r)) throw new Error(JSON.stringify(r));
	return r.r.l;
};
const sOf = (v: SodiumValue | undefined): Uint8Array => {
	if (!v || !('s' in v)) throw new Error('not a string');
	return Uint8Array.from(Buffer.from(v.s, 'base64'));
};
const refState = (r: SodiumReply): string => {
	if (!r.ok || r.refs?.[0] == null) throw new Error('no state came back');
	return r.refs[0];
};

// #endregion

// #region keygens and the small primitives

describe('keygens return fresh keys of the documented size', () => {
	it.each([
		['sodium_crypto_generichash_keygen', 32],
		['sodium_crypto_secretbox_keygen', 32],
		['sodium_crypto_stream_keygen', 32],
		['sodium_crypto_stream_xchacha20_keygen', 32],
		['sodium_crypto_auth_keygen', 32],
		['sodium_crypto_shorthash_keygen', 16],
		['sodium_crypto_kdf_keygen', 32],
		['sodium_crypto_secretstream_xchacha20poly1305_keygen', 32],
		['sodium_crypto_aead_aes256gcm_keygen', 32],
		['sodium_crypto_aead_aegis128l_keygen', 16],
		['sodium_crypto_aead_aegis256_keygen', 32],
		['sodium_crypto_aead_chacha20poly1305_keygen', 32],
		['sodium_crypto_aead_chacha20poly1305_ietf_keygen', 32],
		['sodium_crypto_aead_xchacha20poly1305_ietf_keygen', 32],
		['sodium_crypto_box_keypair', 64],
		['sodium_crypto_kx_keypair', 64],
		['sodium_crypto_sign_keypair', 96]
	] as const)('%s gives %i bytes, different each call', (fn, size) => {
		const a = raw(call(fn));
		expect(a.length).toBe(size);
		expect(Buffer.from(a).equals(Buffer.from(raw(call(fn))))).toBe(false);
	});

	it('says AES-256-GCM is available, since the host has it in software', () => {
		expect(flag(call('sodium_crypto_aead_aes256gcm_is_available'))).toBe(true);
	});
});

describe('secretbox and the XSalsa20 stream', () => {
	const key = seq(32, 3, 1);
	const nonce = seq(24, 5, 2);

	it('xors a message with the keystream, which is what crypto_stream_xor means', () => {
		const m = seq(100, 7, 3);
		const ks = raw(call('sodium_crypto_stream', 100, enc(nonce), enc(key)));
		const out = raw(call('sodium_crypto_stream_xor', enc(m), enc(nonce), enc(key)));
		expect(ks.length).toBe(100);
		expect(Array.from(out)).toEqual(Array.from(m, (x, i) => x ^ ks[i]!));
	});

	it('lays a secretbox out as the tag, then the message xored past the first 32 keystream bytes', () => {
		const m = seq(50, 11, 5);
		const sealed = raw(call('sodium_crypto_secretbox', enc(m), enc(nonce), enc(key)));
		const ks = raw(call('sodium_crypto_stream', 32 + 50, enc(nonce), enc(key)));
		expect(sealed.length).toBe(16 + 50);
		expect(Array.from(sealed.subarray(16))).toEqual(Array.from(m, (x, i) => x ^ ks[32 + i]!));
	});

	it('opens what it sealed and answers FALSE for a flipped byte, a short frame and a wrong key', () => {
		const sealed = raw(call('sodium_crypto_secretbox', enc('hello'), enc(nonce), enc(key)));
		const open = (c: Uint8Array, k = key) =>
			call('sodium_crypto_secretbox_open', enc(c), enc(nonce), enc(k));
		expect(Buffer.from(raw(open(sealed))).toString()).toBe('hello');
		const flipped = Uint8Array.from(sealed);
		flipped[20]! ^= 1;
		expect(flag(open(flipped))).toBe(false);
		expect(flag(open(sealed.subarray(0, 15)))).toBe(false);
		expect(flag(open(sealed, seq(32, 9, 9)))).toBe(false);
	});

	it.each(['sodium_crypto_stream', 'sodium_crypto_stream_xchacha20'])(
		'%s refuses a length of zero',
		(fn) => {
			expect(refused(call(fn, 0, enc(nonce), enc(key)))).toContain('must be greater than 0');
		}
	);
});

describe('XChaCha20 against draft-irtf-cfrg-xchacha appendix A.3.1', () => {
	const key = seq(32, 1, 0x80);
	const nonce = seq(24, 1, 0x40);
	const ad = hexBytes('50515253c0c1c2c3c4c5c6c7');
	const pt =
		"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";

	it('reproduces the published ciphertext head and tag through the AEAD', () => {
		const sealed = hexOfReply(
			call(
				'sodium_crypto_aead_xchacha20poly1305_ietf_encrypt',
				enc(pt),
				enc(ad),
				enc(nonce),
				enc(key)
			)
		);
		expect(sealed.startsWith('bd6d179d3e83d43b9576579493c0e939')).toBe(true);
		expect(sealed.endsWith('c0875924c1c7987947deafd8780acf49')).toBe(true);
	});

	it('gives the AEAD body from the stream at block counter 1', () => {
		const sealed = raw(
			call(
				'sodium_crypto_aead_xchacha20poly1305_ietf_encrypt',
				enc(pt),
				enc(ad),
				enc(nonce),
				enc(key)
			)
		);
		const body = raw(
			call('sodium_crypto_stream_xchacha20_xor_ic', enc(pt), enc(nonce), 1, enc(key))
		);
		expect(Array.from(body)).toEqual(Array.from(sealed.subarray(0, pt.length)));
	});

	it('is the same keystream at counter 0 as crypto_stream_xchacha20', () => {
		const zeros = new Uint8Array(70);
		const ks = raw(call('sodium_crypto_stream_xchacha20', 70, enc(nonce), enc(key)));
		const xored = raw(
			call('sodium_crypto_stream_xchacha20_xor', enc(zeros), enc(nonce), enc(key))
		);
		expect(Array.from(xored)).toEqual(Array.from(ks));
		expect(Array.from(ks.subarray(0, 64))).toEqual(
			Array.from(xchacha20(key, nonce, new Uint8Array(64)))
		);
	});

	it('carries the block counter past 32 bits, which noble cannot and libsodium does', () => {
		const ic = 0xfffffffe;
		const out = raw(
			call(
				'sodium_crypto_stream_xchacha20_xor_ic',
				enc(new Uint8Array(150)),
				enc(nonce),
				ic,
				enc(key)
			)
		);
		const nobleBlock = xchacha20(key, nonce, new Uint8Array(64), undefined, ic);
		const wrapped = xchacha20(key, nonce, new Uint8Array(22), undefined, 0);
		expect(out.length).toBe(150);
		expect(Array.from(out.subarray(0, 64))).toEqual(Array.from(nobleBlock));
		expect(Array.from(out.subarray(128))).not.toEqual(Array.from(wrapped));
		const oneBlock = (at: number, len: number) =>
			raw(
				call(
					'sodium_crypto_stream_xchacha20_xor_ic',
					enc(new Uint8Array(len)),
					enc(nonce),
					at,
					enc(key)
				)
			);
		expect(Array.from(out.subarray(64, 128))).toEqual(Array.from(oneBlock(0xffffffff, 64)));
		expect(Array.from(out.subarray(128))).toEqual(Array.from(oneBlock(2 ** 32, 22)));
		const back = raw(
			call('sodium_crypto_stream_xchacha20_xor_ic', enc(out), enc(nonce), ic, enc(key))
		);
		expect(Array.from(back)).toEqual(new Array(150).fill(0));
	});

	it('words a short key as the counter argument, the way php-src does', () => {
		const m = refused(
			call('sodium_crypto_stream_xchacha20_xor_ic', enc('x'), enc(nonce), 0, enc(seq(31)))
		);
		expect(m).toContain('Argument #3');
		expect(m).toContain('KEYBYTES bytes long');
	});
});

describe('crypto_auth is HMAC-SHA-512 cut to 32 bytes', () => {
	const key = seq(32, 3, 9);
	const msg = Buffer.from('the message to authenticate');

	it('matches node:crypto HMAC-SHA-512 truncated to 256 bits', () => {
		const want = Uint8Array.from(
			createHmac('sha512', key).update(msg).digest().subarray(0, 32)
		);
		expect(hexOfReply(call('sodium_crypto_auth', enc(msg), enc(key)))).toBe(
			Buffer.from(want).toString('hex')
		);
	});

	it('verifies its own mac and refuses a flipped one, another message and another key', () => {
		const mac = raw(call('sodium_crypto_auth', enc(msg), enc(key)));
		const check = (m: Uint8Array, k: Uint8Array, a: Uint8Array) =>
			flag(call('sodium_crypto_auth_verify', enc(a), enc(m), enc(k)));
		expect(check(msg, key, mac)).toBe(true);
		const flipped = Uint8Array.from(mac);
		flipped[31]! ^= 1;
		expect(check(msg, key, flipped)).toBe(false);
		expect(check(Buffer.from('other'), key, mac)).toBe(false);
		expect(check(msg, seq(32), mac)).toBe(false);
	});

	it('THROWS for a mac of the wrong length rather than answering FALSE', () => {
		const m = refused(call('sodium_crypto_auth_verify', enc(seq(31)), enc(msg), enc(key)));
		expect(m).toContain('CRYPTO_AUTH_BYTES');
	});
});

describe('shorthash is SipHash-2-4', () => {
	const key = enc(seq(16));

	it.each([
		// the reference implementation's vectors.h, key 00..0f and messages 00.., first entries
		['', '310e0edd47db6f72'],
		['00', 'fd67dc93c539f874'],
		// the SipHash paper's worked example, 15 bytes
		['000102030405060708090a0b0c0d0e', 'e545be4961ca29a1']
	])('hashes %j to %s', (msgHex, want) => {
		expect(hexOfReply(call('sodium_crypto_shorthash', enc(hexBytes(msgHex)), key))).toBe(want);
	});

	it('hashes a message of whole 8-byte words through the main loop alone', () => {
		const a = hexOfReply(call('sodium_crypto_shorthash', enc(seq(16)), key));
		const b = hexOfReply(call('sodium_crypto_shorthash', enc(seq(17)), key));
		expect(a).toHaveLength(16);
		expect(a).not.toBe(b);
	});
});

describe('crypto_kdf_derive_from_key', () => {
	const key = enc(seq(32, 1, 7));
	const ctx = enc('KDFTests');
	const derive = (len: number, id: number, k = key, c = ctx) =>
		call('sodium_crypto_kdf_derive_from_key', len, id, c, k);

	it('is deterministic and splits on the length, the subkey id, the context and the key', () => {
		const base = hexOfReply(derive(32, 1));
		expect(hexOfReply(derive(32, 1))).toBe(base);
		expect(base).toHaveLength(64);
		expect(hexOfReply(derive(32, 2))).not.toBe(base);
		expect(hexOfReply(derive(32, 1, key, enc('KDFTestz')))).not.toBe(base);
		expect(hexOfReply(derive(32, 1, enc(seq(32, 1, 8))))).not.toBe(base);
		expect(hexOfReply(derive(16, 1))).toHaveLength(32);
		expect(hexOfReply(derive(16, 1))).not.toBe(base.slice(0, 32));
	});

	it('refuses a length outside 16..64 and a negative subkey id with ext-sodium wording', () => {
		expect(refused(derive(15, 1))).toContain(
			'greater than or equal to SODIUM_CRYPTO_KDF_BYTES_MIN'
		);
		expect(refused(derive(65, 1))).toContain(
			'less than or equal to SODIUM_CRYPTO_KDF_BYTES_MAX'
		);
		expect(refused(derive(32, -1))).toContain('greater than or equal to 0');
	});
});

// #endregion

// #region box, kx and sign

describe('X25519 and crypto_box against RFC 7748 section 6.1 and the NaCl box vector', () => {
	const aliceSk = hexBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
	const alicePk = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
	const bobSk = hexBytes('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
	const bobPk = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
	const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

	it('derives both public keys and the shared secret', () => {
		expect(hexOfReply(call('sodium_crypto_scalarmult_base', enc(aliceSk)))).toBe(alicePk);
		expect(hexOfReply(call('sodium_crypto_box_publickey_from_secretkey', enc(bobSk)))).toBe(
			bobPk
		);
		expect(
			hexOfReply(call('sodium_crypto_scalarmult', enc(aliceSk), enc(hexBytes(bobPk))))
		).toBe(shared);
		expect(
			hexOfReply(call('sodium_crypto_scalarmult', enc(bobSk), enc(hexBytes(alicePk))))
		).toBe(shared);
	});

	it('refuses an all-zero shared secret, which a low-order point produces', () => {
		expect(
			refused(call('sodium_crypto_scalarmult', enc(aliceSk), enc(new Uint8Array(32))))
		).toBe('internal error');
	});

	it('splits and joins a keypair', () => {
		const kp = raw(
			call(
				'sodium_crypto_box_keypair_from_secretkey_and_publickey',
				enc(aliceSk),
				enc(hexBytes(alicePk))
			)
		);
		expect(Buffer.from(kp).toString('hex')).toBe(
			Buffer.from(aliceSk).toString('hex') + alicePk
		);
		expect(hexOfReply(call('sodium_crypto_box_publickey', enc(kp)))).toBe(alicePk);
		expect(hexOfReply(call('sodium_crypto_box_secretkey', enc(kp)))).toBe(
			Buffer.from(aliceSk).toString('hex')
		);
	});

	it('seeds a keypair from the first 32 bytes of the SHA-512 of the seed, as node:crypto hashes it', () => {
		const seed = seq(32, 5, 1);
		const kp = raw(call('sodium_crypto_box_seed_keypair', enc(seed)));
		const sk = createHash('sha512').update(seed).digest().subarray(0, 32);
		expect(Buffer.from(kp.subarray(0, 32)).equals(sk)).toBe(true);
		expect(hexOfReply(call('sodium_crypto_scalarmult_base', enc(sk)))).toBe(
			Buffer.from(kp.subarray(32)).toString('hex')
		);
	});

	it('reproduces the NaCl box test vector for Alice to Bob', () => {
		const nonce = hexBytes('69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37');
		const message = hexBytes(
			'be075fc53c81f2d5cf141316ebeb0c7b5228c52a4c62cbd44b66849b64244ffc' +
				'e5ecbaaf33bd751a1ac728d45e6c61296cdc3c01233561f41db66cce314adb31' +
				'0e3be8250c46f06dceea3a7fa1348057e2f6556ad6b1318a024a838f21af1fde' +
				'048977eb48f59ffd4924ca1c60902e52f0a089bc76897040e082f93776384864' +
				'5e0705'
		);
		const cipher =
			'f3ffc7703f9400e52a7dfb4b3d3305d98e993b9f48681273c29650ba32fc76ce' +
			'48332ea7164d96a4476fb8c531a1186ac0dfc17c98dce87b4da7f011ec48c972' +
			'71d2c20f9b928fe2270d6fb863d51738b48eeee314a7cc8ab932164548e526ae' +
			'90224368517acfeabd6bb3732bc0e9da99832b61ca01b6de56244a9e88d5f9b3' +
			'7973f622a43d14a6599b1f654cb45a74e355a5';
		const aliceKp = raw(
			call(
				'sodium_crypto_box_keypair_from_secretkey_and_publickey',
				enc(aliceSk),
				enc(hexBytes(bobPk))
			)
		);
		const bobKp = raw(
			call(
				'sodium_crypto_box_keypair_from_secretkey_and_publickey',
				enc(bobSk),
				enc(hexBytes(alicePk))
			)
		);
		const sealed = raw(call('sodium_crypto_box', enc(message), enc(nonce), enc(aliceKp)));
		expect(Buffer.from(sealed).toString('hex')).toBe(cipher);
		const opened = call('sodium_crypto_box_open', enc(sealed), enc(nonce), enc(bobKp));
		expect(Buffer.from(raw(opened)).equals(Buffer.from(message))).toBe(true);
	});

	it('answers FALSE for a flipped byte, a short frame and the wrong keypair', () => {
		const nonce = seq(24);
		const a = raw(call('sodium_crypto_box_keypair'));
		const b = raw(call('sodium_crypto_box_keypair'));
		const toB = raw(
			call(
				'sodium_crypto_box_keypair_from_secretkey_and_publickey',
				enc(a.subarray(0, 32)),
				enc(b.subarray(32))
			)
		);
		const sealed = raw(call('sodium_crypto_box', enc('hi'), enc(nonce), enc(toB)));
		const open = (c: Uint8Array, kp: Uint8Array) =>
			call('sodium_crypto_box_open', enc(c), enc(nonce), enc(kp));
		const flipped = Uint8Array.from(sealed);
		flipped[17]! ^= 1;
		expect(flag(open(flipped, b))).toBe(false);
		expect(flag(open(sealed.subarray(0, 10), b))).toBe(false);
		expect(flag(open(sealed, a))).toBe(false);
	});

	it('seals to a public key and opens with the keypair, in sealed boxes of 48 bytes of overhead', () => {
		const kp = raw(call('sodium_crypto_box_keypair'));
		const sealed = raw(call('sodium_crypto_box_seal', enc('anonymous'), enc(kp.subarray(32))));
		expect(sealed.length).toBe(9 + 48);
		const open = (c: Uint8Array, k: Uint8Array) =>
			call('sodium_crypto_box_seal_open', enc(c), enc(k));
		expect(Buffer.from(raw(open(sealed, kp))).toString()).toBe('anonymous');
		const flipped = Uint8Array.from(sealed);
		flipped[40]! ^= 1;
		expect(flag(open(flipped, kp))).toBe(false);
		expect(flag(open(sealed.subarray(0, 47), kp))).toBe(false);
		expect(flag(open(sealed, raw(call('sodium_crypto_box_keypair'))))).toBe(false);
	});
});

describe('crypto_kx', () => {
	const client = raw(call('sodium_crypto_kx_seed_keypair', enc(seq(32, 1, 1))));
	const server = raw(call('sodium_crypto_kx_seed_keypair', enc(seq(32, 1, 2))));

	it('derives a keypair from a seed deterministically and splits it', () => {
		expect(client.length).toBe(64);
		const again = raw(call('sodium_crypto_kx_seed_keypair', enc(seq(32, 1, 1))));
		expect(Buffer.from(again).equals(Buffer.from(client))).toBe(true);
		expect(hexOfReply(call('sodium_crypto_kx_publickey', enc(client)))).toBe(
			Buffer.from(client.subarray(32)).toString('hex')
		);
		expect(hexOfReply(call('sodium_crypto_kx_secretkey', enc(client)))).toBe(
			Buffer.from(client.subarray(0, 32)).toString('hex')
		);
		expect(hexOfReply(call('sodium_crypto_scalarmult_base', enc(client.subarray(0, 32))))).toBe(
			Buffer.from(client.subarray(32)).toString('hex')
		);
	});

	it('gives the two sides mirrored keys, each the BLAKE2b-512 split blakejs computes', () => {
		const c = listOf(
			call('sodium_crypto_kx_client_session_keys', enc(client), enc(server.subarray(32)))
		);
		const s = listOf(
			call('sodium_crypto_kx_server_session_keys', enc(server), enc(client.subarray(32)))
		);
		expect(Buffer.from(sOf(c[0])).equals(Buffer.from(sOf(s[1])))).toBe(true);
		expect(Buffer.from(sOf(c[1])).equals(Buffer.from(sOf(s[0])))).toBe(true);
		const q = raw(
			call('sodium_crypto_scalarmult', enc(client.subarray(0, 32)), enc(server.subarray(32)))
		);
		const h = blake2b(
			Uint8Array.from([...q, ...client.subarray(32), ...server.subarray(32)]),
			undefined,
			64
		);
		expect(Buffer.from(sOf(c[0])).equals(h.subarray(0, 32))).toBe(true);
		expect(Buffer.from(sOf(c[1])).equals(h.subarray(32))).toBe(true);
	});
});

describe('Ed25519 signatures through the bridge, RFC 8032 section 7.1', () => {
	const seed = hexBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
	const pub = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
	const sig =
		'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555' +
		'fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
	const kp = raw(call('sodium_crypto_sign_seed_keypair', enc(seed)));
	const sk = kp.subarray(0, 64);

	it('derives the published public key and lays the keypair out as secret then public', () => {
		expect(Buffer.from(kp.subarray(64)).toString('hex')).toBe(pub);
		expect(Buffer.from(sk.subarray(0, 32)).equals(Buffer.from(seed))).toBe(true);
		expect(hexOfReply(call('sodium_crypto_sign_publickey', enc(kp)))).toBe(pub);
		expect(hexOfReply(call('sodium_crypto_sign_secretkey', enc(kp)))).toBe(
			Buffer.from(sk).toString('hex')
		);
		expect(hexOfReply(call('sodium_crypto_sign_publickey_from_secretkey', enc(sk)))).toBe(pub);
		const joined = call(
			'sodium_crypto_sign_keypair_from_secretkey_and_publickey',
			enc(sk),
			enc(hexBytes(pub))
		);
		expect(Buffer.from(raw(joined)).equals(Buffer.from(kp))).toBe(true);
	});

	it('signs the empty message to the published signature, detached and combined', () => {
		expect(hexOfReply(call('sodium_crypto_sign_detached', '', enc(sk)))).toBe(sig);
		expect(hexOfReply(call('sodium_crypto_sign', '', enc(sk)))).toBe(sig);
	});

	it('verifies a signature and refuses a flipped one, another message and another key', () => {
		const m = Buffer.from('a message to sign');
		const s = raw(call('sodium_crypto_sign_detached', enc(m), enc(sk)));
		const verify = (sg: Uint8Array, msg: Uint8Array, pk: Uint8Array) =>
			flag(call('sodium_crypto_sign_verify_detached', enc(sg), enc(msg), enc(pk)));
		expect(verify(s, m, kp.subarray(64))).toBe(true);
		const flipped = Uint8Array.from(s);
		flipped[3]! ^= 1;
		expect(verify(flipped, m, kp.subarray(64))).toBe(false);
		expect(verify(s, Buffer.from('another'), kp.subarray(64))).toBe(false);
		expect(verify(s, m, raw(call('sodium_crypto_sign_keypair')).subarray(64))).toBe(false);
		expect(
			refused(
				call(
					'sodium_crypto_sign_verify_detached',
					enc(seq(63)),
					enc(m),
					enc(kp.subarray(64))
				)
			)
		).toContain('CRYPTO_SIGN_BYTES');
	});

	it('opens a combined message and answers FALSE for a tampered or short one', () => {
		const sm = raw(call('sodium_crypto_sign', enc('payload'), enc(sk)));
		const open = (x: Uint8Array) =>
			call('sodium_crypto_sign_open', enc(x), enc(kp.subarray(64)));
		expect(sm.length).toBe(64 + 7);
		expect(Buffer.from(raw(open(sm))).toString()).toBe('payload');
		const tampered = Uint8Array.from(sm);
		tampered[70]! ^= 1;
		expect(flag(open(tampered))).toBe(false);
		expect(flag(open(sm.subarray(0, 63)))).toBe(false);
	});

	it('converts to Curve25519 as the clamped SHA-512 of the seed, and refuses a bad public key', () => {
		const h = createHash('sha512').update(seed).digest().subarray(0, 32);
		const clamped = Uint8Array.from(h);
		clamped[0]! &= 248;
		clamped[31]! &= 127;
		clamped[31]! |= 64;
		const curveSk = raw(call('sodium_crypto_sign_ed25519_sk_to_curve25519', enc(sk)));
		expect(Buffer.from(curveSk).equals(Buffer.from(clamped))).toBe(true);
		const curvePk = hexOfReply(
			call('sodium_crypto_sign_ed25519_pk_to_curve25519', enc(hexBytes(pub)))
		);
		expect(curvePk).toBe(hexOfReply(call('sodium_crypto_scalarmult_base', enc(curveSk))));
		const identity = hexBytes('01' + '00'.repeat(31));
		expect(refused(call('sodium_crypto_sign_ed25519_pk_to_curve25519', enc(identity)))).toBe(
			'conversion failed'
		);
	});
});

// #endregion

// #region ristretto255 and its scalars

describe('ristretto255 through the bridge', () => {
	const L = 2n ** 252n + 27742317777372353535851937790883648493n;
	const toLe = (v: bigint) =>
		Uint8Array.from(Buffer.from(v.toString(16).padStart(64, '0'), 'hex').reverse());
	const fromLe = (b: Uint8Array) => BigInt('0x' + Buffer.from(b).reverse().toString('hex'));
	const pow = (b: bigint, e: bigint): bigint => {
		let out = 1n;
		let base = b % L;
		for (let x = e; x > 0n; x >>= 1n) {
			if (x & 1n) out = (out * base) % L;
			base = (base * base) % L;
		}
		return out;
	};
	const x = fromLe(seq(32, 7, 3)) % L;
	const y = fromLe(seq(32, 11, 5)) % L;
	const sc = (fn: string, ...v: bigint[]) => fromLe(raw(call(fn, ...v.map((n) => enc(toLe(n))))));
	const multiples = [
		'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76',
		'6a493210f7499cd17fecb510ae0cea23a110e8d5b901f8acadd3095c73a3b919',
		'94741f5d5d52755ece4f23f044ee27d5d1ea1e2bd196b462166b16152a9d0259'
	];
	const point = (h: string) => enc(hexBytes(h));

	it('adds, subtracts and negates scalars modulo the group order', () => {
		const p = 'sodium_crypto_core_ristretto255_scalar_';
		expect(sc(`${p}add`, x, y)).toBe((x + y) % L);
		expect(sc(`${p}sub`, x, y)).toBe((x - y + L) % L);
		expect(sc(`${p}mul`, x, y)).toBe((x * y) % L);
		expect(sc(`${p}negate`, x)).toBe((L - x) % L);
		expect(sc(`${p}complement`, x)).toBe((1n - x + L) % L);
	});

	it('inverts a scalar and refuses to invert zero', () => {
		const inv = sc('sodium_crypto_core_ristretto255_scalar_invert', x);
		expect(inv).toBe(pow(x, L - 2n));
		expect((inv * x) % L).toBe(1n);
		expect(
			refused(call('sodium_crypto_core_ristretto255_scalar_invert', enc(new Uint8Array(32))))
		).toBe('internal error');
	});

	it('reduces 64 bytes modulo the group order and draws a random scalar below it', () => {
		const wide = seq(64, 13, 1);
		const want = BigInt('0x' + Buffer.from(wide).reverse().toString('hex')) % L;
		const reduced = raw(call('sodium_crypto_core_ristretto255_scalar_reduce', enc(wide)));
		expect(fromLe(reduced)).toBe(want);
		const a = raw(call('sodium_crypto_core_ristretto255_scalar_random'));
		expect(a.length).toBe(32);
		expect(fromLe(a)).toBeLessThan(L);
		expect(
			Buffer.from(raw(call('sodium_crypto_core_ristretto255_scalar_random'))).equals(
				Buffer.from(a)
			)
		).toBe(false);
	});

	it('multiplies the base point to the RFC 9496 A.1 encodings', () => {
		for (const n of [1, 2, 3]) {
			const got = call('sodium_crypto_scalarmult_ristretto255_base', enc(toLe(BigInt(n))));
			expect(hexOfReply(got), `${n}B`).toBe(multiples[n - 1]);
		}
		const two = call(
			'sodium_crypto_scalarmult_ristretto255',
			enc(toLe(2n)),
			point(multiples[0]!)
		);
		expect(hexOfReply(two)).toBe(multiples[1]);
	});

	it('refuses the identity as a product and a zero base-point scalar', () => {
		expect(
			refused(
				call(
					'sodium_crypto_scalarmult_ristretto255',
					enc(new Uint8Array(32)),
					point(multiples[0]!)
				)
			)
		).toBe('Result is identity element');
		expect(
			refused(call('sodium_crypto_scalarmult_ristretto255_base', enc(new Uint8Array(32))))
		).toContain('must not be zero');
	});

	it('adds and subtracts points, and refuses an invalid encoding', () => {
		const add = call(
			'sodium_crypto_core_ristretto255_add',
			point(multiples[0]!),
			point(multiples[1]!)
		);
		expect(hexOfReply(add)).toBe(multiples[2]);
		const sub = call(
			'sodium_crypto_core_ristretto255_sub',
			point(multiples[2]!),
			point(multiples[0]!)
		);
		expect(hexOfReply(sub)).toBe(multiples[1]);
		const bad = enc(hexBytes('ff'.repeat(31) + '7f'));
		expect(
			refused(call('sodium_crypto_core_ristretto255_add', bad, point(multiples[0]!)))
		).toBe('internal error');
		expect(
			refused(call('sodium_crypto_core_ristretto255_sub', point(multiples[0]!), bad))
		).toBe('internal error');
	});

	it('maps a 64-byte hash to a valid point, and a random point is valid too', () => {
		const h = enc(seq(64, 3, 1));
		const p = raw(call('sodium_crypto_core_ristretto255_from_hash', h));
		expect(raw(call('sodium_crypto_core_ristretto255_from_hash', h))).toEqual(p);
		expect(flag(call('sodium_crypto_core_ristretto255_is_valid_point', enc(p)))).toBe(true);
		const r = raw(call('sodium_crypto_core_ristretto255_random'));
		expect(flag(call('sodium_crypto_core_ristretto255_is_valid_point', enc(r)))).toBe(true);
		expect(
			flag(
				call(
					'sodium_crypto_core_ristretto255_is_valid_point',
					enc(hexBytes('01' + '00'.repeat(31)))
				)
			)
		).toBe(false);
	});
});

// #endregion

// #region password hashing

describe('argon2 password hashing at the smallest parameters', () => {
	const ARGON2I = Number(CONST.SODIUM_CRYPTO_PWHASH_ALG_ARGON2I13);
	const ARGON2ID = Number(CONST.SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13);
	const salt = enc(seq(16, 3, 1));
	const pw = enc('correct horse');
	const MEM = 8192;
	const hash = (len: number, algo: number, ops: number) =>
		call('sodium_crypto_pwhash', len, pw, salt, ops, MEM, algo);

	it('derives a key by argon2id the same way a second call does, and differs by every input', () => {
		const a = hexOfReply(hash(32, ARGON2ID, 1));
		expect(hexOfReply(hash(32, ARGON2ID, 1))).toBe(a);
		expect(a).toHaveLength(64);
		expect(hexOfReply(hash(32, ARGON2ID, 2))).not.toBe(a);
		expect(hexOfReply(hash(24, ARGON2ID, 1))).toHaveLength(48);
		expect(
			hexOfReply(call('sodium_crypto_pwhash', 32, enc('other'), salt, 1, MEM, ARGON2ID))
		).not.toBe(a);
	});

	it('uses argon2i for the other algorithm, which differs from argon2id on the same inputs', () => {
		const i = hexOfReply(hash(32, ARGON2I, 3));
		expect(i).toHaveLength(64);
		expect(i).not.toBe(hexOfReply(hash(32, ARGON2ID, 3)));
	});

	it('refuses what ext-sodium refuses, with its wording', () => {
		expect(refused(hash(0, ARGON2ID, 1))).toContain('Argument #1');
		expect(refused(hash(32, ARGON2ID, 0))).toContain('Argument #4');
		expect(refused(call('sodium_crypto_pwhash', 32, pw, salt, 1, 0, ARGON2ID))).toContain(
			'Argument #5'
		);
		expect(refused(hash(32, 99, 1))).toBe('unsupported password hashing algorithm');
		expect(refused(hash(8, ARGON2ID, 1))).toBe('internal error');
		expect(refused(call('sodium_crypto_pwhash', 32, pw, salt, 1, 4096, ARGON2ID))).toBe(
			'internal error'
		);
		expect(refused(hash(32, ARGON2I, 2))).toBe('internal error');
	});

	it('writes an argon2id string that verifies, and refuses another password', () => {
		const str1 = Buffer.from(raw(call('sodium_crypto_pwhash_str', pw, 1, MEM))).toString(
			'latin1'
		);
		expect(str1).toMatch(
			/^\$argon2id\$v=19\$m=8,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/
		);
		const verify = (h: string, p: string) =>
			flag(call('sodium_crypto_pwhash_str_verify', enc(h), enc(p)));
		expect(verify(str1, 'correct horse')).toBe(true);
		expect(verify(str1, 'wrong horse')).toBe(false);
	});

	it('refuses the cost it cannot honour when it writes a string', () => {
		expect(refused(call('sodium_crypto_pwhash_str', pw, 0, MEM))).toContain('Argument #2');
		expect(refused(call('sodium_crypto_pwhash_str', pw, 1, 0))).toContain('Argument #3');
		expect(refused(call('sodium_crypto_pwhash_str', pw, 1, 4096))).toBe('internal error');
	});

	it('verifies an argon2i string built from the same derivation', () => {
		const out = raw(hash(32, ARGON2I, 3));
		const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/=+$/, '');
		const s = `$argon2i$v=19$m=8,t=3,p=1$${b64(seq(16, 3, 1))}$${b64(out)}`;
		expect(flag(call('sodium_crypto_pwhash_str_verify', enc(s), pw))).toBe(true);
		expect(flag(call('sodium_crypto_pwhash_str_verify', enc(s), enc('nope')))).toBe(false);
	});

	it.each([
		['text that is not a hash', 'not a hash'],
		['a salt of a length base64 cannot have', '$argon2id$v=19$m=8,t=1,p=1$AAAAA$AAAAAAAAAAAA'],
		[
			'a pass count of zero',
			'$argon2id$v=19$m=8,t=0,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA'
		],
		[
			'a memory cost under 8 KiB',
			'$argon2id$v=19$m=4,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA'
		],
		[
			'a memory cost over the cap',
			'$argon2id$v=19$m=999999,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA'
		],
		[
			'work over the cap',
			'$argon2id$v=19$m=8,t=40000,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA'
		],
		['a salt the algorithm rejects', '$argon2id$v=19$m=8,t=1,p=1$AAAA$AAAAAAAAAAAAAAAAAAAAAA']
	])('answers FALSE for %s', (_name, s) => {
		expect(flag(call('sodium_crypto_pwhash_str_verify', enc(s), pw))).toBe(false);
	});

	it('asks for a rehash on other parameters, another algorithm and a malformed string', () => {
		const s = Buffer.from(raw(call('sodium_crypto_pwhash_str', pw, 1, MEM))).toString('latin1');
		const need = (h: string, ops: number, mem: number) =>
			flag(call('sodium_crypto_pwhash_str_needs_rehash', enc(h), ops, mem));
		expect(need(s, 1, MEM)).toBe(false);
		expect(need(s, 2, MEM)).toBe(true);
		expect(need(s, 1, 16384)).toBe(true);
		expect(
			need('$argon2i$v=19$m=8,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA', 3, MEM)
		).toBe(true);
		expect(need('garbage', 1, MEM)).toBe(true);
	});
});

describe('scrypt password hashing at the interactive limits', () => {
	const OPS = Number(CONST.SODIUM_CRYPTO_PWHASH_SCRYPTSALSA208SHA256_OPSLIMIT_INTERACTIVE);
	const MEM = Number(CONST.SODIUM_CRYPTO_PWHASH_SCRYPTSALSA208SHA256_MEMLIMIT_INTERACTIVE);
	const salt = seq(32, 3, 1);
	const fn = 'sodium_crypto_pwhash_scryptsalsa208sha256';

	it('derives what node:crypto scrypt derives at N=16384, r=8, p=1', () => {
		const want = Buffer.from(scryptSync('pw', salt, 32, { N: 16384, r: 8, p: 1 })).toString(
			'hex'
		);
		expect(hexOfReply(call(fn, 32, enc('pw'), enc(salt), OPS, MEM))).toBe(want);
	});

	it('picks the same N when the memory limit is far above the work limit', () => {
		const want = Buffer.from(scryptSync('pw', salt, 20, { N: 16384, r: 8, p: 1 })).toString(
			'hex'
		);
		expect(hexOfReply(call(fn, 20, enc('pw'), enc(salt), OPS, MEM * 2))).toBe(want);
	});

	it('refuses what ext-sodium refuses, with its wording', () => {
		expect(refused(call(fn, 0, enc('pw'), enc(salt), OPS, MEM))).toContain('Argument #1');
		expect(refused(call(fn, 32, enc('pw'), enc(salt), 0, MEM))).toContain('Argument #4');
		expect(refused(call(fn, 32, enc('pw'), enc(salt), OPS, 0))).toContain('Argument #5');
		expect(refused(call(fn, 32, enc('pw'), enc(salt), OPS - 1, MEM))).toContain(`${OPS}`);
		expect(refused(call(fn, 32, enc('pw'), enc(salt), OPS, MEM - 1))).toContain(`${MEM}`);
		expect(refused(call(fn, 8, enc('pw'), enc(salt), OPS, MEM))).toBe('internal error');
	});

	describe('a written $7$ string', () => {
		let s = '';
		beforeAll(() => {
			s = Buffer.from(raw(call(`${fn}_str`, enc('pw'), OPS, MEM))).toString('latin1');
		});
		const verify = (h: string, p: string) => flag(call(`${fn}_str_verify`, enc(h), enc(p)));

		it('carries N, r, p, a salt and a hash in the $7$ layout', () => {
			expect(s).toMatch(/^\$7\$C[./0-9A-Za-z]{10}[./0-9A-Za-z]{43}\$[./0-9A-Za-z]+$/);
		});

		it('verifies with the password it was written for', () => {
			expect(verify(s, 'pw')).toBe(true);
		});

		it('refuses another password', () => {
			expect(verify(s, 'pX')).toBe(false);
		});

		it('refuses an N whose memory is past the cap before computing anything', () => {
			const itoa = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
			expect(verify(s.slice(0, 3) + itoa[24] + s.slice(4), 'pw')).toBe(false);
		});
	});

	it('refuses the cost it cannot honour when it writes a string', () => {
		expect(refused(call(`${fn}_str`, enc('pw'), 0, MEM))).toContain('Argument #2');
		expect(refused(call(`${fn}_str`, enc('pw'), OPS, 0))).toContain('Argument #3');
		expect(refused(call(`${fn}_str`, enc('pw'), OPS - 1, MEM))).toContain(`${OPS}`);
		expect(refused(call(`${fn}_str`, enc('pw'), OPS, MEM - 1))).toContain(`${MEM}`);
	});

	it.each([
		['text that is not a hash', 'not a hash'],
		['a zero log2 of N', '$7$.0000000000ABCDEFGH$ABCDEFGH'],
		['a zero r', '$7$C..............ABCDEFGH$ABCDEFGH']
	])('answers FALSE for %s', (_name, s) => {
		expect(flag(call(`${fn}_str_verify`, enc(s), enc('pw')))).toBe(false);
	});
});

// #endregion

// #region secretstream

describe('secretstream_xchacha20poly1305', () => {
	const P = 'sodium_crypto_secretstream_xchacha20poly1305_';
	const TAG = { message: 0, push: 1, rekey: 2, final: 3 };
	const key = enc(seq(32, 3, 1));

	function begin() {
		const pair = listOf(call(`${P}init_push`, key));
		const header = sOf(pair[1]);
		const push = sOf(pair[0]);
		const pull = raw(call(`${P}init_pull`, enc(header), key));
		return { header, push, pull };
	}

	const push = (state: Uint8Array, m: string, ad = '', tag = TAG.message) => {
		const r = call(`${P}push`, enc(state), enc(m), enc(ad), tag);
		return { frame: raw(r), state: Uint8Array.from(Buffer.from(refState(r), 'base64')) };
	};

	const pull = (state: Uint8Array, frame: Uint8Array, ad = '') => {
		const r = call(`${P}pull`, enc(state), enc(frame), enc(ad));
		if (!r.ok || !('l' in r.r)) return { ok: false as const, reply: r };
		const [plain, tag] = r.r.l;
		return {
			ok: true as const,
			plain: Buffer.from(sOf(plain)).toString(),
			tag: tag && 'i' in tag ? tag.i : -1,
			state: Uint8Array.from(Buffer.from(refState(r), 'base64'))
		};
	};

	it('authenticates with the Poly1305 construction libsodium lays out, including its odd body pad', () => {
		const s = begin();
		const ad = 'twenty-one bytes of ad';
		const m = 'seventeen bytes!!';
		const { frame } = push(s.push, m, ad, TAG.message);
		const k = s.push.subarray(0, 32);
		const nonce = s.push.subarray(32, 44);
		const block = new Uint8Array(64);
		block[0] = TAG.message;
		const sealedBlock = chacha20(k, nonce, block, undefined, 1);
		const body = frame.subarray(1, 1 + m.length);
		const lens = new Uint8Array(16);
		const dv = new DataView(lens.buffer);
		dv.setBigUint64(0, BigInt(ad.length), true);
		dv.setBigUint64(8, BigInt(64 + m.length), true);
		const mac = poly1305.create(chacha20(k, nonce, new Uint8Array(32), undefined, 0));
		const adBytes = Buffer.from(ad);
		mac.update(adBytes);
		mac.update(new Uint8Array((16 - (adBytes.length % 16)) % 16));
		mac.update(sealedBlock);
		mac.update(body);
		mac.update(new Uint8Array(m.length % 16));
		mac.update(lens);
		expect(Buffer.from(frame.subarray(1 + m.length)).equals(Buffer.from(mac.digest()))).toBe(
			true
		);
		expect(frame[0]).toBe(sealedBlock[0]);
	});

	it('keys the stream with HChaCha20 of the header as draft-irtf-cfrg-xchacha 2.2.1 gives it', () => {
		const hchachaKey = enc(seq(32));
		const input = hexBytes('000000090000004a0000000031415927');
		const header = Uint8Array.from([...input, 1, 2, 3, 4, 5, 6, 7, 8]);
		const state = raw(call(`${P}init_pull`, enc(header), hchachaKey));
		expect(state.length).toBe(52);
		expect(Buffer.from(state.subarray(0, 32)).toString('hex')).toBe(
			'82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc'
		);
		expect(Array.from(state.subarray(32, 36))).toEqual([1, 0, 0, 0]);
		expect(Array.from(state.subarray(36, 44))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it('gives a 24 byte header and a 52 byte state on the push side that match the pull side', () => {
		const s = begin();
		expect(s.header.length).toBe(24);
		expect(Buffer.from(s.push).equals(Buffer.from(s.pull))).toBe(true);
	});

	it('round trips a run of messages with every tag and keeps both states in step', () => {
		const s = begin();
		let tx = s.push;
		let rx = s.pull;
		for (const [m, ad, tag] of [
			['first', 'a', TAG.message],
			['second', '', TAG.push],
			['third', 'some longer associated data', TAG.rekey],
			[
				'a message long enough to cross a block boundary of the keystream, sixty-four bytes+',
				'',
				TAG.message
			],
			['last', 'z', TAG.final]
		] as const) {
			const sent = push(tx, m, ad, tag);
			expect(sent.frame.length).toBe(Buffer.byteLength(m) + 17);
			const got = pull(rx, sent.frame, ad);
			expect(got).toMatchObject({ ok: true, plain: m, tag });
			tx = sent.state;
			rx = got.ok ? got.state : rx;
			expect(Buffer.from(tx).equals(Buffer.from(rx))).toBe(true);
		}
	});

	it('answers FALSE for a flipped byte, other associated data, a short frame and a replayed frame', () => {
		const s = begin();
		const one = push(s.push, 'one', 'ad');
		const two = push(one.state, 'two', 'ad');
		const flipped = Uint8Array.from(one.frame);
		flipped[5]! ^= 1;
		expect(pull(s.pull, flipped, 'ad').ok).toBe(false);
		expect(pull(s.pull, one.frame, 'other').ok).toBe(false);
		expect(pull(s.pull, one.frame.subarray(0, 16), 'ad').ok).toBe(false);
		expect(pull(s.pull, two.frame, 'ad').ok).toBe(false);
		const okOne = pull(s.pull, one.frame, 'ad');
		expect(okOne.ok).toBe(true);
		expect(okOne.ok && pull(okOne.state, one.frame, 'ad').ok).toBe(false);
	});

	it('rekeys a state to a new key, and a frame only opens once both sides have rekeyed', () => {
		const s = begin();
		const one = push(s.push, 'one');
		const rx = pull(s.pull, one.frame);
		const viaCall = call(`${P}rekey`, enc(one.state));
		expect(viaCall).toMatchObject({ ok: true, r: { n: 1 } });
		const txKeyed = Uint8Array.from(Buffer.from(refState(viaCall), 'base64'));
		expect(
			Buffer.from(txKeyed.subarray(0, 32)).equals(Buffer.from(one.state.subarray(0, 32)))
		).toBe(false);
		expect(Array.from(txKeyed.subarray(32, 36))).toEqual([1, 0, 0, 0]);
		const two = push(txKeyed, 'two');
		const rxState = rx.ok ? rx.state : s.pull;
		expect(pull(rxState, two.frame).ok).toBe(false);
		const rxKeyed = Uint8Array.from(
			Buffer.from(refState(call(`${P}rekey`, enc(rxState))), 'base64')
		);
		expect(pull(rxKeyed, two.frame)).toMatchObject({ ok: true, plain: 'two' });
	});

	it('rekeys when the 32-bit message counter wraps, on both sides', () => {
		const s = begin();
		const edge = (st: Uint8Array) => {
			const out = Uint8Array.from(st);
			out.set([0xff, 0xff, 0xff, 0xff], 32);
			return out;
		};
		const sent = push(edge(s.push), 'wrap');
		const got = pull(edge(s.pull), sent.frame);
		expect(got).toMatchObject({ ok: true, plain: 'wrap' });
		expect(Array.from(sent.state.subarray(32, 36))).toEqual([1, 0, 0, 0]);
		const next = push(sent.state, 'after');
		expect(pull(got.ok ? got.state : s.pull, next.frame)).toMatchObject({
			ok: true,
			plain: 'after'
		});
	});

	it('refuses a tag outside 0-255 and a state of the wrong length', () => {
		const s = begin();
		expect(refused(call(`${P}push`, enc(s.push), enc('m'), '', 256))).toContain('0-255');
		expect(refused(call(`${P}push`, enc(seq(10)), enc('m'), '', 0))).toContain(
			'correct length'
		);
		expect(refused(call(`${P}pull`, enc(seq(10)), enc(seq(40)), ''))).toBe(
			'incorrect state length'
		);
		expect(refused(call(`${P}rekey`, enc(seq(10))))).toBe('incorrect state length');
	});
});

// #endregion

// #region the host entry

describe('the host entry on requests ext-sodium would never send', () => {
	it('turns an unexpected error into a SodiumException reply instead of throwing', () => {
		const r = call('sodium_crypto_auth');
		expect(r).toMatchObject({ ok: false, c: 'SodiumException' });
		expect(refused(r).length).toBeGreaterThan(0);
	});

	it('encodes an integer result, which is how a stream tag comes back', () => {
		const s = listOf(
			call('sodium_crypto_secretstream_xchacha20poly1305_init_push', enc(seq(32)))
		);
		expect(s.length).toBe(2);
	});
});

// #endregion

describe('the PHP fragment', () => {
	it.each(SODIUM_API.functions.map((f) => f.name))('declares %s()', (fn) => {
		expect(SODIUM_FIX).toContain(`function ${fn}(`);
	});

	it('defines every constant, which is a fatal Error in PHP 8 when absent', () => {
		const lines = sodiumConstantsPhp().split('\n');
		expect(lines.length).toBe(Object.keys(SODIUM_API.constants).length);
		for (const name of Object.keys(SODIUM_API.constants)) {
			expect(SODIUM_FIX).toContain(`define('${name}'`);
		}
	});

	it('takes the state by reference on every function that mutates it', () => {
		// a by-value parameter would make every chunk after the first digest nothing, silently
		expect(SODIUM_FIX).toContain('function sodium_crypto_generichash_update(&$state,');
		expect(SODIUM_FIX).toContain('function sodium_crypto_generichash_final(&$state,');
		expect(SODIUM_FIX).toContain(
			'function sodium_crypto_secretstream_xchacha20poly1305_push(&$state,'
		);
	});

	it('marks key material sensitive, so a stack trace does not print it', () => {
		expect(SODIUM_FIX).toContain(
			'function sodium_crypto_secretbox(#[\\SensitiveParameter] $message, $nonce, #[\\SensitiveParameter] $key)'
		);
	});

	it('declares SodiumException, because every one of these throws rather than returning FALSE', () => {
		expect(SODIUM_FIX).toContain('class SodiumException extends Exception');
	});

	it('guards on its own flag, never on the answer the extension table gives', () => {
		expect(SODIUM_FIX).not.toContain("extension_loaded('sodium')");
		expect(SODIUM_FIX).toContain("!function_exists('cfw_sodium_installed')");
		expect(SODIUM_FIX).toContain("function_exists('vrzno_env')");
	});

	it('declares each wrapper only where the name is free', () => {
		expect(SODIUM_FIX).toContain("if (!function_exists('sodium_crypto_auth'))");
	});

	it('never declares a stub extension, which is what segfaulted the mbstring attempt', () => {
		expect(SODIUM_FIX).not.toContain('get_loaded_extensions');
	});
});
