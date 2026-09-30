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
 *
 * ## 64 since 2026-09-30, measured on a deployed farmOS object
 *
 * That table was read at a growth step of 0.05-0.13, where the rounding decided the figure. At 0.01
 * the start matters only where demand stays below it, which is a FRESH isolate: after a boot and an
 * anonymous render linear memory read 67-71 MB from a 64 MiB start, so 80 held ~13 MB nothing
 * touched. A memory is charged at its full size touched or not (an untouched 80 MiB one read +84 MB),
 * and read against each isolate's own no-PHP baseline a boot plus a render cost 118.4 and 119.9 MB
 * at 64 against 135.5 at 80 (163.8 on a placement whose baseline was 36 MB), and `/php` alone 112.3
 * against 125.2. Boot CPU did not move. A warm object grows past either start, so it gains nothing.
 */
export { INITIAL_PAGES, PRISTINE_PAGES } from './initial-pages.js';

export const PRISTINE_WASM = '.interp/php8.5.wasm';

/** the binary the shipping seam imports; emitted after the pristine one is sha256-verified */
export const TUNED_WASM = '.interp/php8.5.tuned.wasm';

/** one wasm section: its id, where its body starts and ends in the file */
type Section = { id: number; start: number; end: number };

/** reads an unsigned LEB128 at `at`, answering the value and the offset after it */
function readLeb(bytes: Uint8Array, at: number): [number, number] {
	let r = 0;
	let shift = 0;
	let by: number;
	do {
		by = bytes[at++] as number;
		r += (by & 0x7f) * 2 ** shift;
		shift += 7;
	} while (by & 0x80);
	return [r, at];
}

function encodeLeb(v: number): number[] {
	const out: number[] = [];
	do {
		let by = v & 0x7f;
		v = Math.floor(v / 128);
		if (v) by |= 0x80;
		out.push(by);
	} while (v);
	return out;
}

function sectionsOf(bytes: Uint8Array): Section[] {
	const out: Section[] = [];
	let p = 8;
	while (p < bytes.length) {
		const id = bytes[p] as number;
		const [size, start] = readLeb(bytes, p + 1);
		out.push({ id, start, end: start + size });
		p = start + size;
	}
	return out;
}

/** the limits at `at`: flags, min, optional max, and where the min field sits */
function readLimits(bytes: Uint8Array, at: number) {
	const flags = bytes[at] as number;
	const minAt = at + 1;
	const [minPages, afterMin] = readLeb(bytes, minAt);
	const [maxPages, end] = flags & 1 ? readLeb(bytes, afterMin) : [null, afterMin];
	return { minPages, maxPages, minAt, minLen: afterMin - minAt, end };
}

/** where the one memory is declared: the memory section, or an import once it has been moved */
function findMemory(bytes: Uint8Array): ReturnType<typeof readLimits> & { imported: boolean } {
	const secs = sectionsOf(bytes);
	const mem = secs.find((s) => s.id === 5);
	if (mem) {
		const [count, at] = readLeb(bytes, mem.start);
		if (count !== 1) throw new Error(`expected one memory, found ${count}`);
		return { ...readLimits(bytes, at), imported: false };
	}
	const imp = secs.find((s) => s.id === 2);
	if (imp) {
		let [count, p] = readLeb(bytes, imp.start);
		for (; count > 0; count--) {
			for (let n = 0; n < 2; n++) {
				const [len, at] = readLeb(bytes, p);
				p = at + len;
			}
			const kind = bytes[p++] as number;
			if (kind === 2) return { ...readLimits(bytes, p), imported: true };
			if (kind === 0) p = readLeb(bytes, p)[1];
			else if (kind === 1) p = readLimits(bytes, p + 1).end;
			else if (kind === 3) p += 2;
			else if (kind === 4) p = readLeb(bytes, p + 1)[1];
			else throw new Error(`unknown import kind ${kind}`);
		}
	}
	throw new Error('no memory section in this module');
}

/** the min-pages field of the module's memory, and where in the file it sits */
export function readMemorySection(bytes: Uint8Array): {
	minPages: number;
	maxPages: number | null;
	minAt: number;
	minLen: number;
} {
	const { minPages, maxPages, minAt, minLen } = findMemory(bytes);
	return { minPages, maxPages, minAt, minLen };
}

/** whether the module imports its memory as `env.memory` rather than defining it */
export function importsMemory(bytes: Uint8Array): boolean {
	return findMemory(bytes).imported;
}

/**
 * Moves the module's memory from its memory section to an `env.memory` import, limits unchanged.
 *
 * So the host can hand a new instance the memory of one it dropped: a defined memory is created by
 * `instantiate()` and cannot be shared, and a dropped one is freed only when V8 collects it, which
 * on the platform is often after the next boot has already allocated beside it. Nothing else in
 * the module moves: memory indices stay 0, the `memory` export re-exports the import, and active
 * data segments are written into whatever memory is passed.
 */
export function withImportedMemory(bytes: Uint8Array): Uint8Array {
	const secs = sectionsOf(bytes);
	const mem = secs.find((s) => s.id === 5);
	const imp = secs.find((s) => s.id === 2);
	if (!mem) throw new Error('the module already has no memory section');
	if (!imp) throw new Error('the module has no import section to extend');
	const [count, at] = readLeb(bytes, mem.start);
	if (count !== 1) throw new Error(`expected one memory, found ${count}`);
	const limits = bytes.subarray(at, mem.end);
	const name = (s: string) => {
		const b = new TextEncoder().encode(s);
		return [...encodeLeb(b.length), ...b];
	};
	const [imports, rest] = readLeb(bytes, imp.start);
	const body = [
		...encodeLeb(imports + 1),
		...bytes.subarray(rest, imp.end),
		...name('env'),
		...name('memory'),
		0x02,
		...limits
	];
	const parts: Uint8Array[] = [bytes.subarray(0, 8)];
	for (const s of secs) {
		if (s.id === 5) continue;
		const content = s.id === 2 ? Uint8Array.from(body) : bytes.subarray(s.start, s.end);
		parts.push(Uint8Array.from([s.id, ...encodeLeb(content.length)]), content);
	}
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
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
 * Emits the tuned binary beside the pristine one: the initial pages above, and the memory
 * imported rather than defined ({@link withImportedMemory}).
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
	writeFileSync(out, withImportedMemory(withInitialPages(pristine, pages)));
	return out;
}

/** what one page count is in MiB, for a message a human reads */
export const mib = (pages: number): number => (pages * PAGE) / 1048576;
