import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The two P42 host bridges as PHP sees them, on the interpreter that ships.
 *
 * THIS FILE IS THE WIRING GATE, and that is its main job. Both shims are green in the workers lane
 * against their own JavaScript and both would stay green while `src/site-do.ts` installed neither
 * -- which is exactly the shape `src/ops/supervisor.ts` shipped in for months. Nothing else fails
 * when a bridge is imported and never installed, because `vrzno_env()` simply answers NULL and the
 * fragment declares nothing at all.
 *
 * The second describe is a regression guard with a specific cause. The shipping binary DOES load
 * `ext-zlib` -- measured, it is one of the 25 extensions `get_loaded_extensions()` reports -- so
 * everything under `!extension_loaded('zlib')` is inert on the edge. `cfw_zlib_dict()` was written
 * inside that guard first, which would have shipped a capability no site could reach.
 *
 * Needs the interpreter, so it is in `ARTIFACT_SPECS`.
 */

type Json = Record<string, unknown>;

const run = (code: string) =>
	inObject(freshSite(), async (site: ServeDo) => site.runJson(code)) as Promise<Json>;

/** published BLAKE2b digests; the 512-bit one is RFC 7693 Appendix A */
const ABC_512 =
	'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
	'7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923';
const ABC_256 = 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319';
const EMPTY_256 = '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8';

describe('the BLAKE2b bridge, from PHP', () => {
	it("is installed on the binary, computes strata's content address, and streams", async () => {
		const out = await run(`<?php
			$state = sodium_crypto_generichash_init('', 32);
			sodium_crypto_generichash_update($state, 'a');
			sodium_crypto_generichash_update($state, 'bc');
			$streamed = bin2hex(sodium_crypto_generichash_final($state, 32));
			echo json_encode([
				'declared' => function_exists('sodium_crypto_generichash'),
				'extension' => extension_loaded('sodium'),
				'abc256' => bin2hex(sodium_crypto_generichash('abc', '', 32)),
				'abc512' => bin2hex(sodium_crypto_generichash('abc', '', 64)),
				'empty256' => bin2hex(sodium_crypto_generichash('', '', 32)),
				'streamed' => $streamed,
				'voided' => $state === null,
				'keyMax' => SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MAX,
				'bytesMin' => SODIUM_CRYPTO_GENERICHASH_BYTES_MIN,
			]);`);

		// the wiring: false here means src/site-do.ts stopped installing the bridge
		expect(out.declared, 'site-do.ts must install cfwBlake2b before this fragment runs').toBe(
			true
		);
		expect(out.abc256).toBe(ABC_256);
		expect(out.abc512).toBe(ABC_512);
		expect(out.empty256).toBe(EMPTY_256);
		// the streaming form is what Hash::ofStream() drives over a 256 MiB object
		expect(out.streamed).toBe(ABC_256);
		expect(out.voided).toBe(true);
		expect(Number(out.keyMax)).toBe(64);
		expect(Number(out.bytesMin)).toBe(16);
		// and the shim never claims to BE the extension; a stub module entry segfaulted at exit 139
		// when that was tried for mbstring
		expect(out.extension).toBe(false);
	}, 900_000);

	it('digests binary that is not valid UTF-8, which is why the bridge is base64', async () => {
		const out = await run(`<?php
			$raw = "\\x00\\xff\\xfe\\x80A\\x00";
			echo json_encode([
				'digest' => bin2hex(sodium_crypto_generichash($raw, '', 32)),
				'keyed' => bin2hex(sodium_crypto_generichash($raw, str_repeat('k', 32), 32)),
			]);`);
		expect(String(out.digest)).toMatch(/^[0-9a-f]{64}$/);
		// a key that changed nothing would mean the key never crossed the bridge
		expect(out.keyed).not.toBe(out.digest);
	}, 900_000);

	it('throws SodiumException rather than returning a short digest', async () => {
		const out = await run(`<?php
			function attempt($fn) {
				try { $fn(); return 'no throw'; }
				catch (Throwable $e) { return get_class($e) . ': ' . $e->getMessage(); }
			}
			echo json_encode([
				'shortLen' => attempt(fn() => sodium_crypto_generichash('x', '', 8)),
				'longLen' => attempt(fn() => sodium_crypto_generichash('x', '', 65)),
				'shortKey' => attempt(fn() => sodium_crypto_generichash('x', 'k', 32)),
				'notAState' => attempt(function () { $s = 'garbage'; sodium_crypto_generichash_update($s, 'x'); }),
				'classExists' => class_exists('SodiumException'),
			]);`);
		expect(out.shortLen).toBe('SodiumException: unsupported output length');
		expect(out.longLen).toBe('SodiumException: unsupported output length');
		expect(out.shortKey).toBe('SodiumException: unsupported key length');
		// the message ext-sodium itself gives for a string that is not a state, measured on 8.5.7
		expect(out.notAState).toBe('SodiumException: incorrect state length');
		expect(out.classExists).toBe(true);
	}, 900_000);

	it('keeps two open digests apart across bridge calls', async () => {
		const out = await run(`<?php
			$a = sodium_crypto_generichash_init('', 32);
			$b = sodium_crypto_generichash_init('', 32);
			sodium_crypto_generichash_update($a, 'abc');
			sodium_crypto_generichash_update($b, 'zzz');
			echo json_encode([
				'a' => bin2hex(sodium_crypto_generichash_final($a, 32)),
				'b' => bin2hex(sodium_crypto_generichash_final($b, 32)),
				'oneShotB' => bin2hex(sodium_crypto_generichash('zzz', '', 32)),
			]);`);
		expect(out.a).toBe(ABC_256);
		expect(out.b).toBe(out.oneShotB);
	}, 900_000);
});

describe('cfw_zlib_dict, from PHP, on a binary that HAS ext-zlib', () => {
	it('is declared even though every gz* shim beside it is inert', async () => {
		const out = await run(`<?php
			$anchor = str_repeat('body{color:red}', 40);
			$next = $anchor . 'a{b:c}';
			$primed = cfw_zlib_dict('zlib', $next, $anchor, 9);
			echo json_encode([
				'zlibLoaded' => extension_loaded('zlib'),
				'gzShimInert' => !function_exists('cfw_zlib_installed'),
				'declared' => function_exists('cfw_zlib_dict'),
				'primedLen' => strlen((string) $primed),
				'plainLen' => strlen((string) gzcompress($next, 9)),
				'roundTrip' => cfw_zlib_dict('unzlib', $primed, $anchor) === $next,
				'nativeRefuses' => @gzuncompress($primed) === false,
				'wrongDict' => @cfw_zlib_dict('unzlib', $primed, 'a completely different anchor') === false,
				'gzipRefused' => @cfw_zlib_dict('gzip', $next, $anchor, 9) === false,
			]);`);

		// the two halves of the restructure: the extension IS loaded, the gz* block therefore never
		// declared anything, and cfw_zlib_dict is reachable anyway
		expect(out.zlibLoaded).toBe(true);
		expect(out.gzShimInert).toBe(true);
		expect(out.declared, 'site-do.ts must install cfwZlib before this fragment runs').toBe(
			true
		);
		// the dictionary is the whole lever: the anchor is the previous version of the payload
		expect(Number(out.primedLen)).toBeLessThan(Number(out.plainLen));
		expect(out.roundTrip).toBe(true);
		// a zlib stream with FDICT set, which native zlib cannot read because it has no dictionary
		expect(out.nativeRefuses).toBe(true);
		// and the property that chose node:zlib over fflate for this path
		expect(out.wrongDict).toBe(true);
		expect(out.gzipRefused).toBe(true);
	}, 900_000);
});

/**
 * A FIXED 2048-bit RSA keypair, checked in rather than generated.
 *
 * `openssl_pkey_new()` is part of the extension this shim replaces, so PHP here cannot mint one --
 * and generating it in JS per run would make a failure depend on which key was drawn. This is test
 * material and is deliberately not a secret: it exists to be signed with in a spec.
 */
const RSA_PRIVATE_PEM =
	'-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDUo48/eClNajU5\n/eLKqTqp9nQtxx+IRSz+pHxGqQKcrWtLIvUqiitwpLDFXYR+6J4oGovLKQWPUMKY\nX22rCNBtNwpHkGFwgbPTEKRZkuOv1eG3WunJSs5iDDkviArpqCDYLQ8d0COii3p/\nFzXWR0bziSwDAPFTCR7WsyKmkh/qncouHPtqzkdXYPV7VRUni3S3q7Dvrhoqassd\nsBh41K2Nzl2U0wSG5107ySDprnsFblFI7dWBMqMpKmcr5z5rPODlcdFloIQhpVCZ\ne0auAcT0UrhTEiLwZbkMThgmBg4B6wNfdpYML4y4HJGvuVsDfGH5QHXqzI+CCq+u\nlL1/n8r9AgMBAAECggEARv4ejuG25G5Pu/9cTy5F9EXgzwHasLvrxE61YT//K8Eo\nf8r5kIzV6QNLM3HAEUDnwNrwDlGxVgJwHcBKlJ5aPARyzabSKWZcW90EChXlJ6kg\ndX+Ia1iq5AhRtWFVx2IHKTWOBPWfWB76NGFS66obcaa8B3qyl3cFkUf4iyVhO4p7\n99UTfgwT0NXfMvpBOZo8wysToGtQ2/nAy3743f/RHaMq3O08zke/Zc2Xr0pOMcJE\nn9VH2+iNUzTyD482kc5djcTrgSSUcs7P9JKQ9F7FhMrkiQP/AIBX42BcNP3KMGsA\nOUf8CygUtlcAWv4Th+1DJFb/LyHwromYGMJtW4Uf7wKBgQDx0qd7DY++4Oc9D7Gb\n2G+7Vq5LgiBcvWLZYZRYRd/DG022BzVRih4tgpFcM9zrjG8tbfUmkj4Yauljdtjj\nsWVSP+kvpbmyEhnkGDwiCPO08ZVHtI9wmEZKZ9x9mC6X16qWALk0GqfyY1dpNk+3\nJozYGrqbpToFV/6fgOE8kDeo5wKBgQDhGud46/EEUbHQsxWrJAAaKuKtDgxFchoE\neaNXuxhCiVZk98YmHskDwq7lpxgobMVKi7kgjJDbH9n7XXqfuFnd3XunRu9rPkDk\nbitwrujSsNF3Yf+KV52a+gOYI8gt6+aNe6jW72ScJUKYsa8npR4pcvPEZzJPYNcn\nlH8RsWi8ewKBgQCahFPn2N6ExQh8h86hGkcqmVR9gwRSveCvrh4v2VYFQSkCqtBy\n7aIiyk8/bxQ2nmFb0erXXpK233mJyKMFupBXYecKPwbMtaw9hw7FYJr4f3U3gDQ3\nadVgLcVBqz/6Xh/uAUBV/sJZqwhrffyptsRAQbQDSCwuxe841A0Xub8W+QKBgAh+\nhGeKt7CLCKOwbkvj8uEJ5z3SfuIL+TFcCa7gz3yLRChRNTfxB3LN4N2nnYDBAfzb\nIuQ4iarLG+WhVGQ8h5+YoPbh9Vzdn4M/KQJ6hyyUIYNYvlTRE5BqiMIv73jUIwIJ\nvYhGxkwiF849PjfHwkicHti1cC+Qnu3Oa7EWObaLAoGAcHx1Fbe0/kkvJp/MDL+E\nILcSJVA5mgPxzQPYIB1+fKPLNOny/cumNnsYi/8JXBGsSHPVUl8YzyKRrNrmj1Yg\n6Qqpd3H4Hd/10qA4OmHrVYTLkOHuN7t8bJ4NkTIXZIe0P/XwNEeoTTxrkZL9hylJ\neCuL/3sG209FB5FXCx00zcA=\n-----END PRIVATE KEY-----\n';

const RSA_PUBLIC_PEM =
	'-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1KOPP3gpTWo1Of3iyqk6\nqfZ0LccfiEUs/qR8RqkCnK1rSyL1KoorcKSwxV2EfuieKBqLyykFj1DCmF9tqwjQ\nbTcKR5BhcIGz0xCkWZLjr9Xht1rpyUrOYgw5L4gK6agg2C0PHdAjoot6fxc11kdG\n84ksAwDxUwke1rMippIf6p3KLhz7as5HV2D1e1UVJ4t0t6uw764aKmrLHbAYeNSt\njc5dlNMEhuddO8kg6a57BW5RSO3VgTKjKSpnK+c+azzg5XHRZaCEIaVQmXtGrgHE\n9FK4UxIi8GW5DE4YJgYOAesDX3aWDC+MuByRr7lbA3xh+UB16syPggqvrpS9f5/K\n/QIDAQAB\n-----END PUBLIC KEY-----\n';

describe('the curl and openssl shims are LIVE, not inert', () => {
	it('declares both families, because neither extension is loaded', async () => {
		const out = await run(`<?php
			echo json_encode([
				'curlLoaded' => extension_loaded('curl'),
				'opensslLoaded' => extension_loaded('openssl'),
				'curlDeclared' => function_exists('cfw_curl_installed'),
				'opensslDeclared' => function_exists('cfw_openssl_installed'),
				'curlInit' => function_exists('curl_init'),
				'curlExec' => function_exists('curl_exec'),
				'opensslSign' => function_exists('openssl_sign'),
				'opensslVerify' => function_exists('openssl_verify'),
				'curloptUrl' => defined('CURLOPT_URL') ? CURLOPT_URL : null,
				'algoSha256' => defined('OPENSSL_ALGO_SHA256') ? OPENSSL_ALGO_SHA256 : null,
			]);`);

		// THE TRAP THIS EXISTS FOR is the one cfw_zlib_dict fell into above: a shim guarded on
		// `!extension_loaded(...)` is DECORATIVE if the build actually loads the extension. zlib is
		// loaded and its gz* block never runs; these two are not, so the guards must have passed
		expect(out.curlLoaded).toBe(false);
		expect(out.opensslLoaded).toBe(false);
		expect(out.curlDeclared, 'curl-fix did not run or its guard refused').toBe(true);
		expect(out.opensslDeclared, 'openssl-fix did not run or its guard refused').toBe(true);

		// and the functions an unmodified SDK actually reaches for
		expect(out.curlInit).toBe(true);
		expect(out.curlExec).toBe(true);
		expect(out.opensslSign).toBe(true);
		expect(out.opensslVerify).toBe(true);
		// an undefined constant is a PHP 8 fatal, so a caller composing a request needs these
		expect(Number(out.curloptUrl)).toBe(10002);
		expect(Number(out.algoSha256)).toBe(6);
	}, 900_000);

	it('signs and verifies a real RSA key from PHP, through the bridge', async () => {
		const out = await run(`<?php
			// a fixed 2048-bit key: openssl_pkey_new() needs the extension this shim replaces
			$key = ${JSON.stringify(RSA_PRIVATE_PEM)};
			$pub = ${JSON.stringify(RSA_PUBLIC_PEM)};
			$sig = '';
			$signed = openssl_sign('the payload', $sig, $key, OPENSSL_ALGO_SHA256);
			echo json_encode([
				'signed' => $signed,
				'sigLen' => strlen($sig),
				'good' => openssl_verify('the payload', $sig, $pub, OPENSSL_ALGO_SHA256),
				'tampered' => openssl_verify('other bytes', $sig, $pub, OPENSSL_ALGO_SHA256),
				'brokenKey' => openssl_verify('the payload', $sig, 'not a pem', OPENSSL_ALGO_SHA256),
			]);`);

		expect(out.signed).toBe(true);
		expect(Number(out.sigLen)).toBe(256);
		// the tri-state, end to end: 1 valid, 0 read-and-rejected, -1 the call itself failed.
		// Collapsing the last two would report a broken key as a forged token
		expect(Number(out.good)).toBe(1);
		expect(Number(out.tampered)).toBe(0);
		expect(Number(out.brokenKey)).toBe(-1);
	}, 900_000);
});
