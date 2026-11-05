/**
 * The Worker's default cache, or a stand-in when the platform forbids it.
 *
 * A user Worker in a Workers for Platforms dispatch namespace cannot touch `caches.default`:
 * reading the property throws. `wrangler.managed.jsonc` sets `CACHE_API=off` for that case, and
 * every direct use goes through here, so the serving path never reads the property there.
 * The stand-in misses every read and drops every write, so the next tier (the KV page tier, then
 * the object) answers.
 */

const ABSENT: Cache = {
	match: async () => undefined,
	put: async () => undefined,
	delete: async () => false,
	add: async () => undefined,
	addAll: async () => undefined,
	keys: async () => [],
	matchAll: async () => []
} as unknown as Cache;

/** whether the Cache API may be read; only an explicit `off` turns it off */
export function cacheApiEnabled(env?: { CACHE_API?: string }): boolean {
	return env?.CACHE_API?.trim().toLowerCase() !== 'off';
}

/** `caches.default`, or the stand-in when `CACHE_API=off` */
export function defaultCache(env?: { CACHE_API?: string }): Cache {
	return cacheApiEnabled(env) ? caches.default : ABSENT;
}
