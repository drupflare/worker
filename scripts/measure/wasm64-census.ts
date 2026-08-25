import { readFileSync } from 'node:fs';

/**
 * Splits the measured heap peak into the part wasm64 would widen and the part it would not, and
 * decides wasm64 without a build where the arithmetic allows it.
 *
 * `bun scripts/measure/wasm64-census.ts`
 *
 * The question wasm64 is stuck on is a MIX, not a direction. Break-even is `128 / peak` blended across
 * every allocation, and the measured struct growths straddle it: `zval` 0%, `zend_object` +16.7%,
 * `HashTable` +27.3%, `Bucket` +33.3%. So the verdict turns on how much of the peak is made of
 * things that widen at all.
 *
 * **The bound this computes is one-sided and that is what makes it useful.** Bytes below
 * `__heap_base` are emitted by the linker and do not reallocate, and MEMFS file content is bytes
 * rather than structures. Everything else is charged at `Bucket`'s +33.3%, which no real mix can
 * exceed. If the pessimistic total still fits, wasm64 fits under ANY mix and no build is needed to
 * say so; if it does not, the build is the only thing that can settle it.
 *
 * RULE 0 does not apply: every figure here is a BYTE COUNT read out of an artifact or an isolate,
 * never a duration.
 */

export const MIB = 1_048_576;
export const ISOLATE_LIMIT = 128 * MIB;

/** the largest measured struct growth, so charging it to every scaling byte cannot understate */
export const WORST_STRUCT_GROWTH = 32 / 24;

/** section ids from the WebAssembly binary format */
const SECTION_DATA = 11;
const SECTION_GLOBAL = 6;
const SECTION_EXPORT = 7;

type Reader = { bytes: Uint8Array; at: number };

function leb(r: Reader): number {
	let result = 0;
	let shift = 0;
	for (;;) {
		const byte = r.bytes[r.at++]!;
		result |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return result >>> 0;
		shift += 7;
	}
}

/**
 * Walks the module's sections and reports the Data section payload and the `__heap_base` global.
 *
 * `__heap_base` is the authority when it is exported: it is the exact address the allocator starts
 * from, so it covers static data, the stack and any linker padding between them. The Data payload is
 * the fallback and is a LOWER bound on the same quantity, since it counts initialised bytes only.
 */
export function inspectModule(bytes: Uint8Array): { dataBytes: number; heapBase: number | null } {
	const r: Reader = { bytes, at: 8 }; // past the magic and version
	let dataBytes = 0;
	let heapBase: number | null = null;
	const globalInit: number[] = [];
	let exportedHeapBaseIndex: number | null = null;

	while (r.at < bytes.length) {
		const id = bytes[r.at++]!;
		const size = leb(r);
		const end = r.at + size;

		if (id === SECTION_DATA) {
			const count = leb(r);
			for (let i = 0; i < count; i++) {
				const flags = leb(r);
				// an active segment carries an offset expression; skip it to the 0x0b terminator
				if (flags === 0 || flags === 2) {
					if (flags === 2) leb(r);
					while (bytes[r.at++] !== 0x0b);
				}
				const len = leb(r);
				dataBytes += len;
				r.at += len;
			}
		} else if (id === SECTION_GLOBAL) {
			const count = leb(r);
			for (let i = 0; i < count; i++) {
				r.at++; // value type
				r.at++; // mutability
				// only i32.const initialisers matter here; anything else records as unknown
				if (bytes[r.at] === 0x41) {
					r.at++;
					globalInit.push(leb(r));
				} else {
					globalInit.push(-1);
				}
				while (bytes[r.at++] !== 0x0b);
			}
		} else if (id === SECTION_EXPORT) {
			const count = leb(r);
			for (let i = 0; i < count; i++) {
				const nameLen = leb(r);
				const name = new TextDecoder().decode(bytes.subarray(r.at, r.at + nameLen));
				r.at += nameLen;
				const kind = bytes[r.at++]!;
				const index = leb(r);
				if (kind === 3 && (name === '__heap_base' || name === '___heap_base')) {
					exportedHeapBaseIndex = index;
				}
			}
		}
		r.at = end;
	}

	if (exportedHeapBaseIndex !== null) {
		const value = globalInit[exportedHeapBaseIndex];
		if (typeof value === 'number' && value > 0) heapBase = value;
	}
	return { dataBytes, heapBase };
}

export const mib = (n: number) => (n / MIB).toFixed(2);

/**
 * The measured peaks, from `scripts/measure/growth-ladder.ts` at the shipping step with opcache off.
 *
 * Hardcoded rather than re-measured: the ladder takes ~15 minutes per arm and these are the figures
 * CLAUDE.md's growth table already records. Re-run the ladder if the tree has moved.
 */
export const PEAKS = {
	render: 96.0 * MIB,
	install: 100.81 * MIB,
	auth: 105.88 * MIB
};

export interface Bound {
	nonScaling: number;
	scaling: number;
	worst: number;
	fits: boolean;
}

/**
 * The one-sided bound, as arithmetic rather than as prose.
 *
 * `fits` true means the workload survives ANY mix, so it is a decision. `fits` false means only that
 * this bound cannot accept it -- the worst mix charges `Bucket` growth to every scaling byte and no
 * real heap is all Buckets, so a false here is never a refusal.
 */
export function boundFor(peak: number, staticFloor: number, memfs: number): Bound {
	const nonScaling = staticFloor + memfs;
	const scaling = Math.max(0, peak - nonScaling);
	const worst = nonScaling + scaling * WORST_STRUCT_GROWTH;
	return { nonScaling, scaling, worst, fits: worst <= ISOLATE_LIMIT };
}

/**
 * MEMFS holds the mounted tree, and its CEILING is knowable without booting anything.
 *
 * `LAZY_FS_BUDGET_BYTES` is what the lazy filesystem may hold before it evicts, and the driver pack
 * is mounted eagerly on top of it. Charging both in full is the largest MEMFS this runtime can
 * reach, which is the right thing to charge to a bound that is trying to be pessimistic. Override
 * with `MEMFS_BYTES` to score a measured census instead.
 */
export function memfsCeiling(wranglerJsonc: string, packBytes: number): number {
	const budget = Number(/"LAZY_FS_BUDGET_BYTES":\s*"(\d+)"/.exec(wranglerJsonc)?.[1] ?? 0);
	return budget + packBytes;
}

function sizeOf(path: string): number {
	try {
		return readFileSync(path).byteLength;
	} catch {
		return 0;
	}
}

function main(): void {
	const wasmPath = process.argv[2] ?? '.interp/php8.5.wasm';
	const { dataBytes, heapBase } = inspectModule(new Uint8Array(readFileSync(wasmPath)));

	const measured = Number(process.env['MEMFS_BYTES'] ?? 0);
	const memfs =
		measured > 0
			? measured
			: memfsCeiling(readFileSync('wrangler.jsonc', 'utf8'), sizeOf('assets/driver.json'));
	const staticFloor = heapBase ?? dataBytes;

	console.log(`artifact:      ${wasmPath}`);
	console.log(`data section:  ${dataBytes} bytes (${mib(dataBytes)} MiB)`);
	console.log(
		heapBase === null
			? 'no __heap_base export, so the data section is the floor and this bound is LOOSER than it could be'
			: `__heap_base:   ${heapBase} bytes (${mib(heapBase)} MiB)`
	);
	console.log(
		`MEMFS bytes:   ${memfs} (${mib(memfs)} MiB)` +
			(measured > 0 ? ' (measured)' : ' (the lazy-FS budget plus the pack, so a ceiling)')
	);
	console.log('');

	let allFit = true;
	for (const [name, peak] of Object.entries(PEAKS)) {
		const b = boundFor(peak, staticFloor, memfs);
		if (!b.fits) allFit = false;
		console.log(
			`${name.padEnd(8)} peak ${mib(peak)} MiB = ${mib(b.nonScaling)} non-scaling + ` +
				`${mib(b.scaling)} scaling  ->  worst case ${mib(b.worst)} MiB  ` +
				`(${b.fits ? 'FITS under any mix' : 'over the cap at the worst mix'})`
		);
	}

	console.log('');
	console.log(
		allFit
			? 'EVERY workload fits at the worst possible mix, so wasm64 needs no build to accept.'
			: 'At least one workload exceeds 128 MiB at the worst mix, so this bound cannot ACCEPT wasm64.\n' +
					'It cannot refuse it either: the worst mix charges Bucket growth to every scaling byte,\n' +
					'and a real heap holds zvals that do not widen at all. Build src/rc/wasm64.rc.pending\n' +
					'in phasm and score it with growth-ladder.ts on the AUTHENTICATED column.'
	);
}

if (import.meta.main) main();
