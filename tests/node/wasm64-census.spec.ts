import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	boundFor,
	inspectModule,
	ISOLATE_LIMIT,
	memfsCeiling,
	MIB,
	PEAKS,
	WORST_STRUCT_GROWTH
} from '../../scripts/measure/wasm64-census';

/**
 * The one-sided bound that decides whether P26 needs a build.
 *
 * The arithmetic is the whole instrument, so it is what gets asserted -- including the direction of
 * its own conclusion, because a bound that could only ever say "fits" would be decoration. The
 * section walker is exercised against a module built here rather than against the shipping binary,
 * so a failure names the parser instead of the artifact.
 */

/** LEB128, unsigned, which is how every length and index in a wasm module is encoded */
function leb(n: number): number[] {
	const out: number[] = [];
	do {
		let byte = n & 0x7f;
		n >>>= 7;
		if (n !== 0) byte |= 0x80;
		out.push(byte);
	} while (n !== 0);
	return out;
}

function section(id: number, payload: number[]): number[] {
	return [id, ...leb(payload.length), ...payload];
}

/**
 * A minimal module carrying one active data segment and, optionally, an exported `__heap_base`.
 *
 * Hand-built because the two things worth testing -- that an active segment's offset expression is
 * skipped rather than counted, and that the export resolves to the right global -- are both
 * invisible in a module that has only one of each.
 */
function moduleWith(opts: { dataSegments: number[][]; heapBase?: number }): Uint8Array {
	const bytes: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

	if (opts.heapBase !== undefined) {
		// two globals, so an export pointing at index 1 proves the index is honoured
		const globals = [
			...leb(2),
			0x7f,
			0x00,
			0x41,
			...leb(999),
			0x0b,
			0x7f,
			0x00,
			0x41,
			...leb(opts.heapBase),
			0x0b
		];
		bytes.push(...section(6, globals));
		const name = [...new TextEncoder().encode('__heap_base')];
		bytes.push(...section(7, [...leb(1), ...leb(name.length), ...name, 0x03, ...leb(1)]));
	}

	const data: number[] = [...leb(opts.dataSegments.length)];
	for (const seg of opts.dataSegments) {
		// flags 0 = active in memory 0, then an i32.const offset expression, then the payload
		data.push(0x00, 0x41, ...leb(1024), 0x0b, ...leb(seg.length), ...seg);
	}
	bytes.push(...section(11, data));
	return new Uint8Array(bytes);
}

describe('the wasm section walker', () => {
	it('sums every data segment and skips the offset expression', () => {
		const mod = moduleWith({
			dataSegments: [
				[1, 2, 3],
				[4, 5]
			]
		});
		expect(inspectModule(mod).dataBytes).toBe(5);
	});

	it('reads __heap_base from the global its export names, not from the first global', () => {
		const mod = moduleWith({ dataSegments: [[1]], heapBase: 4096 });
		expect(inspectModule(mod).heapBase).toBe(4096);
	});

	it('reports a null heap base when nothing exports one, so the caller can widen the bound', () => {
		expect(inspectModule(moduleWith({ dataSegments: [[1]] })).heapBase).toBeNull();
	});

	/**
	 * The shipping binary, which is the case the null branch above exists for: emscripten does not
	 * export `__heap_base` here, so the data section is the floor. Skipped when `.interp/` is absent,
	 * which is the artifact boundary a clean checkout sits behind.
	 */
	it('parses the shipping interpreter', () => {
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(readFileSync('.interp/php8.5.wasm'));
		} catch {
			return;
		}
		const { dataBytes } = inspectModule(bytes);
		expect(dataBytes).toBeGreaterThan(1 * MIB);
		expect(dataBytes).toBeLessThan(bytes.byteLength);
	});
});

describe('the bound', () => {
	it('charges the largest measured struct growth, which is Bucket 24 -> 32', () => {
		expect(WORST_STRUCT_GROWTH).toBeCloseTo(1.3333, 4);
	});

	it('exempts the non-scaling floor rather than growing it', () => {
		const b = boundFor(100 * MIB, 10 * MIB, 0);
		expect(b.nonScaling).toBe(10 * MIB);
		expect(b.scaling).toBe(90 * MIB);
		expect(b.worst).toBeCloseTo(10 * MIB + 90 * MIB * WORST_STRUCT_GROWTH, 0);
	});

	it('never reports negative scaling when the floor exceeds the peak', () => {
		expect(boundFor(1 * MIB, 10 * MIB, 0).scaling).toBe(0);
	});

	/**
	 * The direction that matters. A bound that accepted every input would justify skipping the build
	 * on arithmetic that proves nothing, so the authenticated workload MUST come back over the cap at
	 * today's figures -- that is what says a build is still required.
	 */
	it('does NOT accept the authenticated render, which is why P26 still needs a build', () => {
		const floor = 3_011_523 + 4_646_863; // the shipping data section plus the MEMFS ceiling
		expect(boundFor(PEAKS.auth, floor, 0).fits).toBe(false);
		expect(boundFor(PEAKS.render, floor, 0).fits).toBe(true);
	});

	it('would accept a peak small enough, so the true branch is reachable', () => {
		expect(boundFor(90 * MIB, 0, 0).worst).toBeLessThanOrEqual(ISOLATE_LIMIT);
		expect(boundFor(90 * MIB, 0, 0).fits).toBe(true);
	});
});

describe('the MEMFS ceiling', () => {
	it('is the lazy-FS budget plus the pack, both read rather than assumed', () => {
		expect(memfsCeiling('{ "LAZY_FS_BUDGET_BYTES": "4194304" }', 1000)).toBe(4_195_304);
	});

	it('degrades to the pack alone when the budget is absent', () => {
		expect(memfsCeiling('{}', 1000)).toBe(1000);
	});

	/**
	 * The real config, so a budget change moves the bound rather than being missed by a fixture.
	 */
	it('reads the shipping lazy-FS budget', () => {
		const wrangler = readFileSync('wrangler.jsonc', 'utf8');
		expect(memfsCeiling(wrangler, 0)).toBeGreaterThan(0);
	});
});
