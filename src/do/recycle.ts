import { isMissingTable } from '../util/errors';
import { firstRow } from '../util/sql';
import { memoryOf, releaseGrowthCap } from './growth/cap';
import type { RecycleHost } from './host';
import { isolateAboveBytes, recycleAboveBytes } from './isolate';
import { PACK_INDEX_BYTES, lazyMountBytes } from './lazy-mount';
import type { Row } from './types';

/**
 * Linear memory right now, or 0 where there is nothing to read (`this.php` can be a
 * `stubRender()` stub with no `binary`).
 */
export function heapNow(host: RecycleHost): number {
	const binary = host.php?.binary;
	if (!binary) return 0;
	return host.heapBytes(binary)?.byteLength ?? 0;
}

/**
 * The whole isolate's demand: wasm linear memory plus the JS-side bytes the mount holds (the
 * pack blob and in-memory fs arrays share the 128 MiB budget).
 */
export function isolateNow(host: RecycleHost): number {
	const linear = host.heapNow();
	if (linear === 0) return 0;
	const lazy = lazyMountBytes(host.mountInfo);
	return linear + lazy.blob + lazy.resident + (lazy.blob > 0 ? PACK_INDEX_BYTES : 0);
}

/**
 * Whether this object should drop its interpreter at the next safe point; either threshold
 * fires.
 *
 * Only once the heap has grown since the boot (a reused memory starts large and a drop cannot
 * shrink it, else it would drop every invocation). The batch guard reads this too.
 */
export function oversized(host: RecycleHost): boolean {
	const linear = host.heapNow();
	if (linear <= host.bootLinear) return false;
	return (
		linear >= recycleAboveBytes(host.env) || host.isolateNow() >= isolateAboveBytes(host.env)
	);
}

/**
 * Drops the interpreter, but only one with a `binary` (a `stubRender()` stub holds no heap and
 * would be lost).
 */
export function dropInterpreter(host: RecycleHost): void {
	if (!host.php?.binary) return;
	// a one-shot interpreter's writes are judged as it goes
	host.php.mysql?.endRun?.();
	releaseGrowthCap(memoryOf(host.php.binary));
	host.php = undefined;
}

/**
 * Drops the interpreter when linear memory has climbed too close to the isolate limit.
 *
 * PHP returns nothing under `USE_ZEND_ALLOC=0`, so demand is cumulative; past 128 MiB the edge
 * resets the isolate and every in-flight request. Called between invocations only (a
 * mid-request drop holds both heaps until collection). A ceiling check; a trend misses a
 * workload arriving high.
 */
export function recycleIfOversized(host: RecycleHost, reason: 'request' | 'alarm'): boolean {
	if (!host.php) return false;
	const bytes = host.heapNow();
	const rebuild = host.rebuildBoot;
	// both thresholds, as oversized() reads them (linear memory alone left the isolate past
	// its own)
	if (!host.oversized() && !rebuild) return false;
	host.dropInterpreter();
	host.rebuildBoot = false;
	host.lastRecycle = { at: host.nowMs(), bytes, reason, ...(rebuild ? { rebuild } : {}) };
	host.recycles = (host.recycles ?? 0) + 1;
	return true;
}

/** drops the interpreter on an owner's call; false when none is resident to drop */
export function recycleForOwner(host: RecycleHost): boolean {
	if (!host.php?.binary) return false;
	host.lastRecycle = { at: host.nowMs(), bytes: host.heapNow(), reason: 'owner' };
	host.dropInterpreter();
	host.recycles = (host.recycles ?? 0) + 1;
	return true;
}

/** whether the next kernel boot has to rebuild the container; unreadable reads as no */
export function containerMissing(host: RecycleHost): boolean {
	try {
		const row = firstRow(
			host.sql.exec<Row<{ n: number }>>('SELECT COUNT(*) AS n FROM cache_container')
		);
		return Number(row?.n ?? 0) === 0;
	} catch (e) {
		if (!isMissingTable(e)) host.noteError('containerMissing', e);
		return false;
	}
}

/** drops the interpreter after a request that carried a file; see `carriesUpload()` */
export function recycleAfterUpload(host: RecycleHost): void {
	if (!host.uploadSeen) return;
	host.uploadSeen = false;
	if (!host.php) return;
	host.lastRecycle = { at: host.nowMs(), bytes: host.heapNow(), reason: 'upload' };
	host.php = undefined;
	host.recycles = (host.recycles ?? 0) + 1;
}
