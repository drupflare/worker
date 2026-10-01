import {
	captureHandles,
	ensureHeapTables,
	latestSnapshotMeta,
	snapshotPageIndex
} from '../../db/heap-store';
import { BOOT_KERNEL, BOOT_PHASES, type BootPhase, bootPhaseFragment } from '../../drupal/site-php';
import { opcacheMode } from '../../runtime/opcache';
import type { SitePhpDurableObject } from '../../site-do';
import { DIAG_BRIDGE_PHP } from '../../site/generated/assets';
import { errorMessage } from '../../util/errors';
import { phpScript } from '../../util/php';
import { jsonError } from '../../util/reply';
import { heapRestoreChunkBudget, heapSnapshotEnabled } from '../alarm';
import { delegatingHandleTable } from '../heap-image';
import { HEAP_IMAGE_ATTEMPTS_KEY, HEAP_IMAGE_KEY } from '../keys';
import type { Payload } from '../types';

/** lists (`op=list`) or reads (`op=read&path=`) the opcache `.bin` files under /tmp */
export async function opcache(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const { binary } = await site.ensurePhp();
	const fs = binary.FS as unknown as {
		readdir(p: string): string[];
		stat(p: string): { mode: number; size: number };
		isDir(mode: number): boolean;
		readFile(p: string): Uint8Array;
	};
	if (url.searchParams.get('op') === 'read') {
		const path = url.searchParams.get('path') ?? '';
		if (!path.startsWith('/tmp/') || path.includes('..') || !path.endsWith('.bin')) {
			return jsonError('a .bin path under /tmp', 400);
		}
		return new Response(fs.readFile(path), {
			headers: { 'content-type': 'application/octet-stream' }
		});
	}
	const files: { path: string; bytes: number }[] = [];
	const walk = (dir: string) => {
		for (const name of fs.readdir(dir)) {
			if (name === '.' || name === '..') continue;
			const path = `${dir}/${name}`;
			const st = fs.stat(path);
			if (fs.isDir(st.mode)) walk(path);
			else if (path.endsWith('.bin')) files.push({ path, bytes: st.size });
		}
	};
	walk('/tmp');
	return Response.json({
		ok: true,
		mode: opcacheMode(site.env?.OPCACHE_MODE),
		files
	});
}

/** heap snapshot, restore and the bridge check that stops a false pass */
export async function heap(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const op = url.searchParams.get('op') ?? 'status';
	if (op === 'snapshot') {
		// `fresh=1` refuses to snapshot a restored heap; a restored boot never mints a vrzno
		// handle, so the snapshot would inherit an empty handle table and look fine
		if (url.searchParams.get('fresh') === '1') {
			site.php = undefined;
			site.heapRestoreCursor = undefined;
			site.heapRestore = {
				restored: false,
				reason: 'skipped for a fresh snapshot'
			};
			await site.ensurePhp({ skipRestore: true });
		}
		// boot the kernel first; a snapshot taken after `ensurePhp()` alone holds the wrong
		// lifecycle point (47 non-zero pages, no open descriptors)
		const booted = await site.runJson(BOOT_KERNEL);
		const askedChunk = Number(url.searchParams.get('chunkBytes') ?? 0);
		const snap = await site.snapshotHeap({
			chunkBytes: askedChunk > 0 ? askedChunk : undefined
		});
		return Response.json({ booted, snapshot: snap });
	}
	if (op === 'bridge') {
		// a byte comparison proves nothing (a restored heap renders cached bytes with the bridge
		// dead), so force a host call to round-trip through `vrzno_env()`
		const out = await site.runJson(phpScript(DIAG_BRIDGE_PHP));
		return Response.json({ heapRestore: site.heapRestore ?? null, hostCall: out });
	}
	if (op === 'handles') {
		// names of the live vrzno handles; a restore needs each one nameable in a fresh instance
		const { binary } = await site.ensurePhp();
		const live = captureHandles(
			site.handleIndex(binary),
			binary as unknown as Record<string, unknown>
		);
		ensureHeapTables(site.sql);
		const meta = latestSnapshotMeta(site.sql, String(site.heapGeneration() ?? ''));
		const stored = meta ? snapshotPageIndex(site.sql, meta.id) : undefined;
		return Response.json({
			tablePresent: site.handleIndex(binary) !== undefined,
			live: live.handles,
			unnameable: live.unnameable,
			stored: stored?.handles ?? null,
			liveNextId: site.handleIndex(binary)?.id ?? null,
			heapRestore: site.heapRestore ?? null
		});
	}
	if (op === 'trace') {
		// `Module.targets.get` is non-writable, so wrap the object one level up (the glue re-reads
		// `Module.targets` at each call site)
		const { binary } = await site.ensurePhp();
		const table = site.handleIndex(binary);
		if (!table) return Response.json({ error: 'no vrzno handle table' });
		const misses: number[] = [];
		const hits: Array<{ id: number; kind: string }> = [];
		const wrapper = delegatingHandleTable(table, {
			onGet: (id, v) => {
				if (v === undefined) {
					if (!misses.includes(Number(id))) misses.push(Number(id));
				} else if (hits.length < 24) {
					hits.push({ id: Number(id), kind: typeof v });
				}
			}
		});
		(binary as unknown as { targets: unknown }).targets = wrapper;
		let render: Payload;
		try {
			render = (await site.fillOne(
				url.searchParams.get('path') ?? '/'
			)) as unknown as Payload;
		} catch (e) {
			render = { threw: errorMessage(e) };
		} finally {
			(binary as unknown as { targets: unknown }).targets = table;
		}
		return Response.json({
			misses,
			hits,
			nextId: table.id,
			live: captureHandles(table, binary as unknown as Record<string, unknown>),
			render,
			heapRestore: site.heapRestore ?? null
		});
	}
	if (op === 'corrupt') {
		// fault injection so the digest refusal is reachable from a deployed worker
		// (diagnostics-gated, like /php)
		ensureHeapTables(site.sql);
		const flipped = site.corruptStoredChunk(Number(url.searchParams.get('chunk') ?? 0));
		return Response.json(flipped);
	}
	if (op === 'restore') {
		// drop the interpreter so the next `ensurePhp()` takes the cold-object restore branch
		site.php = undefined;
		site.heapRestoreCursor = undefined;
		site.heapRestore = undefined;
		let booted: Payload;
		try {
			await site.ensurePhp();
			booted = { ok: true };
		} catch (e) {
			booted = { ok: false, error: errorMessage(e) };
		}
		return Response.json({ booted, heapRestore: site.heapRestore ?? null });
	}
	ensureHeapTables(site.sql);
	return Response.json({
		heapRestore: site.heapRestore ?? null,
		heapRestoreCursor: site.heapRestoreCursor ?? null,
		packGeneration: site.packGeneration() ?? null,
		heapGeneration: site.heapGeneration() ?? null,
		latest: latestSnapshotMeta(site.sql, String(site.heapGeneration() ?? '')) ?? null,
		enabled: heapSnapshotEnabled(site.env),
		chunkBudget: heapRestoreChunkBudget(site.env) ?? 'all',
		// what the alarm's producer has done, so the default can be checked on a deployed site
		imagedGeneration: site.metaGet(HEAP_IMAGE_KEY),
		imageAttempts: site.metaGet(HEAP_IMAGE_ATTEMPTS_KEY) ?? null,
		lastHeapImage: site.lastHeapImage ?? null,
		// wasm linear memory now (what `INITIAL_MEMORY` governs); null when PHP has not booted,
		// since 0 would read as a measured empty heap
		linearMemoryBytes: site.php ? (site.heapBytes(site.php.binary)?.byteLength ?? null) : null
	});
}

/**
 * One boot phase per invocation; `?phase=kernel-boot` runs every phase up to that one. Cost is the
 * `cpuTime` difference between phases from `wrangler tail` (in-isolate clocks read 0 there).
 */
export async function bootphase(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const requested = (url.searchParams.get('phase') ?? 'render') as BootPhase;
	if (!BOOT_PHASES.includes(requested)) {
		return Response.json(
			{ error: `unknown phase`, phase: requested, phases: BOOT_PHASES },
			{ status: 400 }
		);
	}
	// drop the interpreter; `BOOT_KERNEL` memoises the kernel into `$GLOBALS`, so a warm object
	// measures nothing
	site.php = undefined;
	site.heapRestoreCursor = undefined;
	const t0 = Date.now();
	const out = await site.runJson(bootPhaseFragment(requested));
	return Response.json({
		phase: requested,
		phases: BOOT_PHASES,
		result: out,
		// present so a local run is orderable, and useless on the edge by design
		localElapsedMs: Date.now() - t0,
		mountInfo: site.mountInfo ?? null,
		howToRead:
			'deploy, then subtract consecutive cpuTime figures from wrangler tail; ' +
			'container-read and container-unserialize both baseline against kernel-new'
	});
}
