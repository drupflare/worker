import { describe, expect, it } from 'vitest';
import { WASM_PAGE_BYTES } from '../../../src/db/heap-store';
import {
	BootImageError,
	applyBootImage,
	bootImageContext,
	bootImageVerdict,
	chunkBootImage,
	configDigest,
	pageHash,
	parseBootImageIndex,
	settingsDigest,
	type BootImageIndex
} from '../../../src/ops/boot-image';

/**
 * The shared boot image's pure half: the key a site must equal, the index, and the apply that
 * verifies every page before it lands. The PHP that makes the heap is not here.
 */

const PAGE = WASM_PAGE_BYTES;

/** pages that each carry their own number, so a page written to the wrong place reads wrong */
function imageOf(pages: number[], memoryPages = 40) {
	const data = new Uint8Array(pages.length * PAGE);
	pages.forEach((p, i) => data.fill((p % 250) + 1, i * PAGE, (i + 1) * PAGE));
	return { byteLength: memoryPages * PAGE, pages, data };
}

const META = { context: 'ctx', streams: [], handles: [{ id: 1, name: '@globalThis' }] };

const serve =
	(files: Record<string, Uint8Array>) =>
	async (file: string): Promise<Uint8Array> => {
		const bytes = files[file];
		if (!bytes) throw new Error(`no ${file}`);
		return bytes;
	};

describe('the context key', () => {
	const parts = { generation: 'g|m', driver: 'd', config: 'c', settings: 's' };

	it('names every part, so one that differs is a different key', () => {
		const key = bootImageContext(parts);
		expect(key).toBe('generation=g|m|driver=d|config=c|settings=s');
		for (const part of Object.keys(parts) as (keyof typeof parts)[])
			expect(bootImageContext({ ...parts, [part]: 'other' })).not.toBe(key);
	});

	it('chooses the image only when the context is equal and an index is published', () => {
		const { index } = chunkBootImage(imageOf([1]), { ...META, context: 'a' });
		expect(bootImageVerdict(index, 'a')).toEqual({ use: true });
		expect(bootImageVerdict(index, 'b')).toEqual({ use: false, reason: 'context differs' });
		expect(bootImageVerdict(undefined, 'a')).toEqual({
			use: false,
			reason: 'no boot image is published'
		});
	});
});

describe('the config and settings digests', () => {
	const rows = (data: [string, string, string | Uint8Array][]) => ({
		exec: () => {
			const all = data.map(([collection, name, value]) => ({
				collection,
				name,
				data: value
			}));
			return { toArray: () => all, [Symbol.iterator]: () => all[Symbol.iterator]() };
		}
	});

	it('reads a blob and a string alike and changes with any row', () => {
		const text = configDigest(rows([['', 'system.site', 'name: A']]));
		const blob = configDigest(rows([['', 'system.site', new TextEncoder().encode('name: A')]]));
		expect(blob).toBe(text);
		expect(configDigest(rows([['', 'system.site', 'name: B']]))).not.toBe(text);
		expect(configDigest(rows([['', 'system.theme', 'name: A']]))).not.toBe(text);
		expect(text).toMatch(/^[0-9a-f]{32}$/);
	});

	it('keeps a row boundary a boundary', () => {
		const joined = configDigest(rows([['', 'a', 'bc']]));
		const split = configDigest(rows([['', 'ab', 'c']]));
		expect(split).not.toBe(joined);
	});

	it('orders keys, so equal settings read equal whatever their insertion order', () => {
		expect(settingsDigest({ a: 1, b: { y: 2, x: [3, { q: 1, p: 2 }] } })).toBe(
			settingsDigest({ b: { x: [3, { p: 2, q: 1 }], y: 2 }, a: 1 })
		);
		expect(settingsDigest({ a: 1 })).not.toBe(settingsDigest({ a: 2 }));
		expect(settingsDigest(undefined)).toBe(settingsDigest(null));
	});
});

describe('the page hash', () => {
	it('is stable, sensitive to a one-byte change and indifferent to where the view starts', () => {
		const page = new Uint8Array(PAGE).fill(7);
		const h = pageHash(page);
		expect(pageHash(page)).toBe(h);
		const changed = page.slice();
		changed[PAGE - 1] = 8;
		expect(pageHash(changed)).not.toBe(h);
		const shifted = new Uint8Array(PAGE + 1);
		shifted.set(page, 1);
		expect(pageHash(shifted.subarray(1))).toBe(h);
	});
});

describe('chunking and the index', () => {
	it('splits into files of at most chunkPages and hashes each page', () => {
		const image = imageOf([2, 3, 9, 10, 30]);
		const { index, files } = chunkBootImage(image, META, 2);
		expect(index.chunks.map((c) => [c.file, c.pages])).toEqual([
			['c000.bin', [2, 3]],
			['c001.bin', [9, 10]],
			['c002.bin', [30]]
		]);
		expect(Object.keys(files)).toEqual(['c000.bin', 'c001.bin', 'c002.bin']);
		expect(files['c002.bin']!.length).toBe(PAGE);
		expect(index.chunks[0]!.hashes[1]).toBe(pageHash(files['c000.bin']!.subarray(PAGE)));
		expect(index.byteLength).toBe(40 * PAGE);
	});

	it('refuses a chunk size that is not a positive integer and data that is not whole pages', () => {
		expect(() => chunkBootImage(imageOf([1]), META, 0)).toThrow(RangeError);
		expect(() => chunkBootImage(imageOf([1]), META, 1.5)).toThrow(RangeError);
		const image = imageOf([1, 2]);
		expect(() => chunkBootImage({ ...image, data: image.data.subarray(PAGE) }, META)).toThrow(
			RangeError
		);
	});

	it('round-trips through JSON and rejects each way an index can be wrong', () => {
		const { index } = chunkBootImage(imageOf([1, 2]), META);
		const parsed = parseBootImageIndex(JSON.parse(JSON.stringify(index)));
		expect(parsed).toEqual(index);
		const chunk = index.chunks[0]!;
		const bad: [string, unknown][] = [
			['not an object', 'x'],
			['version 2', { ...index, version: 2 }],
			['page size 4096', { ...index, pageBytes: 4096 }],
			['whole number of pages', { ...index, byteLength: PAGE + 1 }],
			['no context', { ...index, context: '' }],
			['no chunks', { ...index, chunks: [] }],
			['no stream or handle record', { ...index, streams: undefined }],
			['malformed', { ...index, chunks: [{ ...chunk, file: '../c000.bin' }] }],
			['malformed', { ...index, chunks: [{ ...chunk, hashes: [] }] }],
			['malformed', { ...index, chunks: [{ ...chunk, pages: [9_999], hashes: [0] }] }]
		];
		for (const [reason, value] of bad) {
			const result = parseBootImageIndex(value);
			expect(typeof result, reason).toBe('string');
			expect(result as string).toContain(reason);
		}
	});
});

describe('applying an image', () => {
	const build = (pages: number[], chunkPages = 2) => {
		const { index, files } = chunkBootImage(imageOf(pages), META, chunkPages);
		return { index, files };
	};

	it('writes every page where its number says and nothing else', async () => {
		const { index, files } = build([1, 4, 5, 20, 21]);
		const live = new Uint8Array(40 * PAGE);
		live.fill(255);
		const applied = await applyBootImage(live, index, serve(files));
		expect(applied).toEqual({ files: 3, pages: 5, bytes: 5 * PAGE });
		for (const p of [1, 4, 5, 20, 21]) expect(live[p * PAGE]).toBe((p % 250) + 1);
		expect(live[2 * PAGE]).toBe(255);
		expect(live[39 * PAGE]).toBe(255);
	});

	it('gives the same heap at any width, including one', async () => {
		const { index, files } = build([1, 4, 5, 20, 21, 22, 30], 1);
		const a = new Uint8Array(40 * PAGE);
		const b = new Uint8Array(40 * PAGE);
		await applyBootImage(a, index, serve(files), { inFlight: 1 });
		await applyBootImage(b, index, serve(files), { inFlight: 16 });
		expect(Buffer.compare(a, b)).toBe(0);
	});

	it('refuses a heap that is smaller than the image before it reads a file', async () => {
		const { index } = build([1]);
		let fetched = 0;
		await expect(
			applyBootImage(new Uint8Array(10 * PAGE), index, async () => {
				fetched++;
				return new Uint8Array();
			})
		).rejects.toThrow(/image needs/);
		expect(fetched).toBe(0);
	});

	it('refuses a short file whole, leaving the heap untouched when it was the first', async () => {
		const { index, files } = build([1, 2]);
		const short = { 'c000.bin': files['c000.bin']!.subarray(0, PAGE) };
		const live = new Uint8Array(40 * PAGE);
		const error = await applyBootImage(live, index, serve(short)).catch((e) => e);
		expect(error).toBeInstanceOf(BootImageError);
		expect(error.bytesWritten).toBe(0);
		expect(live.every((b) => b === 0)).toBe(true);
	});

	it('names a page whose bytes disagree with its hash, and writes none of that file', async () => {
		const { index, files } = build([1, 2]);
		const bad = files['c000.bin']!.slice();
		bad[PAGE + 17] = bad[PAGE + 17]! ^ 1;
		const live = new Uint8Array(40 * PAGE);
		const error = await applyBootImage(live, index, serve({ 'c000.bin': bad }), {
			inFlight: 1
		}).catch((e) => e);
		expect(String(error.message)).toContain('page 2 does not match');
		expect(live.every((b) => b === 0)).toBe(true);
	});

	it('reports bytes written when an earlier file landed, which is a heap to drop', async () => {
		const { index, files } = build([1, 2, 3, 4], 2);
		const live = new Uint8Array(40 * PAGE);
		const second = files['c001.bin']!.slice();
		second[0] = second[0]! ^ 1;
		const error = await applyBootImage(live, index, serve({ ...files, 'c001.bin': second }), {
			inFlight: 1
		}).catch((e) => e);
		expect(error.bytesWritten).toBe(2 * PAGE);
		expect(live[PAGE]).toBe(2);
	});

	it('turns a fetch failure into a refusal that names the file', async () => {
		const { index } = build([1]);
		const error = await applyBootImage(new Uint8Array(40 * PAGE), index, async () => {
			throw new Error('404');
		}).catch((e) => e);
		expect(error).toBeInstanceOf(BootImageError);
		expect(String(error.message)).toContain('c000.bin: 404');
	});

	it('is typed so a caller can pass the index it parsed', () => {
		const { index } = build([1]);
		const typed: BootImageIndex = index;
		expect(typed.chunks).toHaveLength(1);
	});
});
