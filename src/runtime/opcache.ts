/**
 * The opcache ini, as a seam with three arms.
 *
 * ## Why this is a seam and not a config edit
 *
 * The file cache is WRITE-ONLY on this runtime, measured on the edge: 112 `.bin` files after a
 * kernel boot and 1,301 across 425 directories after one render, and nothing ever reads them back.
 * MEMFS belongs to the interpreter instance, so every cold boot starts with an empty `/tmp` and
 * every lookup is a guaranteed miss; within one instance, three entries deleted by hand did not
 * reappear across three further renders.
 *
 * It is write-only for want of persistence, not of reading: planted into a fresh instance before it
 * boots, the 92 files a kernel boot writes are all read and none recompiled, against a control that
 * writes all 92 (measured 2026-09-24 in the workers pool). A cache shipped with the pack would load.
 *
 * That is an obvious thing to delete and it must not be deleted blind. `file_cache_only=1` makes the
 * file cache opcache's ONLY backing store, so removing the path may disable opcache rather than
 * merely stop the writes -- and removing opcache ini blind is exactly what produced the 8.5
 * `exit(-2)`, which aborted during MODULE STARTUP on a deployed worker with no route logic reached.
 *
 * ## The arms
 *
 * | mode     | what it is                                             |
 * | -------- | ------------------------------------------------------ |
 * | `file`   | opcache on, file cache is the only store               |
 * | `shm`    | opcache on, no file cache, shared memory as the store  |
 * | `off`    | opcache disabled entirely                              |
 * | `pack`   | the file cache the pack ships, read-only               |
 *
 * `pack` is opt-in, and `off` stays the default. Measured 2026-09-25 on two deployed paid workers,
 * one cold first render per minute, then again with the levers swapped between the deploys: object
 * cpuTime per cold render (per-minute p90) read ~820-1,020 ms on `pack` against ~1,800 on `off`, and
 * 1,204-1,524 against 1,636-2,236 after the swap, so the CPU saving follows the lever. Visitor wall
 * did not: p50 1,482 against 2,291, then 2,341 against 2,286 (n=8 each), because the deploy moves it
 * more than the lever does. The layer is 1,839 scripts and 8,581,446 bytes, and it holds that much
 * more of the isolate. `scripts/bake-opcache.ts` builds it.
 *
 * `shm` is the arm with a real chance of not working at all. opcache's shared-memory backend wants
 * `mmap`/`shmget`, which is why `file_cache_only=1` is there in the first place; if the arm aborts,
 * that IS the measurement and it is what justifies keeping the write-only file cache.
 */

export const OPCACHE_MODES = ['file', 'shm', 'off', 'pack'] as const;

export type OpcacheMode = (typeof OPCACHE_MODES)[number];

/**
 * The shipping arm, and it is `off` as of 2026-08-23.
 *
 * MEASURED, one object per arm, boot plus one real fill on the shipping 8.5 interpreter:
 *
 * | arm    | `.bin` files | MEMFS bytes | linear memory | `opcache_get_status()` | median render |
 * | ------ | ------------ | ----------- | ------------- | ---------------------- | ------------- |
 * | `file` | 2,346        | 32,141,312  | 105,709,568   | **enabled: false**     | 46 ms         |
 * | `shm`  | 0            | 0           | 200,540,160   | enabled: true          | 42 ms         |
 * | `off`  | 0            | 0           | 100,663,296   | --                     | 45 ms         |
 *
 * `file` reports opcache DISABLED -- `file_cache_only=1` turns the shared-memory backend off, which
 * is what the status API answers about -- and writes 30.65 MiB into MEMFS for a cache nothing ever
 * reads. It buys nothing measurable and costs 5,046,272 bytes of linear memory plus 32,141,312 of
 * MEMFS, both inside the same 128 MiB isolate.
 *
 * `shm` is the arm that looks best on every column except the one that binds: its arena is PHP's
 * linear memory, taking it to 191.25 MiB, 63 MiB over the cap. It cannot ship.
 *
 * The render figures are GATE-LANE WALL CLOCK and a comparison, never a CPU cost (RULE 0). 45
 * against 46 at n=5 is parity; a compile-CPU penalty large enough to justify 37 MiB would not hide
 * in 1 ms.
 */
export const DEFAULT_OPCACHE_MODE: OpcacheMode = 'off';

/** an unknown value falls back to the shipping arm rather than producing an invalid ini */
export function opcacheMode(raw?: string | null): OpcacheMode {
	const value = String(raw ?? '').trim();
	return (OPCACHE_MODES as readonly string[]).includes(value)
		? (value as OpcacheMode)
		: DEFAULT_OPCACHE_MODE;
}

/**
 * The ini lines for one arm.
 *
 * `/tmp`, NOT `/tmp/opcache`, and the ordering is the whole reason. opcache reads this during PHP's
 * MODULE STARTUP, which happens inside the binary's constructor; the `mkdirp(FS, '/tmp/opcache')` in
 * the mount sequence runs later, so on a binary that HAS opcache the directory does not exist yet
 * and startup aborts. Emscripten's MEMFS always creates `/tmp`.
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
	// the shipped cache is linked under /tmp after the mount, and read-only keeps a miss from writing
	// the 30 MiB of MEMFS the `file` arm spends
	return mode === 'pack' ? [...file, 'opcache.file_cache_read_only=1'] : file;
}

/** the path the shipped cache is mounted at, beside the tree it was compiled from */
export const OPCACHE_PACK_ROOT = '/drupal/.opcache';

/**
 * What a shipped cache was compiled FROM: the packed driver and every locked package version.
 *
 * `validate_timestamps=0` means a cached script is never checked against its source, so a cache
 * baked before a driver or composer change would run the old code. The mount refuses a cache whose
 * key disagrees with the running tree. FNV-1a over the sorted versions; change detection only.
 */
export function opcacheSourceKey(driverDigest: string, lock: Record<string, string>): string {
	const canonical = JSON.stringify(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)));
	let h = 0x811c9dc5;
	for (let i = 0; i < canonical.length; i++) {
		h ^= canonical.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${driverDigest}:${h.toString(16).padStart(8, '0')}`;
}

/** whether the mount should take the shipped cache: `stale` is one compiled from other sources */
export function opcachePackState(
	pack: { source: string } | null,
	mode: OpcacheMode,
	lazyMount: boolean,
	sourceKey: string
): 'none' | 'stale' | 'usable' {
	if (pack === null || mode !== 'pack' || !lazyMount) return 'none';
	return pack.source === sourceKey ? 'usable' : 'stale';
}
