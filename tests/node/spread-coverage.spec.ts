import { describe, expect, it } from 'vitest';
import { coveringSpread } from '../../scripts/measure/v101-arms';
import { affinityKey, chooseTarget } from '../../src/ops/replica-routing';

/**
 * The load generator has to reach every lane it claims to measure.
 *
 * `affinityKey()` keys a session-carrying request on the path and the router takes
 * `hash(key) % (lanes + 1)`, so a fixed path list covers whatever buckets it happens to land in. The
 * rig's previous eight paths covered 6 of 9 buckets at 8 lanes, 7 of 17 at 16 and 8 of 33 at 32 --
 * the idle lanes read as a pool that will not scale, which is indistinguishable from one that
 * cannot.
 *
 * Node lane: it imports a script from `scripts/`.
 */

/** the lane the shipping router would actually choose for an authenticated request to `path` */
function laneFor(path: string, lanes: number): number {
	return chooseTarget({
		site: 'm1',
		method: 'GET',
		replicas: lanes,
		pathname: '/serve',
		affinity: affinityKey({ session: 's', address: null, pathname: path })
	}).lane;
}

describe('the replica load generator covers the pool it measures', () => {
	const pool = ['/', '/node', ...Array.from({ length: 200 }, (_, i) => `/node/${i + 1}`)];

	it('agrees with the shipping router, so the copied hash cannot drift', () => {
		const { paths } = coveringSpread(16, pool);
		// every chosen path must land in a distinct lane by the ROUTER's own arithmetic
		const lanes = paths.map((p) => laneFor(p, 16));
		expect(new Set(lanes).size, 'two paths chose the same lane').toBe(paths.length);
	});

	it('fills every bucket from 1 lane to 48', () => {
		for (const lanes of [1, 2, 4, 8, 16, 32, 48]) {
			const c = coveringSpread(lanes, pool);
			expect(c.missing, `${lanes} lanes: ${c.missing.length} buckets get no load`).toEqual(
				[]
			);
			expect(c.covered).toBe(lanes + 1);
		}
	});

	/**
	 * The control. Without it the assertion above passes on any pool large enough by luck and says
	 * nothing about whether short pools are caught.
	 */
	it('reports the shortfall rather than covering it, on a pool that cannot', () => {
		const short = coveringSpread(32, ['/', '/node', '/rss.xml', '/user/login']);
		expect(short.covered).toBeLessThan(33);
		expect(short.missing.length).toBeGreaterThan(0);
		expect(short.covered + short.missing.length).toBe(33);
	});
});
