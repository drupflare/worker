import {
	captureHandles,
	captureStreams,
	dropSnapshotById,
	dropStaleSnapshots,
	ensureHeapTables,
	gcHeapSnapshots,
	type HandleIndex,
	latestSnapshotMeta,
	replayHandles,
	replayStreams,
	snapshotPageIndex,
	type StreamFS,
	streamRestoreInto,
	toStorableBytes,
	writeHeapSnapshot
} from '../db/heap-store';
import { BOOT_KERNEL } from '../drupal/site-php';
import { hasDeploymentEnv } from '../ops/deployment-env';
import {
	checkHeapSnapshot,
	emptyHeapIntegrityStats,
	noteHeapCheck,
	pruneHeapRecords,
	sealHeapSnapshot
} from '../ops/heap-integrity';
import type { SitePhpDurableObject } from '../site-do';
import { firstRow } from '../util/sql';
import { heapRestoreChunkBudget, heapSnapshotEnabled } from './alarm';
import { HEAP_IMAGE_ATTEMPTS_KEY, HEAP_IMAGE_KEY } from './keys';
import type { HandleTableOps, Payload, SiteBinary } from './types';

/**
 * Keeps every vrzno handle alive for the interpreter's whole life.
 *
 * `Module.targets.byInteger` is a `WeakerMap` whose iterator deletes collected entries, so a handle
 * the heap still names can be gone by snapshot time; the pin runs before any PHP does.
 */
export function pinHandles(site: SitePhpDurableObject, binary: SiteBinary): number {
	const table = site.handleIndex(binary);
	if (!table) return 0;
	const pinned = new Set<object>();
	site.pinnedHandles = pinned;
	(binary as unknown as { targets: unknown }).targets = delegatingHandleTable(table, {
		onAdd: (o) => pinned.add(o)
	});
	return pinned.size;
}

/**
 * A delegating stand-in for the handle table, with optional observers on `get` and `add`.
 *
 * A plain object, not a Proxy: `Module.targets.get` is non-writable and non-configurable, so the
 * object one level up is replaced (a get trap could only return the real value).
 */
export function delegatingHandleTable(
	table: HandleIndex,
	hooks: { onGet?: (id: number, value: unknown) => void; onAdd?: (o: object) => void } = {}
): Record<string, unknown> {
	const real = table as unknown as HandleTableOps;
	return {
		byObject: table.byObject,
		byInteger: table.byInteger,
		get id(): number {
			return table.id;
		},
		set id(v: number) {
			table.id = v;
		},
		get: (id: number) => {
			const v = real.get(id);
			hooks.onGet?.(id, v);
			return v;
		},
		add: (o: object) => {
			const id = real.add(o);
			hooks.onAdd?.(o);
			return id;
		},
		getId: (o: object) => real.getId(o),
		has: (o: object) => real.has(o),
		hasId: (id: number) => real.hasId(id),
		remove: (id: number) => real.remove(id)
	};
}

/**
 * Writes this object's booted heap into its own SQLite.
 *
 * Post-boot, pre-render: a rendered heap is a request-contaminated heap.
 *
 * The fd table and the vrzno handle table (see `HandleRecord`) travel with the bytes: the open
 * descriptors are what a restore depends on, and the heap stores `Module.targets` ids as bare
 * integers.
 *
 * The root of what was written is sealed in key-value storage in the same synchronous run, so no
 * request can run between the rows and their record.
 */
export async function snapshotHeap(
	site: SitePhpDurableObject,
	opts: { chunkBytes?: number } = {}
): Promise<Payload> {
	const { binary } = await site.ensurePhp();
	const heap = site.heapBytes(binary);
	if (!heap) return { ok: false, error: 'no reachable heap on this binary' };
	ensureHeapTables(site.sql);
	const streams = captureStreams(binary.FS as unknown as StreamFS);
	const handles = captureHandles(
		site.handleIndex(binary),
		binary as unknown as Record<string, unknown>
	);
	const t0 = Date.now();
	const { root, ...written } = writeHeapSnapshot(site.sql, {
		// the live view, not a copy: nothing before the last chunk insert can grow the heap, and a
		// copy spent a second 64 MB when the isolate had none (`exceededMemory` on the edge)
		heap,
		streams,
		handles: handles.handles,
		generation: String(site.heapGeneration() ?? ''),
		nowMs: site.nowMs(),
		// fixed at write time because a streaming restore locates chunks by `seq * chunkBytes`
		// (one 2 MB chunk cost 21-52 ms of cpuTime per firing on the edge)
		chunkBytes: opts.chunkBytes
	});
	const sealed = site.secretStore().sealed;
	sealHeapSnapshot(sealed, written.id, root);
	// one snapshot is all a restore needs; an unbounded table of 40 MB images would be worse than
	// the watchdog table
	const dropped = gcHeapSnapshots(site.sql, 1);
	pruneHeapRecords(sealed, site.sql);
	return {
		ok: true,
		...written,
		droppedOlder: dropped,
		streams: streams.length,
		handles: handles.handles.length,
		// reported at snapshot time too: a handle nothing can name makes the image unrestorable
		unnameableHandles: handles.unnameable,
		heapBytes: heap.length,
		elapsedMs: Date.now() - t0
	};
}

/**
 * Takes this site's one heap image, on an alarm that arrives with no interpreter.
 *
 * It never drops a resident interpreter (that holds two linear memories at once and destroys live
 * state); it waits for an alarm that finds `php === null`, which provisioning and
 * `recycleIfOversized()` produce. A site that never does simply never images
 * (`imagedGeneration: null` on `/heap`).
 */
export async function snapshotStep(site: SitePhpDurableObject): Promise<Payload | undefined> {
	// gates the producer (`HEAP_SNAPSHOT` gates the restore); off by default because a restore
	// costs ~648 ms more cpuTime than booting (1,912 vs 1,264 ms median) and ~8 MB a site
	if (String(site.env?.HEAP_IMAGE ?? '0') !== '1' || hasDeploymentEnv(site.env)) return undefined;
	if (!heapSnapshotEnabled(site.env)) return undefined;
	if (site.isPoolLane()) return undefined;
	// a resident interpreter is not this object's to take
	if (site.php !== undefined) return undefined;
	const generation = site.heapGeneration();
	if (generation === undefined) return undefined;
	if (site.metaGet(HEAP_IMAGE_KEY) === generation) {
		// the mark says imaged; a restore that refused the image deleted it, and then it is owed again
		ensureHeapTables(site.sql);
		if (latestSnapshotMeta(site.sql, generation) !== undefined) return undefined;
	}
	// three strikes per generation (not lifetime, or three module installs would stop imaging) so
	// an image that cannot be taken does not own the alarm chain
	const attempts = site.imageAttempts(generation);
	if (attempts >= 3) return undefined;
	// never over an image somebody else took (`gcHeapSnapshots()` keeps exactly one)
	ensureHeapTables(site.sql);
	const sealed = site.secretStore().sealed;
	const held = latestSnapshotMeta(site.sql, generation);
	if (held !== undefined) {
		const check = checkHeapSnapshot(sealed, site.sql, held.id);
		noteHeapCheck((site.heapIntegrity ??= emptyHeapIntegrityStats()), check);
		if (check.ok) {
			site.metaSet(HEAP_IMAGE_KEY, generation);
			return undefined;
		}
		// rows nobody sealed are not an image anybody took
		dropSnapshotById(site.sql, held.id);
		pruneHeapRecords(sealed, site.sql);
	}
	site.metaSet(HEAP_IMAGE_ATTEMPTS_KEY, `${generation} ${attempts + 1}`);
	try {
		// `ensurePhp()` alone holds 47 non-zero pages and no descriptors; the kernel boot is what a
		// restore skips
		await site.runJson(BOOT_KERNEL);
		const snap = await site.snapshotHeap();
		if (snap.ok === true) site.metaSet(HEAP_IMAGE_KEY, generation);
		return { heapImage: snap };
	} catch (e: any) {
		return { heapImage: { ok: false, error: String(e?.message ?? e) } };
	}
}

/**
 * Restores a stored heap into this instance, or explains why it refused.
 *
 * Called after the mount, bridge and capabilities are installed: they populate the JS side that
 * the heap's vrzno handles index into.
 *
 * The stored rows are hashed and compared to the root sealed outside SQL before anything else
 * touches the instance; an image with no record, or with rows that hash to another root, is
 * deleted and the boot continues from the pack. The fd table is asserted before the memcpy and a
 * refusal is loud: dropped sqlite descriptors give a locking-protocol error after an 80-120 s
 * stall (a hung request on the edge), while a refusal costs one boot.
 */
export async function tryRestoreHeap(
	site: SitePhpDurableObject,
	binary: SiteBinary,
	opts: { maxChunks?: number } = {}
): Promise<Payload> {
	// the boot path reads these before anything wrote them and can meet a table older than the
	// code (`CREATE TABLE IF NOT EXISTS` adds no column, so "no such column: handle_table")
	ensureHeapTables(site.sql);
	const generation = site.heapGeneration();
	const meta = latestSnapshotMeta(site.sql, String(generation ?? ''));
	if (!meta) {
		// every stored image is for another generation; pruning here (not at `/__enable`) also
		// catches an uninstall driven from Drupal's own UI, which reaches no host route
		const dropped = generation === undefined ? 0 : dropStaleSnapshots(site.sql, generation);
		pruneHeapRecords(site.secretStore().sealed, site.sql);
		return {
			restored: false,
			reason: 'no snapshot for this pack generation',
			droppedStale: dropped
		};
	}

	const live = site.heapBytes(binary);
	if (!live) return { restored: false, reason: 'no reachable heap on this binary' };
	if (live.length < meta.byteLength) {
		// the snapshot came from a larger INITIAL_MEMORY
		return {
			restored: false,
			reason: `heap is ${live.length} bytes, snapshot is ${meta.byteLength}`
		};
	}

	// before the page index, the fd table and the handle table are read, and before any of them
	// touches this instance: all of them steer the restore and all of them are in the root
	const sealed = site.secretStore().sealed;
	const tVerify = Date.now();
	const check = checkHeapSnapshot(sealed, site.sql, meta.id);
	const verifyMs = Date.now() - tVerify;
	noteHeapCheck((site.heapIntegrity ??= emptyHeapIntegrityStats()), check);
	if (!check.ok) {
		dropSnapshotById(site.sql, meta.id);
		pruneHeapRecords(sealed, site.sql);
		return {
			restored: false,
			reason: `heap image refused: ${check.reason}`,
			integrity: check.reason
		};
	}

	const index = snapshotPageIndex(site.sql, meta.id);
	if (!index) return { restored: false, reason: 'snapshot metadata without a page index' };

	// the fd assertion, before anything touches linear memory (a no-op on the DO path: the
	// database is a host call, so there are no descriptors above stdio)
	const replay = replayStreams(binary.FS as unknown as StreamFS, index.streams);
	if (replay.failed.length > 0) {
		return {
			restored: false,
			reason: 'fd replay failed; refusing before any bytes land',
			failed: replay.failed
		};
	}

	// the heap holds `Module.targets` ids as integers, so each handle is a dead index until
	// re-registered at the same id (else `TypeError: target is not a function`); refuse early
	const handles = replayHandles(
		site.handleIndex(binary),
		binary as unknown as Record<string, unknown>,
		index.handles
	);
	if (handles.failed.length > 0) {
		return {
			restored: false,
			reason: 'vrzno handle replay failed; refusing before any bytes land',
			failedHandles: handles.failed
		};
	}

	// the image never had a tail past its own length, so zero what a reused memory left there
	if (live.length > meta.byteLength) live.fill(0, meta.byteLength);
	const t0 = Date.now();
	// nothing larger than one chunk is allocated: the isolate ceiling is non-monotone (128 MiB
	// failed while 160 succeeded)
	const applied = streamRestoreInto(site.sql, live, {
		meta,
		pageIndex: index.pageIndex,
		limit: opts.maxChunks,
		chunkDigests: check.chunkDigests
	});
	site.heapRestoreCursor = applied.complete
		? undefined
		: {
				snapshotId: meta.id,
				nextChunk: applied.nextChunk,
				totalChunks: applied.totalChunks,
				bytesWritten: applied.bytesWritten,
				firings: 1,
				verified: { meta, pageIndex: index.pageIndex, chunkDigests: check.chunkDigests }
			};
	return {
		restored: applied.complete,
		partial: !applied.complete,
		bytes: meta.byteLength,
		digest: meta.digest,
		streamsReplayed: replay.replayed.length,
		handlesReplayed: handles.replayed.length,
		handleNextId: handles.nextId,
		verifyMs,
		memcpyMs: Date.now() - t0,
		...applied
	};
}

/**
 * Flips one byte of a stored chunk and leaves its digest alone, so the next restore must refuse.
 *
 * Makes the refusal executable in production, not only in a test: a chunk with the wrong bytes
 * gives a heap of the right length that renders subtly wrong with no error. The stored digest is
 * left untouched; corrupting both would restore cleanly and prove nothing.
 */
export function corruptStoredChunk(site: SitePhpDurableObject, seq: number): Payload {
	const meta = latestSnapshotMeta(site.sql, String(site.heapGeneration() ?? ''));
	if (!meta) return { ok: false, reason: 'no snapshot for this pack generation' };
	const row = firstRow(
		site.sql.exec(
			'SELECT bytes, digest FROM cfw_heap_chunk WHERE snapshot_id = ? AND seq = ?',
			meta.id,
			seq
		)
	) as { bytes: ArrayBufferLike | Uint8Array; digest: string } | undefined;
	if (!row) return { ok: false, reason: `snapshot ${meta.id} has no chunk ${seq}` };

	const bytes = toStorableBytes(row.bytes);
	const at = Math.floor(bytes.length / 2);
	const was = bytes[at] ?? 0;
	const copy = new Uint8Array(bytes);
	copy[at] = was ^ 0xff;
	site.sql.exec(
		'UPDATE cfw_heap_chunk SET bytes = ? WHERE snapshot_id = ? AND seq = ?',
		copy,
		meta.id,
		seq
	);
	return {
		ok: true,
		snapshotId: meta.id,
		seq,
		byteOffset: at,
		was,
		now: copy[at],
		digestLeftIntact: row.digest,
		next: 'GET /heap?op=restore -- the restore must refuse with a chunk digest mismatch'
	};
}

/**
 * Applies the next slice of an in-flight restore. Driven by `alarm()`, never by a request.
 *
 * The heap is read from the live binary each firing, since the cursor only means something for the
 * mounted heap. The cursor is in-memory, so it dies with the isolate and the next boot restarts at
 * chunk 0. It carries what the first firing verified against the sealed root, and each chunk is
 * checked against those digests as it lands; a cursor without them refuses.
 */
export async function restoreStepOnce(site: SitePhpDurableObject): Promise<Payload | undefined> {
	const cursor = site.heapRestoreCursor;
	if (!cursor) return undefined;
	if (!site.php) {
		// unreachable in practice; resuming at chunk N onto a zeroed heap would report success
		site.heapRestoreCursor = undefined;
		return {
			heapRestore: { restored: false, reason: 'isolate replaced; restarting at chunk 0' }
		};
	}

	const verified = cursor.verified;
	const live = site.heapBytes(site.php.binary);
	if (!verified || !live || verified.meta.id !== cursor.snapshotId) {
		// chunks already landed, so the heap is dropped with the cursor
		site.heapRestoreCursor = undefined;
		site.php = undefined;
		return {
			heapRestore: {
				restored: false,
				reason: verified
					? 'snapshot changed under an in-flight restore'
					: 'restore cursor holds no verified image',
				discardedHeap: true
			}
		};
	}

	const t0 = Date.now();
	let applied;
	try {
		applied = streamRestoreInto(site.sql, live, {
			meta: verified.meta,
			pageIndex: verified.pageIndex,
			chunkDigests: verified.chunkDigests,
			from: cursor.nextChunk,
			limit: heapRestoreChunkBudget(site.env)
		});
	} catch (e) {
		// a digest refusal mid-restore leaves the heap partly overwritten: drop it and let the next
		// request boot from the pack
		site.heapRestoreCursor = undefined;
		site.php = undefined;
		site.heapRestore = {
			restored: false,
			reason: String((e as Error)?.message ?? e),
			discardedHeap: true
		};
		return { heapRestore: site.heapRestore };
	}

	cursor.nextChunk = applied.nextChunk;
	cursor.bytesWritten += applied.bytesWritten;
	cursor.firings += 1;
	site.heapRestoreCursor = applied.complete ? undefined : cursor;
	site.heapRestore = {
		restored: applied.complete,
		partial: !applied.complete,
		bytes: verified.meta.byteLength,
		digest: verified.meta.digest,
		chunksApplied: cursor.nextChunk,
		totalChunks: applied.totalChunks,
		bytesWritten: cursor.bytesWritten,
		firings: cursor.firings,
		memcpyMs: Date.now() - t0
	};
	return { heapRestore: site.heapRestore };
}
