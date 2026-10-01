/**
 * Every value `x-cfw-cache` may carry, in one place.
 *
 * Its own module so a spec can import it without pulling `site-do.ts`, which instantiates the
 * interpreter at module scope. The e2e assertion drifted against a hand-written list twice.
 */
export const CACHE_TIERS = [
	'HIT',
	'MISS',
	'RENDER',
	'ASSEMBLED',
	// a shell proven against the visitor's own render (their harvest, not an assembly)
	'VERIFY',
	'EDGE',
	// the same page as EDGE held in the answering isolate, so no I/O (`anon-cached` spends
	// 7.9-14.0 ms of `x-worker-ms` on a 0.70 ms request)
	'MEM',
	'KV',
	// a compiled plan executed in the front worker with no object hop (the only authenticated tier)
	'PLAN',
	'DENY',
	// a replica that has not applied the required generation (a retry elsewhere can fix it)
	'STALE',
	// a stored page a bump superseded, served while its refill is queued (a 200, unlike `STALE`)
	'AGED',
	// a replica meeting work it may not do (retry on the primary); one word because the contract
	// scanner matches [A-Z]+
	'REFUSED',
	// a render that threw, answered 500; not MISS because a retry cannot fix it
	'ERROR'
] as const;

/** one of {@link CACHE_TIERS} */
export type CacheTier = (typeof CACHE_TIERS)[number];

const KNOWN: ReadonlySet<string> = new Set(CACHE_TIERS);

/** whether a header value names a cache tier (case-insensitive) */
export function isCacheTier(value: unknown): value is CacheTier {
	return typeof value === 'string' && KNOWN.has(value.toUpperCase());
}
