/**
 * Storage for a wasm heap snapshot in the Durable Object's own SQLite.
 *
 * Every platform limit here is measured on a deployed object and kept as a constant so it does not
 * live only in prose.
 * @module
 */

import { deflateSync, inflateSync } from 'fflate';

// local copies of the `../util` helpers: `scripts/measure/heap-digest-cost.ts` runs this file under
// plain node, which resolves no extensionless relative import
const errorMessage = (e: unknown): string =>
	String((e as { message?: unknown } | null | undefined)?.message ?? e);
const firstRow = <T = Record<string, unknown>>(cursor: { toArray(): T[] }): T | undefined =>
	cursor.toArray()[0];

/** bytes per record in Durable Object SQLite; exceeding it is a hard error, not a truncation */
export const DO_SQLITE_MAX_RECORD_BYTES = 2_199_995;

/** statement text ceiling in characters (base64 becomes text and blows it; bound BLOBs do not) */
export const DO_SQLITE_MAX_STATEMENT_CHARS = 100_000;

/** one wasm page; elision works at page granularity because the heap grows by pages */
export const WASM_PAGE_BYTES = 65_536;

/**
 * Default bytes per stored chunk, sized by the 10 ms CPU cap rather than the record cap.
 *
 * Deployed sweep with `HEAP_RESTORE_CHUNKS=1`:
 *
 * | chunk bytes | rows | per-firing edge cpuTime | over the 10 ms cap |
 * | ----------- | ---- | ----------------------- | ------------------ |
 * | 2,000,000   | 5    | median 29, max 52 ms    | 3 of 4             |
 * | 400,000     | 21   | median 8, max 13 ms     | 4 of 21            |
 * | 200,000     | 41   | median 2, max 10 ms     | **0 of 41**        |
 *
 * One restore step fits one free-plan invocation only near this size. Per-firing CPU tracks chunk
 * size; the digest is about 0.1 ms per 200,000 bytes (`scripts/measure/heap-digest-cost.ts`).
 */
export const DEFAULT_CHUNK_BYTES = 200_000;

/** ddl for the snapshot tables: one metadata row, N chunk rows of bytes */
export const HEAP_SNAPSHOT_DDL = `
CREATE TABLE IF NOT EXISTS cfw_heap_snapshot (
	id INTEGER PRIMARY KEY,
	created_at INTEGER NOT NULL,
	byte_length INTEGER NOT NULL,
	page_bytes INTEGER NOT NULL,
	total_pages INTEGER NOT NULL,
	kept_pages INTEGER NOT NULL,
	page_index TEXT NOT NULL,
	chunk_bytes INTEGER NOT NULL,
	digest TEXT NOT NULL,
	generation TEXT NOT NULL,
	fd_table TEXT NOT NULL,
	handle_table TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS cfw_heap_chunk (
	snapshot_id INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	bytes BLOB NOT NULL,
	digest TEXT NOT NULL,
	raw_bytes INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (snapshot_id, seq)
);
`.trim();

/**
 * A heap with its all-zero pages removed, plus the index needed to put them back.
 *
 * `pageIndex` lists the kept page numbers; every page not listed was all zero and restores as zero.
 */
export type ElidedHeap = {
	/** the retained pages, concatenated in `pageIndex` order */
	bytes: Uint8Array;
	/** page numbers retained, ascending */
	pageIndex: number[];
	/** pages in the original heap */
	totalPages: number;
	/** length of the original heap in bytes */
	byteLength: number;
	/** bytes actually retained */
	pageBytes: number;
};

/**
 * Copies a heap out of wasm memory so it can be stored.
 *
 * `uint8.set(arrayBuffer)` copies zero bytes and throws nothing (an `ArrayBuffer` is not
 * array-like), so the source is wrapped in a view first. The copy also detaches from the live
 * `WebAssembly.Memory`, whose buffer is replaced on growth.
 */
export function toStorableBytes(src: ArrayBuffer | ArrayBufferLike | Uint8Array): Uint8Array {
	const view = src instanceof Uint8Array ? src : new Uint8Array(src);
	// a copy, not a view (a later memory.grow() cannot invalidate it)
	return view.slice();
}

/**
 * True when every byte in `[from, to)` is zero, read a word at a time (3.93x the byte form on a
 * 96 MiB heap). Head and tail stay bytewise: a `Uint32Array` view needs a 4-aligned absolute
 * offset.
 */
function isZeroRange(bytes: Uint8Array, from: number, to: number): boolean {
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

/**
 * Drops all-zero pages from a heap.
 *
 * A booted Drupal heap goes from 80,543,744 to 39,911,590 bytes raw. Elision is free; compression
 * (see {@link packChunk}) trades boot CPU for bytes at rest.
 */
export function elideZeroPages(heap: Uint8Array, pageBytes = WASM_PAGE_BYTES): ElidedHeap {
	if (pageBytes <= 0) throw new RangeError('pageBytes must be positive');
	const totalPages = Math.ceil(heap.length / pageBytes);
	const keep: number[] = [];
	for (let p = 0; p < totalPages; p++) {
		const from = p * pageBytes;
		const to = Math.min(from + pageBytes, heap.length);
		if (!isZeroRange(heap, from, to)) keep.push(p);
	}
	// a trailing partial page is kept at its real length, so reassembly cannot over-run
	let out = 0;
	for (const p of keep) out += Math.min(pageBytes, heap.length - p * pageBytes);
	const bytes = new Uint8Array(out);
	let at = 0;
	for (const p of keep) {
		const from = p * pageBytes;
		const to = Math.min(from + pageBytes, heap.length);
		bytes.set(heap.subarray(from, to), at);
		at += to - from;
	}
	return { bytes, pageIndex: keep, totalPages, byteLength: heap.length, pageBytes: out };
}

/**
 * Rebuilds the full heap from an elided one. Pages not in `pageIndex` come back as zero.
 *
 * The result is `byteLength` long, not `totalPages * pageBytes` (the last page is usually partial,
 * and one extra byte fails the digest compare).
 */
export function reassembleHeap(elided: ElidedHeap, pageBytes = WASM_PAGE_BYTES): Uint8Array {
	const full = new Uint8Array(elided.byteLength);
	let at = 0;
	for (const p of elided.pageIndex) {
		const from = p * pageBytes;
		if (from >= elided.byteLength) throw new RangeError(`page ${p} is past the heap end`);
		const len = Math.min(pageBytes, elided.byteLength - from);
		full.set(elided.bytes.subarray(at, at + len), from);
		at += len;
	}
	if (at !== elided.bytes.length) {
		// index and payload disagree; refuse rather than restore a plausible wrong heap
		throw new Error(`page index consumed ${at} of ${elided.bytes.length} bytes`);
	}
	return full;
}

/**
 * Deflates one chunk for storage, or hands it back unpacked when packing it gains nothing.
 *
 * An image is 69% of a site's storage and free's 5 GB is an account-wide hard cap. Measured on an
 * 11,206,656-byte image in 57 chunks: 3.54x per chunk against 3.565x for the whole image.
 *
 * It is per chunk by requirement: {@link streamRestoreInto} holds one chunk at a time because the
 * isolate memory ceiling is non-monotone (a 128 MiB allocation failed where 160 MiB succeeded).
 * `deflateSync` keeps both sides synchronous.
 *
 * @returns the bytes to store, and `rawBytes` (the inflated length, or 0 when stored as they came;
 *   0 is also what rows written before the column read, so it doubles as the migration)
 */
export function packChunk(bytes: Uint8Array): { stored: Uint8Array; rawBytes: number } {
	const packed = deflateSync(bytes);
	// no real chunk has expanded (worst ratio 0.719) but already-compressed bytes would
	if (packed.length >= bytes.length) return { stored: bytes, rawBytes: 0 };
	return { stored: packed, rawBytes: bytes.length };
}

/**
 * The inverse of {@link packChunk}: inflates a stored chunk back to the heap bytes.
 *
 * @param rawBytes the inflated length recorded with the row; 0 means the row is already heap bytes
 * @throws when the inflated length disagrees with the recorded one
 */
export function unpackChunk(stored: Uint8Array, rawBytes: number): Uint8Array {
	if (rawBytes <= 0) return stored;
	// no `{ out }` hint: fflate truncates to a preallocated buffer silently, which would pass the
	// length check below with the wrong content
	const out = inflateSync(stored);
	if (out.length !== rawBytes) {
		throw new Error(`chunk inflated to ${out.length} bytes, row recorded ${rawBytes}`);
	}
	return out;
}

/** one stored row */
export type HeapChunk = { seq: number; bytes: Uint8Array };

/**
 * Splits bytes into rows that fit the record cap.
 *
 * Refuses a chunk size at or over the cap up front, so SQLite cannot reject a write mid-snapshot
 * and leave a partial image.
 */
export function chunkHeap(bytes: Uint8Array, chunkBytes = DEFAULT_CHUNK_BYTES): HeapChunk[] {
	if (chunkBytes <= 0) throw new RangeError('chunkBytes must be positive');
	if (chunkBytes >= DO_SQLITE_MAX_RECORD_BYTES) {
		throw new RangeError(
			`chunkBytes ${chunkBytes} is not under the ${DO_SQLITE_MAX_RECORD_BYTES}-byte record cap`
		);
	}
	const out: HeapChunk[] = [];
	for (let at = 0, seq = 0; at < bytes.length; at += chunkBytes, seq++) {
		// slice, not subarray (a view would pin the whole heap)
		out.push({ seq, bytes: bytes.slice(at, Math.min(at + chunkBytes, bytes.length)) });
	}
	return out;
}

/**
 * Concatenates stored rows back into one buffer.
 *
 * Sorts by `seq` (SQLite row order follows the query plan; an out-of-order join gives the right
 * length and wrong content) and throws on a gap or a length mismatch.
 */
export function joinChunks(chunks: HeapChunk[], expectedBytes?: number): Uint8Array {
	const sorted = [...chunks].sort((a, b) => a.seq - b.seq);
	for (let i = 0; i < sorted.length; i++) {
		if (sorted[i]?.seq !== i) throw new Error(`chunk sequence has a gap at ${i}`);
	}
	const total = sorted.reduce((n, c) => n + c.bytes.length, 0);
	if (expectedBytes !== undefined && total !== expectedBytes) {
		throw new Error(`chunks total ${total} bytes, expected ${expectedBytes}`);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of sorted) {
		out.set(c.bytes, at);
		at += c.bytes.length;
	}
	return out;
}

/**
 * 128-bit FNV-1a over the heap: an equality check, not a cryptographic guarantee.
 */
export function digestBytes(bytes: Uint8Array): string {
	// four 32-bit lanes (one collides at 77,163 pages, ~213 sites, and a dedup collision serves
	// another site's memory); lanes, not BigInt (23.7 MB a byte at a time)
	let a = 0x811c9dc5;
	let b = 0x01000193;
	let c = 0x9e3779b9;
	let d = 0x85ebca6b;
	// a word per lane (3.83x the byte form), native-endian; an unaligned view is copied so the same
	// bytes always hash alike
	if ((bytes.byteOffset & 3) !== 0) bytes = bytes.slice();
	let i = 0;
	const wordCount = bytes.length >>> 2;
	if (wordCount > 0) {
		const words = new Uint32Array(bytes.buffer, bytes.byteOffset, wordCount);
		for (let w = 0; w < wordCount; w++) {
			const v = words[w] as number;
			a = Math.imul(a ^ v, 0x01000193) >>> 0;
			b = Math.imul(b ^ (v + w), 0x85ebca6b) >>> 0;
			c = Math.imul(c ^ (v ^ w), 0xc2b2ae35) >>> 0;
			d = Math.imul(d ^ ((v >>> 16) + w), 0x27d4eb2f) >>> 0;
		}
		i += wordCount << 2;
	}
	for (; i < bytes.length; i++) {
		d = Math.imul(d ^ (bytes[i] as number), 0x27d4eb2f) >>> 0;
	}
	// multiply carries only propagate upward, so the finalizer mixes high bits down
	return fmix(a) + fmix(b) + fmix(c) + fmix(d);
}

/** murmur3's 32-bit avalanche, as eight hex digits */
function fmix(h: number): string {
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
	return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

/**
 * The open file descriptors a restored heap needs, at the same fd numbers (inodes do not matter).
 *
 * Dropping `/dev/urandom` throws `RandomException`; dropping the three sqlite fds stalls 80-120 s
 * before a locking error, a hung request on the edge. So the table is asserted before the memcpy.
 */
export type FdEntry = { fd: number; path: string; flags: number };

/**
 * Paths whose absence from a non-empty capture means the table was reconstructed, not captured.
 *
 * Not a list every runtime has: on the Durable Object path the database is a host call, so a
 * booted object has no descriptors above stdio. A runtime with any descriptor also opened
 * `/dev/urandom` (PHP's random source), so descriptors without it were assembled elsewhere.
 */
export const RECONSTRUCTION_TELL_PATHS = ['/dev/urandom'] as const;

/** @deprecated use `RECONSTRUCTION_TELL_PATHS`; this name reads as a requirement list */
export const REQUIRED_FD_PATHS = RECONSTRUCTION_TELL_PATHS;

/**
 * Compares a live fd table against the snapshot's.
 *
 * Returns every problem instead of throwing, so a caller names them all up front.
 */
export function fdTableProblems(snapshot: FdEntry[], live: FdEntry[]): string[] {
	const problems: string[] = [];
	// an empty capture replays to an empty table (the DO path, where the database is a host call)
	if (snapshot.length === 0) return problems;

	const liveByFd = new Map(live.map((e) => [e.fd, e]));
	for (const want of snapshot) {
		const got = liveByFd.get(want.fd);
		if (!got) {
			problems.push(`fd ${want.fd} (${want.path}) is not open`);
			continue;
		}
		// the heap holds the fd number, so a matching path at another number still breaks
		if (got.path !== want.path) {
			problems.push(`fd ${want.fd} is ${got.path}, snapshot had ${want.path}`);
		}
	}
	for (const tell of RECONSTRUCTION_TELL_PATHS) {
		if (!snapshot.some((e) => e.path === tell)) {
			problems.push(
				`snapshot has ${snapshot.length} descriptors but no ${tell}, so it was not captured ` +
					'from a live instance; a restore will throw RandomException'
			);
		}
	}
	return problems;
}

/**
 * One open descriptor, in the form a restore needs it.
 *
 * `fd` and `position` both matter: the heap holds the descriptor number, and a handle replayed at
 * offset 0 against a heap that believes it is mid-file reads the wrong bytes without error.
 */
export type StreamRecord = {
	fd: number;
	path: string;
	flags: number;
	position: number;
	seekable?: boolean;
	nodeId?: number | null;
	isDir?: boolean;
};

/** the emscripten FS surface the capture and replay actually touch, and nothing wider */
export interface StreamFS {
	streams: Array<{
		fd: number;
		path: string;
		flags: number;
		position: number;
		seekable?: boolean;
		node?: { id?: number; mode: number } | null;
	} | null>;
	open(
		path: string,
		flags: number | string
	): {
		fd: number;
		path: string;
		flags: number;
		position: number;
	};
	isDir(mode: number): boolean;
}

/**
 * Every open descriptor above stdio.
 *
 * Starts at 3: emscripten sets up 0/1/2 (stdio) for every instance, so replaying them would fight
 * the runtime.
 */
export function captureStreams(FS: StreamFS): StreamRecord[] {
	const out: StreamRecord[] = [];
	for (let fd = 3; fd < FS.streams.length; fd++) {
		const s = FS.streams[fd];
		if (!s) continue;
		out.push({
			fd,
			path: s.path,
			flags: s.flags,
			position: s.position,
			seekable: s.seekable,
			nodeId: s.node?.id ?? null,
			isDir: s.node ? FS.isDir(s.node.mode) : false
		});
	}
	return out;
}

/**
 * One vrzno handle, recorded as a name rather than the object it points at.
 *
 * `Module.targets.add(obj)` hands out `++this.id` and the PHP heap stores that integer, so after a
 * restore into a fresh instance the call dies as an uncatchable `TypeError: target is not a
 * function`. `CfwSqlClient::$execFunction` is resolved once and memoised into the kernel, so it
 * goes stale (`vrzno_env()` re-resolves at call time).
 *
 * A name survives the isolate where a reference cannot: `globalThis` and the `cfw*` Module
 * functions resolve by name in any instance, an arbitrary object does not, so capture reports what
 * it could not name instead of dropping it.
 */
export type HandleRecord = { id: number; name: string };

/** the name reserved for the global object, which is not a Module key */
export const GLOBAL_HANDLE_NAME = '@globalThis';

/**
 * The `Module.targets` surface capture and replay touch, and nothing wider.
 *
 * `byInteger` is php-wasm's iterable `WeakerMap` of `[id, object]`; `byObject` is a `WeakMap`. `id`
 * must be written on replay or the next `add()` re-issues an id the heap already owns.
 */
export interface HandleIndex {
	byObject: { set(key: object, id: number): unknown };
	byInteger: {
		set(id: number, value: object): unknown;
		[Symbol.iterator](): Iterator<[number, object]>;
	};
	id: number;
}

/** what a capture found, split into what can be restored and what cannot */
export type HandleCapture = {
	handles: HandleRecord[];
	/** handles whose object has no name in a fresh instance; a restore must refuse on these */
	unnameable: Array<{ id: number; kind: string }>;
};

/** a short description of a value, for reporting a handle that could not be named */
function describeValue(value: unknown): string {
	if (typeof value === 'function') return `function ${value.name || '(anonymous)'}`;
	if (value === null) return 'null';
	if (typeof value !== 'object') return typeof value;
	const ctor = (value as { constructor?: { name?: string } }).constructor;
	return `object ${ctor?.name ?? '(no constructor)'}`;
}

/**
 * Records the live vrzno handle table as names.
 *
 * Names resolve by value against the Module's keys plus the global object (`vrzno_env($name)`
 * reaches `Module[$name]`, so those are the only handles PHP can hold). Each key read is guarded,
 * since one throwing accessor must not cost the snapshot its handle table.
 */
export function captureHandles(
	index: HandleIndex | undefined,
	module: Record<string, unknown>,
	root: unknown = globalThis
): HandleCapture {
	const out: HandleCapture = { handles: [], unnameable: [] };
	if (!index) return out;

	const names = new Map<unknown, string>();
	names.set(root, GLOBAL_HANDLE_NAME);
	for (const key of Object.keys(module)) {
		let value: unknown;
		try {
			value = module[key];
		} catch {
			continue;
		}
		const holdable =
			typeof value === 'function' || (typeof value === 'object' && value !== null);
		if (holdable && !names.has(value)) names.set(value, key);
	}

	for (const [id, obj] of index.byInteger) {
		const name = names.get(obj);
		if (name === undefined) out.unnameable.push({ id: Number(id), kind: describeValue(obj) });
		else out.handles.push({ id: Number(id), name });
	}
	out.handles.sort((a, b) => a.id - b.id);
	out.unnameable.sort((a, b) => a.id - b.id);
	return out;
}

/** what a handle replay did, reported per handle so a partial failure names itself */
export type HandleReplayResult = {
	replayed: HandleRecord[];
	failed: Array<{ id: number; name: string; error: string }>;
	/** the highest id now issued, so a later `add()` cannot alias a restored handle */
	nextId: number;
};

/**
 * Re-registers each captured handle at the same integer id, in ascending order, and raises
 * `index.id` to the highest one. An id that lands elsewhere silently calls the wrong object, and a
 * low `index.id` lets the next `add()` reuse an owned id.
 *
 * Failures are collected so the caller can refuse the restore before the memcpy, as `replayStreams`
 * does for descriptors.
 */
export function replayHandles(
	index: HandleIndex | undefined,
	module: Record<string, unknown>,
	handles: HandleRecord[],
	root: unknown = globalThis
): HandleReplayResult {
	const out: HandleReplayResult = { replayed: [], failed: [], nextId: index?.id ?? 0 };
	if (!index) {
		for (const h of handles) {
			out.failed.push({
				id: h.id,
				name: h.name,
				error: 'no vrzno handle table on this binary'
			});
		}
		return out;
	}

	for (const h of [...handles].sort((a, b) => a.id - b.id)) {
		let value: unknown;
		try {
			value = h.name === GLOBAL_HANDLE_NAME ? root : module[h.name];
		} catch (e) {
			out.failed.push({ id: h.id, name: h.name, error: errorMessage(e) });
			continue;
		}
		if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) {
			out.failed.push({
				id: h.id,
				name: h.name,
				error: `resolves to ${describeValue(value)}, which cannot hold a handle`
			});
			continue;
		}
		try {
			index.byInteger.set(h.id, value as object);
			index.byObject.set(value as object, h.id);
			if (index.id < h.id) index.id = h.id;
			out.replayed.push(h);
		} catch (e) {
			out.failed.push({ id: h.id, name: h.name, error: errorMessage(e) });
		}
	}
	out.nextId = index.id;
	return out;
}

/** what a replay did, reported per descriptor so a partial failure names itself */
export type ReplayResult = {
	replayed: Array<{ fd: number; path: string; position: number }>;
	failed: Array<{ fd: number; path: string; error: string }>;
};

/**
 * Reopens each captured descriptor at the same fd number.
 *
 * `FS.open()` returns the next free descriptor, so the stream is relocated and the vacated slot
 * nulled. The numeric flags go back as-is so the node ops see the mode PHP opened with. Failures
 * are returned, not thrown, so the caller can refuse the restore before the memcpy.
 */
export function replayStreams(FS: StreamFS, streams: StreamRecord[]): ReplayResult {
	const out: ReplayResult = { replayed: [], failed: [] };
	for (const s of streams) {
		try {
			const stream = FS.open(s.path, s.flags);
			if (stream.fd !== s.fd) {
				FS.streams[s.fd] = stream;
				FS.streams[stream.fd] = null;
				stream.fd = s.fd;
			}
			stream.position = s.position;
			out.replayed.push({ fd: s.fd, path: s.path, position: s.position });
		} catch (e) {
			out.failed.push({ fd: s.fd, path: s.path, error: errorMessage(e) });
		}
	}
	return out;
}

/**
 * The `ctx.storage.sql` surface this module needs, and nothing wider.
 *
 * Narrow so a unit test can drive the read/write path with a fake.
 */
export interface HeapSql {
	// not generic: the platform's `exec()` returns Record<string, SqlStorageValue>[]; rows are
	// narrowed at each use
	exec(
		query: string,
		...bindings: Array<null | number | bigint | string | Uint8Array>
	): {
		toArray(): Array<Record<string, unknown>>;
		// iterating keeps a restore from materializing every row up front
		[Symbol.iterator](): Iterator<Record<string, unknown>>;
	};
}

/** what a stored snapshot's metadata row holds */
export type SnapshotMeta = {
	id: number;
	/** bytes per chunk at write time; seq * this is a chunk's offset in the elided stream */
	chunkBytes?: number;
	byteLength: number;
	pageBytes: number;
	totalPages: number;
	keptPages: number;
	digest: string;
	generation: string;
	createdAt: number;
};

/** whether a table already carries a column, so `ALTER` can be skipped */
function hasColumn(sql: HeapSql, table: string, column: string): boolean {
	return (
		sql.exec(`SELECT name FROM pragma_table_info(?) WHERE name = ?`, table, column).toArray()
			.length > 0
	);
}

/** creates the snapshot tables and adds any column an older deployed table lacks */
export function ensureHeapTables(sql: HeapSql): void {
	for (const stmt of HEAP_SNAPSHOT_DDL.split(';')) {
		const t = stmt.trim();
		if (t) sql.exec(`${t};`);
	}
	// check before `ALTER`, never catch (a failing one dirties `sqlite_master` and sent the serve
	// path into `migrate: starting`)
	if (!hasColumn(sql, 'cfw_heap_snapshot', 'handle_table')) {
		sql.exec(
			`ALTER TABLE cfw_heap_snapshot ADD COLUMN handle_table TEXT NOT NULL DEFAULT '[]';`
		);
	}
	if (!hasColumn(sql, 'cfw_heap_chunk', 'raw_bytes')) {
		sql.exec(`ALTER TABLE cfw_heap_chunk ADD COLUMN raw_bytes INTEGER NOT NULL DEFAULT 0;`);
	}
}

/**
 * Writes a heap into the object's own SQLite.
 *
 * Elides, chunks, then inserts each chunk as a bound BLOB parameter (base64 would become statement
 * text and blow {@link DO_SQLITE_MAX_STATEMENT_CHARS}). The fd table is stored with the bytes it
 * belongs to, never rebuilt from another instance.
 */
export function writeHeapSnapshot(
	sql: HeapSql,
	opts: {
		heap: Uint8Array;
		streams: StreamRecord[];
		generation: string;
		nowMs: number;
		handles?: HandleRecord[];
		chunkBytes?: number;
		pageBytes?: number;
	}
): {
	id: number;
	rows: number;
	storedBytes: number;
	compressedBytes: number;
	digest: string;
	keptPages: number;
} {
	const pageBytes = opts.pageBytes ?? WASM_PAGE_BYTES;
	const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
	if (chunkBytes <= 0) throw new RangeError('chunkBytes must be positive');
	if (chunkBytes >= DO_SQLITE_MAX_RECORD_BYTES) {
		throw new RangeError(
			`chunkBytes ${chunkBytes} is not under the ${DO_SQLITE_MAX_RECORD_BYTES}-byte record cap`
		);
	}

	const heap = opts.heap;
	const totalPages = Math.ceil(heap.length / pageBytes);
	const keep: number[] = [];
	for (let p = 0; p < totalPages; p++) {
		const from = p * pageBytes;
		const to = Math.min(from + pageBytes, heap.length);
		if (!isZeroRange(heap, from, to)) keep.push(p);
	}
	let elidedLength = 0;
	for (const p of keep) elidedLength += Math.min(pageBytes, heap.length - p * pageBytes);
	const elided = {
		byteLength: heap.length,
		totalPages,
		pageIndex: keep,
		bytesLength: elidedLength
	};
	const digest = digestBytes(heap);

	const row = firstRow(
		sql.exec(
			`INSERT INTO cfw_heap_snapshot
				(created_at, byte_length, page_bytes, total_pages, kept_pages, page_index, chunk_bytes, digest, generation, fd_table, handle_table)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
			opts.nowMs,
			elided.byteLength,
			pageBytes,
			elided.totalPages,
			elided.pageIndex.length,
			JSON.stringify(elided.pageIndex),
			chunkBytes,
			digest,
			opts.generation,
			JSON.stringify(opts.streams),
			JSON.stringify(opts.handles ?? [])
		)
	);
	const id = Number(row?.id ?? 0);
	if (!id) throw new Error('snapshot insert returned no id');

	// one staging buffer refilled in place; the stream equals elideZeroPages() + chunkHeap(), so
	// `seq * chunkBytes` still locates a chunk
	const staging = new Uint8Array(chunkBytes);
	let filled = 0;
	let seq = 0;
	let compressedBytes = 0;
	const flush = () => {
		if (filled === 0) return;
		// real length (the last chunk is short; padding would restore zeroes)
		const bytes = staging.slice(0, filled);
		const { stored, rawBytes } = packChunk(bytes);
		// per-chunk digest over the heap bytes: a streaming restore must refuse a chunk before it
		// lands, and this also catches a bad inflate and verifies rows written before packing
		sql.exec(
			'INSERT INTO cfw_heap_chunk (snapshot_id, seq, bytes, digest, raw_bytes) VALUES (?, ?, ?, ?, ?)',
			id,
			seq,
			stored,
			digestBytes(bytes),
			rawBytes
		);
		compressedBytes += stored.length;
		seq++;
		filled = 0;
	};
	for (const p of keep) {
		const from = p * pageBytes;
		const to = Math.min(from + pageBytes, heap.length);
		let at = from;
		while (at < to) {
			const take = Math.min(chunkBytes - filled, to - at);
			staging.set(heap.subarray(at, at + take), filled);
			filled += take;
			at += take;
			if (filled === chunkBytes) flush();
		}
	}
	flush();

	return {
		id,
		rows: seq,
		storedBytes: elided.bytesLength,
		// what the rows occupy (the storage cap's unit); `storedBytes` stays the elided length
		// because restore offsets are in those coordinates
		compressedBytes,
		digest,
		keptPages: elided.pageIndex.length
	};
}

/**
 * Whether the newest stored image predates the chunk codec, so re-imaging would shrink it.
 *
 * The producer skips a site whose recorded generation is current, so an unpacked image (3.57x its
 * packed size) would never re-image on its own; the alarm reads this to clear that generation once.
 *
 * A zero `raw_bytes` on any chunk is enough (the codec writes it on every packed row, and only an
 * incompressible chunk is legitimately zero); a false positive costs one re-image.
 *
 * @returns false when there is no image at all
 */
export function hasUnpackedChunks(sql: HeapSql): boolean {
	const meta = latestSnapshotMeta(sql);
	if (meta === undefined) return false;
	return (
		sql
			.exec(
				'SELECT 1 AS unpacked FROM cfw_heap_chunk WHERE snapshot_id = ? AND raw_bytes <= 0 LIMIT 1',
				meta.id
			)
			.toArray().length > 0
	);
}

/** the newest snapshot's metadata, or undefined when there is none */
export function latestSnapshotMeta(sql: HeapSql, generation?: string): SnapshotMeta | undefined {
	const rows = generation
		? sql
				.exec(
					'SELECT * FROM cfw_heap_snapshot WHERE generation = ? ORDER BY id DESC LIMIT 1',
					generation
				)
				.toArray()
		: sql.exec('SELECT * FROM cfw_heap_snapshot ORDER BY id DESC LIMIT 1').toArray();
	const r = rows[0];
	if (!r) return undefined;
	return {
		id: Number(r.id),
		byteLength: Number(r.byte_length),
		pageBytes: Number(r.page_bytes),
		totalPages: Number(r.total_pages),
		keptPages: Number(r.kept_pages),
		digest: String(r.digest),
		chunkBytes: Number(r.chunk_bytes ?? DEFAULT_CHUNK_BYTES),
		generation: String(r.generation),
		createdAt: Number(r.created_at)
	};
}

/** the page index, fd table and handle table for one snapshot, without touching a single chunk */
export function snapshotPageIndex(
	sql: HeapSql,
	id: number
): { pageIndex: number[]; streams: StreamRecord[]; handles: HandleRecord[] } | undefined {
	const row = firstRow(
		sql.exec(
			'SELECT page_index, fd_table, handle_table FROM cfw_heap_snapshot WHERE id = ?',
			id
		)
	);
	if (!row) return undefined;
	return {
		pageIndex: JSON.parse(String(row.page_index ?? '[]')) as number[],
		streams: JSON.parse(String(row.fd_table ?? '[]')) as StreamRecord[],
		handles: JSON.parse(String(row.handle_table ?? '[]')) as HandleRecord[]
	};
}

/**
 * Reads a snapshot back and rebuilds the heap.
 *
 * A digest mismatch throws: a right-length wrong-bytes heap restores cleanly and renders subtly
 * wrong, so refusing (one boot) beats accepting. `joinChunks` also sorts and checks gaps.
 */
export function readHeapSnapshot(
	sql: HeapSql,
	opts: { generation?: string } = {}
): { heap: Uint8Array; streams: StreamRecord[]; meta: SnapshotMeta } | undefined {
	const meta = latestSnapshotMeta(sql, opts.generation);
	if (!meta) return undefined;

	const chunkRows = sql
		.exec(
			'SELECT seq, bytes, raw_bytes FROM cfw_heap_chunk WHERE snapshot_id = ? ORDER BY seq',
			meta.id
		)
		.toArray();
	if (chunkRows.length === 0) throw new Error(`snapshot ${meta.id} has no chunks`);

	const fdRow = firstRow(
		sql.exec('SELECT page_index, fd_table FROM cfw_heap_snapshot WHERE id = ?', meta.id)
	);
	const pageIndex = JSON.parse(String(fdRow?.page_index ?? '[]')) as number[];
	const streams = JSON.parse(String(fdRow?.fd_table ?? '[]')) as StreamRecord[];

	const bytes = joinChunks(
		chunkRows.map((r) => {
			const seq = Number(r.seq);
			try {
				return {
					seq,
					bytes: unpackChunk(
						toStorableBytes(r.bytes as ArrayBufferLike | Uint8Array),
						Number(r.raw_bytes ?? 0)
					)
				};
			} catch (e) {
				// nothing has landed yet; same wording as the streaming reader
				throw new Error(
					`snapshot ${meta.id} chunk ${seq} did not inflate: ` + errorMessage(e)
				);
			}
		})
	);
	const heap = reassembleHeap(
		{
			bytes,
			pageIndex,
			totalPages: meta.totalPages,
			byteLength: meta.byteLength,
			pageBytes: bytes.length
		},
		meta.pageBytes
	);

	const actual = digestBytes(heap);
	if (actual !== meta.digest) {
		throw new Error(
			`snapshot ${meta.id} digest mismatch: stored ${meta.digest}, rebuilt ${actual}`
		);
	}
	return { heap, streams, meta };
}

/**
 * Where one kept page lives, in both coordinate systems.
 *
 * Maps an offset in the elided stream (what chunks concatenate to) onto the heap, so a chunk
 * applies without assembling the stream.
 */
type PageSpan = { elidedStart: number; heapStart: number; length: number };

/** the elided-to-heap map, in ascending elided order */
export function pageSpans(
	pageIndex: number[],
	byteLength: number,
	pageBytes = WASM_PAGE_BYTES
): PageSpan[] {
	const spans: PageSpan[] = [];
	let elided = 0;
	for (const page of pageIndex) {
		const heapStart = page * pageBytes;
		if (heapStart >= byteLength) throw new RangeError(`page ${page} is past the heap end`);
		const length = Math.min(pageBytes, byteLength - heapStart);
		spans.push({ elidedStart: elided, heapStart, length });
		elided += length;
	}
	return spans;
}

/**
 * A chunk whose stored bytes disagree with its stored digest.
 *
 * `bytesWritten` says what the caller owes: on the first chunk the heap is untouched (boot from
 * the pack); at chunk N the heap has the right length and wrong bytes and must be dropped.
 */
export class HeapChunkDigestError extends Error {
	/** the chunk sequence number that failed */
	readonly seq: number;
	/** the digest stored with the chunk */
	readonly expected: string;
	/** the digest of the bytes read, or why they would not inflate */
	readonly actual: string;
	/** bytes this call had already applied to the live heap before it refused */
	readonly bytesWritten: number;
	/** chunks this call had already applied */
	readonly chunksApplied: number;
	constructor(opts: {
		seq: number;
		expected: string;
		actual: string;
		bytesWritten: number;
		chunksApplied: number;
	}) {
		super(`chunk ${opts.seq} digest mismatch: stored ${opts.expected}, read ${opts.actual}`);
		this.name = 'HeapChunkDigestError';
		this.seq = opts.seq;
		this.expected = opts.expected;
		this.actual = opts.actual;
		this.bytesWritten = opts.bytesWritten;
		this.chunksApplied = opts.chunksApplied;
	}
}

/** what a streaming restore did, and the largest single buffer it held */
export type StreamRestoreResult = {
	chunks: number;
	bytesWritten: number;
	largestChunkBytes: number;
	elidedBytes: number;
	/** the `from` a resuming call must pass to continue; equals `totalChunks` when done */
	nextChunk: number;
	/** how many chunks the snapshot has in total, so a caller knows when it is complete */
	totalChunks: number;
	/** every chunk applied, so the restore is finished and the heap is usable */
	complete: boolean;
};

/**
 * Applies a stored snapshot directly into a live heap, one chunk at a time.
 *
 * Nothing larger than one chunk is allocated: the isolate memory ceiling is non-monotone (128 MiB
 * failed where 160 MiB succeeded), so materialising the image passes repeatedly, then fails in
 * production. Each digest is checked before its chunk is applied. `DecompressionStream` is not
 * used (15.7 ms per MB of output on the edge); fflate inflates synchronously.
 *
 * @param sql - the Durable Object's own SQL
 * @param target - the live heap, written in place
 * @param opts - `from`/`limit` slice the chunk sequence so a restore divides across alarm firings
 */
export function streamRestoreInto(
	sql: HeapSql,
	target: Uint8Array,
	opts: { meta: SnapshotMeta; pageIndex: number[]; from?: number; limit?: number }
): StreamRestoreResult {
	const { meta, pageIndex } = opts;
	if (target.length !== meta.byteLength) {
		throw new RangeError(`heap is ${target.length} bytes, snapshot is ${meta.byteLength}`);
	}
	const spans = pageSpans(pageIndex, meta.byteLength, meta.pageBytes);
	const from = opts.from ?? 0;
	const limit = opts.limit ?? Number.MAX_SAFE_INTEGER;

	const totalChunks = Number(
		(
			firstRow(
				sql.exec('SELECT COUNT(*) AS n FROM cfw_heap_chunk WHERE snapshot_id = ?', meta.id)
			) as { n: number | bigint } | undefined
		)?.n ?? 0
	);
	const out: StreamRestoreResult = {
		chunks: 0,
		bytesWritten: 0,
		largestChunkBytes: 0,
		elidedBytes: spans.reduce((n, sp) => n + sp.length, 0),
		nextChunk: from,
		totalChunks,
		complete: false
	};

	// iterate; `.toArray()` would materialise every chunk row
	const cursor = sql.exec(
		'SELECT seq, bytes, digest, raw_bytes FROM cfw_heap_chunk WHERE snapshot_id = ? AND seq >= ? ORDER BY seq',
		meta.id,
		from
	);

	let spanAt = 0;
	for (const row of cursor) {
		if (out.chunks >= limit) break;
		const seq = Number(row.seq);
		// a chunk that will not inflate is corrupt: report it as a digest error so the caller
		// gets `bytesWritten`
		let bytes: Uint8Array;
		try {
			bytes = unpackChunk(
				toStorableBytes(row.bytes as ArrayBufferLike | Uint8Array),
				Number(row.raw_bytes ?? 0)
			);
		} catch (e) {
			throw new HeapChunkDigestError({
				seq,
				expected: String(row.digest ?? ''),
				actual: `did not inflate: ${errorMessage(e)}`,
				bytesWritten: out.bytesWritten,
				chunksApplied: out.chunks
			});
		}
		const expected = String(row.digest ?? '');
		const actual = digestBytes(bytes);
		if (expected !== '' && actual !== expected) {
			// refuse before applying (a landed bad chunk restores cleanly and renders wrong)
			throw new HeapChunkDigestError({
				seq,
				expected,
				actual,
				bytesWritten: out.bytesWritten,
				chunksApplied: out.chunks
			});
		}
		out.largestChunkBytes = Math.max(out.largestChunkBytes, bytes.length);

		// this chunk covers [chunkStart, chunkStart + bytes.length) of the elided stream
		const chunkStart = seq * (meta.chunkBytes ?? DEFAULT_CHUNK_BYTES);
		const chunkEnd = chunkStart + bytes.length;
		// spans and chunks both ascend, so this walk is linear
		while (
			spanAt > 0 &&
			spans[spanAt - 1] &&
			(spans[spanAt - 1] as PageSpan).elidedStart > chunkStart
		) {
			spanAt--;
		}
		while (
			spanAt < spans.length &&
			(spans[spanAt] as PageSpan).elidedStart + (spans[spanAt] as PageSpan).length <=
				chunkStart
		) {
			spanAt++;
		}
		for (let i = spanAt; i < spans.length; i++) {
			const sp = spans[i] as PageSpan;
			if (sp.elidedStart >= chunkEnd) break;
			const overlapStart = Math.max(sp.elidedStart, chunkStart);
			const overlapEnd = Math.min(sp.elidedStart + sp.length, chunkEnd);
			if (overlapEnd <= overlapStart) continue;
			// a view, not a copy
			target.set(
				bytes.subarray(overlapStart - chunkStart, overlapEnd - chunkStart),
				sp.heapStart + (overlapStart - sp.elidedStart)
			);
			out.bytesWritten += overlapEnd - overlapStart;
		}
		out.chunks++;
		out.nextChunk = seq + 1;
	}
	out.complete = out.nextChunk >= totalChunks;
	return out;
}

/**
 * Keeps the newest `keep` snapshots and deletes the rest.
 *
 * Chunks go first, so a crash between the deletes leaves orphaned metadata rather than megabytes.
 */
export function gcHeapSnapshots(sql: HeapSql, keep = 1): number {
	if (keep < 1) throw new RangeError('keep must be at least 1');
	const doomed = sql
		.exec('SELECT id FROM cfw_heap_snapshot ORDER BY id DESC LIMIT -1 OFFSET ?', keep)
		.toArray()
		.map((r) => Number(r.id));
	for (const id of doomed) {
		sql.exec('DELETE FROM cfw_heap_chunk WHERE snapshot_id = ?', id);
		sql.exec('DELETE FROM cfw_heap_snapshot WHERE id = ?', id);
	}
	return doomed.length;
}

/**
 * Deletes every snapshot, whatever generation it is for.
 *
 * The generation (pack plus enabled modules) does not move when a reconciliation step rewrites
 * configuration, so the old image would still restore the kernel the step replaces.
 * `dropStaleSnapshots()` cannot serve: it keeps exactly the generation that is now wrong.
 */
export function dropAllSnapshots(sql: HeapSql): number {
	const doomed = sql
		.exec('SELECT id FROM cfw_heap_snapshot')
		.toArray()
		.map((r) => Number(r.id));
	for (const id of doomed) {
		sql.exec('DELETE FROM cfw_heap_chunk WHERE snapshot_id = ?', id);
		sql.exec('DELETE FROM cfw_heap_snapshot WHERE id = ?', id);
	}
	return doomed.length;
}

/**
 * Deletes every snapshot that is not for `generation`.
 *
 * A generation only moves forward, so an image for any other one is dead storage (~10 MB each).
 */
export function dropStaleSnapshots(sql: HeapSql, generation: string): number {
	const doomed = sql
		.exec('SELECT id FROM cfw_heap_snapshot WHERE generation IS NOT ?', generation)
		.toArray()
		.map((r) => Number(r.id));
	for (const id of doomed) {
		sql.exec('DELETE FROM cfw_heap_chunk WHERE snapshot_id = ?', id);
		sql.exec('DELETE FROM cfw_heap_snapshot WHERE id = ?', id);
	}
	return doomed.length;
}
