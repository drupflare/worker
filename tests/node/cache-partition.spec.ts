import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Workers Cache feature is keyed WITHOUT the host, and this product is multi-tenant by host.
 *
 * `developers.cloudflare.com/workers/cache/cache-keys/`: "The cache key does not include the host, so
 * a request to `/api/users/42` hits the same cached entry whether it came in through
 * `api.example.com`, `api.example.net`, a service binding, or a `workers.dev` URL." Every site here
 * serves `/`, so enabling `cache` in a shipping config serves one site's front page to another site's
 * visitors.
 *
 * **AND ZONE CACHE RULES CANNOT ADD THE HOST BACK**, which is what makes this structural rather than
 * a tuning gap: "No zone configuration for caching applies to Workers Caching. Cache Rules, Cache
 * Response Rules, Page Rules, cache level settings ... have no effect on a Worker's cache." The zone
 * cache-key documentation DOES put the host in the key, and reading it as evidence about this feature
 * is the mistake to avoid -- they are different products and only one of them is host-blind.
 *
 * Two further reasons it is not the serving lever it looks like, both from Cloudflare's own pages. A
 * hit skips Worker EXECUTION but is still "billed at the standard Workers request rate", so the
 * 100,000/day meter does not move; and enabling it "bills requests that are normally free: static
 * asset requests and worker-to-worker invocations", so it is a net INCREASE in metered requests.
 * What it does buy is CPU, which is not a meter this project is bound by.
 *
 * `caches.default` is a DIFFERENT mechanism and is safe: `cacheKey()` in `src/site.ts` builds a key
 * carrying both the origin and the site id, so neither half of the pair can collide. This guards only
 * the wrangler feature, which no key of ours can reach.
 */

const CONFIGS = ['wrangler.jsonc', 'wrangler.bench.jsonc'] as const;

/** jsonc with line comments stripped; the same reader `deploy-build.spec.ts` uses */
function config(path: string): Record<string, unknown> {
	const text = readFileSync(path, 'utf8')
		.split('\n')
		.map((l) => l.replace(/^\s*\/\/.*$/, ''))
		.join('\n');
	return JSON.parse(text) as Record<string, unknown>;
}

describe('the shipping configs do not enable an unpartitioned cache', () => {
	for (const path of CONFIGS) {
		it(`${path} enables Workers Cache nowhere`, () => {
			const parsed = config(path);
			// the whole block rather than its `enabled` flag: a future default-on would be missed
			// by a check that only reads the spelling it knows about today
			expect(
				parsed.cache,
				`${path} enables Workers Cache, which is keyed without the host and would serve ` +
					'one site to another. Partition it with a cf.cacheKey carrying the site id first.'
			).toBeUndefined();

			// `exports: { default: { cache: {...} } }` is the same feature by another spelling,
			// and the top-level read cannot see it
			const exports = (parsed.exports ?? {}) as Record<string, { cache?: unknown }>;
			for (const [name, entry] of Object.entries(exports)) {
				expect(
					entry?.cache,
					`${path} enables Workers Cache on the \`${name}\` entrypoint`
				).toBeUndefined();
			}
		});
	}

	it('keeps the site id in the page cache key, which is what makes caches.default safe', () => {
		// THE KEY ARRAY, NOT THE DECLARATION. Reading the whole arrow function matched `site` in
		// the PARAMETER LIST, so deleting it from the key left this green -- the exact defect the
		// file guards against, in the guard itself
		const src = readFileSync('src/site.ts', 'utf8');
		const parts = src.match(/const pageKey =[\s\S]*?cacheKey\(\s*origin,\s*\[([^\]]*)\]/);
		expect(parts?.[1], 'pageKey() not found in src/site.ts').toBeTruthy();
		const key = parts?.[1] ?? '';
		expect(
			key,
			'the page cache key dropped the site id, so two sites now share entries'
		).toMatch(/\bsite\b/);
		expect(key).toMatch(/\bgeneration\b/);
	});
});
