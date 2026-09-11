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
	// a shell being proven against the visitor's own render; the body is their harvest, not an
	// assembly, so it is a different tier rather than an ASSEMBLED with a flag
	'VERIFY',
	'EDGE',
	// the same page as EDGE, held in the isolate that is already answering, so it costs no I/O at
	// all. `anon-cached` spends 7.9-14.0 ms of `x-worker-ms` on a 0.70 ms request, and the read
	// this replaces is the difference
	'MEM',
	'KV',
	// a compiled render plan executed in the front worker's own isolate, with no object hop; the
	// only tier that answers an AUTHENTICATED page without one
	'PLAN',
	'DENY',
	// a replica refusing because it has not applied the generation the caller requires; a distinct
	// tier because it is the only refusal a caller can fix by retrying somewhere else
	'STALE',
	// a stored page a bump has superseded, served while its refill is queued. NOT `STALE`, which is
	// the replica refusal above and a different event: this one is a 200 carrying real content
	'AGED',
	// a replica meeting work it may not do; the caller retries on the primary. Single word like every
	// other tier -- the contract scanner matches [A-Z]+ and a hyphen is invisible to it
	'REFUSED',
	// a render that THREW, answered 500 with the exception. Distinct from MISS because a retry
	// cannot fix it: the two used to be indistinguishable and the 503 invited the retry that
	// re-entered the same failing render
	'ERROR'
] as const;

export type CacheTier = (typeof CACHE_TIERS)[number];

const KNOWN: ReadonlySet<string> = new Set(CACHE_TIERS);

export function isCacheTier(value: unknown): value is CacheTier {
	return typeof value === 'string' && KNOWN.has(value.toUpperCase());
}
