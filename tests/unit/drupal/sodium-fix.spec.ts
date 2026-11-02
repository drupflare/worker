import { describe, expect, it } from 'vitest';
import { SODIUM_API } from '../../../src/site/generated/sodium-api';
import {
	PHP_ONLY_FUNCTIONS,
	SODIUM_FIX,
	sodiumConstantsPhp
} from '../../../src/site/shims/sodium-fix';
import {
	installSodium,
	PWHASH_MEMORY_CAP,
	SODIUM_BRIDGE,
	sodiumFunctions,
	sodiumHostCall,
	type SodiumReply
} from '../../../src/site/shims/sodium-lib';

/**
 * The host half of the sodium bridge and the text of the PHP half.
 *
 * Every function is compared with native libsodium by `tests/node/sodium-conformance.spec.ts`; the
 * published vectors below give this file an oracle of its own, so a machine with no PHP still
 * fails if the bridge stops computing BLAKE2b.
 */

const enc = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
const hexOf = (b64: string) => Buffer.from(b64, 'base64').toString('hex');

function call(f: string, ...a: unknown[]): SodiumReply {
	return sodiumHostCall({ f, a });
}

function str(r: SodiumReply): string {
	if (!r.ok) throw new Error(r.m);
	if (!('s' in r.r)) throw new Error('not a string');
	return r.r.s;
}

/** published BLAKE2b digests; the 512-bit one is RFC 7693 Appendix A */
const VECTORS = [
	{
		msg: 'abc',
		len: 64,
		hex:
			'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
			'7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
	},
	{
		msg: 'abc',
		len: 32,
		hex: 'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319'
	},
	{
		msg: '',
		len: 32,
		hex: '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8'
	}
];

describe('generichash is BLAKE2b', () => {
	it.each(VECTORS)('blake2b-$len of "$msg"', ({ msg, len, hex }) => {
		expect(hexOf(str(call('sodium_crypto_generichash', enc(msg), '', String(len))))).toBe(hex);
	});

	it('gives a different digest at a different length, because outlen is in the parameter block', () => {
		const a = hexOf(str(call('sodium_crypto_generichash', enc('abc'), '', '64')));
		const b = hexOf(str(call('sodium_crypto_generichash', enc('abc'), '', '32')));
		expect(a.slice(0, 64)).not.toBe(b);
	});

	it('digests bytes that are not valid UTF-8, which is why the bridge is base64', () => {
		const raw = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x00]);
		const key = enc(Buffer.alloc(32, 0x6b));
		const plain = str(call('sodium_crypto_generichash', enc(raw), '', '32'));
		expect(plain).not.toBe(str(call('sodium_crypto_generichash', enc(raw), key, '32')));
	});
});

describe('the incremental state is a value, not a handle', () => {
	const init = () => str(call('sodium_crypto_generichash_init', '', '32'));

	function update(state: string, part: string): string {
		const r = call('sodium_crypto_generichash_update', state, enc(part));
		if (!r.ok) throw new Error(r.m);
		return String(r.refs?.[0]);
	}

	it('chunked agrees with the one-shot, which is what Hash::ofStream() relies on', () => {
		let state = init();
		for (const part of ['a', 'b', 'c']) state = update(state, part);
		const fin = call('sodium_crypto_generichash_final', state, '32');
		expect(hexOf(str(fin))).toBe(VECTORS[1]!.hex);
		expect(fin.ok && fin.refs?.[0]).toBeNull();
	});

	it('is 384 bytes, as ext-sodium reports', () => {
		expect(Buffer.from(init(), 'base64').length).toBe(384);
	});

	it('lets two copies of one state go on separately, which a handle table could not', () => {
		const base = update(init(), 'ab');
		const left = update(base, 'c');
		const right = update(base, 'z');
		const a = hexOf(str(call('sodium_crypto_generichash_final', left, '32')));
		const b = hexOf(str(call('sodium_crypto_generichash_final', right, '32')));
		expect(a).toBe(VECTORS[1]!.hex);
		expect(b).toBe(hexOf(str(call('sodium_crypto_generichash', enc('abz'), '', '32'))));
	});

	it('holds no context between calls, so there is nothing to leak or to cap', () => {
		for (let i = 0; i < 200; i++) init();
		expect(hexOf(str(call('sodium_crypto_generichash_final', init(), '32')))).toBe(
			VECTORS[2]!.hex
		);
	});

	it('finishes at a length other than the init length the way libsodium does', () => {
		// libsodium keeps the init length in the parameter block and copies the chaining value out
		const state = init();
		const short = hexOf(str(call('sodium_crypto_generichash_final', state, '16')));
		expect(short).toBe(VECTORS[2]!.hex.slice(0, 32));
	});

	it.each([enc(new Uint8Array(10)), enc(new Uint8Array(383))])(
		'refuses a state that is not one',
		(s) => {
			expect(call('sodium_crypto_generichash_update', s, enc('x'))).toEqual({
				ok: false,
				c: 'SodiumException',
				m: 'incorrect state length'
			});
		}
	);
});

describe('the bridge refuses what ext-sodium refuses', () => {
	it.each([0, 1, 15, 65, 128])('an output length of %s', (len) => {
		expect(call('sodium_crypto_generichash', enc('x'), '', String(len))).toEqual({
			ok: false,
			c: 'SodiumException',
			m: 'unsupported output length'
		});
	});

	it.each([1, 15, 65])('a key of %s bytes', (n) => {
		expect(call('sodium_crypto_generichash', enc('x'), enc(Buffer.alloc(n, 1)), '32')).toEqual({
			ok: false,
			c: 'SodiumException',
			m: 'unsupported key length'
		});
	});

	it('treats an empty key as unkeyed rather than as sixteen zero bytes', () => {
		expect(hexOf(str(call('sodium_crypto_generichash', enc('abc'), '', '32')))).toBe(
			VECTORS[1]!.hex
		);
	});

	it('names an unknown function instead of guessing one', () => {
		expect(call('sodium_nothing')).toEqual({
			ok: false,
			c: 'SodiumException',
			m: 'unknown function sodium_nothing'
		});
	});

	it('words a wrong length the way ext-sodium does, with the constant name', () => {
		expect(call('sodium_crypto_secretbox', enc('m'), enc('n'), enc(Buffer.alloc(32)))).toEqual({
			ok: false,
			c: 'SodiumException',
			m: 'sodium_crypto_secretbox(): Argument #2 ($nonce) must be SODIUM_CRYPTO_SECRETBOX_NONCEBYTES bytes long'
		});
	});

	it('refuses a password hash past the memory cap the way libsodium refuses an allocation', () => {
		const m = PWHASH_MEMORY_CAP / 1024 + 1;
		expect(
			call(
				'sodium_crypto_pwhash',
				'32',
				enc('pw'),
				enc(Buffer.alloc(16)),
				'1',
				String(m * 1024),
				'2'
			)
		).toEqual({ ok: false, c: 'SodiumException', m: 'internal error' });
	});
});

describe('every function of the inventory has a host or a PHP half', () => {
	it('backs all 110 functions, 11 of them in PHP alone', () => {
		const names = SODIUM_API.functions.map((f) => f.name);
		expect(names.length).toBe(110);
		const host = new Set(sodiumFunctions());
		expect(names.filter((n) => !host.has(n) && !PHP_ONLY_FUNCTIONS.has(n))).toEqual([]);
		expect(PHP_ONLY_FUNCTIONS.size).toBe(11);
	});
});

describe('installing it on a PHP module', () => {
	it('hangs the bridge on the key the PHP half resolves', () => {
		const binary: Record<string, unknown> = {};
		installSodium(binary, (fn) => fn());
		expect(typeof binary[SODIUM_BRIDGE]).toBe('function');
		expect(SODIUM_FIX).toContain(`vrzno_env('${SODIUM_BRIDGE}')`);
	});

	it('runs inside the mask, because a hash is a long synchronous frame under the PHP stack', () => {
		let masked = 0;
		const binary: Record<string, unknown> = {};
		installSodium(binary, (fn) => {
			masked++;
			return fn();
		});
		const run = binary[SODIUM_BRIDGE] as (json: string) => string;
		run(JSON.stringify({ f: 'sodium_crypto_generichash', a: [enc('abc'), '', '32'] }));
		expect(masked).toBe(1);
	});

	it('answers rather than throwing on a request that is not JSON', () => {
		const binary: Record<string, unknown> = {};
		installSodium(binary, (fn) => fn());
		const out = JSON.parse((binary[SODIUM_BRIDGE] as (json: string) => string)('not json'));
		expect(out.ok).toBe(false);
		expect(String(out.m)).toContain('unparseable request');
	});
});

describe('the PHP fragment', () => {
	it.each(SODIUM_API.functions.map((f) => f.name))('declares %s()', (fn) => {
		expect(SODIUM_FIX).toContain(`function ${fn}(`);
	});

	it('defines every constant, which is a fatal Error in PHP 8 when absent', () => {
		const lines = sodiumConstantsPhp().split('\n');
		expect(lines.length).toBe(Object.keys(SODIUM_API.constants).length);
		for (const name of Object.keys(SODIUM_API.constants)) {
			expect(SODIUM_FIX).toContain(`define('${name}'`);
		}
	});

	it('takes the state by reference on every function that mutates it', () => {
		// a by-value parameter would make every chunk after the first digest nothing, silently
		expect(SODIUM_FIX).toContain('function sodium_crypto_generichash_update(&$state,');
		expect(SODIUM_FIX).toContain('function sodium_crypto_generichash_final(&$state,');
		expect(SODIUM_FIX).toContain(
			'function sodium_crypto_secretstream_xchacha20poly1305_push(&$state,'
		);
	});

	it('marks key material sensitive, so a stack trace does not print it', () => {
		expect(SODIUM_FIX).toContain(
			'function sodium_crypto_secretbox(#[\\SensitiveParameter] $message, $nonce, #[\\SensitiveParameter] $key)'
		);
	});

	it('declares SodiumException, because every one of these throws rather than returning FALSE', () => {
		expect(SODIUM_FIX).toContain('class SodiumException extends Exception');
	});

	it('guards on its own flag, never on the answer the extension table gives', () => {
		expect(SODIUM_FIX).not.toContain("extension_loaded('sodium')");
		expect(SODIUM_FIX).toContain("!function_exists('cfw_sodium_installed')");
		expect(SODIUM_FIX).toContain("function_exists('vrzno_env')");
	});

	it('declares each wrapper only where the name is free', () => {
		expect(SODIUM_FIX).toContain("if (!function_exists('sodium_crypto_auth'))");
	});

	it('never declares a stub extension, which is what segfaulted the mbstring attempt', () => {
		expect(SODIUM_FIX).not.toContain('get_loaded_extensions');
	});
});
