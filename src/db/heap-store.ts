/**
 * Storage layer for a wasm heap snapshot in the Durable Object's own SQLite.
 *
 * Every limit below is measured on a deployed object, not inferred. They are constants here because
 * this project has repeatedly paid for platform limits that lived only in prose: the 100-parameter
 * ceiling broke the cache write path, and the 50-byte LIKE ceiling was believed to bind only `GLOB`.
 */

/**
 * Bytes per record in Durable Object SQLite. Measured; exceeding it is a hard error, not a truncation.
 */
export const DO_SQLITE_MAX_RECORD_BYTES = 2_199_995;

/**
 * Statement text ceiling, in characters. This is why the heap NEVER goes through the base64 codec:
 * a base64 payload becomes statement TEXT and blows this, where a bound BLOB parameter does not.
 */
export const DO_SQLITE_MAX_STATEMENT_CHARS = 100_000;

/** One wasm page. Elision works at page granularity because that is how the heap is grown. */
export const WASM_PAGE_BYTES = 65_536;

/**
 * Default bytes per stored chunk.
 *
 * Sized by the CPU cap, not by the record cap, and the correction is measured.
 * The old default was 2,000,000 -- chosen because it fits `DO_SQLITE_MAX_RECORD_BYTES` -- and a
 * deployed sweep with `HEAP_RESTORE_CHUNKS=1` showed the record cap is not the binding constraint:
 *
 * | chunk bytes | rows | per-firing edge cpuTime | over the 10 ms cap |
 * | ----------- | ---- | ----------------------- | ------------------ |
 * | 2,000,000   | 5    | median 29, max 52 ms    | 3 of 4             |
 * | 400,000     | 21   | median 8, max 13 ms     | 4 of 21            |
 * | 200,000     | 41   | median 2, max 10 ms     | **0 of 41**        |
 *
 * So the goal of chunking -- one restore step inside one free-plan invocation -- only holds
 * at roughly this size. 41 rows for an 8.1 MB elided image is still a handful of reads, and rows are
 * not the meter that binds. The cost is not the memcpy: each chunk is also digested by a per-byte
 * JS loop (`digestBytes`), so per-firing CPU tracks chunk size closely.
 */
export const DEFAULT_CHUNK_BYTES = 200_000;

/** DDL for the snapshot tables. Two tables: one row of metadata, N rows of bytes. */
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
	PRIMARY KEY (snapshot_id, seq)
);
`.trim();

/**
 * A heap with its all-zero pages removed, plus the index needed to put them back.
 *
 * `pageIndex` holds the page numbers that were KEPT, ascending. Everything not listed was all zero
 * and is restored as zero, which is what a fresh `WebAssembly.Memory` already contains.
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
 * Copies a heap out of wasm memory into a plain array so it can be stored.
 *
 * This function exists because of a silent-failure trap. `someUint8Array.set(arrayBuffer)` copies
 * **zero bytes** and throws nothing -- the destination stays zeroed and the snapshot looks like it
 * worked until the restore renders an empty page. An `ArrayBuffer` is not an array-like, so `set()`
 * treats it as having no indexed properties and length 0. It must be wrapped in a view first.
 *
 * Wrapping also detaches the result from the live `WebAssembly.Memory`, which matters: the buffer a
 * growing heap hands out can be replaced, so a stored reference would read the wrong bytes later.
 */
export function toStorableBytes(src: ArrayBuffer | ArrayBufferLike | Uint8Array): Uint8Array {
	const view = src instanceof Uint8Array ? src : new Uint8Array(src);
	// slice() rather than a view: a copy that cannot be invalidated by a later memory.grow()
	return view.slice();
}

/**
 * True when every byte in `[from, to)` is zero, read a word at a time: 3.93x the byte form over a
 * 96 MiB heap. Head and tail stay bytewise because a `Uint32Array` view needs a 4-aligned ABSOLUTE
 * offset, and a page boundary always is one.
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
 * Measured on a booted Drupal heap: 80,543,744 bytes goes to 39,911,590 raw, so slightly over half
 * the image is pages that a fresh instance already has. Compression is a SEPARATE and conditional
 * decision -- elision is free and always correct, compression trades boot CPU for bytes at rest and
 * only pays when the measurement says the bytes are needed.
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
 * The result is `byteLength` long, NOT `totalPages * pageBytes`, because the last page is usually
 * partial and a heap that is even one byte too long shifts nothing but still fails a digest compare.
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
		// a mismatch means the index and the payload disagree, which would restore a plausible but
		// wrong heap -- refuse rather than hand back something that renders
		throw new Error(`page index consumed ${at} of ${elided.bytes.length} bytes`);
	}
	return full;
}

/** one stored row */
export type HeapChunk = { seq: number; bytes: Uint8Array };

/**
 * Splits bytes into rows that fit the record cap.
 *
 * Refuses a chunk size at or over the cap rather than letting SQLite reject the write halfway
 * through a snapshot, which would leave a partial image that looks storable.
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
		// subarray would store a view onto the whole heap; slice keeps each row independent
		out.push({ seq, bytes: bytes.slice(at, Math.min(at + chunkBytes, bytes.length)) });
	}
	return out;
}

/**
 * Concatenates stored rows back into one buffer.
 *
 * Sorts by `seq` rather than trusting arrival order: SQLite returns rows in whatever order the query
 * plan produces, and an out-of-order join yields a heap that is the right LENGTH and wrong content,
 * which is the failure shape this project keeps producing.
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
 * 128-bit FNV-1a over the heap: an equality assertion, not a cryptographic guarantee.
 *
 * It answers "are these the same bytes", which is the only question a restore asks.
 */
export function digestBytes(bytes: Uint8Array): string {
	// four lanes, because 32 bits collides at 77,163 pages (213 sites) and a dedup-key collision
	// serves one site another's memory. Lanes rather than BigInt: 23.7 MB a byte at a time
	let a = 0x811c9dc5;
	let b = 0x01000193;
	let c = 0x9e3779b9;
	let d = 0x85ebca6b;
	// a word per lane, 3.83x the byte form over 35 MB, native-endian (only ever compared against
	// another from the same machine). An unaligned view is COPIED, not walked: word boundaries
	// would otherwise fall differently and key the same bytes twice. No shipping caller is unaligned
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
	// multiply carries propagate UPWARD only, so without a finalizer a flipped high bit never
	// reaches the low ones and near-identical pages stay near-identical
	return fmix(a) + fmix(b) + fmix(c) + fmix(d);
}

/** murmur3's 32-bit avalanche, as eight hex digits */
function fmix(h: number): string {
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
	return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0');
}

/**
 * The open file descriptors a restored heap must have, recorded at snapshot time.
 *
 * Measured on the standalone restore probe, and it inverted the hypothesis this code was written
 * against: inode alignment is NOT load-bearing (shifting every inode by 1 and by 500 both restored
 * byte-identically), but the open fd table IS, at the same fd numbers. Four descriptors. Dropping
 * `/dev/urandom`'s alone throws `RandomException`; dropping the three sqlite fds gives a
 * locking-protocol error after an **80-120 second stall**, which on the edge is a hung request
 * rather than an error -- so this is asserted BEFORE the memcpy and fails loudly.
 */
export type FdEntry = { fd: number; path: string; flags: number };

/**
 * Paths whose absence from a NON-EMPTY capture means the table was reconstructed, not captured.
 *
 * NOT a list of descriptors every runtime has, which is how it was being read and is where the false
 * alarm came from. On the Durable Object path the database is a HOST CALL rather than a file, so a
 * booted object legitimately has zero descriptors above stdio, and the check demanded a
 * `/dev/urandom` that is correctly absent. The four descriptors came from `static-free-v1`
 * STANDALONE, with a real `.sqlite` open on disk.
 *
 * What survives is the narrow inference: a runtime that opened ANY descriptor also opened
 * `/dev/urandom`, because PHP's CSPRNG does. So a capture that holds descriptors but no
 * `/dev/urandom` did not come from a live `captureStreams()` -- it was assembled somewhere else,
 * which is the failure this exists to catch.
 */
export const RECONSTRUCTION_TELL_PATHS = ['/dev/urandom'] as const;

/** @deprecated read `RECONSTRUCTION_TELL_PATHS`; this name reads as a requirement list and is not one */
export const REQUIRED_FD_PATHS = RECONSTRUCTION_TELL_PATHS;

/**
 * Compares a live fd table against the snapshot's.
 *
 * Returns the problems rather than throwing, so a caller can report all of them at once: a restore
 * that fails on the second of four descriptors after an 80-second stall is much harder to diagnose
 * than one that names all four up front.
 */
export function fdTableProblems(snapshot: FdEntry[], live: FdEntry[]): string[] {
	const problems: string[] = [];
	// nothing captured is not a missing capture. An empty table replays to an empty table, so there is
	// nothing a restore can get wrong -- this is the DO path, where the database is a host call
	if (snapshot.length === 0) return problems;

	const liveByFd = new Map(live.map((e) => [e.fd, e]));
	for (const want of snapshot) {
		const got = liveByFd.get(want.fd);
		if (!got) {
			problems.push(`fd ${want.fd} (${want.path}) is not open`);
			continue;
		}
		// same NUMBER and same path: a matching path at a different fd still breaks, because the heap
		// holds the integer
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
 * `fd` is the load-bearing field: the heap holds descriptor NUMBERS, so a correct path reopened at
 * a different number still breaks. `position` matters for the same reason -- a replayed handle at
 * offset 0 against a heap that believes it is mid-file reads the wrong bytes and returns them
 * happily.
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
 * Starts at 3: 0/1/2 are stdio, which emscripten sets up for every instance, so
 * replaying them would fight the runtime rather than restore anything.
 *
 * Ported from the restore probe rather than reimplemented -- that code is the only version of this
 * that has been proven against a real restore, and `src/probes/**` are frozen instruments that
 * must not be edited, so the logic is promoted here instead.
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
 * One vrzno handle, recorded as a NAME rather than as the object it points at.
 *
 * MEASURED, and it falsifies what this project wrote down twice. `Module.targets` is a
 * `UniqueIndex`: `add(obj)` hands out `++this.id` and the PHP side stores that INTEGER inside the
 * heap. So a handle taken before a snapshot is an index into a JS table that a fresh instance does
 * not have, and the glue's call thunk is
 * `const target = Module.targets.get($0); ... target(...args)` -- an absent entry is `undefined`
 * and the call dies as **`TypeError: target is not a function`**, uncatchable from PHP.
 *
 * That is exactly what a render through a restored heap did on a deployed worker, and it is why
 * "no handle-table replay was needed" was wrong: `vrzno_env()` re-resolves `Module[$name]` at CALL
 * time, so the `op=bridge` probe mints a fresh handle and passes, while
 * `CfwSqlClient::$execFunction` -- resolved ONCE in the constructor and memoised into the booted
 * kernel -- is a stale integer the moment the heap is restored into a new instance.
 *
 * A name rather than a reference because a reference cannot survive the isolate. `globalThis` and
 * the `cfw*` host functions hung off the Module are reproducible by name in any fresh instance; an
 * arbitrary object (a `Response`, an `ArrayBuffer`) is not, which is why capture reports what it
 * could NOT name instead of silently dropping it.
 */
export type HandleRecord = { id: number; name: string };

/** the name reserved for the global object, which is not a Module key */
export const GLOBAL_HANDLE_NAME = '@globalThis';

/**
 * The `Module.targets` surface capture and replay touch, and nothing wider.
 *
 * `byInteger` is php-wasm's `WeakerMap`, which is iterable and holds `[id, object]`; `byObject` is
 * a real `WeakMap`. `id` is a plain writable property, and writing it is load-bearing: without it
 * the next `add()` would re-issue an id the restored heap already believes it owns.
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
	/** handles whose object has no name in a fresh instance; a restore MUST refuse on these */
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
 * Resolution is BY VALUE against the Module's own keys plus the global object, because that is the
 * only naming a fresh instance can reproduce: `vrzno_env($name)` reaches `Module[$name]`, so every
 * handle PHP can legitimately have acquired is either the global or something the Module hangs.
 *
 * Reads of Module keys are individually guarded: an emscripten Module carries accessor properties,
 * and one throwing getter must not cost the whole snapshot its handle table.
 */
export function captureHandles(
	index: HandleIndex | null | undefined,
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
 * Re-registers each captured handle AT THE SAME INTEGER ID.
 *
 * Ascending id order, and `index.id` is raised to the highest one seen. Both matter: the PHP heap
 * holds the integers, so an id that lands anywhere else is a handle pointing at the wrong object --
 * which does not throw, it silently calls something else. Leaving `index.id` low is the same defect
 * one step later, because the next `add()` would hand a fresh object an id the heap already owns.
 *
 * Failures are collected rather than thrown so the caller can refuse the restore BEFORE the memcpy
 * and name every bad handle at once, exactly as `replayStreams` does for descriptors.
 */
export function replayHandles(
	index: HandleIndex | null | undefined,
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
			out.failed.push({ id: h.id, name: h.name, error: String((e as Error)?.message ?? e) });
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
			out.failed.push({ id: h.id, name: h.name, error: String((e as Error)?.message ?? e) });
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
 * Reopens each captured descriptor AT THE SAME fd NUMBER.
 *
 * `FS.open()` returns the next free descriptor, which is not necessarily the one the image
 * expects, so the stream is relocated afterwards and the vacated slot nulled.
 *
 * The numeric flags go back in as-is: they came out of a real open, and the node ops then see
 * exactly the mode PHP opened with. Measured without this -- dropping
 * `/dev/urandom` alone throws `RandomException`, and dropping the three sqlite descriptors gives a
 * locking-protocol error **after an 80-120 second stall**, which on the edge is a hung request
 * rather than an error. That is why failures are collected and returned rather than thrown past:
 * the caller must be able to refuse the restore BEFORE the memcpy, naming every bad descriptor at
 * once.
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
			const err = e as { message?: string };
			out.failed.push({ fd: s.fd, path: s.path, error: String(err?.message ?? e) });
		}
	}
	return out;
}

/**
 * The `ctx.storage.sql` surface this module needs, and nothing wider.
 *
 * Narrow: it makes the read/write path drivable from a unit test with a fake, which is
 * the only way to test a Durable Object's storage without a Durable Object.
 */
export interface HeapSql {
	// NOT generic: the platform's `exec()` returns Record<string, SqlStorageValue>[],
	// and a generic T is too permissive to accept it. Rows are narrowed at each use instead
	exec(
		query: string,
		...bindings: Array<null | number | bigint | string | Uint8Array>
	): {
		toArray(): Array<Record<string, unknown>>;
		// the DO cursor is iterable, and iterating is what keeps a restore from materializing every
		// row before a single byte moves
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

export function ensureHeapTables(sql: HeapSql): void {
	for (const stmt of HEAP_SNAPSHOT_DDL.split(';')) {
		const t = stmt.trim();
		if (t) sql.exec(`${t};`);
	}
	// a table created before handle_table existed keeps its old columns under CREATE TABLE IF NOT
	// EXISTS, and a deployed object carries one; the ALTER is the only thing that adds it
	try {
		sql.exec(
			`ALTER TABLE cfw_heap_snapshot ADD COLUMN handle_table TEXT NOT NULL DEFAULT '[]';`
		);
	} catch {
		/* already there */
	}
}

/**
 * Writes a heap into the object's own SQLite.
 *
 * Elide, chunk, then insert each chunk as a BOUND BLOB PARAMETER. The binding is not a style
 * choice: a base64 payload would become statement TEXT and blow the 100,000-character statement
 * ceiling long before the record cap, which is why the codec is bypassed entirely here.
 *
 * The fd table goes in the metadata row rather than being derived on restore. It is the
 * load-bearing part of a restore, so it is stored WITH the bytes it belongs to -- a snapshot whose
 * descriptor table is reconstructed from a different instance's state is not a snapshot.
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
): { id: number; rows: number; storedBytes: number; digest: string; keptPages: number } {
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

	const row = sql
		.exec(
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
		.toArray()[0];
	const id = Number(row?.id ?? 0);
	if (!id) throw new Error('snapshot insert returned no id');

	// one chunk-sized staging buffer, refilled in place. The kept pages are copied into it in
	// order, so the byte stream is identical to elideZeroPages() + chunkHeap() and a restore reads
	// it the same way -- `seq * chunkBytes` still locates a chunk in the elided stream
	const staging = new Uint8Array(chunkBytes);
	let filled = 0;
	let seq = 0;
	const flush = () => {
		if (filled === 0) return;
		// sliced to its real length: the last chunk is short, and storing the whole staging
		// buffer would pad the elided stream with zeroes a restore would then apply
		const bytes = staging.slice(0, filled);
		// a digest PER CHUNK, not just for the whole heap: a streaming restore applies bytes as it
		// reads them, so a whole-image check can only tell you afterwards that the heap is already
		// wrong. This one refuses the chunk before it lands
		sql.exec(
			'INSERT INTO cfw_heap_chunk (snapshot_id, seq, bytes, digest) VALUES (?, ?, ?, ?)',
			id,
			seq,
			bytes,
			digestBytes(bytes)
		);
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
		digest,
		keptPages: elided.pageIndex.length
	};
}

/** the newest snapshot's metadata, or null when there is none */
export function latestSnapshotMeta(sql: HeapSql, generation?: string): SnapshotMeta | null {
	const rows = generation
		? sql
				.exec(
					'SELECT * FROM cfw_heap_snapshot WHERE generation = ? ORDER BY id DESC LIMIT 1',
					generation
				)
				.toArray()
		: sql.exec('SELECT * FROM cfw_heap_snapshot ORDER BY id DESC LIMIT 1').toArray();
	const r = rows[0];
	if (!r) return null;
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
): { pageIndex: number[]; streams: StreamRecord[]; handles: HandleRecord[] } | null {
	const row = sql
		.exec('SELECT page_index, fd_table, handle_table FROM cfw_heap_snapshot WHERE id = ?', id)
		.toArray()[0];
	if (!row) return null;
	return {
		pageIndex: JSON.parse(String(row.page_index ?? '[]')) as number[],
		streams: JSON.parse(String(row.fd_table ?? '[]')) as StreamRecord[],
		handles: JSON.parse(String(row.handle_table ?? '[]')) as HandleRecord[]
	};
}

/**
 * Reads a snapshot back and rebuilds the heap.
 *
 * **The digest is verified and a mismatch REFUSES.** That check is the whole reason the digest is
 * stored: a heap that is the right length and the wrong bytes restores cleanly and then renders
 * something subtly wrong, which is this project's signature failure. Refusing costs one boot;
 * accepting costs a silently incorrect site.
 *
 * `ORDER BY seq` is belt and braces -- `joinChunks` sorts and checks for gaps anyway, because
 * SQLite makes no promise about row order and an out-of-order join produces a right-length,
 * wrong-content heap.
 */
export function readHeapSnapshot(
	sql: HeapSql,
	opts: { generation?: string } = {}
): { heap: Uint8Array; streams: StreamRecord[]; meta: SnapshotMeta } | null {
	const meta = latestSnapshotMeta(sql, opts.generation);
	if (!meta) return null;

	const chunkRows = sql
		.exec('SELECT seq, bytes FROM cfw_heap_chunk WHERE snapshot_id = ? ORDER BY seq', meta.id)
		.toArray();
	if (chunkRows.length === 0) throw new Error(`snapshot ${meta.id} has no chunks`);

	const fdRow = sql
		.exec('SELECT page_index, fd_table FROM cfw_heap_snapshot WHERE id = ?', meta.id)
		.toArray()[0];
	const pageIndex = JSON.parse(String(fdRow?.page_index ?? '[]')) as number[];
	const streams = JSON.parse(String(fdRow?.fd_table ?? '[]')) as StreamRecord[];

	const bytes = joinChunks(
		chunkRows.map((r) => ({
			seq: Number(r.seq),
			bytes: toStorableBytes(r.bytes as ArrayBufferLike | Uint8Array)
		}))
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
 * A restore has to map an offset in the ELIDED stream (what the chunks concatenate to) onto an offset
 * in the heap (where the page belongs). Precomputing the map is what lets a chunk be applied without
 * ever assembling the elided stream.
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
 * Typed rather than a bare `Error` because `bytesWritten` decides what the CALLER owes. A refusal on
 * the first chunk leaves the heap untouched and costs one boot from the pack; a refusal at chunk N
 * has already applied N chunks, so the live heap is now the right LENGTH and the wrong BYTES and
 * must be thrown away rather than booted. A boolean-free `Error` cannot tell those apart, and the
 * boot path was treating both as the cheap case.
 */
export class HeapChunkDigestError extends Error {
	readonly seq: number;
	readonly expected: string;
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
 * Applies a stored snapshot DIRECTLY into a live heap, one chunk at a time.
 *
 * **Nothing larger than a single chunk is ever allocated.** That is a hard requirement rather than an
 * optimisation, and it comes from a measurement: the isolate memory ceiling is **non-monotone** --
 * a 128 MiB allocation failed while 160 MiB succeeded -- because it is an isolate-wide budget shared
 * with whatever else a reused isolate holds. A restore that materialises the image will therefore
 * pass N times and then fail in production, which is the worst possible test signal. The previous
 * implementation allocated the row array, the joined buffer AND the reassembled heap: roughly 4x the
 * image.
 *
 * Compression is absent for the same reason it was disqualified rather than traded off:
 * `DecompressionStream` bills at **15.7 ms/MB of output** on the edge, so inflating a 22.4 MB
 * snapshot would cost ~350 ms of billed CPU -- 35x the free per-invocation cap -- against a memcpy
 * measured at roughly a tenth of that. The compressed form wins on rows and storage and loses on the
 * only meter that binds.
 *
 * Each chunk's digest is checked BEFORE its bytes are applied. A whole-image check cannot help a
 * streaming restore: by the time it fails, the heap is already wrong.
 *
 * @param sql The Durable Object's own SQL.
 * @param target The live heap. Written in place.
 * @param opts `from`/`limit` restrict the work to a slice of the chunk sequence, which is what makes
 *   a restore divisible across alarm invocations.
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
			sql
				.exec('SELECT COUNT(*) AS n FROM cfw_heap_chunk WHERE snapshot_id = ?', meta.id)
				.toArray()[0] as { n: number | bigint } | undefined
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

	// ORDER BY seq and ITERATE. `.toArray()` here would materialise every chunk row, which is the
	// allocation this whole function exists to avoid
	const cursor = sql.exec(
		'SELECT seq, bytes, digest FROM cfw_heap_chunk WHERE snapshot_id = ? AND seq >= ? ORDER BY seq',
		meta.id,
		from
	);

	let spanAt = 0;
	for (const row of cursor) {
		if (out.chunks >= limit) break;
		const seq = Number(row.seq);
		const bytes = toStorableBytes(row.bytes as ArrayBufferLike | Uint8Array);
		const expected = String(row.digest ?? '');
		const actual = digestBytes(bytes);
		if (expected !== '' && actual !== expected) {
			// refuse BEFORE applying. A corrupted chunk that lands leaves a heap that is the right
			// length and the wrong bytes, which restores cleanly and then renders something subtly
			// wrong -- this project's signature failure
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
		// advance to the first span this chunk touches; spans and chunks are both ascending, so the
		// walk is linear rather than a search per chunk
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
			// subarray is a VIEW, not a copy: no allocation here
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
 * An unbounded snapshot table is the watchdog lesson repeated at 40 MB a row: the health ledger
 * grew to 46% of the database before it was capped. Chunks go first so a crash between the two
 * deletes leaves orphaned metadata rather than orphaned megabytes.
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
