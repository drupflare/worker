/**
 * Whether the snapshot's scans use the machine's width or a byte at a time.
 *
 * ```sh
 * bun scripts/measure/heap-bulk.ts
 * ```
 *
 * The interpreter imports `_emscripten_memcpy_js`, emitted only when `bulk-memory` is off, so a PHP
 * `memcpy` crosses into JS onto a native `copyWithin`; phasm's `bulkmem` arm prices that crossing.
 * The host's own byte loops are now wide, and this keeps the OLD forms as the subtrahend. Local
 * wall clock is legitimate because it is reported only as a RATIO within one isolate.
 */

import { digestBytes } from '../../src/db/heap-store.js';

/** the byte-at-a-time scan this replaced, kept so the ratio has a subtrahend */
export function isZeroRangeBytewise(bytes: Uint8Array, from: number, to: number): boolean {
	for (let i = from; i < to; i++) {
		if (bytes[i] !== 0) return false;
	}
	return true;
}

/** what `isZeroRange()` in `heap-store.ts` now does, exported here because that one is private */
export function isZeroRangeWordwise(bytes: Uint8Array, from: number, to: number): boolean {
	let i = from;
	while (i < to && ((bytes.byteOffset + i) & 3) !== 0) {
		if (bytes[i] !== 0) return false;
		i++;
	}
	const wordEnd = to - ((to - i) & 3);
	if (i < wordEnd) {
		const words = new Uint32Array(bytes.buffer, bytes.byteOffset + i, (wordEnd - i) >>> 2);
		for (let w = 0; w < words.length; w++) {
			if (words[w] !== 0) return false;
		}
		i = wordEnd;
	}
	while (i < to) {
		if (bytes[i] !== 0) return false;
		i++;
	}
	return true;
}

/** the four-lane digest as it was before the widening */
export function digestBytewise(bytes: Uint8Array): string {
	let a = 0x811c9dc5;
	let b = 0x01000193;
	let c = 0x9e3779b9;
	let d = 0x85ebca6b;
	for (let i = 0; i < bytes.length; i++) {
		const v = bytes[i] as number;
		a = Math.imul(a ^ v, 0x01000193) >>> 0;
		b = Math.imul(b ^ (v + i), 0x85ebca6b) >>> 0;
		c = Math.imul(c ^ (v ^ (i & 0xff)), 0xc2b2ae35) >>> 0;
		d = Math.imul(d ^ (v + (i >>> 8)), 0x27d4eb2f) >>> 0;
	}
	return (
		a.toString(16).padStart(8, '0') +
		b.toString(16).padStart(8, '0') +
		c.toString(16).padStart(8, '0') +
		d.toString(16).padStart(8, '0')
	);
}

/**
 * Mostly zero pages, with non-zero runs where PHP allocates. Randomness comes from the HIGH bits:
 * an LCG's low k bits repeat every 2^k draws, handing back duplicates that read as collisions.
 */
export function syntheticHeap(bytes: number, filledFraction = 0.36): Uint8Array {
	const out = new Uint8Array(bytes);
	const PAGE = 65_536;
	const pages = Math.floor(bytes / PAGE);
	let seed = 0x2545f491;
	const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
	for (let p = 0; p < pages; p++) {
		if (next() / 0xffffffff > filledFraction) continue;
		const at = p * PAGE;
		for (let i = 0; i < PAGE; i += 7) out[at + i] = next() >>> 24;
	}
	return out;
}

if (import.meta.main) {
	const MB = 1024 * 1024;
	const heap = syntheticHeap(96 * MB);
	const PAGE = 65_536;

	// correctness first: a faster predicate that disagrees is not a candidate
	let disagreements = 0;
	for (let at = 0; at < heap.length; at += PAGE) {
		if (isZeroRangeBytewise(heap, at, at + PAGE) !== isZeroRangeWordwise(heap, at, at + PAGE)) {
			disagreements++;
		}
	}
	console.log(`zero-page predicate disagreements: ${disagreements} (must be 0)`);

	const time = (label: string, fn: () => unknown, runs = 3) => {
		fn();
		const ms: number[] = [];
		for (let r = 0; r < runs; r++) {
			const t0 = performance.now();
			fn();
			ms.push(performance.now() - t0);
		}
		ms.sort((x, y) => x - y);
		const med = ms[ms.length >> 1] as number;
		console.log(
			`  ${label.padEnd(34)} ${med.toFixed(1)} ms  (${ms.map((m) => m.toFixed(0)).join(', ')})`
		);
		return med;
	};

	console.log('\nzero-page scan over a 96 MiB heap');
	const zb = time('bytewise (what it replaced)', () => {
		let n = 0;
		for (let at = 0; at < heap.length; at += PAGE)
			if (isZeroRangeBytewise(heap, at, at + PAGE)) n++;
		return n;
	});
	const zw = time('wordwise (what ships)', () => {
		let n = 0;
		for (let at = 0; at < heap.length; at += PAGE)
			if (isZeroRangeWordwise(heap, at, at + PAGE)) n++;
		return n;
	});
	console.log(`  ratio ${(zb / zw).toFixed(2)}x`);

	// the digest walks only the KEPT pages, which is what a snapshot stores
	const kept: number[] = [];
	for (let at = 0; at < heap.length; at += PAGE) {
		if (!isZeroRangeWordwise(heap, at, at + PAGE)) kept.push(at);
	}
	const keptBytes = new Uint8Array(kept.length * PAGE);
	kept.forEach((at, n) => keptBytes.set(heap.subarray(at, at + PAGE), n * PAGE));
	console.log(`\ndigest over ${kept.length} kept pages (${keptBytes.length} bytes)`);
	const db = time('bytewise (what it replaced)', () => digestBytewise(keptBytes));
	const dw = time('wordwise (what ships)', () => digestBytes(keptBytes));
	console.log(`  ratio ${(db / dw).toFixed(2)}x`);

	// the OLD digest is the control: without one a degenerate generator reads as a collision
	const n = Math.min(kept.length, 400);
	const distinctPages = new Set<string>();
	const seenOld = new Set<string>();
	const seenNew = new Set<string>();
	for (let p = 0; p < n; p++) {
		const page = keptBytes.slice(p * PAGE, (p + 1) * PAGE);
		distinctPages.add(Buffer.from(page).toString('base64'));
		seenOld.add(digestBytewise(page));
		seenNew.add(digestBytes(page));
		const flipAt = (p * 37) % PAGE;
		page[flipAt] = (page[flipAt] as number) ^ 1;
		distinctPages.add(Buffer.from(page).toString('base64'));
		seenOld.add(digestBytewise(page));
		seenNew.add(digestBytes(page));
	}
	console.log(`\nover ${n * 2} one-bit-apart pages:`);
	console.log(
		`  distinct INPUTS          ${distinctPages.size}   <- the ceiling either can reach`
	);
	console.log(`  bytewise (control)       ${seenOld.size}`);
	console.log(`  wordwise (what ships)    ${seenNew.size}`);
	console.log(
		`  verdict: ${seenNew.size === distinctPages.size ? 'no collisions' : `${distinctPages.size - seenNew.size} collisions`}`
	);

	console.log(
		'\nwall clock, LOCAL, reported as a ratio between two implementations in one isolate.'
	);
}
