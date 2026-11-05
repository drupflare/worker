import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheApiEnabled, defaultCache } from '../../src/ops/cache-api';

afterEach(() => vi.unstubAllGlobals());

describe('the default cache stand-in', () => {
	it('is on unless the variable is exactly off', () => {
		expect(cacheApiEnabled()).toBe(true);
		expect(cacheApiEnabled({})).toBe(true);
		expect(cacheApiEnabled({ CACHE_API: '1' })).toBe(true);
		expect(cacheApiEnabled({ CACHE_API: ' OFF ' })).toBe(false);
	});

	it('never reads the platform cache when off', async () => {
		const read = vi.fn(() => {
			throw new Error('This Worker is not permitted to access the default cache.');
		});
		vi.stubGlobal('caches', {
			get default() {
				return read();
			}
		});
		const cache = defaultCache({ CACHE_API: 'off' });
		expect(read).not.toHaveBeenCalled();
		expect(await cache.match(new Request('https://a.test/'))).toBeUndefined();
		await cache.put(new Request('https://a.test/'), new Response('x'));
		expect(await cache.delete(new Request('https://a.test/'))).toBe(false);
	});

	it('returns the platform cache otherwise', () => {
		const platform = { match: vi.fn() };
		vi.stubGlobal('caches', { default: platform });
		expect(defaultCache({})).toBe(platform);
	});
});
