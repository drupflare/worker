import { describe, expect, it } from 'vitest';
import {
	agedServeAllowed,
	agedServeMaxMs,
	argon2Enabled,
	backgroundPhpHold,
	DEFAULT_MEMORY_CACHE_BINS,
	memoryCacheBins,
	memoryCacheMaxItems,
	migrateEngine,
	phpStringList,
	prefillDefault
} from '../../../src/do/levers';
import type { SiteEnv } from '../../../src/env';

const env = (vars: Record<string, unknown>) => vars as unknown as SiteEnv;

describe('the background PHP hold', () => {
	it('holds until the end of the settle window and then lets PHP run', () => {
		expect(backgroundPhpHold(1_000, 1_500, 60_000)).toBe(61_000);
		expect(backgroundPhpHold(1_000, 61_000, 60_000)).toBeUndefined();
	});

	it('does not hold without a boot time or with the hold turned off', () => {
		expect(backgroundPhpHold(undefined, 5, 60_000)).toBeUndefined();
		expect(backgroundPhpHold(1_000, 1_001, 0)).toBeUndefined();
	});
});

describe('prefill and argon2 defaults', () => {
	it('prefills on free and not on paid, and an explicit PREFILL wins either way', () => {
		expect(prefillDefault(env({}))).toBe(true);
		expect(prefillDefault(env({ PLAN: 'paid' }))).toBe(false);
		expect(prefillDefault(env({ PLAN: 'paid', PREFILL: '1' }))).toBe(true);
		expect(prefillDefault(env({ PREFILL: '0' }))).toBe(false);
	});

	it('argon2 is off unless the operator says 1', () => {
		expect(argon2Enabled(undefined)).toBe(false);
		expect(argon2Enabled(env({ ARGON2: '0' }))).toBe(false);
		expect(argon2Enabled(env({ ARGON2: '1' }))).toBe(true);
	});
});

describe('the in-memory cache bins', () => {
	it('takes the default when unset or blank and none switches them off', () => {
		expect(memoryCacheBins(env({}))).toEqual([...DEFAULT_MEMORY_CACHE_BINS]);
		expect(memoryCacheBins(env({ MEMORY_CACHE_BINS: '  ' }))).toEqual([
			...DEFAULT_MEMORY_CACHE_BINS
		]);
		expect(memoryCacheBins(env({ MEMORY_CACHE_BINS: 'None' }))).toEqual([]);
	});

	it('keeps only names that are safe to put in generated PHP', () => {
		expect(
			memoryCacheBins(env({ MEMORY_CACHE_BINS: 'menu, bad name,render,x;y,,ok_1' }))
		).toEqual(['menu', 'render', 'ok_1']);
	});

	it('caps the entries per bin at a positive whole number, else 64', () => {
		expect(memoryCacheMaxItems(env({}))).toBe(64);
		expect(memoryCacheMaxItems(env({ MEMORY_CACHE_MAX_ITEMS: '128.9' }))).toBe(128);
		expect(memoryCacheMaxItems(env({ MEMORY_CACHE_MAX_ITEMS: '-3' }))).toBe(64);
		expect(memoryCacheMaxItems(env({ MEMORY_CACHE_MAX_ITEMS: 'many' }))).toBe(64);
	});

	it('writes a PHP array literal of the names', () => {
		expect(phpStringList(['menu', 'render'])).toBe("['menu', 'render']");
		expect(phpStringList([])).toBe('[]');
	});
});

describe('serving a superseded page', () => {
	it('allows 60 s by default and honours 0 as off', () => {
		expect(agedServeMaxMs(env({}))).toBe(60_000);
		expect(agedServeMaxMs(env({ AGED_SERVE_MAX_MS: '0' }))).toBe(0);
		expect(agedServeMaxMs(env({ AGED_SERVE_MAX_MS: '1500.7' }))).toBe(1500);
		expect(agedServeMaxMs(env({ AGED_SERVE_MAX_MS: '-1' }))).toBe(60_000);
	});

	it('refuses a path under an operator NEVER_STALE entry and nothing else', () => {
		const e = env({ NEVER_STALE: '/cart, /checkout ,' });
		expect(agedServeAllowed('/cart', e)).toBe(false);
		expect(agedServeAllowed('/checkout/pay', e)).toBe(false);
		expect(agedServeAllowed('/cartoon', e)).toBe(true);
		expect(agedServeAllowed('/user/login', e)).toBe(true);
		expect(agedServeAllowed('/anything', env({}))).toBe(true);
	});
});

describe('the migration engine', () => {
	it('prefers the request parameter, then the env, and defaults to sql', () => {
		expect(migrateEngine(new URL('https://x/migrate?engine=php'))).toBe('php');
		expect(
			migrateEngine(new URL('https://x/migrate?engine=sql'), env({ MIGRATE_ENGINE: 'php' }))
		).toBe('sql');
		expect(
			migrateEngine(new URL('https://x/migrate?engine=bogus'), env({ MIGRATE_ENGINE: 'php' }))
		).toBe('php');
		expect(migrateEngine(undefined, env({}))).toBe('sql');
	});
});
