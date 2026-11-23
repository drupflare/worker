type Transferable = ArrayBuffer & { transfer?: (length: number) => ArrayBuffer };

/** detaches a buffer's bytes; false when the runtime cannot transfer it */
export function releaseOwnedBuffer(buffer: ArrayBuffer): boolean {
	const transfer = (buffer as Transferable).transfer;
	if (typeof transfer !== 'function') return false;
	try {
		transfer.call(buffer, 0);
		return true;
	} catch (error) {
		// transfer throws a TypeError for a buffer that is already detached
		if (error instanceof TypeError) return false;
		throw error;
	}
}

/** what the release flags freed since this isolate started */
export const releaseCounts = {
	evictedFiles: 0,
	evictedBytes: 0,
	retiredGraphs: 0,
	retiredNodes: 0,
	retiredBytes: 0
};

/** detaches an evicted file's bytes when RELEASE_EVICTED is 1, if the view covers its buffer */
export function releaseEvicted(
	env: { RELEASE_EVICTED?: string },
	contents: Uint8Array | null
): boolean {
	if (env.RELEASE_EVICTED !== '1' || contents === null) return false;
	if (!(contents.buffer instanceof ArrayBuffer)) return false;
	if (contents.byteOffset !== 0) return false;
	if (contents.byteLength !== contents.buffer.byteLength) return false;
	const bytes = contents.buffer.byteLength;
	const done = releaseOwnedBuffer(contents.buffer);
	if (done) {
		releaseCounts.evictedFiles += 1;
		releaseCounts.evictedBytes += bytes;
	}
	return done;
}

/** an Emscripten FS node, as far as the release walks it */
export type GraphNode = {
	mode: number;
	name: string;
	parent?: GraphNode;
	name_next?: GraphNode | null;
	contents: unknown;
	cfwEntry?: unknown;
	cfwRow?: unknown;
	cfwDirty?: boolean;
	stream_ops?: unknown;
	node_ops?: unknown;
};

/** the Emscripten FS members the release reads; the shipped glue's own, not a public API */
export type ReleasableFS = {
	lookupPath(path: string): { node: object };
	isDir(mode: number): boolean;
	/** the hash table `lookupPath` walks; each chain runs through `name_next` */
	nameTable: Array<GraphNode | null | undefined>;
	streams: Array<{ node?: object } | null | undefined>;
};

export type ReleasableBinary = {
	FS?: ReleasableFS;
	HEAPU8?: { buffer: ArrayBufferLike };
	wasmMemory?: { buffer: ArrayBufferLike };
	lookupMemo?: { clear(): void };
};

export type ReleaseStats = { nodes: number; streams: number; detachedBytes: number };

/**
 * Releases the host graph of an interpreter that was dropped for good, when RELEASE_HOST_GRAPH is
 * 1. Undefined when nothing was released.
 *
 * `sockets` are the owner's parked outbound sockets; an instance that still holds any is left to
 * the collector, since its parked work could wake on a detached buffer.
 */
export function releaseRetired(
	env: { RELEASE_HOST_GRAPH?: string; MEMORY_TRACE?: string } | undefined,
	php: { binary?: ReleasableBinary },
	sockets?: { size: number }
): ReleaseStats | undefined {
	if (env?.RELEASE_HOST_GRAPH !== '1' || !php.binary || (sockets?.size ?? 0) > 0)
		return undefined;
	const stats = releaseHostGraph(php.binary);
	releaseCounts.retiredGraphs += 1;
	releaseCounts.retiredNodes += stats.nodes;
	releaseCounts.retiredBytes += stats.detachedBytes;
	if (env.MEMORY_TRACE === '1') console.log(JSON.stringify({ cfw: 'host-release', ...stats }));
	return stats;
}

/**
 * Drops the host side of an interpreter's `/drupal` mount: unlinks every node from the name table,
 * detaches the bytes of clean lazy files and empties the stream slots.
 *
 * Only for an interpreter nothing can run in again. The filesystem it empties is one that
 * interpreter would still read.
 */
export function releaseHostGraph(binary: ReleasableBinary): ReleaseStats {
	const stats: ReleaseStats = { nodes: 0, streams: 0, detachedBytes: 0 };
	const FS = binary.FS;
	if (!FS) return stats;
	let root: GraphNode;
	try {
		root = FS.lookupPath('/drupal').node as GraphNode;
	} catch {
		// nothing mounted there
		return stats;
	}
	binary.lookupMemo?.clear();
	const native = binary.HEAPU8?.buffer ?? binary.wasmMemory?.buffer;
	const nodes = new Set<object>();
	const stack: GraphNode[] = [root];
	for (let node = stack.pop(); node; node = stack.pop()) {
		if (nodes.has(node)) continue;
		nodes.add(node);
		if (!FS.isDir(node.mode)) continue;
		for (const child of Object.values((node.contents ?? {}) as Record<string, GraphNode>)) {
			stack.push(child);
		}
	}
	for (const node of nodes as Set<GraphNode>) {
		const bytes = node.contents;
		// a clean lazy file's bytes are a private copy; any other buffer may have an owner outside
		if (
			(node.cfwEntry || node.cfwRow) &&
			!node.cfwDirty &&
			bytes instanceof Uint8Array &&
			bytes.byteOffset === 0 &&
			bytes.byteLength === bytes.buffer.byteLength &&
			bytes.buffer !== native &&
			bytes.buffer instanceof ArrayBuffer
		) {
			const length = bytes.byteLength;
			if (releaseOwnedBuffer(bytes.buffer)) stats.detachedBytes += length;
		}
		node.contents = FS.isDir(node.mode) ? Object.create(null) : null;
		node.cfwEntry = undefined;
		node.cfwRow = undefined;
		node.stream_ops = undefined;
		node.node_ops = undefined;
	}
	for (let slot = 0; slot < FS.nameTable.length; slot++) {
		let previous: GraphNode | null | undefined = null;
		let node = FS.nameTable[slot];
		while (node) {
			const next: GraphNode | null | undefined = node.name_next;
			if (nodes.has(node)) {
				if (previous) previous.name_next = next;
				else FS.nameTable[slot] = next ?? null;
				node.name_next = null;
			} else previous = node;
			node = next;
		}
	}
	const siblings = root.parent?.contents as Record<string, GraphNode> | undefined;
	if (siblings) delete siblings[root.name];
	for (let fd = 0; fd < FS.streams.length; fd++) {
		const node = FS.streams[fd]?.node;
		if (node && nodes.has(node)) {
			FS.streams[fd] = null;
			stats.streams++;
		}
	}
	stats.nodes = nodes.size;
	return stats;
}
