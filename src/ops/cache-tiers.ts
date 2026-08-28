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
	'KV',
	'DENY'
] as const;

export type CacheTier = (typeof CACHE_TIERS)[number];

const KNOWN: ReadonlySet<string> = new Set(CACHE_TIERS);

export function isCacheTier(value: unknown): value is CacheTier {
	return typeof value === 'string' && KNOWN.has(value.toUpperCase());
}
