import { describe, expect, it } from 'vitest';
import {
	BLAKE2B_BRIDGE,
	blake2bHostCall,
	emptyStates,
	GENERICHASH_BYTES_MAX,
	GENERICHASH_BYTES_MIN,
	installBlake2b,
	MAX_OPEN_STATES,
	readKey,
	SODIUM_FIX,
	validLength,
	type Blake2bBinary
} from '../../../src/drupal/sodium-fix';

/**
 * The host half of the BLAKE2b bridge, and the text of the PHP half.
 *
 * The digest itself is oracle-tested elsewhere: `bun run measure:blake2b-parity` runs 448
 * generated cases plus 3 published vectors through this same `blake2bHostCall()` with native
 * `ext-sodium` as the oracle, which is the only comparison that can say the algorithm is right.
 * What this file covers is everything around it -- the state table, the refusals, the mask, and
 * the fragment's shape -- none of which a digest comparison would notice.
 *
 * The three vectors below are repeated here rather than only in the script so the gate has an
 * oracle of its own; a machine with no PHP still fails if the bridge stops computing BLAKE2b.
 */

const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const hexOf = (b64: string) => Buffer.from(b64, 'base64').toString('hex');

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

function oneShot(msg: string, len = 32, key64 = ''): string {
	const r = blake2bHostCall({ op: 'hash', b64: enc(msg), key64, len }, emptyStates());
	if (!r.ok) throw new Error(r.error);
	return hexOf(r.b64 ?? '');
}

describe('the BLAKE2b bridge computes BLAKE2b', () => {
	it.each(VECTORS)('blake2b-$len of "$msg"', ({ msg, len, hex }) => {
		expect(oneShot(msg, len)).toBe(hex);
	});

	it('gives a different digest at a different length, because outlen is in the parameter block', () => {
		// the property that makes a truncated 64-byte digest the WRONG answer for a 32-byte one,
		// and the reason `final()` refuses a length that disagrees with `init()`
		expect(oneShot('abc', 64).slice(0, 64)).not.toBe(oneShot('abc', 32));
	});

	it('keys the digest, so a key is not decoration', () => {
		const key64 = Buffer.alloc(32, 0x6b).toString('base64');
		expect(oneShot('abc', 32, key64)).not.toBe(oneShot('abc', 32));
	});

	it('digests bytes that are not valid UTF-8, which is why the bridge is base64', () => {
		const raw = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x00]);
		const r = blake2bHostCall(
			{ op: 'hash', b64: raw.toString('base64'), len: 32 },
			emptyStates()
		);
		expect(r.ok).toBe(true);
		expect(r.ok && (r.b64 ?? '').length).toBeGreaterThan(0);
	});
});

describe('the incremental form shares one context across calls', () => {
	it('chunked agrees with the one-shot, which is the whole point of Hash::ofStream()', () => {
		const states = emptyStates();
		const init = blake2bHostCall({ op: 'init', len: 32 }, states);
		expect(init.ok).toBe(true);
		const state = init.ok ? init.state : 0;
		for (const part of ['a', 'b', 'c']) {
			expect(blake2bHostCall({ op: 'update', state, b64: enc(part) }, states).ok).toBe(true);
		}
		const fin = blake2bHostCall({ op: 'final', state, len: 32 }, states);
		expect(fin.ok).toBe(true);
		expect(hexOf((fin.ok && fin.b64) || '')).toBe(oneShot('abc'));
	});

	it('releases the context on final, so a second final cannot answer', () => {
		const states = emptyStates();
		const init = blake2bHostCall({ op: 'init', len: 32 }, states);
		const state = init.ok ? init.state : 0;
		expect(blake2bHostCall({ op: 'final', state, len: 32 }, states).ok).toBe(true);
		expect(states.open.size).toBe(0);
		const again = blake2bHostCall({ op: 'final', state, len: 32 }, states);
		expect(again).toEqual({ ok: false, error: 'incorrect state length' });
	});

	it('refuses a final length that disagrees with init, where ext-sodium leaks state bytes', () => {
		// MEASURED on native 8.5.7: final($state, 64) on a state inited at 32 returns the 32-byte
		// digest followed by 32 bytes of adjacent memory, which is not a digest at any length.
		// Refusing is a deliberate divergence and the only one the parity run reports
		const states = emptyStates();
		const init = blake2bHostCall({ op: 'init', len: 32 }, states);
		const state = init.ok ? init.state : 0;
		expect(blake2bHostCall({ op: 'final', state, len: 64 }, states)).toEqual({
			ok: false,
			error: 'unsupported output length'
		});
		// and the context is released rather than left open for a retry that cannot work
		expect(states.open.size).toBe(0);
	});

	it('keeps several digests apart', () => {
		const states = emptyStates();
		const a = blake2bHostCall({ op: 'init', len: 32 }, states);
		const b = blake2bHostCall({ op: 'init', len: 32 }, states);
		const sa = a.ok ? a.state : 0;
		const sb = b.ok ? b.state : 0;
		expect(sa).not.toBe(sb);
		blake2bHostCall({ op: 'update', state: sa, b64: enc('abc') }, states);
		blake2bHostCall({ op: 'update', state: sb, b64: enc('zzz') }, states);
		const fa = blake2bHostCall({ op: 'final', state: sa, len: 32 }, states);
		const fb = blake2bHostCall({ op: 'final', state: sb, len: 32 }, states);
		expect(hexOf((fa.ok && fa.b64) || '')).toBe(oneShot('abc'));
		expect(hexOf((fb.ok && fb.b64) || '')).toBe(oneShot('zzz'));
	});

	it('refuses past the open-state cap rather than evicting a live context', () => {
		// evicting would make a later final() answer a digest over PART of the message, and a
		// wrong content address is worse than a failed one
		const states = emptyStates();
		for (let i = 0; i < MAX_OPEN_STATES; i++) {
			expect(blake2bHostCall({ op: 'init', len: 32 }, states).ok).toBe(true);
		}
		const over = blake2bHostCall({ op: 'init', len: 32 }, states);
		expect(over.ok).toBe(false);
		expect(over.ok === false && over.error).toContain(String(MAX_OPEN_STATES));
		expect(states.open.size).toBe(MAX_OPEN_STATES);
	});
});

describe('the bridge refuses what ext-sodium refuses', () => {
	it.each([0, 1, 15, 65, 128, 2.5])('an output length of %s', (len) => {
		expect(validLength(len)).toBe(false);
		expect(blake2bHostCall({ op: 'hash', b64: enc('x'), len }, emptyStates())).toEqual({
			ok: false,
			error: 'unsupported output length'
		});
	});

	it.each([GENERICHASH_BYTES_MIN, 32, GENERICHASH_BYTES_MAX])('accepts %s', (len) => {
		expect(validLength(len)).toBe(true);
	});

	it.each([1, 15, 65])('a key of %s bytes', (n) => {
		const key64 = Buffer.alloc(n, 0x6b).toString('base64');
		expect(readKey(key64)).toBe('unsupported key length');
		expect(
			blake2bHostCall({ op: 'hash', b64: enc('x'), key64, len: 32 }, emptyStates())
		).toEqual({
			ok: false,
			error: 'unsupported key length'
		});
	});

	it('treats an empty key as unkeyed rather than as sixteen zero bytes', () => {
		expect(readKey('')).toBeUndefined();
		expect(oneShot('abc', 32, '')).toBe(VECTORS[1]!.hex);
	});

	it('names an unknown op instead of guessing one', () => {
		const r = blake2bHostCall({ op: 'digest', b64: enc('x') }, emptyStates());
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.error).toContain("unknown blake2b op 'digest'");
	});

	it('refuses an update against a state nobody opened', () => {
		expect(blake2bHostCall({ op: 'update', state: 99, b64: enc('x') }, emptyStates())).toEqual({
			ok: false,
			error: 'incorrect state length'
		});
	});
});

describe('installing it on a PHP module', () => {
	it('hangs the bridge on the key the PHP half resolves', () => {
		const binary: Blake2bBinary = {};
		installBlake2b(binary, (fn) => fn());
		expect(typeof binary[BLAKE2B_BRIDGE]).toBe('function');
		expect(SODIUM_FIX).toContain(`vrzno_env('${BLAKE2B_BRIDGE}')`);
	});

	it('runs inside the mask, because a BLAKE2b pass is a long synchronous frame', () => {
		let masked = 0;
		const binary: Blake2bBinary = {};
		installBlake2b(binary, (fn) => {
			masked++;
			return fn();
		});
		const call = binary[BLAKE2B_BRIDGE] as (json: string) => string;
		call(JSON.stringify({ op: 'hash', b64: enc('abc'), len: 32 }));
		expect(masked).toBe(1);
	});

	it('keeps its state table across calls on one binary, which is what init/final need', () => {
		const binary: Blake2bBinary = {};
		installBlake2b(binary, (fn) => fn());
		const call = binary[BLAKE2B_BRIDGE] as (json: string) => string;
		const init = JSON.parse(call(JSON.stringify({ op: 'init', len: 32 })));
		expect(init.ok).toBe(true);
		call(JSON.stringify({ op: 'update', state: init.state, b64: enc('abc') }));
		const fin = JSON.parse(call(JSON.stringify({ op: 'final', state: init.state, len: 32 })));
		expect(hexOf(fin.b64)).toBe(VECTORS[1]!.hex);
	});

	it('gives two binaries two state tables', () => {
		const a: Blake2bBinary = {};
		const b: Blake2bBinary = {};
		installBlake2b(a, (fn) => fn());
		installBlake2b(b, (fn) => fn());
		const callA = a[BLAKE2B_BRIDGE] as (json: string) => string;
		const callB = b[BLAKE2B_BRIDGE] as (json: string) => string;
		const init = JSON.parse(callA(JSON.stringify({ op: 'init', len: 32 })));
		const other = JSON.parse(
			callB(JSON.stringify({ op: 'update', state: init.state, b64: '' }))
		);
		expect(other).toEqual({ ok: false, error: 'incorrect state length' });
	});

	it('answers rather than throwing on a request that is not JSON', () => {
		const binary: Blake2bBinary = {};
		installBlake2b(binary, (fn) => fn());
		const call = binary[BLAKE2B_BRIDGE] as (json: string) => string;
		const out = JSON.parse(call('not json at all'));
		expect(out.ok).toBe(false);
		expect(String(out.error)).toContain('unparseable request');
	});
});

describe('the PHP fragment', () => {
	it.each([
		'sodium_crypto_generichash',
		'sodium_crypto_generichash_init',
		'sodium_crypto_generichash_update',
		'sodium_crypto_generichash_final'
	])('declares %s()', (fn) => {
		expect(SODIUM_FIX).toContain(`function ${fn}(`);
	});

	it.each([
		'SODIUM_CRYPTO_GENERICHASH_BYTES',
		'SODIUM_CRYPTO_GENERICHASH_BYTES_MIN',
		'SODIUM_CRYPTO_GENERICHASH_BYTES_MAX',
		'SODIUM_CRYPTO_GENERICHASH_KEYBYTES',
		'SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MIN',
		'SODIUM_CRYPTO_GENERICHASH_KEYBYTES_MAX'
	])('defines %s, which is a fatal Error in PHP 8 when absent', (name) => {
		expect(SODIUM_FIX).toContain(`define('${name}'`);
	});

	it('takes the state by reference on both functions that mutate it', () => {
		// a caller does `$state = ..._init(); ..._update($state, $block);` -- a by-value parameter
		// would make every chunk after the first digest nothing, silently
		expect(SODIUM_FIX).toContain('function sodium_crypto_generichash_update(&$state,');
		expect(SODIUM_FIX).toContain('function sodium_crypto_generichash_final(&$state,');
	});

	it('declares SodiumException, because every one of these throws rather than returning FALSE', () => {
		expect(SODIUM_FIX).toContain('class SodiumException extends Exception');
	});

	it('stays inert where the real extension exists, and where the bridge does not', () => {
		expect(SODIUM_FIX).toContain("!extension_loaded('sodium')");
		expect(SODIUM_FIX).toContain("!function_exists('cfw_sodium_installed')");
		expect(SODIUM_FIX).toContain('if ($__cfw_blake2b !== null) {');
		expect(SODIUM_FIX).toContain("function_exists('vrzno_env')");
	});

	it('never claims the extension is loaded, which is what segfaulted the mbstring attempt', () => {
		expect(SODIUM_FIX).not.toContain('extension_loaded_sodium');
		expect(SODIUM_FIX).not.toContain('get_loaded_extensions');
	});

	it('carries no backtick, which would truncate the String.raw block', () => {
		expect(SODIUM_FIX).not.toContain('`');
	});
});
