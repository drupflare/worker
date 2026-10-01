/**
 * The opcache file cache the pack ships, written by `scripts/bake-opcache.ts`; undefined when none
 * was baked (the `pack` arm then mounts nothing). `systemId` is opcache's per-build directory, so
 * a cache from another binary is never read; `source` is `opcacheSourceKey()` at bake time.
 */
export const OPCACHE_PACK:
	| {
			systemId: string;
			files: number;
			bytes: number;
			source: string;
	  }
	| undefined = undefined;
