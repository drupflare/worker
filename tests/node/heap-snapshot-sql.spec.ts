import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_CHUNK_BYTES,
	DO_SQLITE_MAX_RECORD_BYTES,
	GLOBAL_HANDLE_NAME,
	HeapChunkDigestError,
	digestBytes,
	ensureHeapTables,
	gcHeapSnapshots,
	latestSnapshotMeta,
	readHeapSnapshot,
	snapshotPageIndex,
	streamRestoreInto,
	writeHeapSnapshot,
	type HeapSql,
	type StreamRecord
} from '../../src/db/heap-store';

/**
 * The heap snapshot's storage path against a REAL SQLite engine.
 *
 * `tests/unit/db/heap-store.spec.ts` covers the arithmetic with no database. This file exists
 * because the arithmetic being right is not the same as the round trip being right: bound BLOB
 * parameters, `RETURNING id`, row order, and integer widening are all engine behaviour, and every
 * one of them has produced a defect in this project. `node:sqlite` is the same engine family as
 * Durable Object SQLite and `tests/node/migrate-sql.spec.ts` already relies on it, so this is a
 * closer instrument than a hand-written fake.
 *
 * It is NOT a substitute for the platform limits, which only a deployed object can confirm. Those
 * are asserted as constants, not re-measured here.
 */

/** the `ctx.storage.sql` shape, over node:sqlite */
function makeSql(db: DatabaseSync): HeapSql {
	return {
		exec(query, ...bindings) {
			const stmt = db.prepare(query);
			// node:sqlite refuses .all() on a statement that returns nothing, and DO's exec() is
			// uniform, so the shape is normalised here rather than at every call site
			const rows = /^\s*(select|insert|update|delete)[\s\S]*returning|^\s*select/i.test(query)
				? (stmt.all(...(bindings as never[])) as unknown[])
				: (stmt.run(...(bindings as never[])), []);
			const arr = rows as Array<Record<string, unknown>>;
			// iterable as well as arrayable: streamRestoreInto() ITERATES, because
			// toArray() would materialise every chunk row before a single byte moved
			return {
				toArray: () => arr,
				[Symbol.iterator]: () => arr[Symbol.iterator]()
			};
		}
	};
}

const STREAMS: StreamRecord[] = [
	{ fd: 3, path: '/drupal/sites/default/files/.sqlite', flags: 557122, position: 4096 },
	{ fd: 6, path: '/dev/urandom', flags: 0, position: 0 }
];

/** a sparse heap: content in some pages, zeros elsewhere, like a real booted image */
function sparseHeap(pages: Array<number | null>, pageBytes: number): Uint8Array {
	const heap = new Uint8Array(pages.length * pageBytes);
	pages.forEach((fill, p) => {
		if (fill !== null) heap.fill(fill, p * pageBytes, (p + 1) * pageBytes);
	});
	return heap;
}

describe('a heap survives a round trip through SQLite', () => {
	let db: DatabaseSync;
	let sql: HeapSql;

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		sql = makeSql(db);
		ensureHeapTables(sql);
	});

	it('creates both tables idempotently', () => {
		// the DO calls this on every boot, so a second call must not throw
		expect(() => ensureHeapTables(sql)).not.toThrow();
		const names = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((r) => (r as { name: string }).name);
		expect(names).toContain('cfw_heap_snapshot');
		expect(names).toContain('cfw_heap_chunk');
	});

	it('writes and reads back the identical heap', () => {
		const heap = sparseHeap([1, null, 2, null, null, 3], 128);
		const w = writeHeapSnapshot(sql, {
			heap,
			streams: STREAMS,
			generation: 'gen-a',
			nowMs: 1_000,
			chunkBytes: 100,
			pageBytes: 128
		});
		expect(w.rows).toBeGreaterThan(1);
		expect(w.keptPages).toBe(3);

		const back = readHeapSnapshot(sql);
		expect(back).not.toBeNull();
		expect([...back!.heap]).toEqual([...heap]);
		expect(digestBytes(back!.heap)).toBe(w.digest);
	});

	it('carries the fd table back with the bytes', () => {
		// the descriptor table is what makes a restore work, so it must travel WITH
		// the image rather than be rebuilt from whatever instance happens to be restoring
		const heap = sparseHeap([7, null], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: STREAMS,
			generation: 'gen-a',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		const back = readHeapSnapshot(sql);
		expect(back!.streams).toHaveLength(2);
		expect(back!.streams[0]?.fd).toBe(3);
		expect(back!.streams[0]?.position).toBe(4096);
		expect(back!.streams[1]?.path).toBe('/dev/urandom');
	});

	it('stores BLOBs, not text', () => {
		// if a chunk ever came back as a string the codec crept in, and a base64 payload would blow
		// the 100,000-char statement ceiling long before the record cap
		const heap = sparseHeap([5, 6], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		const row = db.prepare('SELECT bytes FROM cfw_heap_chunk WHERE seq = 0').get() as {
			bytes: unknown;
		};
		expect(row.bytes).toBeInstanceOf(Uint8Array);
	});

	it('refuses a corrupted heap instead of restoring it', () => {
		// a right-length wrong-bytes heap restores cleanly then renders subtly wrong; refusing costs
		// one boot, accepting costs a broken site
		const heap = sparseHeap([1, 2, 3], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		db.prepare('UPDATE cfw_heap_chunk SET bytes = ? WHERE seq = 0').run(
			new Uint8Array(64).fill(9)
		);
		expect(() => readHeapSnapshot(sql)).toThrow(/digest mismatch/);
	});

	it('returns null when nothing has been stored', () => {
		expect(readHeapSnapshot(sql)).toBeNull();
		expect(latestSnapshotMeta(sql)).toBeNull();
	});

	it('reads the NEWEST snapshot, and can filter by generation', () => {
		const a = sparseHeap([1], 64);
		const b = sparseHeap([2], 64);
		writeHeapSnapshot(sql, {
			heap: a,
			streams: [],
			generation: 'old',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		writeHeapSnapshot(sql, {
			heap: b,
			streams: [],
			generation: 'new',
			nowMs: 2,
			chunkBytes: 64,
			pageBytes: 64
		});
		expect([...readHeapSnapshot(sql)!.heap]).toEqual([...b]);
		// a pack generation change must not restore an image built against the old pack
		expect([...readHeapSnapshot(sql, { generation: 'old' })!.heap]).toEqual([...a]);
	});

	it('survives a heap whose last page is partial', () => {
		const heap = new Uint8Array(200).fill(3);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		const back = readHeapSnapshot(sql)!;
		expect(back.heap.length).toBe(200);
		expect([...back.heap]).toEqual([...heap]);
	});

	it('stores an all-zero heap as zero chunks and still restores it', () => {
		const heap = new Uint8Array(128);
		const w = writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		expect(w.rows).toBe(0);
		// no chunks means the read must refuse rather than hand back a plausible empty heap
		expect(() => readHeapSnapshot(sql)).toThrow(/no chunks/);
	});
});

describe('the restore streams, and that is a STRUCTURAL requirement not an optimisation', () => {
	let db: DatabaseSync;
	let sql: HeapSql;

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		sql = makeSql(db);
		ensureHeapTables(sql);
	});

	it('never allocates more than one chunk, proven by instrumenting the allocator', () => {
		// the acceptance check, and it is structural. The isolate memory ceiling
		// is NON-MONOTONE -- a 128 MiB allocation failed on a deployed worker while 160 MiB succeeded
		// -- because it is an isolate-wide budget shared with whatever else a reused isolate holds.
		// So an empirical memory test cannot tell "safe" from "not yet unlucky", and only a bound on
		// allocation SIZE can.
		const heap = sparseHeap([1, null, 2, null, 3, null, 4, 5], 64);
		const CHUNK = 96;
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: CHUNK,
			pageBytes: 64
		});

		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;
		const target = new Uint8Array(heap.length);

		const RealU8 = globalThis.Uint8Array;
		const sizes: number[] = [];
		// every construction that ALLOCATES goes through `new Uint8Array(number)`; a view over an
		// existing buffer does not, which is the distinction that matters here
		class Spy extends RealU8 {
			constructor(...args: unknown[]) {
				// @ts-expect-error forwarding a union the base overloads accept
				super(...args);
				if (typeof args[0] === 'number') sizes.push(args[0]);
			}
		}
		globalThis.Uint8Array = Spy as unknown as Uint8ArrayConstructor;
		try {
			streamRestoreInto(sql, target, { meta, pageIndex: index.pageIndex });
		} finally {
			globalThis.Uint8Array = RealU8;
		}

		expect(sizes.length).toBeGreaterThan(0);
		const largest = Math.max(...sizes);
		expect(
			largest,
			`largest allocation was ${largest} bytes; the chunk size is ${CHUNK}. A restore that ` +
				'allocates more than one chunk will pass N times and then fail in production.'
		).toBeLessThanOrEqual(CHUNK);
		// and nothing heap-sized, which is what the old join + reassemble path did three times over
		expect(largest).toBeLessThan(heap.length);
	});

	it('still restores the heap byte for byte while streaming', () => {
		const heap = sparseHeap([9, null, 8, null, null, 7, 6, null], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 96,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;
		const target = new Uint8Array(heap.length);
		const out = streamRestoreInto(sql, target, { meta, pageIndex: index.pageIndex });
		expect([...target]).toEqual([...heap]);
		expect(digestBytes(target)).toBe(meta.digest);
		expect(out.bytesWritten).toBe(out.elidedBytes);
	});

	it('refuses a corrupted chunk BEFORE its bytes land', () => {
		// a whole-image digest cannot help a streaming restore: by the time it fails the heap is
		// already wrong. This is why the digest is per chunk
		const heap = sparseHeap([1, 2, 3, 4], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 96,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;
		db.prepare('UPDATE cfw_heap_chunk SET bytes = ? WHERE seq = 0').run(
			new Uint8Array(96).fill(9)
		);
		const target = new Uint8Array(heap.length);
		expect(() => streamRestoreInto(sql, target, { meta, pageIndex: index.pageIndex })).toThrow(
			/chunk 0 digest mismatch/
		);
		// and the target is untouched, which is what refusing first buys
		expect(target.every((b) => b === 0)).toBe(true);
	});

	it('reports zero bytes written when it refuses on the FIRST chunk', () => {
		// the caller's obligation depends on this number: a refusal that landed nothing costs one
		// boot from the pack, and the boot path is allowed to carry on using the heap it has
		const heap = sparseHeap([1, 2, 3, 4], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 96,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;
		db.prepare('UPDATE cfw_heap_chunk SET bytes = ? WHERE seq = 0').run(
			new Uint8Array(96).fill(9)
		);
		const target = new Uint8Array(heap.length);
		try {
			streamRestoreInto(sql, target, { meta, pageIndex: index.pageIndex });
			expect.unreachable('the corrupted chunk must refuse');
		} catch (e) {
			expect(e).toBeInstanceOf(HeapChunkDigestError);
			expect((e as HeapChunkDigestError).seq).toBe(0);
			expect((e as HeapChunkDigestError).bytesWritten).toBe(0);
			expect((e as HeapChunkDigestError).chunksApplied).toBe(0);
		}
	});

	it('reports the bytes it already applied when it refuses MID-sequence', () => {
		// the case the untyped throw hid. Chunk 1 corrupt means chunk 0 has already landed, so the
		// live heap is now the right LENGTH and the wrong BYTES -- and the boot path has to know,
		// because carrying on renders something subtly wrong with no error at all
		const heap = sparseHeap([1, 2, 3, 4], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 96,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;
		db.prepare('UPDATE cfw_heap_chunk SET bytes = ? WHERE seq = 1').run(
			new Uint8Array(96).fill(9)
		);
		const target = new Uint8Array(heap.length);
		try {
			streamRestoreInto(sql, target, { meta, pageIndex: index.pageIndex });
			expect.unreachable('the corrupted chunk must refuse');
		} catch (e) {
			expect(e).toBeInstanceOf(HeapChunkDigestError);
			expect((e as HeapChunkDigestError).seq).toBe(1);
			expect((e as HeapChunkDigestError).chunksApplied).toBe(1);
			expect((e as HeapChunkDigestError).bytesWritten).toBe(96);
		}
		// and the heap really is dirty, which is the fact the error has to carry
		expect(target.some((b) => b !== 0)).toBe(true);
	});

	it('round-trips the handle table through the snapshot row', () => {
		// the handle table travels WITH the bytes for the same reason the fd table does: a table
		// rebuilt from some other instance's state is not this heap's table
		const heap = sparseHeap([1, 2], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			handles: [
				{ id: 1, name: GLOBAL_HANDLE_NAME },
				{ id: 4, name: 'cfwSqlExec' }
			],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 96,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		expect(snapshotPageIndex(sql, meta.id)!.handles).toEqual([
			{ id: 1, name: GLOBAL_HANDLE_NAME },
			{ id: 4, name: 'cfwSqlExec' }
		]);
	});

	it('defaults the handle table to empty for a snapshot written without one', () => {
		const heap = sparseHeap([1, 2], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 96,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		expect(snapshotPageIndex(sql, meta.id)!.handles).toEqual([]);
	});

	it('applies only a slice when asked, which is what makes it divisible across alarms', () => {
		const heap = sparseHeap([1, 2, 3, 4, 5, 6], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;
		const target = new Uint8Array(heap.length);
		const first = streamRestoreInto(sql, target, {
			meta,
			pageIndex: index.pageIndex,
			limit: 2
		});
		expect(first.chunks).toBe(2);
		expect([...target]).not.toEqual([...heap]);
		// resuming from the cursor finishes it, with no re-read of what already landed
		const rest = streamRestoreInto(sql, target, {
			meta,
			pageIndex: index.pageIndex,
			from: first.chunks
		});
		expect(rest.chunks).toBeGreaterThan(0);
		expect([...target]).toEqual([...heap]);
	});

	it('reports where to resume and whether it is done, which is what the alarm cursor reads', () => {
		const heap = sparseHeap([1, 2, 3, 4, 5, 6], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;
		const target = new Uint8Array(heap.length);

		const first = streamRestoreInto(sql, target, {
			meta,
			pageIndex: index.pageIndex,
			limit: 2
		});
		expect(first.totalChunks).toBeGreaterThan(2);
		expect(first.nextChunk).toBe(2);
		// the flag the DO branches on; a partial restore reporting complete is the failure that would
		// let a half-written heap execute PHP
		expect(first.complete).toBe(false);

		const rest = streamRestoreInto(sql, target, {
			meta,
			pageIndex: index.pageIndex,
			from: first.nextChunk
		});
		expect(rest.nextChunk).toBe(rest.totalChunks);
		expect(rest.complete).toBe(true);
	});

	it('a restore driven one chunk per firing lands the same bytes as a single-shot one', () => {
		// the actual claim: divisibility must not change the result. Alarm-chunking that produced a
		// different heap from the whole-image path would be a silent corruption with a passing test
		const heap = sparseHeap([7, null, 6, 5, null, 4, 3, null, 2], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;

		const oneShot = new Uint8Array(heap.length);
		streamRestoreInto(sql, oneShot, { meta, pageIndex: index.pageIndex });

		const chunked = new Uint8Array(heap.length);
		let cursor = 0;
		let firings = 0;
		for (;;) {
			const step = streamRestoreInto(sql, chunked, {
				meta,
				pageIndex: index.pageIndex,
				from: cursor,
				limit: 1
			});
			firings++;
			// every firing must advance, or the alarm chain re-arms at +1 ms forever
			expect(step.nextChunk).toBeGreaterThan(cursor);
			cursor = step.nextChunk;
			if (step.complete) break;
			expect(firings).toBeLessThan(64);
		}
		expect(firings).toBeGreaterThan(1);
		expect([...chunked]).toEqual([...oneShot]);
		expect([...chunked]).toEqual([...heap]);
		expect(digestBytes(chunked)).toBe(meta.digest);
	});

	it('refuses a heap whose length disagrees with the snapshot', () => {
		const heap = sparseHeap([1, 2], 64);
		writeHeapSnapshot(sql, {
			heap,
			streams: [],
			generation: 'g',
			nowMs: 1,
			chunkBytes: 64,
			pageBytes: 64
		});
		const meta = latestSnapshotMeta(sql)!;
		const index = snapshotPageIndex(sql, meta.id)!;
		expect(() =>
			streamRestoreInto(sql, new Uint8Array(64), { meta, pageIndex: index.pageIndex })
		).toThrow(/snapshot is/);
	});
});

describe('garbage collection, because an unbounded table ate 46% of a database once', () => {
	let db: DatabaseSync;
	let sql: HeapSql;

	beforeEach(() => {
		db = new DatabaseSync(':memory:');
		sql = makeSql(db);
		ensureHeapTables(sql);
		for (let i = 1; i <= 4; i++) {
			writeHeapSnapshot(sql, {
				heap: sparseHeap([i], 64),
				streams: [],
				generation: `g${i}`,
				nowMs: i,
				chunkBytes: 64,
				pageBytes: 64
			});
		}
	});

	it('keeps the newest and deletes the rest, chunks included', () => {
		expect(gcHeapSnapshots(sql, 1)).toBe(3);
		const metas = db.prepare('SELECT COUNT(*) AS c FROM cfw_heap_snapshot').get() as {
			c: number;
		};
		const chunks = db.prepare('SELECT COUNT(*) AS c FROM cfw_heap_chunk').get() as {
			c: number;
		};
		expect(Number(metas.c)).toBe(1);
		// orphaned chunks are the expensive half; metadata rows are bytes, chunks are megabytes
		expect(Number(chunks.c)).toBe(1);
	});

	it('honours a larger keep', () => {
		expect(gcHeapSnapshots(sql, 2)).toBe(2);
		const metas = db.prepare('SELECT COUNT(*) AS c FROM cfw_heap_snapshot').get() as {
			c: number;
		};
		expect(Number(metas.c)).toBe(2);
	});

	it('is a no-op when there is nothing to drop', () => {
		gcHeapSnapshots(sql, 1);
		expect(gcHeapSnapshots(sql, 1)).toBe(0);
	});

	it('refuses to keep zero, which would delete the image being restored', () => {
		expect(() => gcHeapSnapshots(sql, 0)).toThrow(RangeError);
	});

	it('leaves the surviving snapshot readable', () => {
		gcHeapSnapshots(sql, 1);
		expect([...readHeapSnapshot(sql)!.heap]).toEqual([...sparseHeap([4], 64)]);
	});
});

describe('the default chunk size against the real record cap', () => {
	it('is under the cap with room for the rest of the row', () => {
		expect(DEFAULT_CHUNK_BYTES).toBeLessThan(DO_SQLITE_MAX_RECORD_BYTES);
		expect(DO_SQLITE_MAX_RECORD_BYTES - DEFAULT_CHUNK_BYTES).toBeGreaterThan(100_000);
	});

	it('trades rows for divisibility, which is the correction the edge forced', () => {
		// This used to assert "about 20 rows", off a 2,000,000-byte chunk. That number
		// was sized against the RECORD cap, and a deployed sweep with HEAP_RESTORE_CHUNKS=1 showed
		// the record cap never bound: one 2 MB step cost 21-52 ms of edge cpuTime, 5x the free
		// per-invocation cap the chunking exists to fit. At 200,000 every one of 41 firings came in
		// under 10 ms. Rows are cheap; an indivisible step is not.
		expect(Math.ceil(39_911_590 / DEFAULT_CHUNK_BYTES)).toBe(200);
		// and the image the DO actually snapshots, 8,126,464 elided bytes measured on the edge
		expect(Math.ceil(8_126_464 / DEFAULT_CHUNK_BYTES)).toBe(41);
	});
});
