import { describe, expect, it } from 'vitest';
import { binaryToBytes } from '../../../src/util/base64';
import { fnv1a32 } from '../../../src/util/hash';
import { bytesToHex } from '../../../src/util/hex';

describe('fnv1a32', () => {
	it('matches the published FNV-1a 32-bit vectors', () => {
		expect(fnv1a32('')).toBe(0x811c9dc5);
		expect(fnv1a32('a')).toBe(0xe40c292c);
		expect(fnv1a32('foobar')).toBe(0xbf9cf968);
	});

	it('is unsigned and stable across calls', () => {
		const h = fnv1a32('a longer string with é and 中');
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffffffff);
		expect(fnv1a32('a longer string with é and 中')).toBe(h);
	});
});

describe('bytesToHex', () => {
	it('pads each byte to two lowercase digits', () => {
		expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]).buffer)).toBe('00010f10ff');
	});

	it('is empty for an empty buffer', () => {
		expect(bytesToHex(new ArrayBuffer(0))).toBe('');
	});
});

describe('binaryToBytes', () => {
	it('takes one byte per char code', () => {
		expect([...binaryToBytes('A\u0000ÿ')]).toEqual([65, 0, 255]);
	});

	it('inverts atob', () => {
		expect([...binaryToBytes(atob('AQID'))]).toEqual([1, 2, 3]);
	});

	it('is empty for an empty string', () => {
		expect(binaryToBytes('').length).toBe(0);
	});
});
