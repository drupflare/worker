import { describe, expect, it } from 'vitest';
import {
	HEAP_PACK_RATIO,
	SITE_STORAGE_BYTES,
	storageCeiling
} from '../../scripts/measure/free-envelope';
import { readHeapSnapshot, unpackChunk } from '../../src/db/heap-store';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The chunk codec, driven end to end by the real image producer.
 *
 * `HEAP_IMAGE` IS OFF BY DEFAULT, so this spec turns it on. An image costs storage and, measured on
 * a deployed A/B, more `cpuTime` than the boot it replaces -- 1,912 ms median over n=5 against
 * 1,264 ms over n=4, ranges not overlapping. Deflation cannot reach that term, so the codec bounds
 * an opt-in cost rather than closing anything on its own.
 *
 * WHAT IS ASSERTED HERE IS THE PROPERTY, NOT THE MAGNITUDE: packed is smaller than stored, every
 * row records its inflated length, and the round trip is byte-identical. Both sides of each of
 * those move together, so a feature landing in the pack cannot fail this file. The measured sizes
 * are printed for a reader and compared against nothing.
 */

const TIMEOUT = 1_800_000;

type Imaged = {
	stub: DurableObjectStub;
	/** the elided heap length, which is the coordinate system the restore's offsets are in */
	storedBytes: number;
	/** what the rows occupy, which is what the storage cap is spent in */
	compressedBytes: number;
	keptPages: number;
	stored: { bytes: Uint8Array; rawBytes: number }[];
};

async function imagedSite(): Promise<Imaged> {
	const stub = freshSite();
	await inObject(stub, (site: ServeDo) =>
		site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'))
	);
	await inObject(stub, (site: ServeDo) => {
		// the producer is opt-in; without this `snapshotStep()` answers null and every assertion
		// below would fail on a missing image rather than on the codec
		(site.env as Record<string, unknown>).HEAP_IMAGE = '1';
		(site.env as Record<string, unknown>).HEAP_SNAPSHOT = '1';
		(site as { php: unknown }).php = null;
	});
	const out = (await inObject(stub, (site: ServeDo) =>
		(site as unknown as { snapshotStep(): Promise<unknown> }).snapshotStep()
	)) as {
		heapImage?: {
			ok?: boolean;
			storedBytes?: number;
			compressedBytes?: number;
			keptPages?: number;
		};
	} | null;
	expect(out?.heapImage?.ok, JSON.stringify(out)).toBe(true);

	const stored = await inObject(stub, (site: ServeDo) =>
		site.sql
			.exec('SELECT bytes, raw_bytes FROM cfw_heap_chunk ORDER BY seq')
			.toArray()
			.map((r) => ({
				bytes: new Uint8Array(r['bytes'] as ArrayBufferLike),
				rawBytes: Number(r['raw_bytes'] ?? 0)
			}))
	);

	return {
		stub,
		storedBytes: Number(out?.heapImage?.storedBytes ?? 0),
		compressedBytes: Number(out?.heapImage?.compressedBytes ?? 0),
		keptPages: Number(out?.heapImage?.keptPages ?? 0),
		stored
	};
}

let cached: Promise<Imaged> | null = null;
const measured = () => (cached ??= imagedSite());

describe('the heap image chunk codec, on a real image', () => {
	it(
		'reports what the image measured, against the constants and compared to nothing',
		async () => {
			const m = await measured();
			console.log(
				JSON.stringify(
					{
						elidedBytes: m.storedBytes,
						keptPages: m.keptPages,
						rows: m.stored.length,
						packedBytes: m.compressedBytes,
						ratio: Number((m.storedBytes / m.compressedBytes).toFixed(3)),
						// what the model carries, so a reader sees drift without a spec failing on it
						modelElided: SITE_STORAGE_BYTES.heapSnapshot,
						modelPacked: SITE_STORAGE_BYTES.packedHeapSnapshot,
						modelRatio: Number(HEAP_PACK_RATIO.toFixed(3)),
						sitesIfStored: storageCeiling(true).sitesPerAccount,
						sitesIfNot: storageCeiling(false).sitesPerAccount
					},
					null,
					1
				)
			);
			expect(m.compressedBytes).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'stores less than it holds, which is the thing that could go inert',
		async () => {
			const m = await measured();
			expect(m.compressedBytes).toBeLessThan(m.storedBytes);
		},
		TIMEOUT
	);

	it(
		'records the inflated length on every row, since the restore offsets are in heap bytes',
		async () => {
			const m = await measured();
			expect(m.stored.length).toBeGreaterThan(0);
			expect(m.stored.every((r) => r.rawBytes > 0)).toBe(true);
			// each row is smaller than what it inflates to, per row rather than in aggregate
			expect(m.stored.every((r) => r.bytes.length < r.rawBytes)).toBe(true);
		},
		TIMEOUT
	);

	it(
		'unpacks to exactly the elided stream the snapshot recorded',
		async () => {
			const m = await measured();
			const total = m.stored
				.map((r) => unpackChunk(r.bytes, r.rawBytes))
				.reduce((n, b) => n + b.length, 0);
			expect(total).toBe(m.storedBytes);
		},
		TIMEOUT
	);

	it(
		'round-trips through the reader, which verifies the digest and refuses a mismatch',
		async () => {
			const m = await measured();
			// `readHeapSnapshot()` rebuilds the heap and throws unless the digest agrees, so calling
			// it IS the byte-identity assertion; a right-length wrong-content restore cannot pass
			const back = await inObject(m.stub, (site: ServeDo) => {
				const r = readHeapSnapshot(site.sql as never);
				return r === null ? null : { length: r.heap.length, byteLength: r.meta.byteLength };
			});
			expect(back).not.toBeNull();
			expect(back!.length).toBe(back!.byteLength);
		},
		TIMEOUT
	);
});
