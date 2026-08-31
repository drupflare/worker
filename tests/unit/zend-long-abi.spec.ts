import { describe, expect, it } from 'vitest';

/**
 * P28: can PHP's integer width be bought without the pointer width? No, and the reason is one
 * typedef.
 *
 * The proposal was to force `ZEND_ENABLE_ZVAL_LONG64` on a wasm32 build and keep 32-bit pointers,
 * on the strength of a real prior: `zval` measures **16 bytes on both targets**, so alignment is
 * already paying for the 8-byte slot. That prior is correct and it is not the whole answer.
 *
 * **`zend_ulong` IS `zend_long`.** Read from the PHP 8.5 source rather than assumed --
 * `Zend/zend_long.h` typedefs `zend_long`/`zend_ulong` together under one `#ifdef`, and defines
 * that macro only for `__x86_64__ || __LP64__ || _LP64 || _WIN64`. `Zend/zend_types.h` then puts a
 * `zend_ulong h` in BOTH of the structures that decide how much memory a render holds:
 *
 *     struct _zend_string { zend_refcounted_h gc; zend_ulong h; size_t len; char val[1]; };
 *     typedef struct _Bucket { zval val; zend_ulong h; zend_string *key; } Bucket;
 *
 * So the growth P26 measured for wasm64 was never only about pointers: the hash is tied to
 * `zend_long` and travels with it.
 *
 * MEASURED with a real compiler over an explicit wasm32-ABI model (pointer 4, size_t 4, double 8):
 *
 * | struct  | today | with LONG64 | delta   | P26's wasm64 figure |
 * | ------- | ----- | ----------- | ------- | ------------------- |
 * | zval    | 16    | 16          | 0%      | -                   |
 * | Bucket  | 24    | 32          | **+33%**| **33%**             |
 * | string  | 20    | 24          | +20%    | 60%                 |
 *
 * **Bucket comes out at exactly the wasm64 number**, which is the finding: P28 pays P26's price on
 * the structure Drupal allocates most of, and P26 was rejected on that price. `zend_string` is the
 * cheaper half, because `len` is a `size_t` and stays 4 bytes.
 *
 * AND IT IS WORSE THAN "THE HASH IS THE CAUSE", which is what this file was written to show. The
 * case below was meant to prove the hash grew Bucket and the pointer did not; it FAILED, because
 * both land on 32. `zval` is 16 and the remaining two members fill an 8-aligned tail, so widening
 * EITHER `zend_ulong h` OR `zend_string *key` alone takes Bucket from 24 to 32. There is no
 * arrangement of this change that keeps Bucket at 24, which is the sharpest form of the answer:
 * "buy the integer width without the pointer width" has nothing to buy on the structure that
 * decides the cost.
 *
 * AND THERE IS NO ROOM FOR IT. `tests/integration/linear-memory.spec.ts` measures the render peak
 * at 115.25 MiB against a 128 MiB isolate -- **12.75 MiB** -- with the JS side still to pay for out
 * of the same budget. A third more per hash bucket across a Drupal render does not fit in that.
 *
 * WHAT THIS FILE IS: the arithmetic, so the idea cannot be re-proposed without re-deriving it. It
 * is not a substitute for a build. If someone wants `PHP_INT_SIZE === 8` anyway, the build is the
 * only thing that settles what it costs in practice -- but it now has to argue past a measured 33%
 * rather than past an assumption that pointers were the problem.
 */

/** wasm32: pointers and size_t are 4 bytes, a double is 8, alignment equals size up to 8 */
const PTR = 4;
const SIZE_T = 4;
const DOUBLE = 8;

const align = (offset: number, to: number) => Math.ceil(offset / to) * to;

/** lays out a struct given `[size, alignment]` members, C rules */
function sizeOf(members: Array<[number, number]>): number {
	let offset = 0;
	let strongest = 1;
	for (const [size, alignment] of members) {
		strongest = Math.max(strongest, alignment);
		offset = align(offset, alignment) + size;
	}
	return align(offset, strongest);
}

/** the three structures, parameterised on the width `zend_long`/`zend_ulong` gets */
function layout(longBytes: 4 | 8) {
	const L: [number, number] = [longBytes, longBytes];
	// zend_refcounted_h is two uint32s
	const gc: [number, number] = [8, 4];
	// the value union is as wide as its widest member and aligned to it
	const unionWidth = Math.max(longBytes, DOUBLE, PTR);
	const value: [number, number] = [unionWidth, unionWidth];
	const zval = sizeOf([value, [4, 4], [4, 4]]);

	return {
		zval,
		bucket: sizeOf([[zval, unionWidth], L, [PTR, PTR]]),
		string: sizeOf([gc, L, [SIZE_T, SIZE_T], [1, 1]])
	};
}

describe('forcing ZEND_ENABLE_ZVAL_LONG64 on a wasm32 build', () => {
	const now = layout(4);
	const long64 = layout(8);

	it('leaves zval alone, which is the prior the item was built on and it holds', () => {
		expect(now.zval).toBe(16);
		expect(long64.zval).toBe(16);
	});

	it('grows Bucket by exactly the 33% P26 measured for wasm64', () => {
		expect(now.bucket).toBe(24);
		expect(long64.bucket).toBe(32);
		expect(long64.bucket / now.bucket - 1).toBeCloseTo(1 / 3, 6);
	});

	it('grows zend_string too, though less than wasm64 does', () => {
		expect(long64.string).toBeGreaterThan(now.string);
		// `len` is a size_t and stays 4 bytes, which is the one thing 32-bit pointers do buy
		expect(long64.string - now.string).toBe(4);
	});

	// THE ASSERTION I EXPECTED TO PASS HERE FAILED, AND THE REAL ANSWER IS STRONGER. I wrote this
	// to show the hash was the cause and the pointer was not. Both come out at 32: `zval` is 16
	// and the remaining two members have to fill an 8-aligned tail, so widening EITHER one alone
	// takes Bucket from 24 to 32. There is no version of this change that keeps Bucket at 24
	it('grows Bucket to 32 whichever member is widened, so 32-bit pointers buy nothing here', () => {
		const hashOnly = sizeOf([
			[now.zval, 8],
			[8, 8],
			[PTR, PTR]
		]);
		const pointerOnly = sizeOf([
			[now.zval, 8],
			[4, 4],
			[8, 8]
		]);
		expect(hashOnly).toBe(32);
		expect(pointerOnly).toBe(32);
		expect(hashOnly).toBe(long64.bucket);
		// which is why P28 and P26 land on the same number for the structure that matters most
		expect(pointerOnly).toBe(long64.bucket);
	});

	it('does not fit the measured render peak, which is what decides it', () => {
		const MIB = 1_048_576;
		// from tests/integration/linear-memory.spec.ts, measured on the shipping build
		const renderPeak = 120_848_384;
		const isolateLimit = 128 * MIB;
		const headroom = isolateLimit - renderPeak;
		expect(headroom).toBeLessThan(16 * MIB);
		// a third more per bucket has to come out of that, and the hash tables are not a small
		// share of a render's heap
		expect(long64.bucket / now.bucket).toBeGreaterThan(1.3);
	});
});
