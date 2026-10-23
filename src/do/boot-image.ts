import { createHash } from 'node:crypto';
import {
	captureHandles,
	captureStreams,
	replayHandles,
	replayStreams,
	WASM_PAGE_BYTES,
	type StreamFS
} from '../db/heap-store';
import type { SiteEnv } from '../env';
import {
	applyBootImage,
	BOOT_IMAGE_VARIANTS,
	bootImageContext,
	bootImageDir,
	BootImageError,
	bootImageVerdict,
	chunkBootImage,
	configDigest,
	parseBootImageIndex,
	settingsDigest,
	type BootImageIndex,
	type BootImageVariant
} from '../ops/boot-image';
import { DRIVER_DIGEST } from '../ops/driver-digest';
import { opcacheMode } from '../runtime/opcache';
import type { SitePhpDurableObject } from '../site-do';
import * as siteAssets from '../site/generated/assets';
import { BOOT_IMAGE_REKEY_PHP } from '../site/generated/assets';
import { errorMessage } from '../util/errors';
import { phpRender } from '../util/php';
import type { Payload, SiteBinary } from './types';

/** whether a cold boot may restore the published boot image; off unless `1` */
export function bootImageEnabled(env?: SiteEnv): boolean {
	return String(env?.BOOT_IMAGE ?? '0') === '1';
}

/** whether this object may capture a boot image of itself, which only a local bake rig sets */
export function bootImageBakeEnabled(env?: SiteEnv): boolean {
	return String(env?.BOOT_IMAGE_BAKE ?? '0') === '1';
}

type AssetsFetcher = { fetch: (request: Request) => Promise<Response> };

const assetsOf = (site: SitePhpDurableObject): AssetsFetcher | undefined =>
	(site.env as { ASSETS?: AssetsFetcher } | undefined)?.ASSETS;

const indexMemo = new WeakMap<object, Map<string, Promise<BootImageIndex | undefined>>>();

/** one variant's published index, read once per isolate; undefined when there is none */
export function loadBootImageIndex(
	assets: AssetsFetcher,
	variant: BootImageVariant
): Promise<BootImageIndex | undefined> {
	let variants = indexMemo.get(assets);
	if (!variants) indexMemo.set(assets, (variants = new Map()));
	let pending = variants.get(variant);
	if (!pending) {
		pending = (async () => {
			try {
				const res = await assets.fetch(
					new Request(`https://assets.local/${bootImageDir(variant)}/index.json`)
				);
				if (!res.ok) return undefined;
				const parsed = parseBootImageIndex(await res.json());
				return typeof parsed === 'string' ? undefined : parsed;
			} catch {
				return undefined;
			}
		})();
		variants.set(variant, pending);
	}
	return pending;
}

let fragmentsMemo: string | undefined;

/**
 * A digest of every PHP, YAML and script asset the host packs.
 *
 * The heap holds the functions an earlier run declared and a fragment's `function_exists` guard
 * keeps them, so an image taken under older fragments would silently run old code.
 */
export function fragmentsDigest(): string {
	if (fragmentsMemo) return fragmentsMemo;
	const hash = createHash('sha256');
	for (const [name, value] of Object.entries(siteAssets).sort(([a], [b]) => (a < b ? -1 : 1)))
		if (typeof value === 'string') hash.update(`${name}\0${value}\0`);
	return (fragmentsMemo = hash.digest('hex').slice(0, 32));
}

/** the config part of a context that asks the restore to refresh what the heap read from config */
export const CONFIG_RESET = 'reset';

/**
 * The context this site must equal for the published image to be its boot, or undefined.
 *
 * `config` is the site's own digest by default, which only an unconfigured site shares with the
 * bake; {@link CONFIG_RESET} is the part an image baked for any configured site carries.
 */
export function siteBootContext(site: SitePhpDurableObject, config?: string): string | undefined {
	const generation = site.heapGeneration();
	if (generation === undefined) return undefined;
	return bootImageContext({
		generation,
		driver: DRIVER_DIGEST,
		config: config ?? configDigest(site.sql),
		settings: settingsDigest({
			...site.bootSettings(),
			opcache: opcacheMode(site.env?.OPCACHE_MODE),
			fragments: fragmentsDigest()
		})
	});
}

/** what a boot decided about the image, and whether its restore also refreshes config state */
export type BootImagePlan = {
	index?: BootImageIndex;
	variant?: BootImageVariant;
	reason: string;
	reset?: boolean;
};

/**
 * Whether this boot restores a published image, and which.
 *
 * A replica or a pool lane is a read copy of another object's state and never boots from a shared
 * image. Anything that differs from the bake sends the site to the plain boot, which is always
 * correct.
 */
export async function planBootImage(site: SitePhpDurableObject): Promise<BootImagePlan> {
	if (!bootImageEnabled(site.env)) return { reason: 'off' };
	if (site.isReplica() || site.isPoolLane()) return { reason: 'a replica boots plain' };
	const assets = assetsOf(site);
	if (!assets) return { reason: 'no ASSETS binding' };
	const strict = siteBootContext(site);
	if (strict === undefined) return { reason: 'not migrated yet' };
	const reset = siteBootContext(site, CONFIG_RESET) as string;
	let reason = 'no boot image is published';
	for (const variant of BOOT_IMAGE_VARIANTS) {
		const index = await loadBootImageIndex(assets, variant);
		if (bootImageVerdict(index, strict).use)
			return { index, variant, reason: `${variant} image, context equal` };
		if (bootImageVerdict(index, reset).use)
			return {
				index,
				variant,
				reason: `${variant} image, context equal, config reset`,
				reset: true
			};
		if (index) reason = 'context differs';
	}
	return { reason };
}

/** pages the boot memory needs for the plan, or 0 when the plan asks for nothing */
export function planPages(plan: BootImagePlan): number {
	return plan.index ? plan.index.byteLength / WASM_PAGE_BYTES : 0;
}

/**
 * Restores the image into a booted interpreter and makes the heap this site's.
 *
 * Runs after the mount, bridge and capabilities, where the heap restore runs, because the heap
 * names JS-side handles and descriptors those create. `dirty` on a refusal says bytes already
 * landed, so the caller must drop the interpreter; otherwise it carries on with the plain boot.
 */
export async function restoreBootImage(
	site: SitePhpDurableObject,
	binary: SiteBinary,
	index: BootImageIndex,
	variant: BootImageVariant,
	reset = false
): Promise<Payload> {
	const t0 = Date.now();
	const live = site.heapBytes(binary);
	if (!live) return { restored: false, reason: 'no reachable heap on this binary' };
	if (live.length < index.byteLength)
		return {
			restored: false,
			reason: `heap is ${live.length} bytes, image needs ${index.byteLength}`
		};
	const streams = replayStreams(binary.FS as unknown as StreamFS, index.streams);
	if (streams.failed.length > 0)
		return { restored: false, reason: 'fd replay failed', failed: streams.failed };
	const handles = replayHandles(
		site.handleIndex(binary),
		binary as unknown as Record<string, unknown>,
		index.handles
	);
	if (handles.failed.length > 0)
		return {
			restored: false,
			reason: 'vrzno handle replay failed',
			failedHandles: handles.failed
		};

	const assets = assetsOf(site);
	if (!assets) return { restored: false, reason: 'no ASSETS binding' };
	let applied;
	try {
		applied = await applyBootImage(live, index, async (file) => {
			const res = await assets.fetch(
				new Request(`https://assets.local/${bootImageDir(variant)}/${file}`)
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return new Uint8Array(await res.arrayBuffer());
		});
	} catch (e) {
		const written = e instanceof BootImageError ? e.bytesWritten : 0;
		return {
			restored: false,
			reason: errorMessage(e),
			dirty: written > 0,
			bytesWritten: written
		};
	}
	const applyMs = Date.now() - t0;

	const rekey = await site
		.runJson(phpRender(BOOT_IMAGE_REKEY_PHP, { RESET_CONFIG: reset ? 'true' : 'false' }))
		.catch((e) => ({ errors: [errorMessage(e)] }));
	if (!Array.isArray(rekey.errors) || rekey.errors.length > 0)
		return {
			restored: false,
			reason: 'rekey failed',
			rekey,
			dirty: true,
			bytesWritten: applied.bytes
		};
	return {
		restored: true,
		source: 'bootimage',
		files: applied.files,
		pages: applied.pages,
		bytes: applied.bytes,
		streamsReplayed: streams.replayed.length,
		handlesReplayed: handles.replayed.length,
		applyMs,
		rekeyMs: Date.now() - t0 - applyMs
	};
}

/**
 * Takes the boot image of this object: every page that differs from the heap at the restore point,
 * with the descriptors and handles the heap names.
 *
 * Only a local bake rig reaches this (`BOOT_IMAGE_BAKE=1`). The baseline is the heap at the point
 * a restore would write into, so the delta is exactly what the restore has to add.
 */
export function captureBootImage(
	site: SitePhpDurableObject,
	binary: SiteBinary,
	baseline: Uint8Array,
	opts: { reset?: boolean } = {}
): { index: BootImageIndex; files: Record<string, Uint8Array> } {
	const heap = site.heapBytes(binary);
	if (!heap) throw new Error('no reachable heap on this binary');
	const context = siteBootContext(site, opts.reset ? CONFIG_RESET : undefined);
	if (context === undefined) throw new Error('the object is not migrated');
	const pages: number[] = [];
	const total = heap.length / WASM_PAGE_BYTES;
	for (let page = 0; page < total; page++) {
		const at = page * WASM_PAGE_BYTES;
		const now = heap.subarray(at, at + WASM_PAGE_BYTES);
		const was =
			at + WASM_PAGE_BYTES <= baseline.length
				? baseline.subarray(at, at + WASM_PAGE_BYTES)
				: undefined;
		if (was ? Buffer.compare(now, was) !== 0 : now.some((b) => b !== 0)) pages.push(page);
	}
	const data = new Uint8Array(pages.length * WASM_PAGE_BYTES);
	pages.forEach((p, i) =>
		data.set(heap.subarray(p * WASM_PAGE_BYTES, (p + 1) * WASM_PAGE_BYTES), i * WASM_PAGE_BYTES)
	);
	const handles = captureHandles(
		site.handleIndex(binary),
		binary as unknown as Record<string, unknown>
	);
	if (handles.unnameable.length > 0)
		throw new Error(`${handles.unnameable.length} handles cannot be named`);
	return chunkBootImage(
		{ byteLength: heap.length, pages, data },
		{
			context,
			streams: captureStreams(binary.FS as unknown as StreamFS),
			handles: handles.handles
		}
	);
}
