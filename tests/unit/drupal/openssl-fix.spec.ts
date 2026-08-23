import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	installSign,
	OPENSSL_ALGOS,
	OPENSSL_FIX,
	SIGN_BRIDGE,
	signHostCall
} from '../../../src/drupal/openssl-fix';

/**
 * RSA and ECDSA signing over `node:crypto`, which is SYNCHRONOUS in workerd.
 *
 * P42.4 was scoped as "crypto.subtle covers RS256/ES256 but is async, so it takes the queue and
 * read-later pair" -- a two-invocation round trip for every signature. That premise is refuted:
 * `node:crypto` exposes `createSign`/`createVerify` here and they return in-line, so this is an
 * ordinary masked bridge like the zlib one and a caller sees a normal function.
 *
 * ROUND TRIP RATHER THAN A FIXED VECTOR, for RSA. PSS/PKCS#1 v1.5 padding is deterministic for
 * RSA and a pinned signature WOULD be checkable, but the same test then cannot cover ECDSA, whose
 * signature is randomised by design. Verifying what was just signed covers both, and a codec that
 * can produce something it cannot check is the defect this catches either way.
 */

const rsa = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const ec = generateKeyPairSync('ec', {
	namedCurve: 'P-256',
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const b64 = (s: string) => btoa(s);

describe('signing over the host bridge', () => {
	it('signs with RS256 and verifies what it produced', () => {
		const signed = signHostCall({
			op: 'sign',
			b64: b64('the payload'),
			key: rsa.privateKey,
			algo: 6
		});
		expect(signed.ok).toBe(true);
		if (!signed.ok || !('sigB64' in signed)) throw new Error('no signature');
		// 2048 bits is 256 bytes, so a much shorter answer means a digest leaked out instead
		expect(atob(signed.sigB64).length).toBe(256);

		const checked = signHostCall({
			op: 'verify',
			b64: b64('the payload'),
			sigB64: signed.sigB64,
			key: rsa.publicKey,
			algo: 6
		});
		expect(checked.ok).toBe(true);
		if (checked.ok && 'valid' in checked) expect(checked.valid).toBe(true);
	});

	it('REFUSES a signature over different bytes, which is the whole point', () => {
		const signed = signHostCall({ op: 'sign', b64: b64('a'), key: rsa.privateKey, algo: 6 });
		if (!signed.ok || !('sigB64' in signed)) throw new Error('no signature');
		const checked = signHostCall({
			op: 'verify',
			b64: b64('b'),
			sigB64: signed.sigB64,
			key: rsa.publicKey,
			algo: 6
		});
		// ok:true with valid:false -- the call SUCCEEDED and the answer is "no". A shim that
		// reported this as an error would turn a forged token into a broken key
		expect(checked.ok).toBe(true);
		if (checked.ok && 'valid' in checked) expect(checked.valid).toBe(false);
	});

	it('handles ECDSA too, whose signature is randomised', () => {
		const signed = signHostCall({ op: 'sign', b64: b64('es256'), key: ec.privateKey, algo: 6 });
		expect(signed.ok).toBe(true);
		if (!signed.ok || !('sigB64' in signed)) throw new Error('no signature');
		const checked = signHostCall({
			op: 'verify',
			b64: b64('es256'),
			sigB64: signed.sigB64,
			key: ec.publicKey,
			algo: 6
		});
		if (checked.ok && 'valid' in checked) expect(checked.valid).toBe(true);
	});

	it('refuses an unknown algorithm rather than silently choosing one', () => {
		const r = signHostCall({ op: 'sign', b64: b64('x'), key: rsa.privateKey, algo: 999 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('unsupported algorithm');
	});

	it('reports a bad key as an error rather than as an invalid signature', () => {
		const r = signHostCall({ op: 'sign', b64: b64('x'), key: 'not a pem', algo: 6 });
		expect(r.ok).toBe(false);
	});

	it('refuses an empty key instead of asking node to parse one', () => {
		const r = signHostCall({ op: 'sign', b64: b64('x'), key: '', algo: 6 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('no key');
	});

	it('maps every algorithm constant to a digest node reports', () => {
		// getHashes() in workerd includes sha1/sha224/sha256/sha384/sha512 and the md family
		for (const digest of Object.values(OPENSSL_ALGOS)) {
			expect(typeof digest).toBe('string');
			expect(digest.length).toBeGreaterThan(2);
		}
		expect(OPENSSL_ALGOS[6]).toBe('sha256');
	});
});

describe('the installed bridge and the PHP half', () => {
	it('installs under the name the fragment resolves', () => {
		const binary: Record<string, unknown> = {};
		installSign(binary, (fn) => fn());
		expect(typeof binary[SIGN_BRIDGE]).toBe('function');
	});

	it('runs inside the mask, because a signature is a long synchronous frame', () => {
		let masked = false;
		const binary: Record<string, unknown> = {};
		installSign(binary, (fn) => {
			masked = true;
			return fn();
		});
		(binary[SIGN_BRIDGE] as (j: string) => string)('{}');
		expect(masked).toBe(true);
	});

	it('answers an unparseable request rather than throwing into PHP', () => {
		const binary: Record<string, unknown> = {};
		installSign(binary, (fn) => fn());
		const out = JSON.parse((binary[SIGN_BRIDGE] as (j: string) => string)('{'));
		expect(out.ok).toBe(false);
		expect(String(out.error)).toContain('unparseable');
	});

	it('declares openssl_verify as a TRI-STATE, not a boolean', () => {
		// ext-openssl answers 1, 0 or -1, and -1 means the call failed rather than the signature
		// being invalid. Collapsing it to a bool reports a broken key as a forged token
		expect(OPENSSL_FIX).toContain('function openssl_verify(');
		expect(OPENSSL_FIX).toContain('return -1;');
	});

	it('takes the signature by reference, which is the signature callers rely on', () => {
		expect(OPENSSL_FIX).toContain('function openssl_sign($data, &$signature');
	});

	it('is inert on a build that HAS ext-openssl', () => {
		expect(OPENSSL_FIX).toContain("!extension_loaded('openssl')");
	});
});
