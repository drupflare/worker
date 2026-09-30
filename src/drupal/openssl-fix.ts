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
import { base64ToBytes, bytesToBase64 } from '../db/file-store.js';

/**
 * `openssl_sign()` and `openssl_verify()` over `node:crypto`, synchronously.
 *
 * The premise this was scoped under was wrong. It read "crypto.subtle covers RS256/ES256 but is
 * **async**, so it takes the queue/read-later pair", which would have made every signature a
 * two-invocation round trip through a deferred queue. Measured 2026-08-23 in workerd: `node:crypto`
 * exposes `createSign`/`createVerify` and they are SYNCHRONOUS -- a 2048-bit RS256 signature comes
 * back in-line, 256 bytes. So this is an ordinary bridge like `cfwZlib`, not a deferred one.
 *
 * WHY `openssl_*` RATHER THAN A NEW `cfwSign()` FUNCTION. An unmodified module is the whole
 * claim. `firebase/php-jwt`, Google's auth client and Stripe's webhook verifier all call
 * `openssl_sign()`/`openssl_verify()` directly, so shimming the names PHP already uses makes them
 * work untouched. A new function would have required every one of them to be patched.
 *
 * WHAT IS HERE NOW, AND WHY IT GREW. The scope above was two functions and a note that the rest had
 * "no caller in this project". Three of the four names `ShimRegistry` refused turned out to have a
 * measured synchronous primitive behind them AND a named caller -- `openssl_pkey_get_public()` is
 * what turns a JWKS entry into something `openssl_verify()` accepts, which is the missing step in
 * every OIDC library. Measured in workerd, every call synchronous: `generateKeyPairSync` produced an
 * RSA-2048 SPKI PEM of 451 bytes, `createPublicKey({key: jwk, format: 'jwk'}).export()` returned
 * bytes IDENTICAL to that PEM, and `privateEncrypt` returned 256.
 *
 * THE SYMMETRIC HALF, KEY DETAILS AND CERTIFICATES are here too, because every SSO and OAuth library
 * in real sites needs them: `openssl_encrypt`/`openssl_decrypt` (AES CBC, CTR, ECB and GCM) for
 * defuse/php-encryption and xmlseclibs, `openssl_pkey_get_details` for league/oauth2-server and
 * lcobucci/jwt, `openssl_x509_*` for php-saml, OAEP `openssl_public_encrypt` for XML encryption, and
 * `openssl_pkey_derive` (ECDH) for web push. Each is one synchronous `node:crypto` call.
 *
 * WHAT IS STILL NOT HERE. `openssl_csr_new` and the PKCS#7/CMS family. `node:crypto` has no
 * certificate-request primitive at all, so that one is absent rather than unimplemented, and it
 * stays refused with the reason named. `openssl_x509_checkpurpose` needs a trust store and purpose
 * table this runtime does not carry, so it answers -1 and records a degradation.
 */

/** the Module key the PHP half resolves through `vrzno_env()` */
export const SIGN_BRIDGE = 'cfwSign';

/**
 * PHP's `OPENSSL_ALGO_*` values mapped to the digest names `node:crypto` takes.
 *
 * The numbers are ext-openssl's own and are stable; they are spelled as literals because the
 * extension is absent, so the constants do not exist to read. `getHashes()` in workerd reports
 * sha1/sha224/sha256/sha384/sha512 among others, so every entry here is backed.
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
 * One sign or verify, decoded.
 *
 * Exported so the gate can drive both ops without a Durable Object.
 *
 * @internal
 */
export function signHostCall(req: SignRequest): SignReply {
	try {
		// the ops that take no digest, answered before the algorithm lookup: a key operation has no
		// algorithm and rejecting one for an absent digest would be a confusing lie
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
			// A JWKS ENTRY OR A PEM, and the first is the reason this exists: every OIDC library
			// fetches a key SET and hands the entry to `openssl_verify()`, which takes a PEM
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
			// `end()` before `verify()`; node throws "Digest already called" otherwise, which
			// would read as a bad key rather than as a misuse of the stream
			v.end();
			return { ok: true, valid: v.verify(key, base64ToBytes(String(req.sigB64 ?? ''))) };
		}

		const s = createSign(digest);
		s.update(data);
		s.end();
		return { ok: true, sigB64: bytesToBase64(new Uint8Array(s.sign(key))) };
	} catch (e: any) {
		// a bad key or a bad signature is a normal outcome for these functions, not a fault:
		// `openssl_verify()` answers -1 on error and FALSE is what `openssl_sign()` returns
		return { ok: false, error: String(e?.message ?? e) };
	}
}

/** the shape `installSign` needs of a PHP binary, so it can be driven from a test */
export type SignBinary = Record<string, unknown>;

/**
 * Installs the bridge on the PHP Module.
 *
 * Masked for the same reason the zlib bridge is: an RSA signature is a long synchronous JavaScript
 * frame under the PHP stack, and that is exactly the window a slice interrupt must not suspend
 * across.
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
 * No `eval()`, like `zlib-fix`: a conditional declaration binds at runtime, so this compiles clean
 * on a build that HAS ext-openssl and the branch never runs. That is what lets
 * `tests/node/php-fragments.spec.ts` lint the body.
 *
 * `openssl_sign()` takes its signature by REFERENCE and returns a bool, which is the shape callers
 * check; `openssl_verify()` returns 1, 0 or -1, where -1 is "an error occurred" rather than
 * "invalid". Getting that tri-state wrong would make a failed verification look like a successful
 * rejection, so the three are kept distinct.
 *
 * Keys and certificates are `OpenSSLAsymmetricKey` and `OpenSSLCertificate` objects, declared here
 * because the extension that owns those names is absent. lcobucci/jwt and league/oauth2-server type
 * against them, so a PEM string where an object belongs is a TypeError. Every function still accepts
 * a PEM string, a `file://` path or the older two-key array wherever ext-openssl accepts a key.
 */
export const OPENSSL_FIX = String.raw`
if (!extension_loaded('openssl') && !function_exists('cfw_openssl_installed')) {
	$__cfw_sign = function_exists('vrzno_env') ? vrzno_env('${SIGN_BRIDGE}') : null;
	if ($__cfw_sign !== null) {
		$GLOBALS['__cfw_sign'] = $__cfw_sign;
		$GLOBALS['__cfw_openssl_errors'] = [];

${opensslDefines}
		if (!defined('OPENSSL_VERSION_TEXT')) { define('OPENSSL_VERSION_TEXT', 'BoringSSL (node:crypto)'); }

		if (!class_exists('OpenSSLAsymmetricKey', false)) {
			/**
			 * A key, holding PEM text rather than a native handle.
			 */
			final class OpenSSLAsymmetricKey {
				public function __construct(
					public readonly string $cfwPublicPem,
					public readonly string $cfwPrivatePem = '',
				) {}
			}
		}
		if (!class_exists('OpenSSLCertificate', false)) {
			/**
			 * A certificate, holding its PEM text.
			 */
			final class OpenSSLCertificate {
				public function __construct(public readonly string $cfwPem) {}
			}
		}

		function cfw_openssl_installed() { return true; }

		/**
		 * Runs one op over the bridge.
		 *
		 * @return array
		 *   The decoded reply, always with an 'ok' key.
		 */
		function cfw_sign_call($payload) {
			$fn = $GLOBALS['__cfw_sign'];
			$reply = json_decode($fn(json_encode($payload)), true);
			if (!is_array($reply)) { $reply = ['ok' => false, 'error' => 'unreadable reply']; }
			if (($reply['ok'] ?? false) !== true) {
				$GLOBALS['__cfw_openssl_errors'][] = (string) ($reply['error'] ?? 'failed');
			}
			return $reply;
		}

		/**
		 * Declares a failure to the operator, the way curl-fix.ts does.
		 *
		 * A per-call trigger_error reaches the log and never the status report, and a failed verify
		 * had neither -- so a caller misreading -1 as "forged" was invisible from outside.
		 */
		function cfw_openssl_degraded($capability, $why) {
			if (class_exists('Drupal\drupflare\Degradation')) {
				Drupal\drupflare\Degradation::record($capability, $why);
			}
		}

		/**
		 * The PEM text for whatever ext-openssl would accept as a key or certificate.
		 *
		 * @param string $want
		 *   'private' for the private half, 'public' for the public half or a certificate.
		 */
		function cfw_openssl_pem($key, $want) {
			if ($key instanceof OpenSSLAsymmetricKey) {
				return $want === 'private' && $key->cfwPrivatePem !== '' ? $key->cfwPrivatePem : $key->cfwPublicPem;
			}
			if ($key instanceof OpenSSLCertificate) { return $key->cfwPem; }
			if (is_array($key) && (isset($key['private']) || isset($key['public']))) {
				return (string) ($key[$want] ?? ($key['private'] ?? ''));
			}
			if (is_array($key)) { $key = $key[0] ?? ''; }
			$key = (string) $key;
			if (str_starts_with($key, 'file://')) {
				$read = @file_get_contents(substr($key, 7));
				return $read === false ? '' : $read;
			}
			return $key;
		}

		function openssl_error_string() {
			return array_shift($GLOBALS['__cfw_openssl_errors']) ?? false;
		}

		function openssl_random_pseudo_bytes($length, &$strong_result = null) {
			$strong_result = true;
			return random_bytes(max(1, (int) $length));
		}

		function openssl_get_cipher_methods($aliases = false) {
			$out = [];
			foreach ([128, 192, 256] as $bits) {
				foreach (['cbc', 'ctr', 'ecb', 'gcm'] as $mode) { $out[] = 'aes-' . $bits . '-' . $mode; }
			}
			return $out;
		}

		/**
		 * Key and IV length for a supported cipher, or NULL.
		 *
		 * @return array|null
		 *   [key bytes, iv bytes].
		 */
		function cfw_openssl_cipher($cipher) {
			if (!preg_match('/^aes-(128|192|256)-(cbc|ctr|ecb|gcm)$/', strtolower((string) $cipher), $m)) { return null; }
			$iv = ['cbc' => 16, 'ctr' => 16, 'ecb' => 0, 'gcm' => 12][$m[2]];
			return [intdiv((int) $m[1], 8), $iv, $m[2]];
		}

		function openssl_cipher_iv_length($cipher_algo) {
			$c = cfw_openssl_cipher($cipher_algo);
			if ($c === null) {
				trigger_error('openssl_cipher_iv_length(): Unknown cipher algorithm', E_USER_WARNING);
				return false;
			}
			return $c[1];
		}

		function openssl_cipher_key_length($cipher_algo) {
			$c = cfw_openssl_cipher($cipher_algo);
			if ($c === null) {
				trigger_error('openssl_cipher_key_length(): Unknown cipher algorithm', E_USER_WARNING);
				return false;
			}
			return $c[0];
		}

		/**
		 * The shared half of encrypt and decrypt: key and IV sized the way ext-openssl sizes them.
		 *
		 * A short key is padded with NUL and a long one truncated, silently, as ext-openssl does.
		 * A short IV is padded with a warning; a GCM IV keeps whatever length the caller gave.
		 */
		function cfw_openssl_crypt($dir, $data, $cipher_algo, $passphrase, $options, $iv, $tag, $aad, $tag_length) {
			$c = cfw_openssl_cipher($cipher_algo);
			if ($c === null) {
				trigger_error('openssl_' . ($dir === 'enc' ? 'encrypt' : 'decrypt') . '(): Unknown cipher algorithm', E_USER_WARNING);
				return false;
			}
			[$keyLen, $ivLen, $mode] = $c;
			$key = substr(str_pad((string) $passphrase, $keyLen, "\0"), 0, $keyLen);
			$iv = (string) $iv;
			if ($mode !== 'gcm' && strlen($iv) !== $ivLen) {
				if ($ivLen > 0 && strlen($iv) < $ivLen) {
					trigger_error('openssl_' . ($dir === 'enc' ? 'encrypt' : 'decrypt') . '(): IV passed is only ' . strlen($iv) . ' bytes long, cipher expects an IV of precisely ' . $ivLen . ' bytes, padding with \\0', E_USER_WARNING);
				}
				$iv = substr(str_pad($iv, $ivLen, "\0"), 0, $ivLen);
			}
			$raw = (bool) ((int) $options & 1);
			$bytes = (string) $data;
			if ($dir === 'dec' && !$raw) {
				$bytes = base64_decode($bytes, true);
				if ($bytes === false) { return false; }
			}
			$payload = [
				'op' => 'cipher',
				'dir' => $dir,
				'cipher' => strtolower((string) $cipher_algo),
				'b64' => base64_encode($bytes),
				'keyB64' => base64_encode($key),
				'ivB64' => base64_encode($iv),
				'padding' => !((int) $options & 2),
				'tagLength' => (int) $tag_length,
			];
			if ($mode === 'gcm') {
				if ((string) $aad !== '') { $payload['aadB64'] = base64_encode((string) $aad); }
				if ($dir === 'dec') { $payload['tagB64'] = base64_encode((string) $tag); }
			}
			return cfw_sign_call($payload);
		}

		function openssl_encrypt($data, $cipher_algo, $passphrase, $options = 0, $iv = '', &$tag = null, $aad = '', $tag_length = 16) {
			$r = cfw_openssl_crypt('enc', $data, $cipher_algo, $passphrase, $options, $iv, null, $aad, $tag_length);
			if (!is_array($r) || ($r['ok'] ?? false) !== true) { return false; }
			if (isset($r['tagB64'])) { $tag = base64_decode((string) $r['tagB64'], true); }
			$out = base64_decode((string) ($r['b64'] ?? ''), true);
			if ($out === false) { return false; }
			return ((int) $options & 1) ? $out : base64_encode($out);
		}

		function openssl_decrypt($data, $cipher_algo, $passphrase, $options = 0, $iv = '', $tag = null, $aad = '') {
			$r = cfw_openssl_crypt('dec', $data, $cipher_algo, $passphrase, $options, $iv, $tag, $aad, $tag === null ? 16 : strlen((string) $tag));
			if (!is_array($r) || ($r['ok'] ?? false) !== true) { return false; }
			return base64_decode((string) ($r['b64'] ?? ''), true);
		}

		function openssl_sign($data, &$signature, $private_key, $algorithm = 6) {
			$r = cfw_sign_call([
				'op' => 'sign',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($private_key, 'private'),
				'algo' => (int) $algorithm,
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_sign(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				cfw_openssl_degraded('openssl signing', 'a signature could not be produced: ' . (string) ($r['error'] ?? 'no reason given'));
				return false;
			}
			$signature = base64_decode((string) ($r['sigB64'] ?? ''), true);
			return $signature !== false;
		}

		/**
		 * Answers 1, 0 or -1, matching ext-openssl.
		 *
		 * -1 means the call itself failed -- an unreadable key, an unsupported digest -- and is NOT
		 * the same as 0, which means the signature was read and did not match. A caller treating
		 * -1 as "invalid" would report a broken key as a forged token.
		 */
		function openssl_verify($data, $signature, $public_key, $algorithm = 6) {
			$r = cfw_sign_call([
				'op' => 'verify',
				'b64' => base64_encode((string) $data),
				'sigB64' => base64_encode((string) $signature),
				'key' => cfw_openssl_pem($public_key, 'public'),
				'algo' => (int) $algorithm,
			]);
			if (($r['ok'] ?? false) !== true) {
				cfw_openssl_degraded('openssl verification', 'a signature could not be checked, so callers see -1 rather than a verdict: ' . (string) ($r['error'] ?? 'no reason given'));
				return -1;
			}
			return ($r['valid'] ?? false) === true ? 1 : 0;
		}

		/**
		 * Turns a PEM, a certificate or a JWKS entry into a public key openssl_verify() accepts.
		 *
		 * THE MISSING STEP IN EVERY OIDC LIBRARY. A provider publishes a key SET, the library reads
		 * the entry it needs and hands it here.
		 *
		 * @return OpenSSLAsymmetricKey|false
		 *   The public key, or FALSE.
		 */
		function openssl_pkey_get_public($public_key) {
			$payload = ['op' => 'pkeyGetPublic'];
			if (is_array($public_key) && isset($public_key['kty'])) {
				$payload['jwk'] = $public_key;
			} else {
				$payload['key'] = cfw_openssl_pem($public_key, 'public');
			}
			$r = cfw_sign_call($payload);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_pkey_get_public(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			return new OpenSSLAsymmetricKey((string) ($r['pem'] ?? ''));
		}

		function openssl_get_publickey($public_key) {
			return openssl_pkey_get_public($public_key);
		}

		/**
		 * Reads a private key, decrypting it with the passphrase when one was used to write it.
		 *
		 * @return OpenSSLAsymmetricKey|false
		 *   The key, or FALSE.
		 */
		function openssl_pkey_get_private($private_key, $passphrase = null) {
			$payload = ['op' => 'pkeyGetPrivate', 'key' => cfw_openssl_pem($private_key, 'private')];
			if ($passphrase !== null && $passphrase !== '') { $payload['passphrase'] = (string) $passphrase; }
			$r = cfw_sign_call($payload);
			if (($r['ok'] ?? false) !== true) { return false; }
			return new OpenSSLAsymmetricKey((string) ($r['publicPem'] ?? ''), (string) ($r['privatePem'] ?? ''));
		}

		function openssl_get_privatekey($private_key, $passphrase = null) {
			return openssl_pkey_get_private($private_key, $passphrase);
		}

		/**
		 * What ext-openssl reports about a key: bits, the public PEM, the type and its parameters.
		 *
		 * @return array|false
		 *   The details, or FALSE.
		 */
		function openssl_pkey_get_details($key) {
			$pem = cfw_openssl_pem($key, 'private');
			$r = cfw_sign_call(['op' => 'pkeyDetails', 'key' => $pem]);
			if (($r['ok'] ?? false) !== true) { return false; }
			$d = (array) ($r['details'] ?? []);
			$types = ['rsa' => 0, 'dsa' => 1, 'dh' => 2, 'ec' => 3];
			$out = [
				'bits' => (int) ($d['bits'] ?? 0),
				'key' => (string) ($d['publicPem'] ?? ''),
				'type' => $types[(string) ($d['keyType'] ?? '')] ?? -1,
			];
			foreach (['rsa', 'ec'] as $family) {
				if (isset($d[$family]) && is_array($d[$family])) {
					$params = [];
					foreach ($d[$family] as $k => $v) {
						$params[$k] = in_array($k, ['curve_name', 'curve_oid'], true) ? (string) $v : base64_decode((string) $v, true);
					}
					$out[$family] = $params;
				}
			}
			return $out;
		}

		/**
		 * A new RSA or EC key pair.
		 *
		 * @return OpenSSLAsymmetricKey|false
		 *   The key, or FALSE.
		 */
		function openssl_pkey_new($options = null) {
			$options = is_array($options) ? $options : [];
			$payload = ['op' => 'pkeyNew', 'bits' => (int) ($options['private_key_bits'] ?? 2048)];
			if (($options['private_key_type'] ?? 0) === 3 || isset($options['curve_name'])) {
				$payload['type'] = 'ec';
				$payload['curve'] = (string) ($options['curve_name'] ?? 'prime256v1');
			}
			$r = cfw_sign_call($payload);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_pkey_new(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			return new OpenSSLAsymmetricKey((string) ($r['publicPem'] ?? ''), (string) ($r['privatePem'] ?? ''));
		}

		/**
		 * Writes a private key out as PEM.
		 *
		 * PASSPHRASES ARE REFUSED rather than ignored. ext-openssl encrypts the output when one is
		 * given, and answering with an UNENCRYPTED key to a caller who asked for an encrypted one
		 * would hand them a secret they believe is protected.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_pkey_export($key, &$out, $passphrase = null) {
			if ($passphrase !== null && $passphrase !== '') {
				trigger_error('openssl_pkey_export(): a passphrase is not supported here', E_USER_WARNING);
				return false;
			}
			$r = cfw_sign_call(['op' => 'pkeyExport', 'key' => cfw_openssl_pem($key, 'private')]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_pkey_export(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			$out = (string) ($r['pem'] ?? '');
			return $out !== '';
		}

		/**
		 * ECDH: the shared secret between a private key and a peer public key.
		 *
		 * @return string|false
		 *   The secret, or FALSE.
		 */
		function openssl_pkey_derive($public_key, $private_key, $key_length = 0) {
			$r = cfw_sign_call([
				'op' => 'derive',
				'peer' => cfw_openssl_pem($public_key, 'public'),
				'key' => cfw_openssl_pem($private_key, 'private'),
			]);
			if (($r['ok'] ?? false) !== true) { return false; }
			$out = base64_decode((string) ($r['b64'] ?? ''), true);
			return ($out !== false && $key_length > 0) ? substr($out, 0, (int) $key_length) : $out;
		}

		function openssl_pkey_free($key) {}
		function openssl_free_key($key) {}
		function openssl_x509_free($certificate) {}

		/**
		 * RSA sign-with-private, which is what a legacy licence check or an older SSO handshake uses.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_private_encrypt($data, &$encrypted_data, $private_key, $padding = 1) {
			$r = cfw_sign_call([
				'op' => 'privateEncrypt',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($private_key, 'private'),
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_private_encrypt(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			$encrypted_data = base64_decode((string) ($r['b64'] ?? ''), true);
			return $encrypted_data !== false;
		}

		/**
		 * The other half of the pair above.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_public_decrypt($data, &$decrypted_data, $public_key, $padding = 1) {
			$r = cfw_sign_call([
				'op' => 'publicDecrypt',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($public_key, 'public'),
			]);
			if (($r['ok'] ?? false) !== true) {
				trigger_error('openssl_public_decrypt(): ' . (string) ($r['error'] ?? 'failed'), E_USER_WARNING);
				return false;
			}
			$decrypted_data = base64_decode((string) ($r['b64'] ?? ''), true);
			return $decrypted_data !== false;
		}

		/**
		 * Encrypt to a public key, PKCS#1 v1.5 or OAEP, which is how XML encryption wraps its key.
		 *
		 * @return bool
		 *   TRUE on success.
		 */
		function openssl_public_encrypt($data, &$encrypted_data, $public_key, $padding = 1) {
			$r = cfw_sign_call([
				'op' => 'publicEncrypt',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($public_key, 'public'),
				'pad' => (int) $padding,
			]);
			if (($r['ok'] ?? false) !== true) { return false; }
			$encrypted_data = base64_decode((string) ($r['b64'] ?? ''), true);
			return $encrypted_data !== false;
		}

		function openssl_private_decrypt($data, &$decrypted_data, $private_key, $padding = 1) {
			$r = cfw_sign_call([
				'op' => 'privateDecrypt',
				'b64' => base64_encode((string) $data),
				'key' => cfw_openssl_pem($private_key, 'private'),
				'pad' => (int) $padding,
			]);
			if (($r['ok'] ?? false) !== true) { return false; }
			$decrypted_data = base64_decode((string) ($r['b64'] ?? ''), true);
			return $decrypted_data !== false;
		}

		/**
		 * Reads a certificate from PEM, a file:// path or another certificate.
		 *
		 * @return OpenSSLCertificate|false
		 *   The certificate, or FALSE.
		 */
		function openssl_x509_read($certificate) {
			$r = cfw_sign_call(['op' => 'x509Export', 'key' => cfw_openssl_pem($certificate, 'public')]);
			if (($r['ok'] ?? false) !== true) { return false; }
			return new OpenSSLCertificate((string) ($r['pem'] ?? ''));
		}

		function openssl_x509_export($certificate, &$output, $no_text = true) {
			$cert = openssl_x509_read($certificate);
			if ($cert === false) { return false; }
			$output = $cert->cfwPem;
			return true;
		}

		function openssl_x509_fingerprint($certificate, $digest_algo = 'sha1', $binary = false) {
			$r = cfw_sign_call([
				'op' => 'x509Fingerprint',
				'key' => cfw_openssl_pem($certificate, 'public'),
				'digest' => strtolower((string) $digest_algo),
			]);
			if (($r['ok'] ?? false) !== true) { return false; }
			$hex = (string) ($r['hex'] ?? '');
			return $binary ? hex2bin($hex) : $hex;
		}

		/**
		 * The fields of a certificate that node:crypto exposes, under ext-openssl's key names.
		 *
		 * @return array|false
		 *   The parsed certificate, or FALSE.
		 */
		function openssl_x509_parse($certificate, $short_names = true) {
			$r = cfw_sign_call(['op' => 'x509Parse', 'key' => cfw_openssl_pem($certificate, 'public')]);
			if (($r['ok'] ?? false) !== true) { return false; }
			return (array) ($r['parsed'] ?? []);
		}

		/**
		 * Purpose checking needs a trust store and purpose table this runtime does not carry.
		 *
		 * @return int
		 *   -1, which ext-openssl uses for "could not be determined".
		 */
		function openssl_x509_checkpurpose($certificate, $purpose, $ca_info = [], $untrusted_certificates_file = null) {
			cfw_openssl_degraded('openssl_x509_checkpurpose', 'there is no trust store or purpose table here, so the answer is -1 (undetermined)');
			return -1;
		}
	}
}
`;
