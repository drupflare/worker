import { describe, expect, it } from 'vitest';
import {
	absorptionCeiling,
	absorptionForModel,
	absorptionFromCounters,
	DEFAULT_EDGE_TTL_SECONDS,
	keyIsDefaultCacheable,
	measureMirrorEmission
} from '../../scripts/measure/cdn-absorption';
import { DEFAULT_MIX, optimalOffWorker } from '../../scripts/measure/free-envelope';

/**
 * The absorption input `optimalOffWorker()` takes, and what is actually knowable about it.
 *
 * The model defaulted it to zero and called it the one number nobody had measured. The emission half
 * IS measurable without traffic, and it says zero is the answer rather than the gap.
 */

describe('what the mirror emits', () => {
	it('writes .html keys with no cache-control, which the CDN will not cache', async () => {
		const emission = await measureMirrorEmission(['/', '/about', '/news/']);
		expect(emission).toHaveLength(3);
		for (const object of emission) {
			expect(object.key, object.key).toMatch(/\.html$/);
			expect(object.cacheControl, object.key).toBeNull();
			expect(object.defaultCacheable, object.key).toBe(false);
		}
		// a directory-style path becomes index.html so a static host resolves it
		expect(emission.map((e) => e.key)).toContain('p/measure/7/news/index.html');
	});

	/** THE CONTROL: the predicate has to say yes to something, or the case above is vacuous */
	it('calls the extensions Cloudflare documents cacheable', () => {
		for (const key of ['p/s/1/x.css', 'p/s/1/f.woff2', 'p/s/1/a.js', 'p/s/1/i.png']) {
			expect(keyIsDefaultCacheable(key), key).toBe(true);
		}
		for (const key of ['p/s/1/x.html', 'p/s/1/api.json', 'p/s/1/noextension']) {
			expect(keyIsDefaultCacheable(key), key).toBe(false);
		}
	});
});

describe('absorption from the operator counters', () => {
	it('is the share of hostname requests that never became a Class B operation', () => {
		expect(absorptionFromCounters(1_000, 250).absorption).toBeCloseTo(0.75, 10);
		expect(absorptionFromCounters(1_000, 0).absorption).toBe(1);
		expect(absorptionFromCounters(1_000, 1_000).absorption).toBe(0);
	});

	it('flags counters that cannot both be right rather than clamping quietly', () => {
		const out = absorptionFromCounters(100, 400);
		expect(out.inconsistent).toBe(true);
		expect(out.absorption).toBe(0);
	});

	it('answers zero on no traffic instead of dividing by it', () => {
		expect(absorptionFromCounters(0, 0).absorption).toBe(0);
	});
});

describe('the ceiling the key structure imposes', () => {
	const base = {
		requestsPerDay: 100_000,
		distinctPaths: 100,
		generationsPerDay: 1,
		edgeTtlSeconds: 86_400,
		independentCaches: 1
	};

	it('charges one origin fetch per key per cache', () => {
		const out = absorptionCeiling(base);
		expect(out.originFetchesPerDay).toBe(100);
		expect(out.refreshesPerKeyLifetime).toBe(1);
		expect(out.absorption).toBeCloseTo(0.999, 10);
	});

	it('falls as the caches that must each fetch for themselves multiply', () => {
		const one = absorptionCeiling(base).absorption;
		const many = absorptionCeiling({ ...base, independentCaches: 50 }).absorption;
		expect(many).toBeLessThan(one);
		expect(absorptionCeiling({ ...base, independentCaches: 50 }).originFetchesPerDay).toBe(
			5_000
		);
	});

	/** the generation is IN the key, so an invalidation replaces the key set and every cache re-fetches */
	it('falls as invalidation mints new keys', () => {
		const quiet = absorptionCeiling(base).absorption;
		const busy = absorptionCeiling({ ...base, generationsPerDay: 24 }).absorption;
		expect(busy).toBeLessThan(quiet);
	});

	it('charges a refresh per edge TTL inside one key lifetime', () => {
		const out = absorptionCeiling({ ...base, edgeTtlSeconds: DEFAULT_EDGE_TTL_SECONDS });
		expect(out.refreshesPerKeyLifetime).toBe(12);
		expect(out.originFetchesPerDay).toBe(1_200);
	});

	it('never reports more absorption than the traffic allows', () => {
		const out = absorptionCeiling({ ...base, requestsPerDay: 10 });
		expect(out.absorption).toBe(0);
	});
});

describe('what the model is handed', () => {
	it('reports zero and names the reason on the shipping emission', async () => {
		const emission = await measureMirrorEmission(['/']);
		const chosen = absorptionForModel({
			emission,
			ceiling: absorptionCeiling({
				requestsPerDay: 100_000,
				distinctPaths: 10,
				generationsPerDay: 1,
				independentCaches: 1
			})
		});
		expect(chosen).toEqual({ absorption: 0, source: 'not-cacheable' });
	});

	/**
	 * COUNTERS BEAT THE INFERENCE. A zone Cache Rule is invisible from here, so a site that has one
	 * would otherwise be told its measured absorption is zero.
	 */
	it('prefers the operator counters over what the origin sends', async () => {
		const emission = await measureMirrorEmission(['/']);
		const chosen = absorptionForModel({
			emission,
			observed: absorptionFromCounters(1_000, 100)
		});
		expect(chosen.source).toBe('observed');
		expect(chosen.absorption).toBeCloseTo(0.9, 10);
	});

	it('feeds optimalOffWorker, and the answer moves with it', () => {
		const off = optimalOffWorker(DEFAULT_MIX, { cdnAbsorption: 0 });
		const on = optimalOffWorker(DEFAULT_MIX, { cdnAbsorption: 0.99 });
		expect(off.boundBy).toBe('worker');
		expect(on.viewsPerDay).toBeGreaterThan(off.viewsPerDay);
		expect(on.share).toBeGreaterThan(off.share);
	});
});
