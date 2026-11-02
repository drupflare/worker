/**
 * Curve25519, Ed25519 and ristretto255 for the sodium stand-in, over `@noble/curves`.
 *
 * Group, field and scalar arithmetic is noble's. This file keeps the libsodium behaviour around
 * it: which encodings are refused, the key used in the signing hash, and the 256-bit wrap in
 * `scalar.add` and `scalar.sub`. JavaScript BigInt is not constant-time, so this is not one.
 *
 * @module
 */
import { ed25519, ristretto255, ristretto255_hasher, x25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, equalBytes, numberToBytesLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';

const Fn = ed25519.Point.Fn;
const RistrettoPoint = ristretto255.Point;

const BASE_U = (() => {
	const b = new Uint8Array(32);
	b[0] = 9;
	return b;
})();

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

const toScalar = (b: Uint8Array): bigint => Fn.create(bytesToNumberLE(b));

// #region x25519

/** the X25519 shared point, or undefined where noble refuses it (low-order u or a zero result) */
export function x25519Shared(k: Uint8Array, u: Uint8Array): Uint8Array | undefined {
	try {
		return x25519.scalarMult(k, u);
	} catch {
		return undefined;
	}
}

/** X25519 of the base point; zeros where [k]B is the identity, as libsodium's base multiply */
export const x25519Base = (k: Uint8Array): Uint8Array =>
	x25519Shared(k, BASE_U) ?? new Uint8Array(32);

// #endregion

// #region ed25519

/** the 64-byte secret key and 32-byte public key for a seed, as `crypto_sign_seed_keypair` */
export function ed25519FromSeed(seed: Uint8Array): { secret: Uint8Array; pub: Uint8Array } {
	const pub = ed25519.getPublicKey(seed);
	return { secret: concat(seed, pub), pub };
}

/** a detached signature by a 64-byte libsodium secret key */
export function ed25519Sign(message: Uint8Array, secret: Uint8Array): Uint8Array {
	const h = sha512(secret.subarray(0, 32));
	const clamped = Uint8Array.from(h.subarray(0, 32));
	clamped[0]! &= 248;
	clamped[31]! &= 127;
	clamped[31]! |= 64;
	const a = toScalar(clamped);
	const pub = secret.subarray(32, 64);
	const r = toScalar(sha512(concat(h.subarray(32, 64), message)));
	const rEnc = ed25519.Point.BASE.multiply(r).toBytes();
	const k = toScalar(sha512(concat(rEnc, pub, message)));
	return concat(rEnc, numberToBytesLE(Fn.create(r + k * a), 32));
}

/** libsodium's detached verify: canonical S, no small-order R or A, and a cofactorless compare */
export function ed25519Verify(sig: Uint8Array, message: Uint8Array, pub: Uint8Array): boolean {
	const s = bytesToNumberLE(sig.subarray(32, 64));
	if (s >= Fn.ORDER) return false;
	const rEnc = sig.subarray(0, 32);
	let a: InstanceType<typeof ed25519.Point>;
	let r: InstanceType<typeof ed25519.Point>;
	try {
		a = ed25519.Point.fromBytes(pub);
		r = ed25519.Point.fromBytes(rEnc);
	} catch {
		return false;
	}
	if (a.isSmallOrder() || r.isSmallOrder()) return false;
	const k = toScalar(sha512(concat(rEnc, pub, message)));
	const check = ed25519.Point.BASE.multiplyUnsafe(s).subtract(a.multiplyUnsafe(k));
	return equalBytes(check.toBytes(), rEnc);
}

/** the X25519 secret for an Ed25519 secret key; throws nothing, any 32 bytes of seed work */
export function ed25519SecretToCurve(secret: Uint8Array): Uint8Array {
	return ed25519.utils.toMontgomerySecret(secret.subarray(0, 32));
}

/** the X25519 public key for an Ed25519 one, or undefined where libsodium refuses it */
export function ed25519PublicToCurve(pub: Uint8Array): Uint8Array | undefined {
	let point: InstanceType<typeof ed25519.Point>;
	try {
		point = ed25519.Point.fromBytes(pub);
	} catch {
		return undefined;
	}
	if (point.isSmallOrder() || !point.isTorsionFree()) return undefined;
	return ed25519.utils.toMontgomery(pub);
}

// #endregion

// #region ristretto255

const decodePoint = (s: Uint8Array): InstanceType<typeof RistrettoPoint> | undefined => {
	try {
		return RistrettoPoint.fromBytes(s);
	} catch {
		return undefined;
	}
};

/** the point a 64-byte hash maps to, as `crypto_core_ristretto255_from_hash` */
export function ristrettoFromHash(h: Uint8Array): Uint8Array {
	return ristretto255_hasher.deriveToCurve!(h).toBytes();
}

/** the sum or difference of two encoded points, or undefined when either is invalid */
export function ristrettoAdd(a: Uint8Array, b: Uint8Array, sub = false): Uint8Array | undefined {
	const p = decodePoint(a);
	const q = decodePoint(b);
	if (!p || !q) return undefined;
	return (sub ? p.subtract(q) : p.add(q)).toBytes();
}

/** the encoded point times a scalar, or undefined for an invalid point or a zero product */
export function ristrettoMul(n: Uint8Array, p?: Uint8Array): Uint8Array | undefined {
	const t = Uint8Array.from(n);
	t[31]! &= 127;
	const k = toScalar(t);
	const point = p ? decodePoint(p) : RistrettoPoint.BASE;
	if (!point || k === 0n) return undefined;
	const r = point.multiply(k);
	return r.is0() ? undefined : r.toBytes();
}

/** whether an encoding is a valid ristretto255 point */
export const ristrettoIsValid = (s: Uint8Array): boolean => decodePoint(s) !== undefined;

// #endregion

// #region scalars mod L

/** a 32 or 64 byte little-endian scalar, reduced */
export const scalarReduce = (s: Uint8Array): Uint8Array => numberToBytesLE(toScalar(s), 32);

/** the arithmetic over the group order, on 32-byte little-endian scalars */
export const scalar = {
	// libsodium adds and subtracts in 256 bits before reducing, so an input past 2^253 wraps
	add: (x: Uint8Array, y: Uint8Array): Uint8Array =>
		numberToBytesLE(
			Fn.create(BigInt.asUintN(256, bytesToNumberLE(x) + bytesToNumberLE(y))),
			32
		),
	// libsodium subtracts by adding the negation, so it wraps the same way
	sub: (x: Uint8Array, y: Uint8Array): Uint8Array =>
		numberToBytesLE(
			Fn.create(BigInt.asUintN(256, bytesToNumberLE(x) + Fn.create(-bytesToNumberLE(y)))),
			32
		),
	mul: (x: Uint8Array, y: Uint8Array): Uint8Array =>
		numberToBytesLE(Fn.mul(toScalar(x), toScalar(y)), 32),
	negate: (x: Uint8Array): Uint8Array => numberToBytesLE(Fn.neg(toScalar(x)), 32),
	complement: (x: Uint8Array): Uint8Array => numberToBytesLE(Fn.sub(Fn.ONE, toScalar(x)), 32),
	invert: (x: Uint8Array): Uint8Array | undefined => {
		const n = toScalar(x);
		return Fn.is0(n) ? undefined : numberToBytesLE(Fn.inv(n), 32);
	}
};

// #endregion
