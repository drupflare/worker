import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * How much of one site's post-boot heap is byte-identical to another's, at page granularity.
 *
 * The first version measured a site with NO DATABASE -- both arms were a bare `freshSite()`, so
 * the kernel booted against an object that had never been migrated. `bare` reproduces that
 * reading, `provisioned` is the one a fleet figure may be quoted from; the gap is the correction.
 */

const PAGE = 65_536;
const TIMEOUT = 900_000;

type Chunk = { seq: number; digest: string };

const call = (site: ServeDo, path: string) => site.fetch(new Request(`https://do.local${path}`));

async function snapshotDigests(stub: DurableObjectStub): Promise<Chunk[]> {
	const res = await stub.fetch(`https://do.local/__heap?op=snapshot&fresh=1&chunkBytes=${PAGE}`, {
		headers: { 'x-cfw-owner': 'test' }
	});
	expect(res.status, await res.text().catch(() => '')).toBe(200);
	return inObject(stub, (site: ServeDo) =>
		(site as unknown as { sql: SqlStorage }).sql
			.exec<Chunk>('SELECT seq, digest FROM cfw_heap_chunk ORDER BY seq')
			.toArray()
	);
}

async function provisionedStub(): Promise<DurableObjectStub> {
	const stub = freshSite();
	await inObject(stub, (site) => call(site, '/__migrate?all=1&prefill=0'));
	return stub;
}

type Dedup = {
	arm: string;
	pagesA: number;
	pagesB: number;
	uniqueWithinA: number;
	sharedAcrossSites: number;
	sharedFraction: number;
	identicalAtSameIndex: number;
	bytesPerSite: number;
	bytesIfShared: number;
};

function compare(arm: string, a: Chunk[], b: Chunk[]): Dedup {
	const counts = new Map<string, number>();
	for (const c of a) counts.set(c.digest, (counts.get(c.digest) ?? 0) + 1);
	let shared = 0;
	for (const c of b) {
		const n = counts.get(c.digest) ?? 0;
		if (n > 0) {
			shared++;
			counts.set(c.digest, n - 1);
		}
	}
	// positionally identical is the stricter question, and the one a per-site page list answers
	const byIndex = new Map(a.map((c) => [c.seq, c.digest]));
	return {
		arm,
		pagesA: a.length,
		pagesB: b.length,
		uniqueWithinA: new Set(a.map((c) => c.digest)).size,
		sharedAcrossSites: shared,
		sharedFraction: +(shared / Math.max(1, b.length)).toFixed(4),
		identicalAtSameIndex: b.filter((c) => byIndex.get(c.seq) === c.digest).length,
		bytesPerSite: b.length * PAGE,
		bytesIfShared: (b.length - shared) * PAGE
	};
}

describe('two sites, snapshotted at wasm-page granularity', () => {
	it(
		'reports the shared fraction for a bare object and for a provisioned one',
		async () => {
			const bare = compare(
				'bare',
				await snapshotDigests(freshSite()),
				await snapshotDigests(freshSite())
			);
			const provisioned = compare(
				'provisioned',
				await snapshotDigests(await provisionedStub()),
				await snapshotDigests(await provisionedStub())
			);
			console.log(`[snapshot-dedup] ${JSON.stringify({ bare, provisioned }, null, 1)}`);

			expect(bare.pagesB).toBeGreaterThan(0);
			expect(provisioned.pagesB).toBeGreaterThan(0);
			// the correction itself: a provisioned site carries a materially larger heap, so a
			// fraction taken on the bare arm is a fraction of the wrong denominator
			expect(provisioned.pagesB).toBeGreaterThan(bare.pagesB);

			// A BAND, NOT A PIN, AND THE PIN WAS THE ERROR. This asserted `toBeCloseTo(0.3779, 4)`
			// on the strength of three consecutive identical runs, read as "an exact property of the
			// pack". It is not: seven runs read 0.3472, 0.3779 x5 and 0.3797, and the outliers only
			// appeared once the suite ran it under load. Three identical readings are evidence of a
			// mode, never of zero variance -- a tolerance of 0.00005 on a figure that moves three
			// points is a guard that fails on the truth.
			expect(provisioned.sharedFraction).toBeGreaterThan(0.3);
			expect(provisioned.sharedFraction).toBeLessThan(0.45);
			// and the BARE arm is deliberately NOT pinned: the same three runs read 0.3994, 0.3994
			// and 0.7603 on it. An object with no database has little structure to share, so the
			// fraction swings on what little there is -- which is the reason a fleet figure is
			// quoted from the provisioned arm and never from this one
			expect(bare.sharedFraction).toBeGreaterThan(0);
		},
		TIMEOUT
	);
});
