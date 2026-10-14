import { describe, expect, it } from 'vitest';
import { poissonArrivals, summarise } from '../../scripts/measure/floor-rig';

describe('the floor rig', () => {
	it('draws arrivals at the requested mean rate, in order and inside the window', () => {
		const at = poissonArrivals(50, 200);
		expect(at.length / 200).toBeGreaterThan(45);
		expect(at.length / 200).toBeLessThan(55);
		expect(at.every((t, i) => i === 0 || t >= at[i - 1]!)).toBe(true);
		expect(at[at.length - 1]!).toBeLessThan(200_000);
	});

	it('counts errors and cache hits and keeps them out of the latency quantiles', () => {
		const s = summarise([
			{ ms: 10, serverMs: 8, status: 200, hit: false },
			{ ms: 20, serverMs: 18, status: 200, hit: true },
			{ ms: 5, serverMs: null, status: 0, hit: false }
		]);
		expect(s.errors).toBe(1);
		expect(s.cacheHits).toBe(1);
		expect(s.clientP95).toBe(20);
	});
});
