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
			// THE DIRECTION INVERTED AND THE OLD ONE WAS MEASURING A DEFECT. A provisioned site used
			// to carry the larger heap -- 1.53x -- and that was the packed `cache_container` row
			// being keyed to a stale dependency hash, so the first boot rebuilt a 482 KB container.
			// With the row readable a provisioned site READS it and a bare object, which has no
			// database to read it from, is the one that builds: 159 pages against 363.
			expect(bare.pagesB).toBeGreaterThan(provisioned.pagesB);

			// A BAND, NOT A PIN, AND THE PIN WAS THE ERROR. This asserted `toBeCloseTo(0.3779, 4)`
			// on the strength of three consecutive identical runs, read as "an exact property of the
			// pack". It is not: seven runs read 0.3472, 0.3779 x5 and 0.3797, and the outliers only
			// appeared once the suite ran it under load. Three identical readings are evidence of a
			// mode, never of zero variance -- a tolerance of 0.00005 on a figure that moves three
			// points is a guard that fails on the truth.
			// the band moved with the container fix, from 0.3-0.45 to the high eighties: what two
			// sites no longer fail to share is the separately-built container. n=5 read 0.8868 x3,
			// 0.8742 and 0.7547, and the low one was taken under full-suite load -- so the width
			// here is the load excursion, not a guess. A first band of 0.65-0.85 was set from the
			// loaded reading alone and failed on the isolated one.
			//
			// What it guards is the REGIME: a regression to the packed container being unreadable
			// sends this back to ~0.38, which any band separating those two catches.
			expect(provisioned.sharedFraction).toBeGreaterThan(0.65);
			expect(provisioned.sharedFraction).toBeLessThan(0.95);
			// and the BARE arm is NOT pinned: the same three runs read 0.3994, 0.3994
			// and 0.7603 on it. An object with no database has little structure to share, so the
			// fraction swings on what little there is -- which is the reason a fleet figure is
			// quoted from the provisioned arm and never from this one
			expect(bare.sharedFraction).toBeGreaterThan(0);
		},
		TIMEOUT
	);
});
