/**
 * Integrity records for stored heap images, kept in sealed storage.
 *
 * `cfw_heap_snapshot` and `cfw_heap_chunk` are SQL, so any PHP with a database write can plant an
 * image with matching row digests and have the next boot restore it into linear memory. The root
 * of each image the host wrote lives in key-value storage under `heapsum:<snapshot id>`, which the
 * SQL bridge cannot read or write; a snapshot with no record, or one whose stored rows hash to a
 * different root, is never restored.
 *
 * @module
 */
import { type HeapSql, hashStoredSnapshot } from '../db/heap-store';
import { type SealedStore, tokenMatches } from './site-secrets';

/** sealed key prefix; the snapshot id follows */
export const HEAP_RECORD_PREFIX = 'heapsum:';

const RECORD_KEY = /^heapsum:(\d+)$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** what the heap integrity check has seen on this object, shown by `/__serve-stats` */
export type HeapIntegrityStats = {
	/** images whose rows hashed to their sealed root */
	verified: number;
	/** images refused: no record, a malformed record, or rows that hash to another root */
	refused: number;
	/** why the last image was refused, with no payload */
	lastReason: string | null;
	/** reasons that already logged a warning */
	warned: Set<string>;
};

/** a fresh stats object */
export function emptyHeapIntegrityStats(): HeapIntegrityStats {
	return { verified: 0, refused: 0, lastReason: null, warned: new Set() };
}

/** the JSON a stats object answers with (the warned set stays inside) */
export function heapIntegrityReport(
	stats: HeapIntegrityStats | undefined
): Omit<HeapIntegrityStats, 'warned'> {
	const s = stats ?? emptyHeapIntegrityStats();
	return { verified: s.verified, refused: s.refused, lastReason: s.lastReason };
}

/** the sealed key holding one snapshot's root */
export function heapRecordKey(id: number): string {
	return `${HEAP_RECORD_PREFIX}${id}`;
}

/** records the root of an image the host just wrote */
export function sealHeapSnapshot(sealed: SealedStore, id: number, root: string): void {
	sealed.put(heapRecordKey(id), root);
}

/** the outcome of checking one stored image against its sealed root */
export type HeapCheck = { ok: true; chunkDigests: string[] } | { ok: false; reason: string };

/**
 * Hashes the rows stored under `id` and compares the root, in constant time, to the sealed record.
 * A missing or malformed record fails closed, and so does a row the hash cannot read.
 */
export function checkHeapSnapshot(sealed: SealedStore, sql: HeapSql, id: number): HeapCheck {
	const record = sealed.get(heapRecordKey(id));
	if (record === undefined) return { ok: false, reason: 'no sealed record' };
	if (typeof record !== 'string' || !HEX64.test(record)) {
		return { ok: false, reason: 'malformed sealed record' };
	}
	let hashed;
	try {
		hashed = hashStoredSnapshot(sql, id);
	} catch {
		return { ok: false, reason: 'stored rows unreadable' };
	}
	if (!hashed) return { ok: false, reason: 'no snapshot row' };
	if (!tokenMatches(hashed.root, record)) return { ok: false, reason: 'digest mismatch' };
	return { ok: true, chunkDigests: hashed.chunkDigests };
}

/** counts a check, warning once per distinct refusal reason */
export function noteHeapCheck(stats: HeapIntegrityStats, check: HeapCheck): void {
	if (check.ok) {
		stats.verified++;
		return;
	}
	stats.refused++;
	stats.lastReason = check.reason;
	if (stats.warned.has(check.reason)) return;
	stats.warned.add(check.reason);
	console.warn(JSON.stringify({ heapIntegrity: { reason: check.reason } }));
}

/** deletes the records whose snapshot is gone; returns how many it removed */
export function pruneHeapRecords(sealed: SealedStore, sql: HeapSql): number {
	const live = new Set(
		sql
			.exec('SELECT id FROM cfw_heap_snapshot')
			.toArray()
			.map((row) => Number(row.id))
	);
	let removed = 0;
	for (const [key] of sealed.list(HEAP_RECORD_PREFIX)) {
		const match = RECORD_KEY.exec(key);
		if (match && live.has(Number(match[1]))) continue;
		sealed.delete(key);
		removed++;
	}
	return removed;
}
