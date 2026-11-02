/**
 * AEGIS-128L and AEGIS-256 with the 256-bit tag libsodium uses, over plain byte arrays.
 *
 * Neither is in `@noble/ciphers`, so the AES round is written out here: one `AESENC` is
 * SubBytes, ShiftRows, MixColumns and a key XOR. The constants and the update schedule follow the
 * CFRG AEGIS draft; the gate checks them against native libsodium.
 *
 * @module
 */

const SBOX = (() => {
	const box = new Uint8Array(256);
	let p = 1;
	let q = 1;
	do {
		p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
		q ^= q << 1;
		q ^= q << 2;
		q ^= q << 4;
		q &= 0xff;
		if (q & 0x80) q ^= 0x09;
		const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5));
		box[p] = (x ^ ((q << 4) | (q >> 4)) ^ 0x63) & 0xff;
	} while (p !== 1);
	box[0] = 0x63;
	return box;
})();

const xtime = (a: number): number => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

type Block = Uint8Array;

/** one AES round of `input` keyed with `roundKey`, as the AESENC instruction */
function aesRound(input: Block, roundKey: Block): Block {
	const s = new Uint8Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) s[c * 4 + r] = SBOX[input[((c + r) % 4) * 4 + r]!]!;
	}
	const out = new Uint8Array(16);
	for (let c = 0; c < 4; c++) {
		const a0 = s[c * 4]!;
		const a1 = s[c * 4 + 1]!;
		const a2 = s[c * 4 + 2]!;
		const a3 = s[c * 4 + 3]!;
		out[c * 4] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3 ^ roundKey[c * 4]!;
		out[c * 4 + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3 ^ roundKey[c * 4 + 1]!;
		out[c * 4 + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3) ^ roundKey[c * 4 + 2]!;
		out[c * 4 + 3] = xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3) ^ roundKey[c * 4 + 3]!;
	}
	return out;
}

const xor = (a: Block, b: Block): Block => {
	const out = new Uint8Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
	return out;
};

const and = (a: Block, b: Block): Block => {
	const out = new Uint8Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i]! & b[i]!;
	return out;
};

const C0 = Uint8Array.of(
	0x00,
	0x01,
	0x01,
	0x02,
	0x03,
	0x05,
	0x08,
	0x0d,
	0x15,
	0x22,
	0x37,
	0x59,
	0x90,
	0xe9,
	0x79,
	0x62
);
const C1 = Uint8Array.of(
	0xdb,
	0x3d,
	0x18,
	0x55,
	0x6d,
	0xc2,
	0x2f,
	0xf1,
	0x20,
	0x11,
	0x31,
	0x42,
	0x73,
	0xb5,
	0x28,
	0xdd
);

/** the two block sizes the variants work in */
type Variant = {
	/** state blocks */
	n: number;
	/** bytes absorbed or encrypted per update */
	rate: number;
	init: (key: Uint8Array, nonce: Uint8Array) => Block[];
	update: (s: Block[], m: Uint8Array) => Block[];
	keystream: (s: Block[]) => Uint8Array;
	/** index of the block the length block is mixed into */
	lenBlock: number;
	tag: (s: Block[]) => Uint8Array;
};

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const L128: Variant = {
	n: 8,
	rate: 32,
	init(key, nonce) {
		const kn = xor(key, nonce);
		let s = [kn, C1, C0, C1, kn, xor(key, C0), xor(key, C1), xor(key, C0)];
		for (let i = 0; i < 10; i++) s = L128.update(s, concat(nonce, key));
		return s;
	},
	update(s, m) {
		const m0 = m.subarray(0, 16);
		const m1 = m.subarray(16, 32);
		return [
			aesRound(s[7]!, xor(s[0]!, m0)),
			aesRound(s[0]!, s[1]!),
			aesRound(s[1]!, s[2]!),
			aesRound(s[2]!, s[3]!),
			aesRound(s[3]!, xor(s[4]!, m1)),
			aesRound(s[4]!, s[5]!),
			aesRound(s[5]!, s[6]!),
			aesRound(s[6]!, s[7]!)
		];
	},
	keystream(s) {
		return concat(
			xor(xor(s[1]!, s[6]!), and(s[2]!, s[3]!)),
			xor(xor(s[2]!, s[5]!), and(s[6]!, s[7]!))
		);
	},
	lenBlock: 2,
	tag: (s) =>
		concat(xor(xor(s[0]!, s[1]!), xor(s[2]!, s[3]!)), xor(xor(s[4]!, s[5]!), xor(s[6]!, s[7]!)))
};

const L256: Variant = {
	n: 6,
	rate: 16,
	init(key, nonce) {
		const k0 = key.subarray(0, 16);
		const k1 = key.subarray(16, 32);
		const n0 = nonce.subarray(0, 16);
		const n1 = nonce.subarray(16, 32);
		let s = [xor(k0, n0), xor(k1, n1), C1, C0, xor(k0, C0), xor(k1, C1)];
		for (let i = 0; i < 4; i++) {
			s = L256.update(s, k0);
			s = L256.update(s, k1);
			s = L256.update(s, xor(k0, n0));
			s = L256.update(s, xor(k1, n1));
		}
		return s;
	},
	update(s, m) {
		return [
			aesRound(s[5]!, xor(s[0]!, m)),
			aesRound(s[0]!, s[1]!),
			aesRound(s[1]!, s[2]!),
			aesRound(s[2]!, s[3]!),
			aesRound(s[3]!, s[4]!),
			aesRound(s[4]!, s[5]!)
		];
	},
	keystream: (s) => xor(xor(s[1]!, s[4]!), xor(s[5]!, and(s[2]!, s[3]!))),
	lenBlock: 3,
	tag: (s) => concat(xor(xor(s[0]!, s[1]!), s[2]!), xor(xor(s[3]!, s[4]!), s[5]!))
};

const le64 = (n: number): Uint8Array => {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(n) * 8n, true);
	return out;
};

function padTo(data: Uint8Array, size: number): Uint8Array {
	const out = new Uint8Array(Math.ceil(data.length / size) * size);
	out.set(data);
	return out;
}

/** runs a variant over `data`; `decrypt` flips which side feeds the state */
function run(
	v: Variant,
	key: Uint8Array,
	nonce: Uint8Array,
	ad: Uint8Array,
	data: Uint8Array,
	decrypt: boolean
): { out: Uint8Array; tag: Uint8Array } {
	let s = v.init(key, nonce);
	const adPad = padTo(ad, v.rate);
	for (let i = 0; i < adPad.length; i += v.rate) s = v.update(s, adPad.subarray(i, i + v.rate));
	const out = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i += v.rate) {
		const z = v.keystream(s);
		const chunk = padTo(data.subarray(i, Math.min(i + v.rate, data.length)), v.rate);
		const res = xor(chunk, z);
		const n = Math.min(v.rate, data.length - i);
		out.set(res.subarray(0, n), i);
		let plain = decrypt ? res : chunk;
		if (decrypt && n < v.rate) plain = padTo(res.subarray(0, n), v.rate);
		s = v.update(s, plain);
	}
	const t = xor(s[v.lenBlock]!, concat(le64(ad.length), le64(data.length)));
	for (let i = 0; i < 7; i++) s = v.update(s, v.rate === 32 ? concat(t, t) : t);
	return { out, tag: v.tag(s) };
}

/** `ciphertext || tag` with a 32-byte tag */
export function aegisSeal(
	variant: '128l' | '256',
	message: Uint8Array,
	ad: Uint8Array,
	nonce: Uint8Array,
	key: Uint8Array
): Uint8Array {
	const { out, tag } = run(variant === '128l' ? L128 : L256, key, nonce, ad, message, false);
	return concat(out, tag);
}

/** the plaintext, or undefined when the tag does not verify */
export function aegisOpen(
	variant: '128l' | '256',
	sealed: Uint8Array,
	ad: Uint8Array,
	nonce: Uint8Array,
	key: Uint8Array
): Uint8Array | undefined {
	if (sealed.length < 32) return undefined;
	const ct = sealed.subarray(0, sealed.length - 32);
	const { out, tag } = run(variant === '128l' ? L128 : L256, key, nonce, ad, ct, true);
	let diff = 0;
	for (let i = 0; i < 32; i++) diff |= tag[i]! ^ sealed[ct.length + i]!;
	return diff === 0 ? out : undefined;
}
