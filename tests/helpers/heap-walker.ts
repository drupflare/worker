/** what the interpreter's dlmalloc heap holds, read off its chunk chain */
export type HeapStats = {
	/** bytes of linear memory */
	linear: number;
	/** bytes in allocated chunks */
	inuse: number;
	/** the heap's break: the address space the allocator has needed so far */
	extent: number;
};

function walkFrom(view: DataView, length: number, start: number): HeapStats | undefined {
	let chunk = start;
	let inuse = 0;
	let chunks = 0;
	let top = 0;
	for (;;) {
		if (chunk + 8 > length) return undefined;
		const head = view.getUint32(chunk + 4, true);
		const size = head & ~7;
		if (size === 0) break;
		if (size < 16 || chunk + size + 8 > length) return undefined;
		const next = chunk + size;
		const nextHead = view.getUint32(next + 4, true);
		const allocated = (head & 2) !== 0;
		chunks++;
		if ((nextHead & ~7) === 0) {
			top = size;
			break;
		}
		// each chunk's flag for its predecessor has to agree with the predecessor's own
		if (((nextHead & 1) !== 0) !== allocated) return undefined;
		if (allocated) inuse += size;
		chunk = next;
	}
	if (chunks <= 1000) return undefined;
	return { linear: length, inuse, extent: chunk - start + top };
}

/**
 * Walks the allocator's chunk chain from the stack base. `memory_get_usage()` reads 0 under the
 * system allocator, so this is the only exact reading of what PHP holds.
 */
export function walkHeap(
	binary: { _emscripten_stack_get_base(): number },
	heap: Uint8Array
): HeapStats {
	const view = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
	const base = binary._emscripten_stack_get_base() >>> 0;
	for (let offset = 0; offset < 512; offset += 8) {
		for (const start of [base + offset - 8, base + offset]) {
			const stats = walkFrom(view, heap.byteLength, start);
			if (stats) return stats;
		}
	}
	throw new Error(`no clean chunk chain from base ${base}`);
}
