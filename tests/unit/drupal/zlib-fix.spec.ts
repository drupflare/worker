import { gunzipSync, gzipSync, inflateSync, strFromU8, strToU8, unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
	ZLIB_BRIDGE,
	ZLIB_FIX,
	installZlib,
	zlibApply,
	zlibHostCall,
	zlibLevel
} from '../../../src/drupal/zlib-fix';

/**
 * The zlib substitution, driven from both ends.
 *
 * What this can and cannot prove. The JS half is real code and is exercised here for
 * real. The PHP half is a string, so what these assert about it is its TEXT -- that the
 * six functions and five constants are present, that the guard is the one that keeps it
 * inert, and that it names the same Module key the installer uses. Its SEMANTICS are
 * checked in `tests/node/zlib-php.spec.ts`, which runs it in a real PHP process against
 * the real extension as the oracle, because nothing in workerd can execute PHP.
 *
 * Byte equality with zlib is not a property and is not asserted. fflate and zlib are
 * different DEFLATE encoders, so their output differs for the same input at the same
 * level -- measured against PHP 8.5.7, all three containers differ. What has to hold is
 * that each container round-trips and that zlib can read what fflate wrote; the node
 * spec pins the cross-direction.
 */

const SAMPLE = 'body{color:red}'.repeat(40);

describe('level mapping', () => {
	it('resolves PHP -1 to 6, which is what zlib calls the default', () => {
		// fflate has no sentinel for "library default", so -1 cannot be passed through
		expect(zlibLevel(-1)).toBe(6);
	});

	it('passes 0 through as 0 rather than treating it as absent', () => {
		// 0 is a real level in PHP -- store, no compression -- and a falsy-check would eat it
		expect(zlibLevel(0)).toBe(0);
	});

	it('keeps every level PHP accepts', () => {
		for (const level of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(zlibLevel(level)).toBe(level);
	});

	it('clamps rather than handing fflate a value it rejects', () => {
		// the PHP half raises ValueError outside -1..9 before it reaches here, so this is the
		// second line of defence rather than the behaviour a caller sees
		expect(zlibLevel(99)).toBe(9);
		expect(zlibLevel(-7)).toBe(0);
	});

	it('treats an unreadable level as the default', () => {
		expect(zlibLevel('nonsense')).toBe(6);
		expect(zlibLevel(undefined)).toBe(6);
	});

	it('maps an explicit null to 0, matching what PHP does to an int parameter', () => {
		// this assertion started out claiming 6 and was wrong: PHP coerces null to 0 for a
		// non-nullable int parameter, so gzencode($d, null) compresses at level 0 there too. An
		// ABSENT level is the -1 case and is handled in zlibHostCall, not here
		expect(zlibLevel(null)).toBe(0);
	});
});

describe('the three containers are distinct and each round-trips', () => {
	const bytes = strToU8(SAMPLE);

	it('gzip is RFC1952, and starts with the magic zlib writes', () => {
		const out = zlibApply('gzip', bytes, 9);
		expect(out[0]).toBe(0x1f);
		expect(out[1]).toBe(0x8b);
		expect(strFromU8(gunzipSync(out))).toBe(SAMPLE);
	});

	it('gzip carries mtime 0, so gzencode() is reproducible for identical input', () => {
		// fflate stamps the current time into bytes 4-7 by default. AssetDumper writes a .gz
		// beside a content-addressed .css, so a live clock there makes the same input produce a
		// different file on every regeneration
		const a = zlibApply('gzip', bytes, 9);
		expect([a[4], a[5], a[6], a[7]]).toEqual([0, 0, 0, 0]);
		expect(Array.from(zlibApply('gzip', bytes, 9))).toEqual(Array.from(a));
	});

	it('zlib is RFC1950 and is not gzip', () => {
		const out = zlibApply('zlib', bytes, 9);
		expect(out[0]).not.toBe(0x1f);
		expect(strFromU8(unzlibSync(out))).toBe(SAMPLE);
	});

	it('deflate is raw RFC1951, so it has no container header at all', () => {
		const out = zlibApply('deflate', bytes, 9);
		expect(strFromU8(inflateSync(out))).toBe(SAMPLE);
		// the wrong-container mistake this catches: raw bytes fed to the zlib reader
		expect(() => unzlibSync(out)).toThrow();
	});

	it('each decoder refuses the other two containers', () => {
		// a mapping that confused gzcompress with gzencode would still round-trip within itself,
		// so this is the assertion that makes the mapping load-bearing
		const gzip = zlibApply('gzip', bytes, 6);
		const zlib = zlibApply('zlib', bytes, 6);
		expect(() => zlibApply('unzlib', gzip, -1)).toThrow();
		expect(() => zlibApply('gunzip', zlib, -1)).toThrow();
	});

	it('level 0 still produces a valid stream, just a bigger one', () => {
		const stored = zlibApply('gzip', bytes, 0);
		expect(strFromU8(gunzipSync(stored))).toBe(SAMPLE);
		expect(stored.length).toBeGreaterThan(zlibApply('gzip', bytes, 9).length);
	});

	it('handles the empty string, which zlib encodes as a valid non-empty stream', () => {
		const out = zlibApply('gzip', new Uint8Array(0), 9);
		expect(out.length).toBeGreaterThan(0);
		expect(gunzipSync(out).length).toBe(0);
	});

	it('survives bytes that are not valid UTF-8, which is why the bridge is base64', () => {
		const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]);
		expect(Array.from(gunzipSync(zlibApply('gzip', raw, 9)))).toEqual(Array.from(raw));
	});

	it('refuses an op it does not implement rather than guessing', () => {
		expect(() => zlibApply('bzip2', bytes, 9)).toThrow(/unknown zlib op/);
	});
});

describe('the host call', () => {
	const b64 = (s: string) => btoa(s);

	it('answers with base64 that decodes to the compressed bytes', () => {
		const reply = zlibHostCall({ op: 'gzip', b64: b64(SAMPLE), level: 9 });
		expect(reply.ok).toBe(true);
		if (!reply.ok) return;
		const out = Uint8Array.from(atob(reply.b64), (c) => c.charCodeAt(0));
		expect(strFromU8(gunzipSync(out))).toBe(SAMPLE);
	});

	it('round-trips through itself for all three containers', () => {
		for (const [enc, dec] of [
			['gzip', 'gunzip'],
			['zlib', 'unzlib'],
			['deflate', 'inflate']
		]) {
			const first = zlibHostCall({ op: enc, b64: b64(SAMPLE), level: 6 });
			expect(first.ok, enc).toBe(true);
			if (!first.ok) continue;
			const back = zlibHostCall({ op: dec, b64: first.b64 });
			expect(back.ok, dec).toBe(true);
			if (!back.ok) continue;
			expect(atob(back.b64)).toBe(SAMPLE);
		}
	});

	it('reports a failure instead of throwing, because the PHP side returns FALSE', () => {
		// UrlHelper::uncompressQueryParameter() calls gzuncompress on user-supplied base64, so
		// garbage in is a normal request rather than an error condition
		const reply = zlibHostCall({ op: 'unzlib', b64: b64('not compressed at all') });
		expect(reply.ok).toBe(false);
		if (reply.ok) return;
		expect(reply.error.length).toBeGreaterThan(0);
	});

	it('reports a failure for an absent op and an absent payload', () => {
		expect(zlibHostCall({}).ok).toBe(false);
		expect(zlibHostCall({ op: 'gunzip' }).ok).toBe(false);
	});
});

describe('installing it on a binary', () => {
	it('installs under the key the PHP half resolves', () => {
		const binary: Record<string, unknown> = {};
		installZlib(binary, (fn) => fn());
		expect(typeof binary[ZLIB_BRIDGE]).toBe('function');
		expect(ZLIB_FIX).toContain(`vrzno_env('${ZLIB_BRIDGE}')`);
	});

	it('runs the work inside the mask, not beside it', () => {
		// fflate's sync deflate is a long JS frame under the PHP stack, and a slice interrupt
		// that fires there cannot suspend. An unmasked bridge is the same defect the SQL bridge
		// in @drupflare/durabledb already documents
		const binary: Record<string, unknown> = {};
		let depth = 0;
		let deepest = 0;
		installZlib(binary, (fn) => {
			depth++;
			deepest = Math.max(deepest, depth);
			try {
				return fn();
			} finally {
				depth--;
			}
		});
		const call = binary[ZLIB_BRIDGE] as (json: string) => string;
		call(JSON.stringify({ op: 'gzip', b64: btoa('x'), level: 9 }));
		expect(deepest).toBe(1);
		expect(depth).toBe(0);
	});

	it('answers a parseable reply even when handed a request that is not JSON', () => {
		const binary: Record<string, unknown> = {};
		installZlib(binary, (fn) => fn());
		const call = binary[ZLIB_BRIDGE] as (json: string) => string;
		const reply = JSON.parse(call('{not json'));
		expect(reply.ok).toBe(false);
		expect(String(reply.error)).toContain('unparseable request');
	});

	it('a real gzip crosses the installed bridge intact', () => {
		const binary: Record<string, unknown> = {};
		installZlib(binary, (fn) => fn());
		const call = binary[ZLIB_BRIDGE] as (json: string) => string;
		const reply = JSON.parse(call(JSON.stringify({ op: 'gzip', b64: btoa(SAMPLE), level: 9 })));
		expect(reply.ok).toBe(true);
		const out = Uint8Array.from(atob(reply.b64), (c) => c.charCodeAt(0));
		expect(strFromU8(gunzipSync(out))).toBe(SAMPLE);
		// and what fflate produced is what a gzip reader accepts
		expect(gzipSync(strToU8(SAMPLE), { level: 9, mtime: 0 }).length).toBe(out.length);
	});
});

describe('what the PHP fragment must say', () => {
	it('defines every function the shim replaces', () => {
		for (const fn of [
			'gzencode',
			'gzdecode',
			'gzcompress',
			'gzuncompress',
			'gzdeflate',
			'gzinflate'
		]) {
			expect(ZLIB_FIX, fn).toContain(`function ${fn}(`);
		}
	});

	it('defines the constants that vanish with the extension', () => {
		// FORCE_GZIP is the one AssetDumper reads; without it the call site is an Error before
		// gzencode is even entered, so a shim carrying only functions would still fail
		for (const c of [
			'FORCE_GZIP',
			'FORCE_DEFLATE',
			'ZLIB_ENCODING_GZIP',
			'ZLIB_ENCODING_DEFLATE',
			'ZLIB_ENCODING_RAW'
		]) {
			expect(ZLIB_FIX, c).toContain(`define('${c}'`);
		}
	});

	it('is inert where the real extension exists', () => {
		expect(ZLIB_FIX).toContain("!extension_loaded('zlib')");
	});

	it('is idempotent, so a second run does not redeclare', () => {
		expect(ZLIB_FIX).toContain("!function_exists('cfw_zlib_installed')");
	});

	it('defines nothing at all when the bridge is absent', () => {
		// a shim that answered FALSE with no bridge would let AssetDumper write a zero-byte .gz
		// and serve it as gzip; an undefined function is the loud failure that deserves
		expect(ZLIB_FIX).toContain('if ($__cfw_zlib !== null) {');
	});

	it('carries no backtick, which would truncate the template literal', () => {
		// this has happened twice in this repo, both times inside a PHP comment
		expect(ZLIB_FIX).not.toContain('`');
	});

	it('does not interpolate the parameter names in its ValueError messages', () => {
		// "Argument #2 ($level)" in a double-quoted PHP string would substitute the VALUE; the
		// escaped form is what makes the message match what ext-zlib says
		expect(ZLIB_FIX).toContain('(\\$level)');
		expect(ZLIB_FIX).toContain('(\\$encoding)');
	});

	it('reaches the bridge the way every other host call does', () => {
		expect(ZLIB_FIX).toContain("function_exists('vrzno_env')");
	});
});
