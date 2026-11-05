/**
 * The Worker's default cache, or a stand-in when the platform forbids it.
 *
 * A user Worker in a Workers for Platforms dispatch namespace cannot touch `caches.default`:
 * reading the property throws. `wrangler.managed.jsonc` sets `CACHE_API=off` for that case, and
 * every direct use goes through here, so the serving path never reads the property there. A read
 * that throws anyway (the variable missing, a namespace that changed) falls back the same way.
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

let warned = false;

/** `caches.default`, or the stand-in when `CACHE_API=off` or the platform refuses the property */
export function defaultCache(env?: { CACHE_API?: string }): Cache {
	if (!cacheApiEnabled(env)) return ABSENT;
	try {
		return caches.default;
	} catch (e) {
		// a namespace that forbids the cache and no `CACHE_API=off` to say so; once per isolate
		if (!warned) {
			warned = true;
			console.warn('caches.default is not available, serving without it', e);
		}
		return ABSENT;
	}
}
