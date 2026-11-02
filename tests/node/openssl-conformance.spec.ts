import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signHostCall } from '../../src/site/shims/openssl-fix';

/**
 * The openssl stand-in against ext-openssl in a native PHP, in both directions.
 *
 * Each case runs one side on the shim and the other side natively, with the same key and bytes, so
 * a wrong digest or padding reads as a mismatch rather than as a self-consistent pair. RSA PKCS#1
 * v1.5 signatures are deterministic, so those compare byte for byte; OAEP and GCM are checked by
 * decrypting across. The native half needs a `php` on PATH with ext-openssl and is skipped with a
 * printed reason without one.
 */

const hasNative = spawnSync('php', ['-r', 'echo extension_loaded("openssl") ? 1 : 0;'], {
	encoding: 'utf8'
});
const native = hasNative.status === 0 && hasNative.stdout === '1';
if (!native) console.log('openssl conformance: skipped, no php with ext-openssl on PATH');

function php(code: string, env: Record<string, string>): string {
	const out = spawnSync('php', ['-r', code], {
		env: { ...process.env, ...env },
		encoding: 'utf8'
	});
	if (out.status !== 0) throw new Error(`php: ${out.stderr}`);
	return out.stdout;
}

const rsa = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');

describe.skipIf(!native)('the stand-in against native ext-openssl', () => {
	it('RSA-OAEP: the shim encrypts and native PHP decrypts with OPENSSL_PKCS1_OAEP_PADDING', () => {
		const sealed = signHostCall({
			op: 'publicEncrypt',
			b64: b64('session key'),
			key: rsa.publicKey,
			pad: 4
		});
		expect(sealed.ok).toBe(true);
		const opened = php(
			`$k = openssl_pkey_get_private(getenv('KEY')); ` +
				`echo openssl_private_decrypt(base64_decode(getenv('CT')), $pt, $k, ` +
				`OPENSSL_PKCS1_OAEP_PADDING) ? base64_encode($pt) : 'ERR';`,
			{ KEY: rsa.privateKey, CT: (sealed as { b64: string }).b64 }
		);
		expect(unb64(opened).toString()).toBe('session key');
	});

	it('RSA-OAEP: native PHP encrypts and the shim decrypts', () => {
		const ct = php(
			`$k = openssl_pkey_get_public(getenv('KEY')); ` +
				`openssl_public_encrypt(base64_decode(getenv('PT')), $ct, $k, ` +
				`OPENSSL_PKCS1_OAEP_PADDING); echo base64_encode($ct);`,
			{ KEY: rsa.publicKey, PT: b64('session key') }
		);
		const opened = signHostCall({ op: 'privateDecrypt', b64: ct, key: rsa.privateKey, pad: 4 });
		expect(opened).toEqual({ ok: true, b64: b64('session key') });
	});

	it('RSA PKCS#1 v1.5 signatures are byte-identical in both directions', () => {
		const data = 'signed by both sides';
		const shim = signHostCall({
			op: 'sign',
			b64: b64(data),
			key: rsa.privateKey,
			algo: 'sha256'
		});
		const sigB64 = (shim as { sigB64: string }).sigB64;
		const nativeSig = php(
			`$k = openssl_pkey_get_private(getenv('KEY')); ` +
				`openssl_sign(getenv('DATA'), $sig, $k, OPENSSL_ALGO_SHA256); echo base64_encode($sig);`,
			{ KEY: rsa.privateKey, DATA: data }
		);
		expect(nativeSig).toBe(sigB64);
		expect(php(`echo OPENSSL_ALGO_SHA256;`, {})).toBe('7');
		const verdict = php(
			`$k = openssl_pkey_get_public(getenv('KEY')); ` +
				`echo openssl_verify(getenv('DATA'), base64_decode(getenv('SIG')), $k, 7);`,
			{ KEY: rsa.publicKey, DATA: data, SIG: sigB64 }
		);
		expect(verdict).toBe('1');
		const back = signHostCall({
			op: 'verify',
			b64: b64(data),
			key: rsa.publicKey,
			sigB64: nativeSig,
			algo: 7
		});
		expect(back).toEqual({ ok: true, valid: true });
	});

	it('AES-256-CBC with zero padding matches native output in both directions', () => {
		const key = Buffer.alloc(32, 7);
		const iv = Buffer.alloc(16, 9);
		const pt = Buffer.alloc(32, 0x41);
		const shim = signHostCall({
			op: 'cipher',
			dir: 'enc',
			cipher: 'aes-256-cbc',
			b64: b64(pt),
			keyB64: b64(key),
			ivB64: b64(iv),
			padding: false
		});
		const ct = (shim as { b64: string }).b64;
		const nativeCt = php(
			`echo base64_encode(openssl_encrypt(base64_decode(getenv('PT')), 'aes-256-cbc', ` +
				`base64_decode(getenv('KEY')), OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING, ` +
				`base64_decode(getenv('IV'))));`,
			{ PT: b64(pt), KEY: b64(key), IV: b64(iv) }
		);
		expect(nativeCt).toBe(ct);
		const back = signHostCall({
			op: 'cipher',
			dir: 'dec',
			cipher: 'aes-256-cbc',
			b64: ct,
			keyB64: b64(key),
			ivB64: b64(iv),
			padding: false
		});
		expect(back).toEqual({ ok: true, b64: b64(pt) });
	});

	it('AES-128-GCM with AAD and a 16-byte tag matches native output in both directions', () => {
		const key = Buffer.alloc(16, 3);
		const iv = Buffer.alloc(12, 5);
		const pt = Buffer.from('gcm plaintext');
		const aad = Buffer.from('header');
		const shim = signHostCall({
			op: 'cipher',
			dir: 'enc',
			cipher: 'aes-128-gcm',
			b64: b64(pt),
			keyB64: b64(key),
			ivB64: b64(iv),
			aadB64: b64(aad),
			tagLength: 16
		}) as { b64: string; tagB64: string };
		const env = {
			PT: b64(pt),
			KEY: b64(key),
			IV: b64(iv),
			AAD: b64(aad)
		};
		const nativeGcm = JSON.parse(
			php(
				`$ct = openssl_encrypt(base64_decode(getenv('PT')), 'aes-128-gcm', ` +
					`base64_decode(getenv('KEY')), OPENSSL_RAW_DATA, base64_decode(getenv('IV')), ` +
					`$tag, base64_decode(getenv('AAD')), 16); ` +
					`echo json_encode(['ct' => base64_encode($ct), 'tag' => base64_encode($tag)]);`,
				env
			)
		) as { ct: string; tag: string };
		expect(nativeGcm.ct).toBe(shim.b64);
		expect(nativeGcm.tag).toBe(shim.tagB64);
		const opened = php(
			`echo openssl_decrypt(base64_decode(getenv('CT')), 'aes-128-gcm', ` +
				`base64_decode(getenv('KEY')), OPENSSL_RAW_DATA, base64_decode(getenv('IV')), ` +
				`base64_decode(getenv('TAG')), base64_decode(getenv('AAD')));`,
			{ ...env, CT: shim.b64, TAG: shim.tagB64 }
		);
		expect(opened).toBe('gcm plaintext');
	});

	it.each([
		['a cipher ext-openssl has but the stand-in does not', 'aes-128-ccm'],
		['a legacy block cipher', 'des-ede3-cbc']
	])('refuses %s by name rather than encrypting with something else (%s)', (_, cipher) => {
		const reply = signHostCall({
			op: 'cipher',
			dir: 'enc',
			cipher,
			b64: b64('x'),
			keyB64: b64(Buffer.alloc(32)),
			ivB64: b64(Buffer.alloc(16)),
			padding: true
		});
		expect(reply.ok).toBe(false);
	});

	it('refuses a digest the stand-in does not implement, rather than signing with another', () => {
		const reply = signHostCall({
			op: 'sign',
			b64: b64('x'),
			key: rsa.privateKey,
			algo: 'sha3-256'
		});
		expect(reply.ok).toBe(false);
	});
});
