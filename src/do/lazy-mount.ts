import type { DriverMountResult, LazyMountResult, MountResult } from '@drupflare/cartridge/fs';

/** bytes of installed-module source held resident before a clean file is dropped again */
export const INSTALLED_FS_BUDGET_BYTES = 2 * 1024 * 1024;

/** a MEMFS node whose contents come from its `cfw_module_file` row on first open */
export type LazyInstalledNode = {
	contents: Uint8Array | null;
	usedBytes: number;
	node_ops: unknown;
	stream_ops: Record<string, unknown>;
	cfwRow: string;
	cfwLoaded: boolean;
	cfwDirty?: boolean;
	timestamp: number;
};

/** What a mount reported, plus the driver overlay written on top of it. */
export type SiteMountInfo = (MountResult | LazyMountResult) & {
	driver?: DriverMountResult;
	/** the shipped opcache cache's system id when the `pack` arm linked one, else absent */
	opcachePack?: string;
};

/**
 * The JS-side half of what a booted interpreter occupies: file contents are typed arrays on the JS
 * heap, invisible to wasm linear memory, and the isolate's 128 MB covers both. Zeros for the
 * streaming mount (no budget, no eviction).
 */
export function lazyMountBytes(info: SiteMountInfo | undefined): {
	blob: number;
	budget: number;
	resident: number;
	highWater: number;
	inflated: number;
	inflatedBytes: number;
	evicted: number;
	reinflated: number;
} {
	const lazy = info && 'blobBytes' in info ? info : undefined;
	const stats = lazy?.inflateStats;
	return {
		blob: lazy?.blobBytes ?? 0,
		budget: lazy?.budgetBytes ?? 0,
		resident: stats?.residentBytes ?? 0,
		highWater: stats?.highWaterBytes ?? 0,
		// these three price a stage: tree opened, and whether the budget re-opened a file
		inflated: stats?.inflated ?? 0,
		inflatedBytes: stats?.inflatedBytes ?? 0,
		evicted: stats?.evicted ?? 0,
		reinflated: stats?.reinflated ?? 0
	};
}

/** the per-file pack's index and blob, one copy per ASSETS binding for the life of the isolate */
const packFiles = new WeakMap<object, Map<string, Promise<PackFile>>>();
type PackFile = { ok: boolean; status: number; bytes: ArrayBuffer; parsed?: unknown };

/**
 * `env` with an ASSETS whose per-file pack answers from the copy the first boot fetched.
 *
 * A refetch per boot held two 12 MB blobs after a drop (farmOS resets cluster on that boot). A
 * deploy is a new isolate, so a copy cannot outlive its pack.
 */
export function packCachedEnv<E>(env: E): E {
	const assets = (env as { ASSETS?: Fetcher } | undefined)?.ASSETS;
	if (!assets) return env;
	let files = packFiles.get(assets);
	if (!files) packFiles.set(assets, (files = new Map()));
	const known = files;
	const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		if (!/\/core\.pf\.(?:bin|json)$/.test(new URL(url).pathname))
			return assets.fetch(input, init);
		let file = known.get(url);
		if (!file) {
			file = assets.fetch(url).then(async (r) => ({
				ok: r.ok,
				status: r.status,
				bytes: r.ok ? await r.arrayBuffer() : new ArrayBuffer(0)
			}));
			known.set(url, file);
			// a failed fetch is retried by the next boot rather than remembered
			file.then(
				(f) => void (f.ok || known.delete(url)),
				() => void known.delete(url)
			);
		}
		// the two members the mount reads; a view over the same bytes, never a copy
		return file.then(
			(f) =>
				({
					ok: f.ok,
					status: f.status,
					arrayBuffer: async () => f.bytes,
					json: async () => (f.parsed ??= JSON.parse(new TextDecoder().decode(f.bytes)))
				}) as unknown as Response
		);
	};
	return { ...env, ASSETS: { fetch, connect: assets.connect?.bind(assets) } as Fetcher };
}

/**
 * What the merged pack index retains on the JS heap, in bytes: `heapUsed` either side of a
 * `JSON.parse` of `core.pf.json` (1,980,912 for 11,457 entries, 1.5x the file). It lifts the
 * authenticated plateau from 96.8% to 98.3% of the ceiling. A constant, so
 * `pack-index-bytes.spec.ts` fails when the pack drifts from it.
 */
export const PACK_INDEX_BYTES = 1_980_912;
