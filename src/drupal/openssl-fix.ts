/**
 * `openssl_*` over `node:crypto`, synchronously: sign and verify, JWK and PEM keys, AES
 * encrypt and decrypt, key details, X.509 parsing and ECDH.
 *
 * Shimming the names PHP already uses makes `firebase/php-jwt`, Google's auth client and Stripe's
 * webhook verifier work untouched. `node:crypto` is synchronous in workerd, so this is an ordinary
 * bridge, not a deferred one. Not here: `openssl_csr_new` and the PKCS#7/CMS family (no
 * primitive); `openssl_x509_checkpurpose` answers -1 (no trust store).
 * @module
 */
import { Buffer } from 'node:buffer';
import {
	constants,
	createCipheriv,
	createDecipheriv,
	createECDH,
	createHash,
	createPrivateKey,
	createPublicKey,
	createSign,
	createVerify,
	generateKeyPairSync,
	privateDecrypt,
	privateEncrypt,
	publicDecrypt,
	publicEncrypt,
	X509Certificate,
	type KeyObject
} from 'node:crypto';
import { base64ToBytes, bytesToBase64 } from '../db/file-store';
import { OPENSSL_FIX_PHP } from '../site/generated/assets';
import { errorMessage } from '../util/errors';
import { renderTemplate } from '../util/template';

/** the Module key the PHP half resolves through `vrzno_env()` */
export const SIGN_BRIDGE = 'cfwSign';

/**
 * PHP's `OPENSSL_ALGO_*` values mapped to the digest names `node:crypto` takes.
 *
 * ext-openssl's stable numbers, spelled as literals because the extension is absent; workerd's
 * `getHashes()` backs every entry.
 */
export const OPENSSL_ALGOS: Record<number, string> = {
	1: 'sha1',
	2: 'md5',
	3: 'md4',
	6: 'sha256',
	7: 'sha384',
	8: 'sha512',
	9: 'sha224'
};

/** what the PHP half sends */
export type SignRequest = {
	op?: string;
	/** base64 of the bytes to sign or verify */
	b64?: string;
	/** the PEM key; private to sign, public or a certificate to verify */
	key?: string;
	/** an `OPENSSL_ALGO_*` value */
	algo?: number;
	/** base64 of the signature, for verify */
	sigB64?: string;
	/** RSA modulus size for `pkeyNew`, in bits */
	bits?: number;
	/** a JWK, for `pkeyGetPublic` when the caller has a key set rather than a PEM */
	jwk?: Record<string, unknown>;
	/** the passphrase an encrypted private PEM was written with */
	passphrase?: string;
	/** `pkeyNew`: 'rsa' or 'ec' */
	type?: string;
	/** `pkeyNew` for EC: an OpenSSL curve name such as prime256v1 */
	curve?: string;
	/** `cipher`: 'enc' or 'dec' */
	dir?: string;
	/** `cipher`: the lowercased OpenSSL cipher name */
	cipher?: string;
	/** `cipher`: exact-length key, IV, AAD and tag, base64 */
	keyB64?: string;
	ivB64?: string;
	aadB64?: string;
	tagB64?: string;
	tagLength?: number;
	/** `cipher`: false for OPENSSL_ZERO_PADDING */
	padding?: boolean;
	/** `publicEncrypt` / `privateDecrypt`: an `OPENSSL_*_PADDING` value */
	pad?: number;
	/** `derive`: the peer's public key as PEM */
	peer?: string;
	/** `x509Fingerprint`: the digest name */
	digest?: string;
};

/** the OpenSSL curve names PHP spells, mapped to what `node:crypto` takes */
export const EC_CURVES: Record<string, string> = {
	prime256v1: 'P-256',
	secp256r1: 'P-256',
	secp384r1: 'P-384',
	secp521r1: 'P-521'
};

const JWK_CURVE_NAMES: Record<string, [string, string, number]> = {
	'P-256': ['prime256v1', '1.2.840.10045.3.1.7', 256],
	'P-384': ['secp384r1', '1.3.132.0.34', 384],
	'P-521': ['secp521r1', '1.3.132.0.35', 521]
};

/** the AES modes the cipher op accepts; the key length comes from the name */
const CIPHER = /^aes-(128|192|256)-(cbc|ctr|ecb|gcm)$/;

const b64url = (s: unknown) =>
	bytesToBase64(new Uint8Array(Buffer.from(String(s ?? ''), 'base64url')));

function privateKeyOf(req: SignRequest): KeyObject {
	const passphrase = req.passphrase ? { passphrase: req.passphrase } : {};
	return createPrivateKey({ key: String(req.key ?? ''), ...passphrase });
}

/** what `openssl_pkey_get_details()` reports for a key, minus the PHP key type number */
function keyDetails(req: SignRequest): Record<string, unknown> {
	const source = String(req.key ?? '');
	let key: KeyObject;
	let isPrivate = false;
	try {
		key = privateKeyOf(req);
		isPrivate = true;
	} catch {
		key = createPublicKey(source);
	}
	const pub = isPrivate ? createPublicKey(key) : key;
	const jwk = key.export({ format: 'jwk' }) as Record<string, unknown>;
	const out: Record<string, unknown> = {
		keyType: key.asymmetricKeyType,
		publicPem: pub.export({ type: 'spki', format: 'pem' })
	};
	if (key.asymmetricKeyType === 'rsa') {
		out.bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
		out.rsa = {
			n: b64url(jwk.n),
			e: b64url(jwk.e),
			...(isPrivate ? { d: b64url(jwk.d) } : {})
		};
	} else if (key.asymmetricKeyType === 'ec') {
		const [name, oid, bits] = JWK_CURVE_NAMES[String(jwk.crv)] ?? [String(jwk.crv), '', 0];
		out.bits = bits;
		out.ec = {
			curve_name: name,
			curve_oid: oid,
			x: b64url(jwk.x),
			y: b64url(jwk.y),
			...(isPrivate ? { d: b64url(jwk.d) } : {})
		};
	} else {
		out.bits = 0;
	}
	return out;
}

function cipherCall(req: SignRequest): SignReply {
	const name = String(req.cipher ?? '').toLowerCase();
	const m = CIPHER.exec(name);
	if (!m) return { ok: false, error: `unsupported cipher ${name}` };
	const key = Buffer.from(String(req.keyB64 ?? ''), 'base64');
	const iv = m[2] === 'ecb' ? null : Buffer.from(String(req.ivB64 ?? ''), 'base64');
	const data = Buffer.from(String(req.b64 ?? ''), 'base64');
	const gcm = m[2] === 'gcm';
	const tagLength = Number(req.tagLength ?? 16);
	const aad = req.aadB64 ? Buffer.from(req.aadB64, 'base64') : null;
	if (req.dir === 'dec') {
		const d = createDecipheriv(
			name,
			key,
			iv,
			gcm ? ({ authTagLength: tagLength } as never) : undefined
		);
		if (gcm) {
			(d as unknown as { setAuthTag(t: Buffer): void }).setAuthTag(
				Buffer.from(String(req.tagB64 ?? ''), 'base64')
			);
			if (aad) (d as unknown as { setAAD(a: Buffer): void }).setAAD(aad);
		}
		if (req.padding === false) d.setAutoPadding(false);
		const out = Buffer.concat([d.update(data), d.final()]);
		return { ok: true, b64: bytesToBase64(new Uint8Array(out)) };
	}
	const c = createCipheriv(
		name,
		key,
		iv,
		gcm ? ({ authTagLength: tagLength } as never) : undefined
	);
	if (gcm && aad) (c as unknown as { setAAD(a: Buffer): void }).setAAD(aad);
	if (req.padding === false) c.setAutoPadding(false);
	const out = Buffer.concat([c.update(data), c.final()]);
	const reply: Record<string, unknown> = { ok: true, b64: bytesToBase64(new Uint8Array(out)) };
	if (gcm) {
		reply.tagB64 = bytesToBase64(
			new Uint8Array((c as unknown as { getAuthTag(): Buffer }).getAuthTag())
		);
	}
	return reply as SignReply;
}

/** what `openssl_x509_parse()` reports, for the fields a certificate object exposes */
function x509Parse(pem: string): Record<string, unknown> {
	const cert = new X509Certificate(pem);
	const fields = (dn: string) => {
		const out: Record<string, string | string[]> = {};
		for (const line of dn.split('\n')) {
			const at = line.indexOf('=');
			if (at < 1) continue;
			const k = line.slice(0, at);
			const v = line.slice(at + 1);
			const prev = out[k];
			out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
		}
		return out;
	};
	const name = (dn: string) =>
		dn
			.split('\n')
			.filter((l) => l.includes('='))
			.map((l) => '/' + l)
			.join('');
	const extensions: Record<string, string> = {};
	if (cert.subjectAltName) extensions.subjectAltName = cert.subjectAltName;
	if (cert.keyUsage?.length) extensions.extendedKeyUsage = cert.keyUsage.join(', ');
	return {
		name: name(cert.subject),
		subject: fields(cert.subject),
		issuer: fields(cert.issuer),
		serialNumberHex: cert.serialNumber,
		serialNumber: BigInt('0x' + cert.serialNumber).toString(),
		validFrom_time_t: Math.floor(Date.parse(cert.validFrom) / 1000),
		validTo_time_t: Math.floor(Date.parse(cert.validTo) / 1000),
		extensions
	};
}

/** what it gets back */
export type SignReply =
	| { ok: true; sigB64: string }
	| { ok: true; valid: boolean }
	| { ok: true; pem: string }
	| { ok: true; privatePem: string; publicPem: string }
	| { ok: true; b64: string; tagB64?: string }
	| { ok: true; details: Record<string, unknown> }
	| { ok: true; parsed: Record<string, unknown> }
	| { ok: true; hex: string }
	| { ok: false; error: string };

/**
 * One sign or verify, decoded (exported so the gate can drive both ops without a Durable Object).
 *
 * @internal
 */
export function signHostCall(req: SignRequest): SignReply {
	try {
		// ops with no digest are answered before the algorithm lookup (a key op has no algorithm)
		if (req.op === 'pkeyNew' && req.type === 'ec') {
			const curve = EC_CURVES[String(req.curve ?? 'prime256v1')];
			if (!curve) return { ok: false, error: `unsupported curve ${String(req.curve)}` };
			const pair = generateKeyPairSync('ec', {
				namedCurve: curve,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
			});
			return { ok: true, privatePem: pair.privateKey, publicPem: pair.publicKey };
		}
		if (req.op === 'pkeyGetPrivate') {
			const key = privateKeyOf(req);
			return {
				ok: true,
				privatePem: key.export({ type: 'pkcs8', format: 'pem' }) as string,
				publicPem: createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string
			};
		}
		if (req.op === 'pkeyDetails') return { ok: true, details: keyDetails(req) };
		if (req.op === 'cipher') return cipherCall(req);
		if (req.op === 'publicEncrypt' || req.op === 'privateDecrypt') {
			const padding =
				Number(req.pad ?? 1) === 4
					? constants.RSA_PKCS1_OAEP_PADDING
					: constants.RSA_PKCS1_PADDING;
			const data = base64ToBytes(String(req.b64 ?? ''));
			const out =
				req.op === 'publicEncrypt'
					? publicEncrypt({ key: String(req.key ?? ''), padding }, data)
					: privateDecrypt(
							{
								key: privateKeyOf(req).export({
									type: 'pkcs8',
									format: 'pem'
								}) as string,
								padding
							},
							data
						);
			return { ok: true, b64: bytesToBase64(new Uint8Array(out)) };
		}
		if (req.op === 'derive') {
			// createECDH over the raw scalar and point: workerd's diffieHellman() refuses EC keys
			const mine = privateKeyOf(req).export({ format: 'jwk' }) as Record<string, string>;
			const peer = createPublicKey(String(req.peer ?? '')).export({
				format: 'jwk'
			}) as Record<string, string>;
			const curve = JWK_CURVE_NAMES[mine.crv ?? ''];
			if (!curve || peer.crv !== mine.crv) {
				return { ok: false, error: 'both keys must be EC keys on the same named curve' };
			}
			const ecdh = createECDH(curve[0]);
			ecdh.setPrivateKey(Buffer.from(mine.d ?? '', 'base64url'));
			const point = Buffer.concat([
				Buffer.from([4]),
				Buffer.from(peer.x ?? '', 'base64url'),
				Buffer.from(peer.y ?? '', 'base64url')
			]);
			return { ok: true, b64: bytesToBase64(new Uint8Array(ecdh.computeSecret(point))) };
		}
		if (req.op === 'x509Parse') return { ok: true, parsed: x509Parse(String(req.key ?? '')) };
		if (req.op === 'x509Fingerprint') {
			const der = new X509Certificate(String(req.key ?? '')).raw;
			return {
				ok: true,
				hex: createHash(String(req.digest ?? 'sha1'))
					.update(der)
					.digest('hex')
			};
		}
		if (req.op === 'x509Export') {
			return { ok: true, pem: new X509Certificate(String(req.key ?? '')).toString() };
		}
		if (req.op === 'pkeyNew') {
			const bits = Number(req.bits ?? 2048);
			if (!Number.isInteger(bits) || bits < 512 || bits > 8192) {
				return { ok: false, error: `unsupported key size ${String(req.bits)}` };
			}
			const pair = generateKeyPairSync('rsa', {
				modulusLength: bits,
				publicKeyEncoding: { type: 'spki', format: 'pem' },
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
			});
			return { ok: true, privatePem: pair.privateKey, publicPem: pair.publicKey };
		}
		if (req.op === 'pkeyGetPublic') {
			// a JWK entry or a PEM (OIDC libraries fetch a key set, `openssl_verify()` takes a PEM)
			const source =
				req.jwk !== undefined
					? createPublicKey({ key: req.jwk as never, format: 'jwk' })
					: createPublicKey(String(req.key ?? ''));
			return { ok: true, pem: source.export({ type: 'spki', format: 'pem' }) as string };
		}
		if (req.op === 'pkeyExport') {
			const key = privateKeyOf(req);
			return { ok: true, pem: key.export({ type: 'pkcs8', format: 'pem' }) as string };
		}
		if (req.op === 'privateEncrypt') {
			const out = privateEncrypt(String(req.key ?? ''), base64ToBytes(String(req.b64 ?? '')));
			return { ok: true, b64: bytesToBase64(new Uint8Array(out)) };
		}
		if (req.op === 'publicDecrypt') {
			const out = publicDecrypt(String(req.key ?? ''), base64ToBytes(String(req.b64 ?? '')));
			return { ok: true, b64: bytesToBase64(new Uint8Array(out)) };
		}

		const digest = OPENSSL_ALGOS[Number(req.algo ?? 6)];
		if (!digest) return { ok: false, error: `unsupported algorithm ${String(req.algo)}` };

		const key = String(req.key ?? '');
		if (key === '') return { ok: false, error: 'no key supplied' };
		const data = base64ToBytes(String(req.b64 ?? ''));

		if (req.op === 'verify') {
			const v = createVerify(digest);
			v.update(data);
			// `end()` before `verify()`; node throws "Digest already called" (reads as a bad key)
			v.end();
			return { ok: true, valid: v.verify(key, base64ToBytes(String(req.sigB64 ?? ''))) };
		}

		const s = createSign(digest);
		s.update(data);
		s.end();
		return { ok: true, sigB64: bytesToBase64(new Uint8Array(s.sign(key))) };
	} catch (e) {
		// a bad key or a bad signature is a normal outcome for these functions, not a fault:
		// `openssl_verify()` answers -1 on error and FALSE is what `openssl_sign()` returns
		return { ok: false, error: errorMessage(e) };
	}
}

/** the shape `installSign` needs of a PHP binary, so it can be driven from a test */
export type SignBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module, masked like the zlib bridge (a slice interrupt must not
 * suspend across a long synchronous frame).
 */
export function installSign(binary: SignBinary, withMask: <R>(fn: () => R) => R): SignBinary {
	binary[SIGN_BRIDGE] = (json: string) =>
		withMask(() => {
			let req: SignRequest;
			try {
				req = JSON.parse(json) as SignRequest;
			} catch (e: any) {
				return JSON.stringify({ ok: false, error: `unparseable request: ${e?.message}` });
			}
			return JSON.stringify(signHostCall(req));
		});
	return binary;
}

const opensslDefines = Object.entries({
	OPENSSL_ALGO_SHA1: 1,
	OPENSSL_ALGO_MD5: 2,
	OPENSSL_ALGO_MD4: 3,
	OPENSSL_ALGO_SHA256: 6,
	OPENSSL_ALGO_SHA384: 7,
	OPENSSL_ALGO_SHA512: 8,
	OPENSSL_ALGO_SHA224: 9,
	OPENSSL_RAW_DATA: 1,
	OPENSSL_ZERO_PADDING: 2,
	OPENSSL_DONT_ZERO_PAD_KEY: 4,
	OPENSSL_PKCS1_PADDING: 1,
	OPENSSL_NO_PADDING: 3,
	OPENSSL_PKCS1_OAEP_PADDING: 4,
	OPENSSL_KEYTYPE_RSA: 0,
	OPENSSL_KEYTYPE_DSA: 1,
	OPENSSL_KEYTYPE_DH: 2,
	OPENSSL_KEYTYPE_EC: 3,
	X509_PURPOSE_SSL_CLIENT: 1,
	X509_PURPOSE_SSL_SERVER: 2,
	X509_PURPOSE_ANY: 7,
	// the feature level node:crypto provides, which callers compare against
	OPENSSL_VERSION_NUMBER: 0x30000000
})
	.map(([name, value]) => `\t\tif (!defined('${name}')) { define('${name}', ${value}); }`)
	.join('\n');

/**
 * The PHP half: the functions, the two key classes and the constants they are called with.
 *
 * No `eval()`, so `php -l` can lint the body. `openssl_verify()` returns 1, 0 or -1 (-1 is an
 * error, not "invalid"); keys and certificates are `OpenSSLAsymmetricKey` and `OpenSSLCertificate`
 * objects (lcobucci/jwt types against them), and every function still accepts a PEM string, a
 * `file://` path or the older two-key array.
 */
export const OPENSSL_FIX = renderTemplate(OPENSSL_FIX_PHP, { OPENSSL_DEFINES: opensslDefines });
