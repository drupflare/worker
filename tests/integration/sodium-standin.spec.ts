import { describe, expect, it } from 'vitest';
import { SODIUM_API } from '../../src/site/generated/sodium-api';
import { EXTENSION_CATALOG } from '../../src/site/shims/extension-table';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The sodium stand-in and the extension table, on the interpreter that ships.
 *
 * The node gate proves each function against native libsodium; this proves the wiring: the
 * built-ins are removed, the fragment runs before anything asks `extension_loaded()`, and a PHP
 * caller sees a loaded extension with the whole API.
 *
 * Needs the interpreter, so it is in `ARTIFACT_SPECS`.
 */

type Json = Record<string, unknown>;

const run = (code: string) =>
	inObject(freshSite(), async (site: ServeDo) => site.runJson(code)) as Promise<Json>;

describe('extension_loaded() over the declared table', () => {
	it('answers true for sodium and gd and false for the partial shims', async () => {
		const out = await run(`<?php echo json_encode([
			'sodium' => extension_loaded('sodium'),
			'upper' => extension_loaded('SODIUM'),
			'gd' => extension_loaded('gd'),
			'curl' => extension_loaded('curl'),
			'openssl' => extension_loaded('openssl'),
			'exif' => extension_loaded('exif'),
			'mbstring' => extension_loaded('mbstring'),
			'zlib' => extension_loaded('ZLIB'),
			'opcache' => extension_loaded('Zend OPcache'),
			'missing' => extension_loaded('no-such-extension'),
		]);`);
		expect(out).toEqual({
			sodium: true,
			upper: true,
			gd: true,
			curl: false,
			openssl: false,
			exif: false,
			mbstring: true,
			zlib: true,
			opcache: true,
			missing: false
		});
	}, 900_000);

	it('lists sodium beside the extensions the binary loads', async () => {
		const out = await run(`<?php echo json_encode([
			'loaded' => get_loaded_extensions(),
			'zend' => get_loaded_extensions(true),
			'funcs' => get_extension_funcs('sodium'),
			'mbFuncs' => in_array('mb_strlen', get_extension_funcs('mbstring'), true),
			'noFuncs' => get_extension_funcs('no-such-extension'),
		]);`);
		const loaded = out['loaded'] as string[];
		expect(loaded).toContain('sodium');
		expect(loaded).toContain('gd');
		for (const name of ['Core', 'mbstring', 'zlib', 'Zend OPcache', 'vrzno', 'Reflection']) {
			expect(loaded).toContain(name);
		}
		expect(loaded.filter((n) => !EXTENSION_CATALOG.includes(n) && n !== 'sodium')).toEqual([]);
		expect(out['zend']).toEqual(['Zend OPcache']);
		expect([...(out['funcs'] as string[])].sort()).toEqual(
			SODIUM_API.functions.map((f) => f.name).sort()
		);
		expect(out['mbFuncs']).toBe(true);
		expect(out['noFuncs']).toBe(false);
	}, 900_000);

	it('cannot make ReflectionExtension agree, and says so', async () => {
		const out = await run(`<?php
			try { new ReflectionExtension('sodium'); $r = 'found'; }
			catch (ReflectionException $e) { $r = 'missing'; }
			echo json_encode(['reflection' => $r, 'loaded' => extension_loaded('sodium')]);`);
		expect(out).toEqual({ reflection: 'missing', loaded: true });
	}, 900_000);
});

describe('the whole sodium API, as PHP sees it', () => {
	it('declares every function, constant and class of the inventory', async () => {
		const names = SODIUM_API.functions.map((f) => f.name);
		const out = await run(`<?php
			$missing = [];
			foreach (${JSON.stringify(names)} as $f) { if (!function_exists($f)) { $missing[] = $f; } }
			$wrong = [];
			foreach (json_decode(base64_decode('${Buffer.from(JSON.stringify(SODIUM_API.constants)).toString('base64')}'), true) as $k => $v) {
				if (!defined($k) || constant($k) !== $v) { $wrong[] = $k; }
			}
			echo json_encode([
				'missing' => $missing,
				'wrong' => $wrong,
				'class' => class_exists('SodiumException') && is_subclass_of('SodiumException', 'Exception'),
			]);`);
		expect(out).toEqual({ missing: [], wrong: [], class: true });
	}, 900_000);

	it('agrees with native libsodium on vectors taken from PHP 8.5.7', async () => {
		const out = await run(`<?php
			$k = hex2bin(str_repeat('0b', 32));
			$n24 = hex2bin(str_repeat('07', 24));
			$n16 = hex2bin(str_repeat('05', 16));
			$kp = sodium_crypto_sign_seed_keypair($k);
			echo json_encode([
				'secretbox' => bin2hex(sodium_crypto_secretbox('hello sodium', $n24, $k)),
				'xchacha' => bin2hex(sodium_crypto_aead_xchacha20poly1305_ietf_encrypt('hello sodium', 'ad', $n24, $k)),
				'aegis' => bin2hex(sodium_crypto_aead_aegis128l_encrypt('hello sodium', 'ad', $n16, substr($k, 0, 16))),
				'hash' => bin2hex(sodium_crypto_generichash('hello sodium')),
				'sig' => bin2hex(sodium_crypto_sign_detached('hello sodium', sodium_crypto_sign_secretkey($kp))),
				'pk' => bin2hex(sodium_crypto_sign_publickey($kp)),
				'verify' => sodium_crypto_sign_verify_detached(sodium_crypto_sign_detached('x', sodium_crypto_sign_secretkey($kp)), 'x', sodium_crypto_sign_publickey($kp)),
				'ristretto' => bin2hex(sodium_crypto_core_ristretto255_from_hash(str_repeat('ab', 32))),
				'argon' => bin2hex(sodium_crypto_pwhash(32, 'pw', str_repeat('s', 16), 2, 65536, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13)),
				'open' => sodium_crypto_secretbox_open(sodium_crypto_secretbox('round trip', $n24, $k), $n24, $k),
			]);`);
		expect(out).toEqual({
			secretbox: '7bc1665e2663a31454a843c611b6aea4ebcf9282aeb15e045c98501c',
			xchacha: 'cec31fdb6c2511409888c19bf18c966dec90d085bc50ebd3e0aa93c9',
			aegis: '01c6ffb3ed6ab232ea50ca936074007e7e81e03c5e188d29481696c637aff81c6c730ceb49237b9099bfcd66',
			hash: '9e8ca0ed816cc89908d9fcf4c6ad5564b55058efc41b02ce45076f30e3531e57',
			sig: '232f104cb4b01f4ffbcedb9d171bcde175cfbdb9014ccdd7996a1eb435c3ed4362b0506d644a20b13a53286ba146bbb0c4dbc84d6a3ed4f315a7f214dabcfd00',
			pk: '66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a',
			verify: true,
			ristretto: '9ae1fb4d06705421432849f3bfa0ac54d9eeeb5b94134aa16747289ceb0d220d',
			argon: 'f2dde1a3c910b85cc4ffc296f93577ce45e3e961775b75138d0aad98a655baca',
			open: 'round trip'
		});
	}, 900_000);

	it('raises what ext-sodium raises, with the class and the message', async () => {
		const out = await run(`<?php
			function t($f) { try { $f(); return 'none'; } catch (Throwable $e) { return get_class($e) . ': ' . $e->getMessage(); } }
			echo json_encode([
				'nonce' => t(fn() => sodium_crypto_secretbox('m', 'n', str_repeat('k', 32))),
				'type' => t(fn() => sodium_crypto_auth([], str_repeat('k', 32))),
				'open' => sodium_crypto_secretbox_open(str_repeat('x', 30), str_repeat('n', 24), str_repeat('k', 32)),
			]);`);
		expect(out).toEqual({
			nonce: 'SodiumException: sodium_crypto_secretbox(): Argument #2 ($nonce) must be SODIUM_CRYPTO_SECRETBOX_NONCEBYTES bytes long',
			type: 'TypeError: sodium_crypto_auth(): Argument #1 ($message) must be of type string, array given',
			open: false
		});
	}, 900_000);

	it('keeps a key out of a stack trace the way the built-in does', async () => {
		const out = await run(`<?php
			try { sodium_crypto_secretbox('m', str_repeat('n', 24), 'short'); }
			catch (Throwable $e) { echo json_encode(['trace' => $e->getTraceAsString(), 'short' => str_contains($e->getTraceAsString(), 'short')]); }`);
		expect(out['short']).toBe(false);
	}, 900_000);
});
