import { createPublicKey, generateKeyPairSync } from 'node:crypto';
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

	it('REFUSES a signature over different bytes', () => {
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

/**
 * The widened half: the three names that were refused and turned out to have a primitive.
 *
 * "OpenSSL is missing" was true of the PHP extension and false of the capability. What sat behind
 * `WITH_OPENSSL=0` was not absence but a bridge scoped to two functions, and the refusal table said
 * keypair generation "needs a real OpenSSL" -- which was true of `crypto.subtle` and not of
 * `node:crypto`.
 *
 * DRIVEN AGAINST A REAL GENERATED KEYPAIR rather than a fixture, because a stub returning `true`
 * passes every naive assertion here.
 */
describe('key operations, which were refused on a premise about the wrong API', () => {
	it('generates a usable RSA keypair and returns both halves as PEM', () => {
		const made = signHostCall({ op: 'pkeyNew', bits: 2048 });
		expect(made.ok).toBe(true);
		const pair = made as { ok: true; privatePem: string; publicPem: string };
		expect(pair.privatePem).toContain('BEGIN PRIVATE KEY');
		expect(pair.publicPem).toContain('BEGIN PUBLIC KEY');

		// USABLE, not merely well-shaped: the generated private key signs and the generated public
		// key verifies it. A generator that produced a plausible PEM nothing could use would pass
		// every assertion above
		const signed = signHostCall({ op: 'sign', b64: 'aGVsbG8=', key: pair.privatePem, algo: 6 });
		expect(signed.ok).toBe(true);
		const checked = signHostCall({
			op: 'verify',
			b64: 'aGVsbG8=',
			key: pair.publicPem,
			sigB64: (signed as { sigB64: string }).sigB64,
			algo: 6
		});
		expect(checked).toEqual({ ok: true, valid: true });
	});

	it('refuses a key size outside what RSA takes, rather than throwing', () => {
		expect(signHostCall({ op: 'pkeyNew', bits: 16 }).ok).toBe(false);
		expect(signHostCall({ op: 'pkeyNew', bits: 99_999 }).ok).toBe(false);
	});

	it('turns a JWK into the same PEM the key itself exports', () => {
		// THE STEP EVERY OIDC LIBRARY NEEDS: a provider publishes a key SET, the library reads the
		// entry it wants, and `openssl_verify()` takes a PEM
		const jwk = createPublicKey(rsa.publicKey).export({ format: 'jwk' });
		const fromJwk = signHostCall({ op: 'pkeyGetPublic', jwk: jwk as never });
		expect(fromJwk.ok).toBe(true);
		expect((fromJwk as { pem: string }).pem).toBe(rsa.publicKey);
	});

	it('accepts a PEM on the same op, so one shim covers both shapes', () => {
		const fromPem = signHostCall({ op: 'pkeyGetPublic', key: rsa.publicKey });
		expect((fromPem as { pem: string }).pem).toBe(rsa.publicKey);
	});

	it('answers a JWKS entry that verifies a signature made by its own private key', () => {
		const jwk = createPublicKey(rsa.publicKey).export({ format: 'jwk' });
		const pem = (signHostCall({ op: 'pkeyGetPublic', jwk: jwk as never }) as { pem: string })
			.pem;
		const signed = signHostCall({ op: 'sign', b64: 'dG9rZW4=', key: rsa.privateKey, algo: 6 });
		expect(
			signHostCall({
				op: 'verify',
				b64: 'dG9rZW4=',
				key: pem,
				sigB64: (signed as { sigB64: string }).sigB64,
				algo: 6
			})
		).toEqual({ ok: true, valid: true });
	});

	it('exports a private key as PKCS#8 PEM', () => {
		const out = signHostCall({ op: 'pkeyExport', key: rsa.privateKey });
		expect(out.ok).toBe(true);
		expect((out as { pem: string }).pem).toContain('BEGIN PRIVATE KEY');
	});

	it('round-trips private-encrypt and public-decrypt', () => {
		const sealed = signHostCall({ op: 'privateEncrypt', b64: 'c2VjcmV0', key: rsa.privateKey });
		expect(sealed.ok).toBe(true);
		const opened = signHostCall({
			op: 'publicDecrypt',
			b64: (sealed as { b64: string }).b64,
			key: rsa.publicKey
		});
		expect((opened as { b64: string }).b64).toBe('c2VjcmV0');
	});

	it('reports an unreadable key as a failure rather than throwing', () => {
		for (const op of ['pkeyGetPublic', 'pkeyExport', 'privateEncrypt', 'publicDecrypt']) {
			expect(signHostCall({ op, key: 'not a key', b64: 'AA==' }).ok, op).toBe(false);
		}
	});

	it('declares every new function in the PHP half', () => {
		for (const fn of [
			'openssl_pkey_get_public',
			'openssl_pkey_new',
			'openssl_pkey_export',
			'openssl_private_encrypt',
			'openssl_public_decrypt'
		]) {
			expect(OPENSSL_FIX, fn).toContain(`function ${fn}(`);
		}
	});

	it('refuses a passphrase on export rather than silently ignoring one', () => {
		// answering with an UNENCRYPTED key to a caller who asked for an encrypted one hands them a
		// secret they believe is protected
		expect(OPENSSL_FIX).toContain('a passphrase is not supported here');
	});
});

describe('the symmetric, detail and exchange ops', () => {
	it('refuses a cipher it does not implement by name', () => {
		const r = signHostCall({ op: 'cipher', dir: 'enc', cipher: 'des-ede3-cbc', b64: '' });
		expect(r).toEqual({ ok: false, error: 'unsupported cipher des-ede3-cbc' });
	});

	it('round-trips AES-128-CBC with padding switched off on a block-sized input', () => {
		const common = {
			op: 'cipher',
			cipher: 'aes-128-cbc',
			keyB64: btoa('k'.repeat(16)),
			ivB64: btoa('i'.repeat(16)),
			padding: false
		};
		const enc = signHostCall({ ...common, dir: 'enc', b64: btoa('0123456789abcdef') }) as {
			b64: string;
		};
		expect(atob(enc.b64)).toHaveLength(16);
		const dec = signHostCall({ ...common, dir: 'dec', b64: enc.b64 }) as { b64: string };
		expect(atob(dec.b64)).toBe('0123456789abcdef');
	});

	it('reports RSA and EC details under the names ext-openssl uses', () => {
		const r = signHostCall({ op: 'pkeyDetails', key: rsa.privateKey }) as {
			details: Record<string, any>;
		};
		expect(r.details.keyType).toBe('rsa');
		expect(r.details.bits).toBe(2048);
		expect(r.details.rsa.d).toBeTruthy();
		const e = signHostCall({ op: 'pkeyDetails', key: ec.publicKey }) as {
			details: Record<string, any>;
		};
		expect(e.details.ec.curve_name).toBe('prime256v1');
		expect(e.details.ec.d).toBeUndefined();
	});

	it('refuses ECDH across two curves rather than deriving garbage', () => {
		const other = generateKeyPairSync('ec', {
			namedCurve: 'P-384',
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
		});
		const r = signHostCall({ op: 'derive', key: ec.privateKey, peer: other.publicKey });
		expect(r.ok).toBe(false);
	});

	it('declares the functions SSO and OAuth libraries reach for', () => {
		for (const fn of [
			'openssl_encrypt',
			'openssl_decrypt',
			'openssl_pkey_get_private',
			'openssl_pkey_get_details',
			'openssl_pkey_derive',
			'openssl_public_encrypt',
			'openssl_private_decrypt',
			'openssl_x509_read',
			'openssl_x509_parse',
			'openssl_x509_fingerprint',
			'openssl_x509_checkpurpose',
			'openssl_random_pseudo_bytes',
			'openssl_cipher_iv_length',
			'openssl_error_string'
		]) {
			expect(OPENSSL_FIX, fn).toContain(`function ${fn}(`);
		}
	});
});
