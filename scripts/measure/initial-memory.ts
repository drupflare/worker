import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INITIAL_PAGES, WASM_PAGE as PAGE, PRISTINE_PAGES } from './initial-pages.js';

/**
 * The interpreter's INITIAL_MEMORY, set on the binary because nothing else can reach it.
 *
 * The wasm module DEFINES its memory rather than importing it, so the figure is in the binary's
 * memory section and neither the glue nor an env var can change it. `growth-glue.ts` tunes the
 * growth STEP the same way and for the same reason; this is the other half of the same budget.
 *
 * ## What it is worth
 *
 * `USE_ZEND_ALLOC=0` means PHP returns nothing between requests, so demand inside one incarnation is
 * the sum of what it has done, and the growth step rounds every rise up. A lower start therefore
 * does not simply subtract: it changes where every later rounding lands. Measured on `wrangler dev`,
 * one workload -- migrate, then `/`, `/user/login`, `/node`, `/user/password`, `/admin` with an
 * invalidation between each -- reading `isolateBytes` afterwards. Every arm rendered the same 17,677
 * bytes, and the readings repeated to the byte across three interleaved rounds:
 *
 * | INITIAL_MEMORY | pages | linear  | isolate total | headroom under 128 |
 * | -------------- | ----- | ------- | ------------- | ------------------ |
 * | 96 (shipped)   | 1536  | 108.50  | 125.83        | 2.17               |
 * | 80             | 1280  | 102.25  | 119.58        | 8.42               |
 * | 72             | 1152  | 104.00  | 121.33        | 6.67               |
 * | 64             | 1024  | 104.56  | 121.89        | 6.11               |
 * | 56             | 896   | 103.37  | 120.70        | 7.30               |
 * | 48             | 768   | 100.18  | 117.51        | 10.49              |
 * | 40             | 640   | 106.81  | 124.14        | 3.86               |
 * | 32             | 512   | hung after four serves, killed at 12m20s                |
 *
 * NOT MONOTONIC, so "lower is better" is the wrong reading: 40 is worse than 48, 72 and 64 are worse
 * than 80, and 32 does not run. 48 measures best and sits two rungs from a build that hangs; 80 is
 * in the middle of the region that behaves and still triples the headroom. That margin is the whole
 * point -- at 96 an object five renders old has 2.17 MiB left, and anything that then asks for a
 * second interpreter resets it.
 */
export { INITIAL_PAGES, PRISTINE_PAGES } from './initial-pages.js';

export const PRISTINE_WASM = '.interp/php8.5.wasm';

/** the binary the shipping seam imports; emitted after the pristine one is sha256-verified */
export const TUNED_WASM = '.interp/php8.5.tuned.wasm';

/** the min-pages field of the module's memory section, and where in the file it sits */
export function readMemorySection(bytes: Uint8Array): {
	minPages: number;
	maxPages: number | null;
	minAt: number;
	minLen: number;
} {
	let p = 8;
	const leb = () => {
		let r = 0;
		let shift = 0;
		let by: number;
		do {
			by = bytes[p++] as number;
			r |= (by & 0x7f) << shift;
			shift += 7;
		} while (by & 0x80);
		return r >>> 0;
	};
	while (p < bytes.length) {
		const id = bytes[p++] as number;
		const size = leb();
		const end = p + size;
		if (id === 5) {
			const count = leb();
			if (count !== 1) throw new Error(`expected one memory, found ${count}`);
			const flags = bytes[p++] as number;
			const minAt = p;
			let minLen = 0;
			while ((bytes[minAt + minLen] as number) & 0x80) minLen++;
			minLen++;
			const minPages = leb();
			const maxPages = flags & 1 ? leb() : null;
			return { minPages, maxPages, minAt, minLen };
		}
		p = end;
	}
	throw new Error('no memory section in this module');
}

/**
 * Rewrites min-pages in place, keeping the LEB128 field the same LENGTH.
 *
 * Every page count worth setting here encodes in the same two bytes as 1536 -- 1280, 1152, 1024, 896
 * and 768 all do -- so no section size moves and no offset shifts. Widening the field would mean
 * rewriting the section header and every offset after it, and a value that needs that is refused
 * rather than half-applied.
 */
export function withInitialPages(bytes: Uint8Array, pages: number): Uint8Array {
	const out = Uint8Array.from(bytes);
	const { minAt, minLen, maxPages } = readMemorySection(out);
	if (maxPages !== null && pages > maxPages) {
		throw new Error(`${pages} pages exceeds the module maximum of ${maxPages}`);
	}
	let v = pages;
	for (let i = 0; i < minLen; i++) {
		let byte = v & 0x7f;
		v >>>= 7;
		if (i < minLen - 1) byte |= 0x80;
		out[minAt + i] = byte;
	}
	if (v !== 0) throw new Error(`${pages} does not fit the ${minLen}-byte field 1536 occupies`);
	return out;
}

/**
 * Emits the tuned binary beside the pristine one.
 *
 * BESIDE rather than over, for the reason `emitTunedGlue()` gives: `restore-artifacts.ts` verifies
 * the download against `cdn-manifest.json`, and a hash that covers a file this repo edits guarantees
 * nothing. A `bun install` would also silently undo an in-place patch.
 */
export function emitTunedWasm(root = process.cwd(), pages = INITIAL_PAGES): string {
	const source = resolve(root, PRISTINE_WASM);
	if (!existsSync(source)) throw new Error(`no interpreter at ${PRISTINE_WASM}`);
	const pristine = new Uint8Array(readFileSync(source));
	const found = readMemorySection(pristine).minPages;
	if (found !== PRISTINE_PAGES) {
		throw new Error(
			`${PRISTINE_WASM} declares ${found} pages, not ${PRISTINE_PAGES}: the published ` +
				'binary moved, so re-measure the curve before trusting INITIAL_PAGES'
		);
	}
	const out = resolve(root, TUNED_WASM);
	writeFileSync(out, withInitialPages(pristine, pages));
	return out;
}

/** what one page count is in MiB, for a message a human reads */
export const mib = (pages: number): number => (pages * PAGE) / 1048576;
