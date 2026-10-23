import { createHash } from 'node:crypto';
import {
	type HandleRecord,
	type HeapSql,
	type StreamRecord,
	toStorableBytes,
	WASM_PAGE_BYTES
} from '../db/heap-store';
import { errorMessage } from '../util/errors';

/** the asset directory holding `index.json` and the numbered chunk files */
export const BOOT_IMAGE_DIR = 'bootimage';

/** the images a build publishes: one for a site the pack made, one for a claimed site */
export const BOOT_IMAGE_VARIANTS = ['pack', 'claimed'] as const;

/** one published image's directory under the asset root */
export type BootImageVariant = (typeof BOOT_IMAGE_VARIANTS)[number];

/** the asset directory of one variant, without a leading or trailing slash */
export function bootImageDir(variant: BootImageVariant): string {
	return `${BOOT_IMAGE_DIR}/${variant}`;
}

/** pages per chunk file the bake writes; 2 MiB keeps what a restore holds in flight small */
export const BOOT_IMAGE_CHUNK_PAGES = 32;

/** files fetched at once while a restore is applying */
export const BOOT_IMAGE_IN_FLIGHT = 4;

/** one asset file of the image: its page numbers in file order and a hash of each page */
export type BootImageChunk = { file: string; pages: number[]; hashes: number[] };

/** `index.json`: what the image is for, what it needs, and the JS-side state its heap names */
export type BootImageIndex = {
	version: 1;
	pageBytes: number;
	/** the memory the image needs, larger than the boot memory once the bake's render grew it */
	byteLength: number;
	/** what the heap was built against; see {@link bootImageContext} */
	context: string;
	chunks: BootImageChunk[];
	streams: StreamRecord[];
	handles: HandleRecord[];
};

/** what a site must equal for the image to be its boot: the facts the heap was built from */
export type BootImageContextParts = {
	/** pack generation and enabled-module fingerprint, as `heapGeneration()` names them */
	generation: string;
	/** the packed driver the container and class loader were built against */
	driver: string;
	/** a digest of the `config` rows; see {@link configDigest} */
	config: string;
	/** a digest of the settings that shape the heap other than the site's own origin and salt */
	settings: string;
};

/** the context key: any part that differs sends the site to the plain boot */
export function bootImageContext(parts: BootImageContextParts): string {
	return [
		`generation=${parts.generation}`,
		`driver=${parts.driver}`,
		`config=${parts.config}`,
		`settings=${parts.settings}`
	].join('|');
}

/**
 * sha256 over the `config` rows in name order.
 *
 * The heap keeps the config objects its bake render read, so a site whose rows differ would render
 * the bake's values (a renamed site showed the old name in its title). `data` is a blob.
 */
export function configDigest(sql: Pick<HeapSql, 'exec'>): string {
	const hash = createHash('sha256');
	const rows = sql.exec(
		'SELECT collection, name, data FROM config ORDER BY collection, name'
	) as Iterable<{ collection: unknown; name: unknown; data: unknown }>;
	for (const row of rows) {
		hash.update(`${String(row.collection)}\0${String(row.name)}\0`);
		const data = row.data;
		hash.update(typeof data === 'string' ? data : toStorableBytes(data as ArrayBufferLike));
		hash.update('\0');
	}
	return hash.digest('hex').slice(0, 32);
}

/** sha256 of a JSON value with its keys in a fixed order, so equal settings read equal */
export function settingsDigest(value: unknown): string {
	const canonical = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(canonical)
			: v && typeof v === 'object'
				? Object.fromEntries(
						Object.entries(v as Record<string, unknown>)
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
							.map(([k, x]) => [k, canonical(x)])
					)
				: v;
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)) ?? 'null')
		.digest('hex')
		.slice(0, 32);
}

/** a 32-bit hash over the little-endian words of one page; the bake and the restore share it */
export function pageHash(page: Uint8Array): number {
	// a view cut from a larger buffer can start off a word boundary
	const aligned = page.byteOffset % 4 === 0 ? page : page.slice();
	const words = new Int32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength >> 2);
	let hash = 0;
	for (let i = 0; i < words.length; i++) hash = (Math.imul(hash, 31) + words[i]!) | 0;
	return hash;
}

/** a refusal; `bytesWritten` says whether the live heap was already touched */
export class BootImageError extends Error {
	/** bytes this call had written into the live heap before it refused */
	readonly bytesWritten: number;
	constructor(message: string, bytesWritten = 0) {
		super(message);
		this.name = 'BootImageError';
		this.bytesWritten = bytesWritten;
	}
}

/** the index as an object of the right shape, or the reason it is not one */
export function parseBootImageIndex(value: unknown): BootImageIndex | string {
	const v = value as Partial<BootImageIndex> | null;
	if (!v || typeof v !== 'object') return 'index is not an object';
	if (v.version !== 1) return `index version ${String(v.version)}`;
	if (v.pageBytes !== WASM_PAGE_BYTES) return `page size ${String(v.pageBytes)}`;
	if (!Number.isInteger(v.byteLength) || (v.byteLength as number) % WASM_PAGE_BYTES !== 0)
		return 'byteLength is not a whole number of pages';
	if (typeof v.context !== 'string' || v.context === '') return 'no context';
	if (!Array.isArray(v.chunks) || v.chunks.length === 0) return 'no chunks';
	if (!Array.isArray(v.streams) || !Array.isArray(v.handles)) return 'no stream or handle record';
	for (const c of v.chunks) {
		const ok =
			typeof c?.file === 'string' &&
			/^c\d{3,}\.bin$/.test(c.file) &&
			Array.isArray(c.pages) &&
			Array.isArray(c.hashes) &&
			c.pages.length === c.hashes.length &&
			c.pages.length > 0 &&
			c.pages.every(
				(p) => Number.isInteger(p) && p >= 0 && p * WASM_PAGE_BYTES < v.byteLength!
			);
		if (!ok) return `chunk ${String(c?.file)} is malformed`;
	}
	return v as BootImageIndex;
}

/** whether this site boots from the image, and the reason when it does not */
export function bootImageVerdict(
	index: BootImageIndex | undefined,
	context: string
): { use: true } | { use: false; reason: string } {
	if (!index) return { use: false, reason: 'no boot image is published' };
	if (index.context !== context) return { use: false, reason: 'context differs' };
	return { use: true };
}

/** fetches one chunk file by name */
export type ChunkFetch = (file: string) => Promise<Uint8Array>;

/** what an apply did */
export type BootImageApplied = { files: number; pages: number; bytes: number };

/**
 * Writes the image's pages into a live heap.
 *
 * Each file is fetched and every page of it hashed before any of its bytes land, so a short or
 * wrong file is refused whole. A refusal after an earlier file landed carries `bytesWritten`, which
 * tells the caller the heap holds the right length and wrong bytes and must be dropped.
 */
export async function applyBootImage(
	live: Uint8Array,
	index: BootImageIndex,
	fetchChunk: ChunkFetch,
	opts: { inFlight?: number } = {}
): Promise<BootImageApplied> {
	if (live.length < index.byteLength)
		throw new BootImageError(`heap is ${live.length} bytes, image needs ${index.byteLength}`);
	const applied: BootImageApplied = { files: 0, pages: 0, bytes: 0 };
	const width = Math.max(1, opts.inFlight ?? BOOT_IMAGE_IN_FLIGHT);
	let next = 0;
	let refusal: BootImageError | undefined;
	const lane = async () => {
		while (!refusal) {
			const chunk = index.chunks[next++];
			if (!chunk) return;
			try {
				const bytes = await fetchChunk(chunk.file);
				if (bytes.length !== chunk.pages.length * WASM_PAGE_BYTES)
					throw new BootImageError(
						`${chunk.file} is ${bytes.length} bytes, expected ${chunk.pages.length * WASM_PAGE_BYTES}`,
						applied.bytes
					);
				for (let i = 0; i < chunk.pages.length; i++) {
					const page = bytes.subarray(i * WASM_PAGE_BYTES, (i + 1) * WASM_PAGE_BYTES);
					if (pageHash(page) !== chunk.hashes[i])
						throw new BootImageError(
							`${chunk.file} page ${chunk.pages[i]} does not match its hash`,
							applied.bytes
						);
				}
				if (refusal) return;
				for (let i = 0; i < chunk.pages.length; i++)
					live.set(
						bytes.subarray(i * WASM_PAGE_BYTES, (i + 1) * WASM_PAGE_BYTES),
						(chunk.pages[i] as number) * WASM_PAGE_BYTES
					);
				applied.files += 1;
				applied.pages += chunk.pages.length;
				applied.bytes += bytes.length;
			} catch (e) {
				refusal ??=
					e instanceof BootImageError
						? e
						: new BootImageError(`${chunk.file}: ${errorMessage(e)}`, applied.bytes);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(width, index.chunks.length) }, lane));
	if (refusal) throw new BootImageError(refusal.message, applied.bytes);
	return applied;
}

/**
 * Splits a delta image into chunk files and the index that names them.
 *
 * `pages` ascend and `data` holds them in that order. The hashes are what `applyBootImage` checks
 * each page against.
 */
export function chunkBootImage(
	image: { byteLength: number; pages: number[]; data: Uint8Array },
	meta: { context: string; streams: StreamRecord[]; handles: HandleRecord[] },
	chunkPages = BOOT_IMAGE_CHUNK_PAGES
): { index: BootImageIndex; files: Record<string, Uint8Array> } {
	if (!Number.isInteger(chunkPages) || chunkPages < 1)
		throw new RangeError('chunkPages must be a positive integer');
	if (image.data.length !== image.pages.length * WASM_PAGE_BYTES)
		throw new RangeError('data is not pages.length pages');
	const index: BootImageIndex = {
		version: 1,
		pageBytes: WASM_PAGE_BYTES,
		byteLength: image.byteLength,
		context: meta.context,
		chunks: [],
		streams: meta.streams,
		handles: meta.handles
	};
	const files: Record<string, Uint8Array> = {};
	for (let at = 0; at < image.pages.length; at += chunkPages) {
		const pages = image.pages.slice(at, at + chunkPages);
		const bytes = image.data.subarray(
			at * WASM_PAGE_BYTES,
			(at + pages.length) * WASM_PAGE_BYTES
		);
		const file = `c${String(index.chunks.length).padStart(3, '0')}.bin`;
		files[file] = bytes;
		index.chunks.push({
			file,
			pages,
			hashes: pages.map((_, i) =>
				pageHash(bytes.subarray(i * WASM_PAGE_BYTES, (i + 1) * WASM_PAGE_BYTES))
			)
		});
	}
	return { index, files };
}
