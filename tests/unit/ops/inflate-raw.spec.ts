import { deflateSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { inflateRaw, inflateZlib } from '../../../src/ops/inflate-raw';

/**
 * The inflater, with `fflate` as the oracle.
 *
 * What is being proved is not "it decompresses" -- fflate already does that -- but `consumed`, which
 * nothing else here can answer and which is the only thing that finds the next packfile object.
 */

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** every block type DEFLATE has, reached by shaping the input rather than by asking for one */
const CORPUS: Record<string, Uint8Array> = {
	empty: new Uint8Array(0),
	oneByte: bytes('x'),
	// no repetition and near-uniform bytes: the encoder gives up and stores
	incompressible: new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 37 + 11) & 0xff)),
	// one symbol repeated: fixed Huffman with long back-references
	runs: bytes('a'.repeat(4096)),
	// skewed symbol frequencies: dynamic Huffman
	php: bytes(
		`<?php\n\nnamespace Drupal\\example;\n\n${'/** doc */\nclass Thing { public function go() { return 1; } }\n'.repeat(80)}`
	),
	// a back-reference longer than its distance, which the copy loop must handle byte at a time
	overlap: bytes(`ab${'ab'.repeat(2000)}`),
	unicode: bytes('é中文\u{1f600}'.repeat(300)),
	maxLength: bytes('z'.repeat(258 * 4))
};

describe('inflateRaw agrees with fflate', () => {
	for (const [name, source] of Object.entries(CORPUS)) {
		it(`round-trips ${name} (${source.length} bytes)`, () => {
			const packed = deflateSync(source);
			const got = inflateRaw(packed, 0, source.length);
			expect(got.data).toEqual(source);
			expect(got.consumed, 'consumed must cover the whole stream and no more').toBe(
				packed.length
			);
		});
	}

	it('round-trips every deflate level, which is how block types are reached', () => {
		const source = CORPUS.php as Uint8Array;
		for (const level of [0, 1, 4, 6, 9] as const) {
			const packed = deflateSync(source, { level });
			const got = inflateRaw(packed, 0, source.length);
			expect(text(got.data), `level ${level}`).toBe(text(source));
			expect(got.consumed, `level ${level} consumed`).toBe(packed.length);
		}
	});
});

describe('consumed is exact, which is the whole reason this exists', () => {
	it('stops at the end of the stream and ignores what follows', () => {
		const first = zlibSync(bytes('first object'));
		const second = zlibSync(bytes('second object'));
		const trailing = bytes('PACK-ish trailing bytes that are not deflate');
		const joined = new Uint8Array(first.length + second.length + trailing.length);
		joined.set(first);
		joined.set(second, first.length);
		joined.set(trailing, first.length + second.length);

		const a = inflateZlib(joined, 0);
		expect(text(a.data)).toBe('first object');
		expect(a.consumed).toBe(first.length);

		const b = inflateZlib(joined, a.consumed);
		expect(text(b.data)).toBe('second object');
		expect(a.consumed + b.consumed).toBe(first.length + second.length);
	});

	it('walks a chain of concatenated streams the way a packfile is read', () => {
		const parts = Array.from({ length: 25 }, (_, i) =>
			bytes(`object ${i} ${'.'.repeat(i * 13)}`)
		);
		const packed = parts.map((p) => zlibSync(p));
		const total = packed.reduce((n, p) => n + p.length, 0);
		const joined = new Uint8Array(total);
		let at = 0;
		for (const p of packed) {
			joined.set(p, at);
			at += p.length;
		}

		let cursor = 0;
		for (let i = 0; i < parts.length; i++) {
			const got = inflateZlib(joined, cursor);
			expect(text(got.data), `object ${i}`).toBe(text(parts[i] as Uint8Array));
			cursor += got.consumed;
		}
		expect(cursor, 'the walk must land exactly on the end').toBe(total);
	});

	it('is unaffected by a wrong size hint', () => {
		const source = CORPUS.runs as Uint8Array;
		const packed = deflateSync(source);
		for (const hint of [0, 1, 10, source.length * 4]) {
			const got = inflateRaw(packed, 0, hint);
			expect(got.data.length, `hint ${hint}`).toBe(source.length);
			expect(got.consumed, `hint ${hint}`).toBe(packed.length);
		}
	});
});

describe('refusals', () => {
	it('refuses a zlib header that is not deflate', () => {
		expect(() => inflateZlib(new Uint8Array([0x78, 0x9c]).fill(0x00), 0)).toThrow(/zlib/);
	});

	it('refuses a corrupt zlib check', () => {
		const packed = zlibSync(bytes('hello'));
		const broken = Uint8Array.from(packed);
		broken[1] = ((broken[1] as number) ^ 0x01) & 0xdf;
		expect(() => inflateZlib(broken, 0)).toThrow(/zlib/);
	});

	it('refuses a preset dictionary rather than decoding it wrongly', () => {
		// FDICT set with a CMF/FLG pair that still passes the mod-31 check
		const withDict = new Uint8Array([0x78, 0xbb, 0, 0, 0, 0]);
		expect(() => inflateZlib(withDict, 0)).toThrow(/preset dictionary/);
	});

	it('refuses a reserved block type', () => {
		// BFINAL=1, BTYPE=3 is reserved and must never decode
		expect(() => inflateRaw(new Uint8Array([0b00000111, 0, 0, 0]), 0)).toThrow(/reserved/);
	});

	it('refuses a truncated stream instead of returning a short read', () => {
		const packed = deflateSync(CORPUS.php as Uint8Array);
		expect(() => inflateRaw(packed.subarray(0, packed.length - 8), 0)).toThrow();
	});

	it('refuses a stored block whose complement disagrees', () => {
		const packed = deflateSync(CORPUS.incompressible as Uint8Array, { level: 0 });
		const broken = Uint8Array.from(packed);
		// the LEN/NLEN pair sits right after the aligned block header
		broken[3] = ((broken[3] as number) ^ 0xff) & 0xff;
		expect(() => inflateRaw(broken, 0)).toThrow(/stored block length/);
	});
});
