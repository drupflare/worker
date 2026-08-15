import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CHUNK_BYTES,
	DO_SQLITE_MAX_RECORD_BYTES,
	GLOBAL_HANDLE_NAME,
	HEAP_SNAPSHOT_DDL,
	HeapChunkDigestError,
	WASM_PAGE_BYTES,
	captureHandles,
	captureStreams,
	chunkHeap,
	digestBytes,
	elideZeroPages,
	fdTableProblems,
	joinChunks,
	reassembleHeap,
	replayHandles,
	replayStreams,
	toStorableBytes,
	type HandleIndex,
	type StreamFS,
	type StreamRecord
} from '../../../src/db/heap-store';

/**
 * The heap snapshot's storage layer. Pure: the standalone restore probe proved the mechanism with a
 * live wasm instance, and the part that was missing -- persisting the image into the object's own
 * SQLite -- is arithmetic that should not need a Durable Object to test.
 *
 * Each test here corresponds to a way this project has actually lost bytes, not to a coverage target.
 */

/** a heap with recognisable content in some pages and zeros in others */
function fixtureHeap(pages: Array<number | null>, pageBytes = 8): Uint8Array {
	const heap = new Uint8Array(pages.length * pageBytes);
	pages.forEach((fill, p) => {
		if (fill === null) return;
		heap.fill(fill, p * pageBytes, (p + 1) * pageBytes);
	});
	return heap;
}

describe('toStorableBytes closes the zero-byte copy trap', () => {
	it('copies real bytes out of an ArrayBuffer', () => {
		// the trap: set(arrayBuffer) copies zero bytes and throws nothing (no indexed properties), so
		// the snapshot looks stored and restores blank
		const ab = new ArrayBuffer(4);
		new Uint8Array(ab).set([1, 2, 3, 4]);

		const wrong = new Uint8Array(4);
		// @ts-expect-error reproducing the exact mistake: ArrayBuffer is not an ArrayLike
		wrong.set(ab);
		expect([...wrong]).toEqual([0, 0, 0, 0]);

		expect([...toStorableBytes(ab)]).toEqual([1, 2, 3, 4]);
	});

	it('detaches from the source, so a later grow cannot change what was stored', () => {
		const live = new Uint8Array([9, 9]);
		const stored = toStorableBytes(live);
		live[0] = 1;
		expect([...stored]).toEqual([9, 9]);
	});
});

describe('zero-page elision', () => {
	it('drops all-zero pages and keeps the rest', () => {
		const heap = fixtureHeap([1, null, 2, null, null, 3]);
		const e = elideZeroPages(heap, 8);
		expect(e.pageIndex).toEqual([0, 2, 5]);
		expect(e.totalPages).toBe(6);
		expect(e.bytes.length).toBe(24);
		expect(e.byteLength).toBe(48);
	});

	it('round-trips to the original bytes', () => {
		const heap = fixtureHeap([1, null, 2, null, null, 3]);
		expect([...reassembleHeap(elideZeroPages(heap, 8), 8)]).toEqual([...heap]);
	});

	it('round-trips an all-zero heap to nothing stored', () => {
		const heap = new Uint8Array(32);
		const e = elideZeroPages(heap, 8);
		expect(e.pageIndex).toEqual([]);
		expect(e.bytes.length).toBe(0);
		expect([...reassembleHeap(e, 8)]).toEqual([...heap]);
	});

	it('handles a trailing partial page without over-running', () => {
		// a heap that is not a whole number of pages is the normal case, and restoring
		// totalPages*pageBytes instead of byteLength yields a heap that is too long
		const heap = new Uint8Array(20).fill(7);
		const e = elideZeroPages(heap, 8);
		expect(e.totalPages).toBe(3);
		expect(e.byteLength).toBe(20);
		const back = reassembleHeap(e, 8);
		expect(back.length).toBe(20);
		expect([...back]).toEqual([...heap]);
	});

	it('refuses a page index that disagrees with the payload', () => {
		// the failure this guards is a restore that succeeds and renders the WRONG heap
		const heap = fixtureHeap([1, null, 2]);
		const e = elideZeroPages(heap, 8);
		expect(() => reassembleHeap({ ...e, bytes: e.bytes.slice(0, 8) }, 8)).toThrow(/consumed/);
	});

	it('refuses a page number past the heap end', () => {
		const heap = fixtureHeap([1]);
		const e = elideZeroPages(heap, 8);
		expect(() => reassembleHeap({ ...e, pageIndex: [99] }, 8)).toThrow(/past the heap end/);
	});

	it('rejects a non-positive page size rather than looping forever', () => {
		expect(() => elideZeroPages(new Uint8Array(8), 0)).toThrow(RangeError);
	});
});

describe('chunking respects the measured record cap', () => {
	it('never emits a chunk at or over the cap', () => {
		expect(DEFAULT_CHUNK_BYTES).toBeLessThan(DO_SQLITE_MAX_RECORD_BYTES);
		for (const c of chunkHeap(new Uint8Array(50), 8)) {
			expect(c.bytes.length).toBeLessThanOrEqual(8);
		}
	});

	it('refuses a chunk size at or over the cap instead of failing mid-snapshot', () => {
		// a rejected write halfway through leaves a partial image that still looks storable
		expect(() => chunkHeap(new Uint8Array(4), DO_SQLITE_MAX_RECORD_BYTES)).toThrow(
			/record cap/
		);
		expect(() => chunkHeap(new Uint8Array(4), DO_SQLITE_MAX_RECORD_BYTES + 1)).toThrow(
			/record cap/
		);
	});

	it('numbers chunks from zero with no gaps', () => {
		expect(chunkHeap(new Uint8Array(20), 8).map((c) => c.seq)).toEqual([0, 1, 2]);
	});

	it('round-trips through join', () => {
		const heap = new Uint8Array(37).map((_, i) => i % 251);
		expect([...joinChunks(chunkHeap(heap, 8), heap.length)]).toEqual([...heap]);
	});

	it('sorts by seq, because SQLite does not promise row order', () => {
		// out-of-order joining produces a heap of the RIGHT length and wrong content
		const heap = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const shuffled = [...chunkHeap(heap, 2)].reverse();
		expect([...joinChunks(shuffled, 6)]).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it('refuses a gap in the sequence', () => {
		const chunks = chunkHeap(new Uint8Array(6), 2).filter((c) => c.seq !== 1);
		expect(() => joinChunks(chunks)).toThrow(/gap/);
	});

	it('refuses a total that disagrees with the expected length', () => {
		const chunks = chunkHeap(new Uint8Array(6), 2);
		expect(() => joinChunks(chunks, 999)).toThrow(/expected 999/);
	});

	it('stores independent copies, not views onto the whole heap', () => {
		const heap = new Uint8Array([1, 2, 3, 4]);
		const chunks = chunkHeap(heap, 2);
		heap[0] = 9;
		expect([...(chunks[0]?.bytes ?? [])]).toEqual([1, 2]);
	});
});

describe('elide then chunk, which is the real storage path', () => {
	it('round-trips a sparse heap end to end', () => {
		const heap = fixtureHeap([1, null, 2, null, null, 3, null, 4], 16);
		const elided = elideZeroPages(heap, 16);
		const chunks = chunkHeap(elided.bytes, 24);
		const rebuilt = reassembleHeap(
			{ ...elided, bytes: joinChunks(chunks, elided.bytes.length) },
			16
		);
		expect([...rebuilt]).toEqual([...heap]);
		expect(digestBytes(rebuilt)).toBe(digestBytes(heap));
	});

	it('stores fewer bytes than the heap when the heap is mostly zeros', () => {
		// the reason elision is unconditional: over half a booted Drupal heap is pages a fresh
		// instance already has (80,543,744 -> 39,911,590 measured)
		const heap = fixtureHeap([1, null, null, null, null, null, null, 2], 16);
		const elided = elideZeroPages(heap, 16);
		expect(elided.bytes.length).toBe(32);
		expect(elided.bytes.length).toBeLessThan(heap.length / 3);
	});
});

describe('the fd table, which is what actually makes a restore work', () => {
	const snap = [
		{ fd: 3, path: '/drupal/sites/default/files/.sqlite', flags: 557122 },
		{ fd: 6, path: '/dev/urandom', flags: 0 }
	];

	it('does not alarm on a DO snapshot, which has no descriptors above stdio', () => {
		// the false alarm this replaced: the four descriptors were measured on a STANDALONE binary
		// with a real .sqlite open. On the DO path the database is a host call rather than a file, so
		// zero descriptors is correct and demanding /dev/urandom was demanding a bug
		expect(fdTableProblems([], [])).toEqual([]);
	});

	it('stays quiet when the restoring instance has descriptors the snapshot never had', () => {
		expect(fdTableProblems([], [{ fd: 3, path: '/dev/urandom', flags: 0 }])).toEqual([]);
	});

	it('names the reconstruction tell only for a capture that HAS descriptors', () => {
		// a table with fds but no /dev/urandom cannot have come from a live captureStreams(), because
		// PHP's CSPRNG opens it; that is the assembled-elsewhere case worth refusing
		const problems = fdTableProblems([snap[0]!], [snap[0]!]);
		expect(problems.some((p) => p.includes('was not captured'))).toBe(true);
	});

	it('passes when the live table matches', () => {
		expect(fdTableProblems(snap, snap)).toEqual([]);
	});

	it('names a missing fd rather than letting the restore stall', () => {
		// dropping the sqlite fds gives a locking-protocol error after 80-120 SECONDS, which on the
		// edge is a hung request, so it is named up front
		const problems = fdTableProblems(snap, [snap[1]!]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('fd 3');
		expect(problems[0]).toContain('not open');
	});

	it('catches a path that moved to a different fd number', () => {
		// the heap holds the integer, so a correct path at the wrong fd still breaks
		const problems = fdTableProblems(snap, [
			{ fd: 3, path: '/dev/urandom', flags: 0 },
			{ fd: 6, path: '/drupal/sites/default/files/.sqlite', flags: 557122 }
		]);
		expect(problems).toHaveLength(2);
	});

	it('reports every problem at once, not just the first', () => {
		expect(fdTableProblems(snap, [])).toHaveLength(2);
	});

	it('refuses a snapshot with no /dev/urandom', () => {
		// its absence throws `Random\RandomException: Could not gather sufficient random data`
		const problems = fdTableProblems([snap[0]!], [snap[0]!]);
		expect(problems.some((p) => p.includes('/dev/urandom'))).toBe(true);
		expect(problems.some((p) => p.includes('RandomException'))).toBe(true);
	});
});

describe('the DDL', () => {
	it('separates metadata from bytes, so a restore reads the index first', () => {
		expect(HEAP_SNAPSHOT_DDL).toContain('cfw_heap_snapshot');
		expect(HEAP_SNAPSHOT_DDL).toContain('cfw_heap_chunk');
		expect(HEAP_SNAPSHOT_DDL).toContain('bytes BLOB NOT NULL');
	});

	it('records the fd table alongside the bytes', () => {
		// a snapshot without its fd table cannot be safely restored, so it is not optional
		expect(HEAP_SNAPSHOT_DDL).toContain('fd_table');
	});

	it('keys chunks by (snapshot_id, seq) so two snapshots cannot interleave', () => {
		expect(HEAP_SNAPSHOT_DDL).toContain('PRIMARY KEY (snapshot_id, seq)');
	});

	it('uses the real wasm page size', () => {
		expect(WASM_PAGE_BYTES).toBe(65_536);
	});
});

/**
 * A fake emscripten FS, narrow enough to drive capture and replay without a wasm instance.
 *
 * `open()` returns the LOWEST free descriptor, which is what the real one does and
 * what makes the relocation in `replayStreams` necessary rather than decorative.
 */
function fakeFS(opts: { failOn?: string[] } = {}): StreamFS & { opened: string[] } {
	const streams: StreamFS['streams'] = [null, null, null];
	return {
		streams,
		opened: [],
		open(path: string, flags: number | string) {
			if (opts.failOn?.includes(path)) throw new Error(`ENOENT: ${path}`);
			this.opened.push(path);
			let fd = 3;
			while (streams[fd]) fd++;
			const stream = { fd, path, flags: Number(flags) || 0, position: 0 };
			streams[fd] = stream;
			return stream;
		},
		isDir(mode: number) {
			return mode === 16877;
		}
	};
}

describe('capturing the open descriptor table', () => {
	it('skips stdio and records everything above it', () => {
		const FS = fakeFS();
		FS.streams[3] = {
			fd: 3,
			path: '/a.sqlite',
			flags: 557122,
			position: 42,
			node: { id: 7, mode: 33188 }
		};
		FS.streams[6] = {
			fd: 6,
			path: '/dev/urandom',
			flags: 0,
			position: 0,
			node: { id: 9, mode: 33188 }
		};
		const caught = captureStreams(FS);
		expect(caught.map((s) => s.fd)).toEqual([3, 6]);
		expect(caught[0]?.path).toBe('/a.sqlite');
		// position is load-bearing: a handle replayed at 0 against a heap that believes it is
		// mid-file reads the wrong bytes and returns them without complaint
		expect(caught[0]?.position).toBe(42);
		expect(caught[0]?.flags).toBe(557122);
	});

	it('tolerates holes in the table', () => {
		const FS = fakeFS();
		FS.streams[5] = { fd: 5, path: '/only.txt', flags: 0, position: 0, node: null };
		expect(captureStreams(FS).map((s) => s.fd)).toEqual([5]);
	});
});

describe('replaying descriptors at the SAME fd number', () => {
	const snap: StreamRecord[] = [
		{ fd: 5, path: '/a.sqlite', flags: 557122, position: 42 },
		{ fd: 9, path: '/dev/urandom', flags: 0, position: 0 }
	];

	it('relocates a stream when open() hands back a different fd', () => {
		// the heap holds fd numbers, so a correct path at the wrong number is still broken (a fresh
		// FS opens at 3 and 4; the snapshot needs 5 and 9)
		const FS = fakeFS();
		const out = replayStreams(FS, snap);
		expect(out.failed).toEqual([]);
		expect(FS.streams[5]?.path).toBe('/a.sqlite');
		expect(FS.streams[9]?.path).toBe('/dev/urandom');
		expect(FS.streams[5]?.fd).toBe(5);
		// and the slot open() originally used is vacated, not left aliasing the same stream
		expect(FS.streams[3]).toBeNull();
	});

	it('restores each position', () => {
		const FS = fakeFS();
		replayStreams(FS, snap);
		expect(FS.streams[5]?.position).toBe(42);
	});

	it('passes the numeric flags straight through', () => {
		// they came out of a real open, so the node ops see exactly the mode PHP opened with
		const FS = fakeFS();
		replayStreams(FS, snap);
		expect(FS.streams[5]?.flags).toBe(557122);
	});

	it('collects failures instead of throwing past the caller', () => {
		// a restore that dies on the second of four descriptors after an 80-120 s stall is far
		// harder to diagnose than one naming all of them before the memcpy
		const FS = fakeFS({ failOn: ['/dev/urandom'] });
		const out = replayStreams(FS, snap);
		expect(out.replayed).toHaveLength(1);
		expect(out.failed).toHaveLength(1);
		expect(out.failed[0]?.path).toBe('/dev/urandom');
		expect(out.failed[0]?.error).toContain('ENOENT');
	});

	it('round-trips capture -> replay', () => {
		const src = fakeFS();
		src.streams[4] = { fd: 4, path: '/x', flags: 2, position: 8, node: { id: 1, mode: 33188 } };
		src.streams[7] = { fd: 7, path: '/y', flags: 0, position: 0, node: { id: 2, mode: 33188 } };
		const dst = fakeFS();
		const out = replayStreams(dst, captureStreams(src));
		expect(out.failed).toEqual([]);
		expect(dst.streams[4]?.path).toBe('/x');
		expect(dst.streams[7]?.path).toBe('/y');
		expect(dst.streams[4]?.position).toBe(8);
	});
});

/**
 * A fake `Module.targets`, shaped like php-wasm's `UniqueIndex` in the ways a restore touches:
 * `byInteger` is iterable, `byObject` is keyed by the object, and `id` is the monotone counter
 * `add()` increments.
 */
function fakeHandleIndex(): HandleIndex & {
	add(o: object): number;
	get(id: number): unknown;
	entries(): Array<[number, object]>;
} {
	const byInteger = new Map<number, object>();
	const byObject = new WeakMap<object, number>();
	const index = {
		byObject,
		byInteger,
		id: 0,
		add(o: object) {
			const existing = byObject.get(o);
			if (existing !== undefined) return existing;
			const id = ++index.id;
			byObject.set(o, id);
			byInteger.set(id, o);
			return id;
		},
		get(id: number) {
			return byInteger.get(id);
		},
		entries() {
			return [...byInteger];
		}
	};
	return index as unknown as HandleIndex & {
		add(o: object): number;
		get(id: number): unknown;
		entries(): Array<[number, object]>;
	};
}

describe('the vrzno handle table is part of a restore, and the restore probe missed it', () => {
	it('names the global object and every Module-hung host function', () => {
		const root = { iAmGlobal: true };
		const cfwSqlExec = () => 'rows';
		const cfwLog = () => undefined;
		const module = { cfwSqlExec, cfwLog, HEAPU8: new Uint8Array(4), notAHandle: 7 };
		const index = fakeHandleIndex();
		index.add(root);
		index.add(cfwSqlExec);
		index.add(cfwLog);

		const out = captureHandles(index, module, root);
		expect(out.unnameable).toEqual([]);
		expect(out.handles).toEqual([
			{ id: 1, name: GLOBAL_HANDLE_NAME },
			{ id: 2, name: 'cfwSqlExec' },
			{ id: 3, name: 'cfwLog' }
		]);
	});

	it('reports a handle nothing can name rather than dropping it', () => {
		// the real failure: a Response or an ArrayBuffer PHP holds cannot be rebuilt in a fresh
		// instance, and a snapshot that quietly omitted it would restore into a dead integer
		const root = {};
		const index = fakeHandleIndex();
		index.add(root);
		index.add(new Map());
		const out = captureHandles(index, {}, root);
		expect(out.handles).toEqual([{ id: 1, name: GLOBAL_HANDLE_NAME }]);
		expect(out.unnameable).toEqual([{ id: 2, kind: 'object Map' }]);
	});

	it('re-registers each handle at the SAME id, because the heap holds the integer', () => {
		const root = {};
		const cfwSqlExec = () => 'rows';
		const module = { cfwSqlExec };
		const fresh = fakeHandleIndex();
		fresh.add(root);

		const out = replayHandles(
			fresh,
			module,
			[
				{ id: 1, name: GLOBAL_HANDLE_NAME },
				{ id: 9, name: 'cfwSqlExec' }
			],
			root
		);
		expect(out.failed).toEqual([]);
		expect(fresh.get(9)).toBe(cfwSqlExec);
		// the assertion that matters: PHP calls handle 9, so handle 9 must be that function
		expect(typeof fresh.get(9)).toBe('function');
	});

	it('raises the id counter so a later add() cannot alias a restored handle', () => {
		// leaving it low is the same defect one step later: the next add() hands a fresh object an
		// id the restored heap already believes it owns, and nothing throws
		const root = {};
		const cfwSqlExec = () => 'rows';
		const fresh = fakeHandleIndex();
		fresh.add(root);
		const out = replayHandles(fresh, { cfwSqlExec }, [{ id: 12, name: 'cfwSqlExec' }], root);
		expect(out.nextId).toBe(12);
		expect(fresh.add({})).toBe(13);
	});

	it('refuses a handle whose name resolves to nothing callable', () => {
		const root = {};
		const fresh = fakeHandleIndex();
		fresh.add(root);
		const out = replayHandles(
			fresh,
			{ cfwSqlExec: undefined },
			[{ id: 2, name: 'cfwSqlExec' }],
			root
		);
		expect(out.replayed).toEqual([]);
		expect(out.failed[0]?.name).toBe('cfwSqlExec');
		expect(out.failed[0]?.error).toContain('cannot hold a handle');
	});

	it('fails every handle when the binary has no table at all', () => {
		const out = replayHandles(null, {}, [{ id: 1, name: GLOBAL_HANDLE_NAME }]);
		expect(out.replayed).toEqual([]);
		expect(out.failed[0]?.error).toContain('no vrzno handle table');
	});

	it('captures nothing, and refuses nothing, when the binary has no table', () => {
		expect(captureHandles(null, {})).toEqual({ handles: [], unnameable: [] });
	});

	it('survives a Module key whose getter throws', () => {
		// an emscripten Module carries accessors; one bad getter must not cost the handle table
		const root = {};
		const cfwLog = () => undefined;
		const module: Record<string, unknown> = { cfwLog };
		Object.defineProperty(module, 'boom', {
			enumerable: true,
			get() {
				throw new Error('nope');
			}
		});
		const index = fakeHandleIndex();
		index.add(root);
		index.add(cfwLog);
		const out = captureHandles(index, module, root);
		expect(out.handles).toEqual([
			{ id: 1, name: GLOBAL_HANDLE_NAME },
			{ id: 2, name: 'cfwLog' }
		]);
	});

	it('round-trips capture -> replay across two fake instances', () => {
		const rootA = {};
		const rootB = {};
		const execA = () => 'a';
		const execB = () => 'b';
		const src = fakeHandleIndex();
		src.add(rootA);
		src.add(execA);
		const captured = captureHandles(src, { cfwSqlExec: execA }, rootA);

		const dst = fakeHandleIndex();
		dst.add(rootB);
		const out = replayHandles(dst, { cfwSqlExec: execB }, captured.handles, rootB);
		expect(out.failed).toEqual([]);
		// the SAME id now resolves to the fresh instance's own function:
		// vrzno_env() resolved Module[name] at boot, so the replay must resolve it again here
		expect(dst.get(2)).toBe(execB);
	});
});

describe('HeapChunkDigestError says whether bytes already landed', () => {
	it('keeps the message the refusal is asserted on', () => {
		const e = new HeapChunkDigestError({
			seq: 0,
			expected: 'aaaa',
			actual: 'bbbb',
			bytesWritten: 0,
			chunksApplied: 0
		});
		expect(e.message).toContain('chunk 0 digest mismatch');
		expect(e.name).toBe('HeapChunkDigestError');
		expect(e).toBeInstanceOf(Error);
	});

	it('distinguishes the cheap refusal from the poisoned one', () => {
		// chunk 0 leaves the heap as the pack booted it; chunk 3 has already overwritten three
		// chunks, and a caller that cannot tell them apart boots a heap of the wrong bytes
		const clean = new HeapChunkDigestError({
			seq: 0,
			expected: 'a',
			actual: 'b',
			bytesWritten: 0,
			chunksApplied: 0
		});
		const dirty = new HeapChunkDigestError({
			seq: 3,
			expected: 'a',
			actual: 'b',
			bytesWritten: 6_000_000,
			chunksApplied: 3
		});
		expect(clean.bytesWritten).toBe(0);
		expect(dirty.bytesWritten).toBe(6_000_000);
		expect(dirty.chunksApplied).toBe(3);
		expect(dirty.seq).toBe(3);
	});
});

describe('the default chunk size is set by the CPU cap, not the record cap', () => {
	it('is small enough that one restore step fits a free-plan invocation', () => {
		// MEASURED on a deployed worker with HEAP_RESTORE_CHUNKS=1: 2,000,000 bytes per chunk cost
		// 21/52/37 ms of edge cpuTime per firing (3 of 4 over the cap), 400,000 cost median 8 max 13
		// (4 of 21 over), and 200,000 cost median 2 max 10 with 0 of 41 over. Pinned as a value
		// because the constant is the only thing standing between "chunked" and "chunked and still
		// over budget", and the record cap it used to be sized against never bound.
		expect(DEFAULT_CHUNK_BYTES).toBe(200_000);
		expect(DEFAULT_CHUNK_BYTES).toBeLessThan(DO_SQLITE_MAX_RECORD_BYTES);
	});

	it('splits the measured elided image into a number of rows a restore can walk', () => {
		// 8,126,464 bytes of elided heap, the figure the edge reports for this pack
		const rows = Math.ceil(8_126_464 / DEFAULT_CHUNK_BYTES);
		expect(rows).toBe(41);
	});
});
