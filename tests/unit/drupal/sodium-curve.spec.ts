import { describe, expect, it } from 'vitest';
import {
	ed25519FromSeed,
	ed25519PublicToCurve,
	ed25519SecretToCurve,
	ed25519Sign,
	ed25519Verify,
	ristrettoAdd,
	ristrettoIsValid,
	ristrettoMul,
	scalar,
	scalarReduce,
	x25519Base,
	x25519Shared
} from '../../../src/site/shims/sodium-curve';

/**
 * Known answers from the RFCs, checked without the sodium gate. The gate compares against native
 * libsodium, which proves agreement; these prove the arithmetic is the RFC's own.
 */

const hex = (s: string) => Uint8Array.from((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('RFC 8032 section 7.1 (Ed25519)', () => {
	const vectors = [
		{
			seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
			pub: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
			msg: '',
			sig:
				'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555' +
				'fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'
		},
		{
			seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
			pub: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
			msg: '72',
			sig:
				'92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996' +
				'e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'
		}
	];

	it.each(vectors)('derives the public key and signs as the RFC says', (v) => {
		const { secret, pub } = ed25519FromSeed(hex(v.seed));
		expect(toHex(pub)).toBe(v.pub);
		const sig = ed25519Sign(hex(v.msg), secret);
		expect(toHex(sig)).toBe(v.sig);
		expect(ed25519Verify(sig, hex(v.msg), pub)).toBe(true);
	});

	it('refuses a signature with a flipped bit and a non-canonical S', () => {
		const v = vectors[1]!;
		const pub = hex(v.pub);
		const sig = hex(v.sig);
		const flipped = Uint8Array.from(sig);
		flipped[40]! ^= 1;
		expect(ed25519Verify(flipped, hex(v.msg), pub)).toBe(false);
		const bigS = Uint8Array.from(sig);
		bigS.set(hex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010'), 32);
		expect(ed25519Verify(bigS, hex(v.msg), pub)).toBe(false);
	});

	it('refuses the identity as a public key and as R, whatever the rest says', () => {
		const identity = hex('01' + '00'.repeat(31));
		const sig = hex(vectors[0]!.sig);
		expect(ed25519Verify(sig, new Uint8Array(0), identity)).toBe(false);
		const rOnly = Uint8Array.from(sig);
		rOnly.set(identity, 0);
		expect(ed25519Verify(rOnly, new Uint8Array(0), hex(vectors[0]!.pub))).toBe(false);
	});

	it('maps the public key and secret key to Curve25519 as the X25519 base point does', () => {
		const v = vectors[0]!;
		const { secret, pub } = ed25519FromSeed(hex(v.seed));
		const curvePub = ed25519PublicToCurve(pub);
		expect(curvePub).toBeDefined();
		expect(toHex(curvePub!)).toBe(toHex(x25519Base(ed25519SecretToCurve(secret))));
	});
});

describe('RFC 7748 section 5.2 and 6.1 (X25519)', () => {
	it('computes the two scalar multiplications of section 5.2', () => {
		expect(
			toHex(
				x25519Shared(
					hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
					hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
				)!
			)
		).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
		expect(
			toHex(
				x25519Shared(
					hex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'),
					hex('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493')
				)!
			)
		).toBe('95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957');
	});

	it('agrees on the section 6.1 Diffie-Hellman exchange from both sides', () => {
		const alice = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
		const bob = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
		expect(toHex(x25519Base(alice))).toBe(
			'8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'
		);
		expect(toHex(x25519Base(bob))).toBe(
			'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'
		);
		const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
		expect(toHex(x25519Shared(alice, x25519Base(bob))!)).toBe(shared);
		expect(toHex(x25519Shared(bob, x25519Base(alice))!)).toBe(shared);
	});

	it('refuses the low-order u values section 6 names', () => {
		const zero = new Uint8Array(32);
		const one = new Uint8Array(32);
		one[0] = 1;
		expect(
			x25519Shared(
				hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
				zero
			)
		).toBeUndefined();
		expect(
			x25519Shared(
				hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'),
				one
			)
		).toBeUndefined();
	});
});

describe('RFC 9496 (ristretto255)', () => {
	const multiples = [
		'0000000000000000000000000000000000000000000000000000000000000000',
		'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76',
		'6a493210f7499cd17fecb510ae0cea23a110e8d5b901f8acadd3095c73a3b919',
		'94741f5d5d52755ece4f23f044ee27d5d1ea1e2bd196b462166b16152a9d0259',
		'da80862773358b466ffadfe0b3293ab3d9fd53c5ea6c955358f568322daf6a57'
	];

	it('multiplies the basepoint to the encodings of section A.1', () => {
		for (let n = 1; n < multiples.length; n++) {
			const k = new Uint8Array(32);
			k[0] = n;
			expect(toHex(ristrettoMul(k)!), `${n}B`).toBe(multiples[n]);
		}
	});

	it('adds the first multiples to the next one', () => {
		expect(toHex(ristrettoAdd(hex(multiples[1]!), hex(multiples[1]!))!)).toBe(multiples[2]);
		expect(toHex(ristrettoAdd(hex(multiples[2]!), hex(multiples[1]!))!)).toBe(multiples[3]);
	});

	it('rejects the encodings section 4.3.1 excludes', () => {
		// s = 1 is negative, so it is not a canonical encoding
		expect(ristrettoIsValid(hex('01' + '00'.repeat(31)))).toBe(false);
		// the 32-byte field maximum is not below p
		expect(ristrettoIsValid(hex('ff'.repeat(31) + '7f'))).toBe(false);
		expect(ristrettoIsValid(hex(multiples[1]!))).toBe(true);
	});

	it('reduces a 64-byte scalar and maps the group order to zero', () => {
		const order = hex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
		expect(toHex(scalarReduce(order))).toBe('00'.repeat(32));
		expect(scalar.invert(new Uint8Array(32))).toBeUndefined();
	});
});
