import { describe, expect, it } from 'vitest';
import { sodiumHostCall, type SodiumReply } from '../../../src/site/shims/sodium-lib';

/**
 * The six AEAD constructions as the host answers them.
 *
 * What a caller reads is the split between a failed tag (FALSE) and a bad argument (a throw): a
 * content-addressed store sweeps a frame on the first and must not on the second. Each is checked
 * for all six, and the RFC 8439 vector gives the IETF one an oracle that needs no PHP.
 */

const enc = (b: Uint8Array | string) => Buffer.from(b).toString('base64');
const bytes = (n: number, mul = 1, add = 0) =>
	Uint8Array.from({ length: n }, (_, i) => (i * mul + add) & 255);

const FAMILIES = [
	['aes256gcm', 32, 12, 16],
	['aegis128l', 16, 16, 32],
	['aegis256', 32, 32, 32],
	['chacha20poly1305', 32, 8, 16],
	['chacha20poly1305_ietf', 32, 12, 16],
	['xchacha20poly1305_ietf', 32, 24, 16]
] as const;

function seal(name: string, m: string, ad: string, nonce: Uint8Array, key: Uint8Array) {
	return sodiumHostCall({
		f: `sodium_crypto_aead_${name}_encrypt`,
		a: [enc(m), enc(ad), enc(nonce), enc(key)]
	});
}

function open(name: string, c: string, ad: string, nonce: Uint8Array, key: Uint8Array) {
	return sodiumHostCall({
		f: `sodium_crypto_aead_${name}_decrypt`,
		a: [c, enc(ad), enc(nonce), enc(key)]
	});
}

const text = (r: SodiumReply): string => {
	if (!r.ok || !('s' in r.r)) throw new Error(JSON.stringify(r));
	return r.r.s;
};

describe.each(FAMILIES)('%s', (name, keyLen, nonceLen, tagLen) => {
	const key = bytes(keyLen, 3, 1);
	const nonce = bytes(nonceLen, 5, 2);

	it('round trips a frame with associated data and adds exactly the tag', () => {
		const sealed = text(seal(name, 'a frame', 'header', nonce, key));
		expect(Buffer.from(sealed, 'base64').length).toBe(7 + tagLen);
		const opened = open(name, sealed, 'header', nonce, key);
		expect(Buffer.from(text(opened), 'base64').toString()).toBe('a frame');
	});

	it('answers FALSE for a flipped byte, the wrong key and the wrong data', () => {
		const sealed = Buffer.from(text(seal(name, 'secret', 'a', nonce, key)), 'base64');
		const flipped = Uint8Array.from(sealed);
		flipped[0]! ^= 0xff;
		const wrong = [
			open(name, enc(flipped), 'a', nonce, key),
			open(name, enc(sealed), 'a', nonce, bytes(keyLen, 7, 9)),
			open(name, enc(sealed), 'b', nonce, key)
		];
		for (const r of wrong) expect(r).toMatchObject({ ok: true, r: { b: false } });
	});

	it('answers FALSE for a frame shorter than the tag rather than crashing', () => {
		expect(open(name, enc(bytes(tagLen - 1)), '', nonce, key)).toMatchObject({
			ok: true,
			r: { b: false }
		});
	});

	it('THROWS for a mis-sized key or nonce, which must not sweep a store', () => {
		const shortKey = open(name, enc(bytes(40)), '', nonce, bytes(keyLen - 1));
		const shortNonce = open(name, enc(bytes(40)), '', bytes(nonceLen - 1), key);
		expect(shortKey).toMatchObject({ ok: false, c: 'SodiumException' });
		expect(shortNonce).toMatchObject({ ok: false, c: 'SodiumException' });
		expect(shortKey.ok === false && shortKey.m).toContain('KEYBYTES');
		expect(shortNonce.ok === false && shortNonce.m).toContain('NPUBBYTES');
	});

	it('changes the ciphertext with the associated data', () => {
		expect(text(seal(name, 'same', 'a', nonce, key))).not.toBe(
			text(seal(name, 'same', 'b', nonce, key))
		);
	});
});

describe('the IETF ChaCha20-Poly1305 against RFC 8439 section 2.8.2', () => {
	it('reproduces the published tag and ciphertext head', () => {
		const key = bytes(32, 1, 0x80);
		const nonce = Uint8Array.from([
			0x07, 0, 0, 0, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47
		]);
		const ad = Uint8Array.from([
			0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7
		]);
		const pt =
			"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
		const r = sodiumHostCall({
			f: 'sodium_crypto_aead_chacha20poly1305_ietf_encrypt',
			a: [enc(pt), enc(ad), enc(nonce), enc(key)]
		});
		const out = Buffer.from(text(r), 'base64').toString('hex');
		expect(out.startsWith('d31a8d34648e60db7b86afbc53ef7ec2')).toBe(true);
		expect(out.endsWith('1ae10b594f09e26a7e902ecbd0600691')).toBe(true);
	});
});
