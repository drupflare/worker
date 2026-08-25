import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CACHE_TIERS, isCacheTier } from '../../src/ops/cache-tiers.js';

/**
 * The `x-cfw-cache` contract, guarded against the source rather than against a hand-written list.
 *
 * A spec that enumerates the tiers by hand goes stale the moment a new one is emitted, and that is
 * not hypothetical: `RENDER`, `ASSEMBLED` and `KV` were all shipping while the e2e assertion listed
 * seven values and none of them.
 */

const SOURCES = ['src/site.ts', 'src/site-do.ts'];
const LITERAL = /'x-cfw-cache':\s*'([A-Z]+)'/g;
const SET_CALL = /set\('x-cfw-cache',\s*'([A-Z]+)'\)/g;
// `pageResponse()` takes the tier as an argument, so those never appear as a header literal
const PAGE_RESPONSE = /pageResponse\(\s*\w+,\s*'([A-Z]+)'/g;

function tiersInSource(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const file of SOURCES) {
		const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
		for (const re of [LITERAL, SET_CALL, PAGE_RESPONSE]) {
			re.lastIndex = 0;
			for (const m of text.matchAll(re)) {
				const tier = m[1] as string;
				found.set(tier, [...(found.get(tier) ?? []), file]);
			}
		}
	}
	return found;
}

describe('the cache-tier contract', () => {
	it('finds tiers in the source at all, or it is asserting nothing', () => {
		expect(tiersInSource().size).toBeGreaterThan(3);
	});

	it('every tier the source emits is declared', () => {
		for (const [tier, files] of tiersInSource()) {
			expect(
				CACHE_TIERS as readonly string[],
				`${tier} emitted by ${files.join(', ')}`
			).toContain(tier);
		}
	});

	it('every declared tier is emitted by something', () => {
		const emitted = tiersInSource();
		for (const tier of CACHE_TIERS) {
			expect(emitted.has(tier), `${tier} is declared and nothing emits it`).toBe(true);
		}
	});

	it('recognises a tier case-insensitively and refuses anything else', () => {
		expect(isCacheTier('render')).toBe(true);
		expect(isCacheTier('RENDER')).toBe(true);
		expect(isCacheTier('RENDERED')).toBe(false);
		expect(isCacheTier(null)).toBe(false);
		expect(isCacheTier(7)).toBe(false);
	});
});

describe('the generation header', () => {
	/**
	 * `pageResponse()` documents `x-cfw-generation` as being on every serve response, and the two
	 * hand-built header sets omitted it. `Number(null)` is 0, so an invalidation test read
	 * "0 is not greater than 0" rather than "the header is missing".
	 */
	it('is set on every response that names a cache tier', () => {
		const text = readFileSync(new URL('../../src/site-do.ts', import.meta.url), 'utf8');
		const blocks = text.split(/'x-cfw-cache':/).slice(1);
		expect(blocks.length).toBeGreaterThan(2);
		for (const block of blocks) {
			const window = block.slice(0, 600);
			const tier = /^\s*'([A-Z]+)'/.exec(block)?.[1] ?? '?';
			expect(window, `the ${tier} response omits x-cfw-generation`).toContain(
				'x-cfw-generation'
			);
		}
	});
});
