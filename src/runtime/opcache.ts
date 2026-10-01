/**
 * The opcache ini, as a seam with four arms: `file` (file cache is the only store), `shm` (shared
 * memory), `off` (the default) and `pack` (the shipped file cache, read-only, opt-in).
 *
 * A seam, not a config edit: the file cache is write-only on this runtime (MEMFS is per
 * instance, so every cold boot misses), but `file_cache_only=1` makes it opcache's only store, and
 * removing opcache ini blind aborted PHP 8.5 during module startup. `shm` may not work at all
 * (it wants `mmap`/`shmget`).
 * @module
 */
import { fnv1a32 } from '../util/hash';

/** the opcache arms, see the module doc */
export const OPCACHE_MODES = ['file', 'shm', 'off', 'pack'] as const;

/** one of {@link OPCACHE_MODES} */
export type OpcacheMode = (typeof OPCACHE_MODES)[number];

/**
 * The shipping arm: `off`. `file` costs 32 MiB of MEMFS for a cache nothing reads, and `shm`
 * (arena in PHP's linear memory, 191.25 MiB) is 63 MiB over the cap; gate-lane render wall clock
 * was parity (45 against 46 ms, n=5), a comparison and not a CPU cost.
 */
export const DEFAULT_OPCACHE_MODE: OpcacheMode = 'off';

/** an unknown value falls back to the shipping arm rather than producing an invalid ini */
export function opcacheMode(raw?: string): OpcacheMode {
	const value = String(raw ?? '').trim();
	return (OPCACHE_MODES as readonly string[]).includes(value)
		? (value as OpcacheMode)
		: DEFAULT_OPCACHE_MODE;
}

/**
 * The ini lines for one arm.
 *
 * The cache path is `/tmp`, not `/tmp/opcache`: opcache reads it during module startup, before the
 * mount sequence's `mkdirp` runs, and a missing directory aborts startup (MEMFS always has `/tmp`).
 */
export function opcacheIni(mode: OpcacheMode = DEFAULT_OPCACHE_MODE): string[] {
	if (mode === 'off') return ['opcache.enable=0', 'opcache.enable_cli=0'];

	const common = [
		'opcache.enable=1',
		'opcache.enable_cli=1',
		'opcache.validate_timestamps=0',
		'opcache.max_accelerated_files=20011',
		'opcache.optimization_level=0x7FFEBFFF'
	];
	if (mode === 'shm') return common;
	const file = [
		...common,
		'opcache.file_cache=/tmp',
		'opcache.file_cache_only=1',
		'opcache.file_cache_consistency_checks=0'
	];
	// the shipped cache is linked under /tmp after the mount; read-only keeps a miss from writing
	// the 30 MiB of MEMFS the `file` arm spends
	return mode === 'pack' ? [...file, 'opcache.file_cache_read_only=1'] : file;
}

/** the path the shipped cache is mounted at, beside the tree it was compiled from */
export const OPCACHE_PACK_ROOT = '/drupal/.opcache';

/**
 * What a shipped cache was compiled from: the packed driver and every locked package version.
 *
 * `validate_timestamps=0` never checks a script against its source, so the mount refuses a cache
 * whose key disagrees with the running tree. FNV-1a over the sorted versions (change detection).
 */
export function opcacheSourceKey(driverDigest: string, lock: Record<string, string>): string {
	const canonical = JSON.stringify(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)));
	return `${driverDigest}:${fnv1a32(canonical).toString(16).padStart(8, '0')}`;
}

/** whether the mount should take the shipped cache: `stale` is one compiled from other sources */
export function opcachePackState(
	pack: { source: string } | undefined,
	mode: OpcacheMode,
	lazyMount: boolean,
	sourceKey: string
): 'none' | 'stale' | 'usable' {
	if (pack === undefined || mode !== 'pack' || !lazyMount) return 'none';
	return pack.source === sourceKey ? 'usable' : 'stale';
}
