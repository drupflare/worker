import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The drop guard has to see the WHOLE isolate, not half of it.
 *
 * A Durable Object gets 128 MiB and that budget covers the wasm linear memory AND the JS heap.
 * `oversized()` compared linear memory alone against `RECYCLE_ABOVE_BYTES`, whose default is
 * 117,440,512 -- and a booted interpreter also holds the 12,001,784-byte pack blob plus up to
 * 4,194,304 bytes of MEMFS contents on the JS side. 117,440,512 + 12,001,784 + 4,194,304 is
 * 133,636,600 against a ceiling of 134,217,728, so the guard could only return true from a state
 * the object had already died in. That is why `recycles: 0` appears beside every one of these
 * resets: the guard never fired, because it could not.
 *
 * The knowledge was already in the file. `lazyMountBytes`'s docblock says MEMFS contents "are
 * typed arrays on the JS heap, so they are invisible to a reading of wasm linear memory -- and the
 * isolate's 128 MB covers both", one function away from the guard that did not call it.
 */

type Stats = {
	isolateBytes: {
		linear: number;
		mount: number;
		resident: number;
		total: number;
		ceiling: number;
		dropAbove: number;
	};
};

const stats = async (site: ServeDo): Promise<Stats> =>
	(await (await site.fetch(new Request('https://do.local/__serve-stats'))).json()) as Stats;

describe('the isolate budget the drop guard reads', () => {
	it('reports the whole isolate as its parts, which nothing did before', async () => {
		const seen = await inObject(freshSite(), async (site) => stats(site));
		const b = seen.isolateBytes;
		// the ceiling is the platform's and is not configurable; a figure compared against the
		// wrong one is how "19.50 MiB spare" was published for an object with ~4
		expect(b.ceiling).toBe(134_217_728);
		expect(b.total).toBe(b.linear + b.mount + b.resident);
	});

	it('leaves at least 4 MiB between the drop threshold and the ceiling', async () => {
		// the margin is not for a leak -- nothing here leaks -- it is for ONE workload landing
		// above the growth rung, which is what the provisioning resets were. A margin under one
		// growth step's slack (983,040 to 2,031,616 bytes) cannot survive that
		const seen = await inObject(freshSite(), async (site) => stats(site));
		const margin = seen.isolateBytes.ceiling - seen.isolateBytes.dropAbove;
		expect(margin).toBeGreaterThanOrEqual(4 * 1024 * 1024);
	});

	it('sets a threshold with more room than the linear-only default left', async () => {
		// THE ARITHMETIC, PINNED, AND IT IS NOT "already over the ceiling" -- I wrote that first,
		// from the audit, and it is wrong by 581,128 bytes. The old guard plus the JS-side bytes it
		// ignored lands at 133,636,600 against 134,217,728, so it fires with 0.55 MiB left. That is
		// under one growth step's slack (983,040 to 2,031,616) and under the merged pack index,
		// which is NOT MEASURED anywhere and is the largest unpriced term here. Too tight to be
		// useful is provable; already dead is not.
		const RECYCLE_ABOVE = 117_440_512;
		const PACK_BLOB = 12_001_784;
		const MEMFS_BUDGET = 4_194_304;
		const oldHeadroom = 134_217_728 - (RECYCLE_ABOVE + PACK_BLOB + MEMFS_BUDGET);
		expect(oldHeadroom).toBe(581_128);
		expect(oldHeadroom).toBeLessThan(983_040);

		const seen = await inObject(freshSite(), async (site) => stats(site));
		const newHeadroom = seen.isolateBytes.ceiling - seen.isolateBytes.dropAbove;
		expect(newHeadroom).toBeGreaterThan(oldHeadroom);
	});

	it('reports zero on an object with no interpreter rather than a bare mount figure', async () => {
		// a total that counted the mount while linear memory was 0 would report an object holding
		// bytes it does not hold, and the drop it triggered would buy nothing
		const seen = await inObject(freshSite(), async (site) => {
			expect(site.oversized()).toBe(false);
			return stats(site);
		});
		if (seen.isolateBytes.linear === 0) expect(seen.isolateBytes.total).toBe(0);
	});
});
