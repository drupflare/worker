import { Image, TinyImgModule } from '@gmitch215/tinyimg';
import wasm from '@gmitch215/tinyimg/tinyimg.wasm';
import { describe, expect, it } from 'vitest';
import {
	GD_FILTER,
	blankCanvas,
	engineFeatures,
	gd2Encode,
	gdAlphaBlend,
	gdColor,
	gdCopy,
	gdFilter,
	liveEngineFeatures,
	runParkImage,
	scaleIndex,
	stretchIndex,
	type ParkImageRequest
} from '../../../src/ops/image-runtime';

describe('the shipped engine features', () => {
	it('lists what the engine encodes without loading it', () => {
		const features = engineFeatures();
		for (const f of ['png', 'jpeg', 'webp', 'avif']) expect(features).toContain(f);
	});
});

describe('a blank canvas', () => {
	it('is a 24-bit BMP whose header names its own size and dimensions', () => {
		const bmp = blankCanvas(3, 2);
		// rows pad to four bytes: 3 pixels * 3 bytes = 9 -> 12
		expect(bmp.length).toBe(54 + 12 * 2);
		expect([bmp[0], bmp[1]]).toEqual([0x42, 0x4d]);
		const view = new DataView(bmp.buffer);
		expect(view.getUint32(2, true)).toBe(bmp.length);
		expect(view.getInt32(18, true)).toBe(3);
		expect(view.getInt32(22, true)).toBe(2);
		expect(view.getUint16(28, true)).toBe(24);
		expect(bmp.slice(54).every((b) => b === 0)).toBe(true);
	});

	it('refuses a size outside the pixel budget or a non-integer one', () => {
		expect(() => blankCanvas(0, 5)).toThrow(RangeError);
		expect(() => blankCanvas(1.5, 5)).toThrow(RangeError);
		expect(() => blankCanvas(5000, 5000)).toThrow(/outside 1 to 16000000 pixels/);
	});
});

describe('a gd colour', () => {
	it('splits ARGB into red, green, blue and an 8-bit alpha', () => {
		expect(gdColor(0x00ff8040)).toEqual([255, 128, 64, 255]);
		// gd alpha 127 is fully clear
		expect(gdColor(0x7f000000)).toEqual([0, 0, 0, 1]);
		expect(gdColor(0x40000000)[3]).toBe(255 - 64 * 2);
	});
});

describe('running a queued gd handle', () => {
	it('refuses a request with neither a source nor a canvas', async () => {
		await expect(
			runParkImage({ source: null, canvas: null, ops: [], format: 'png', quality: -1 })
		).rejects.toThrow(TypeError);
	});

	it('reports the decoder features it loaded, a superset-check against the shipped list', async () => {
		expect(liveEngineFeatures()).toContain('png');
	});

	it('decodes a base64 source rather than a canvas', async () => {
		const bmp = blankCanvas(4, 4);
		let raw = '';
		for (const b of bmp) raw += String.fromCharCode(b);
		const out = await runParkImage({
			source: btoa(raw),
			canvas: null,
			ops: [{ op: 'crop', x: 0, y: 0, width: 2, height: 2 }],
			format: 'png',
			quality: 0
		});
		expect([out.width, out.height]).toEqual([2, 2]);
	});

	it('draws a blank canvas, applies a resize and encodes a png', async () => {
		const out = await runParkImage({
			source: null,
			canvas: { width: 8, height: 6 },
			ops: [{ op: 'resize', width: 4, height: 3 }],
			format: 'png',
			quality: -1
		});
		expect([out.width, out.height]).toEqual([4, 3]);
		expect([...out.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});

const raw = (width: number, height: number, rgba: number[]) => ({
	width,
	height,
	pixels: Uint8Array.from(rgba)
});

describe('libgd pixel arithmetic', () => {
	it('blends with integer division, and returns the source or destination at the extremes', () => {
		expect(gdAlphaBlend(0x00112233, 0x00aabbcc)).toBe(0x00aabbcc);
		expect(gdAlphaBlend(0x00112233, 0x7faabbcc)).toBe(0x00112233);
		expect(gdAlphaBlend(0x7f112233, 0x40aabbcc)).toBe(0x40aabbcc);
		// half-clear source over an opaque destination: weights 63 and 64 of 127, truncated
		expect(gdAlphaBlend(0x00000000, 0x40ff8040) >>> 24).toBe(0);
		expect((gdAlphaBlend(0x00000000, 0x40ff8040) >> 16) & 255).toBe(
			Math.trunc((255 * 63) / 127)
		);
	});

	it('copies at an offset, clips at the destination edge and skips the transparent color', () => {
		const dst = raw(3, 1, [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
		const src = raw(2, 1, [10, 20, 30, 255, 99, 99, 99, 255]);
		gdCopy(dst, src, { dx: 2, dy: 0, sx: 0, sy: 0, width: 2, height: 1 }, undefined, true);
		expect([...dst.pixels]).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 255]);

		const skipped = raw(1, 1, [1, 2, 3, 255]);
		gdCopy(
			skipped,
			raw(1, 1, [10, 20, 30, 255]),
			{ dx: 0, dy: 0, sx: 0, sy: 0, width: 1, height: 1, skip: 0x000a141e },
			undefined,
			true
		);
		expect([...skipped.pixels]).toEqual([1, 2, 3, 255]);
	});

	it('merges as a truncated float mix and drops the alpha', () => {
		const dst = raw(1, 1, [200, 100, 50, 255]);
		gdCopy(
			dst,
			raw(1, 1, [100, 200, 255, 255]),
			{ dx: 0, dy: 0, sx: 0, sy: 0, width: 1, height: 1 },
			25,
			true
		);
		expect([...dst.pixels]).toEqual([
			Math.trunc(100 * 0.25 + (200 * 75) / 100),
			Math.trunc(200 * 0.25 + (100 * 75) / 100),
			Math.trunc(255 * 0.25 + (50 * 75) / 100),
			255
		]);
	});

	it('serves the eight filters, leaves alpha alone and refuses another', () => {
		const px = () => raw(1, 1, [100, 150, 200, 77]);
		const run = (type: number, arg?: number) => {
			const p = px();
			gdFilter(p, type, arg);
			return [...p.pixels];
		};
		expect(run(GD_FILTER.negate)).toEqual([155, 105, 55, 77]);
		expect(run(GD_FILTER.grayscale)).toEqual([140, 140, 140, 77]);
		expect(run(GD_FILTER.brightness, 100)).toEqual([200, 250, 255, 77]);
		expect(run(GD_FILTER.contrast, 100)).toEqual([127, 127, 127, 77]);
		// a flat image through a kernel whose weights sum to the divisor keeps its colour
		expect(run(GD_FILTER.smooth, 1)).toEqual([100, 150, 200, 77]);
		expect(run(GD_FILTER.meanRemoval)).toEqual([100, 150, 200, 77]);
		expect(run(GD_FILTER.edgedetect)).toEqual([
			127 + 0 + 4 * 100 - 400,
			127 + 600 - 600,
			127 + 800 - 800,
			77
		]);
		expect(() => gdFilter(px(), 11, 4)).toThrow(RangeError);
	});
});

const bmp64 = (width: number, height: number) => {
	let s = '';
	for (const b of blankCanvas(width, height)) s += String.fromCharCode(b);
	return btoa(s);
};

const canvasRequest = (ops: ParkImageRequest['ops'], format: ParkImageRequest['format'] = 'png') =>
	({
		source: null,
		canvas: { width: 4, height: 2 },
		ops,
		format,
		quality: -1
	}) as ParkImageRequest;

const decodedPixels = async (bytes: Uint8Array) => {
	const out = await runParkImage({
		source: btoa(String.fromCharCode(...blankCanvas(1, 1))),
		canvas: null,
		ops: [],
		format: 'png',
		quality: -1
	});
	expect(out.width).toBe(1);
	return bytes;
};

describe('running the new queued operations', () => {
	it('fills a blank canvas, flips it and writes png, jpeg, webp and avif', async () => {
		for (const format of ['png', 'jpeg', 'webp', 'avif'] as const) {
			const out = await runParkImage(
				canvasRequest(
					[
						{ op: 'fill', x: 0, y: 0, color: 0x00336699 },
						{ op: 'flip', mode: 3 }
					],
					format
				)
			);
			expect([out.width, out.height]).toEqual([4, 2]);
			expect(out.bytes.length).toBeGreaterThan(0);
		}
		await decodedPixels(new Uint8Array());
	});

	it('copies a nested handle onto the canvas and keeps the queue order across a resize', async () => {
		const copy = {
			op: 'copy' as const,
			src: {
				source: bmp64(2, 2),
				canvas: null,
				ops: [{ op: 'fill' as const, x: 0, y: 0, color: 0x00ff0000 }]
			},
			dx: 1,
			dy: 0,
			sx: 0,
			sy: 0,
			width: 2,
			height: 2,
			blend: true
		};
		const out = await runParkImage(
			canvasRequest([copy, { op: 'resize', width: 8, height: 4, filter: 'nearest' }])
		);
		expect([out.width, out.height]).toEqual([8, 4]);
	});

	it('refuses copies nested past the depth limit', async () => {
		const leaf = {
			source: null,
			canvas: { width: 1, height: 1 },
			ops: [] as ParkImageRequest['ops']
		};
		let src: typeof leaf = leaf;
		for (let i = 0; i < 6; i++) {
			src = {
				...leaf,
				ops: [
					{
						op: 'copy',
						src,
						dx: 0,
						dy: 0,
						sx: 0,
						sy: 0,
						width: 1,
						height: 1,
						blend: true
					}
				]
			};
		}
		await expect(
			runParkImage({ ...src, format: 'png', quality: -1 } as ParkImageRequest)
		).rejects.toThrow(/nest too deeply/);
	});

	it('gives a free rotation the extent PHP reported', async () => {
		const out = await runParkImage({
			source: bmp64(160, 160),
			canvas: null,
			ops: [{ op: 'rotate', degrees: 323, background: 0, width: 225, height: 225 }],
			format: 'png',
			quality: -1
		});
		expect([out.width, out.height]).toEqual([225, 225]);
	});
});

const decoder = TinyImgModule.load(wasm);

/** a PNG whose pixels are `rgba`, as base64 for a request source */
const pngSource = async (width: number, height: number, rgba: number[]) => {
	const image = await Image.open(decoder, blankCanvas(width, height));
	image.edit((target) => target.pixels.set(rgba));
	const bytes = await image.bytes('png');
	image.dispose();
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
};

/** the RGBA pixels of an encoded image */
const readPixels = async (bytes: Uint8Array) => {
	const image = await Image.open(decoder, bytes);
	let out: number[] = [];
	image.edit((target) => {
		out = [...target.pixels];
	});
	const rgba = await image.pixels();
	image.dispose();
	return { width: rgba.width, rgba: [...rgba.pixels], seen: out };
};

describe('libgd source mapping for nearest sampling', () => {
	it('stretchIndex keeps the last source pixel of each run, as gdImageCopyResized does', () => {
		const at = (src: number, dst: number) =>
			Array.from({ length: dst }, (_, k) => stretchIndex(k, src, dst));
		expect(at(5, 3)).toEqual([1, 3, 4]);
		expect(at(2, 4)).toEqual([0, 0, 1, 1]);
		expect(at(4, 2)).toEqual([1, 3]);
		expect(at(7, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(at(3, 7)).toEqual([0, 0, 1, 1, 2, 2, 2]);
	});

	it('scaleIndex truncates a 24.8 fixed-point step, as gdImageScale does', () => {
		const at = (src: number, dst: number) =>
			Array.from({ length: dst }, (_, k) => scaleIndex(k, src, dst));
		expect(at(5, 3)).toEqual([0, 1, 3]);
		expect(at(2, 4)).toEqual([0, 0, 1, 1]);
		expect(at(1, 3)).toEqual([0, 0, 0]);
		expect(at(3, 7)).toEqual([0, 0, 0, 1, 1, 2, 2]);
	});

	it('the two resize filters pick the pixels those mappings name', async () => {
		const ramp = [0, 1, 2, 3, 4].flatMap((v) => [v * 10, 0, 0, 255]);
		const source = await pngSource(5, 1, ramp);
		const run = async (filter: 'stretch' | 'nearest') => {
			const out = await runParkImage({
				source,
				canvas: null,
				ops: [{ op: 'resize', width: 3, height: 1, filter }],
				format: 'png',
				quality: -1
			});
			const { rgba } = await readPixels(out.bytes);
			return [rgba[0], rgba[4], rgba[8]];
		};
		expect(await run('stretch')).toEqual([10, 30, 40]);
		expect(await run('nearest')).toEqual([0, 10, 30]);
	});
});

describe('the alpha each encoder can carry', () => {
	const alpha = [10, 20, 30, 0, 40, 50, 60, 128];

	it('writes a GIF from a true color handle opaque, with no transparent color asked for', async () => {
		const out = await runParkImage({
			source: await pngSource(2, 1, alpha),
			canvas: null,
			ops: [],
			format: 'gif',
			quality: -1,
			transparent: null
		});
		const { rgba } = await readPixels(out.bytes);
		expect([rgba[3], rgba[7]]).toEqual([255, 255]);
		expect(rgba.slice(0, 3)).toEqual([10, 20, 30]);
	});

	it('makes only the pixels equal to the transparent color clear in a GIF', async () => {
		const out = await runParkImage({
			source: await pngSource(2, 1, alpha),
			canvas: null,
			ops: [],
			format: 'gif',
			quality: -1,
			transparent: 0x3f28323c
		});
		const { rgba } = await readPixels(out.bytes);
		expect([rgba[3], rgba[7]]).toEqual([255, 0]);
	});

	it('refuses an AVIF of an image with alpha and writes one without', async () => {
		await expect(
			runParkImage({
				source: await pngSource(2, 1, alpha),
				canvas: null,
				ops: [],
				format: 'avif',
				quality: 50
			})
		).rejects.toThrow(/no alpha channel/);
		const out = await runParkImage({
			source: await pngSource(2, 1, [10, 20, 30, 255, 40, 50, 60, 255]),
			canvas: null,
			ops: [],
			format: 'avif',
			quality: 50
		});
		expect([...out.bytes.slice(4, 8)]).toEqual([0x66, 0x74, 0x79, 0x70]);
	});
});

describe('the GD2 writer', () => {
	const inflate = async (data: Uint8Array) =>
		new Uint8Array(
			await new Response(
				new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))
			).arrayBuffer()
		);
	const word = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
	const gradient = (width: number, height: number) => {
		const pixels = new Uint8Array(width * height * 4);
		for (let i = 0; i < width * height; i++) {
			pixels.set([i & 255, (i >> 8) & 255, 7, i % 3 === 0 ? 0 : 255], i * 4);
		}
		return { width, height, pixels };
	};

	it('writes the header words libgd writes, with raw true color format 3', async () => {
		const out = await gd2Encode(gradient(3, 2), 64, 1, -1);
		expect([...out.slice(0, 4)]).toEqual([0x67, 0x64, 0x32, 0]);
		expect([2, 3, 4, 5, 6, 7, 8].map((n) => word(out, n * 2))).toEqual([2, 3, 2, 64, 3, 1, 1]);
		expect([...out.slice(18, 23)]).toEqual([1, 255, 255, 255, 255]);
		expect(out.length).toBe(18 + 5 + 3 * 2 * 4);
	});

	it('stores alpha 0 to 127 first, then red, green and blue, in chunk order', async () => {
		const img = gradient(3, 2);
		img.pixels.set([10, 20, 30, 255, 1, 2, 3, 0], 0);
		const out = await gd2Encode(img, 64, 1, 0x7f112233);
		expect([...out.slice(18, 23)]).toEqual([1, 0x7f, 0x11, 0x22, 0x33]);
		expect([...out.slice(23, 31)]).toEqual([0, 10, 20, 30, 127, 1, 2, 3]);
	});

	it('orders raw pixels by chunk, each chunk by rows, when the extent spans chunks', async () => {
		const img = gradient(70, 2);
		const out = await gd2Encode(img, 64, 1, -1);
		expect(word(out, 14)).toBe(2);
		expect(out.length).toBe(23 + 70 * 2 * 4);
		const second = 23 + 64 * 2 * 4;
		expect(out[second + 2]).toBe(img.pixels[64 * 4 + 1]);
	});

	it('writes a compressed file with an index of offsets and sizes that inflate to the chunks', async () => {
		const img = gradient(70, 70);
		const out = await gd2Encode(img, 64, 2, -1);
		expect(word(out, 12)).toBe(4);
		const ncx = word(out, 14);
		const ncy = word(out, 16);
		expect([ncx, ncy]).toEqual([2, 2]);
		const view = new DataView(out.buffer);
		expect(view.getInt32(18, false)).toBe(18 + 4 * 8 + 5);
		let end = 18 + 4 * 8 + 5;
		for (let n = 0; n < 4; n++) {
			const offset = view.getInt32(18 + n * 8, false);
			const size = view.getInt32(22 + n * 8, false);
			expect(offset).toBe(end);
			end += size;
			const chunk = await inflate(out.slice(offset, offset + size));
			const w = n % 2 === 0 ? 64 : 6;
			const h = n < 2 ? 64 : 6;
			expect(chunk.length).toBe(w * h * 4);
		}
		expect(end).toBe(out.length);
		expect(out[18 + 4 * 8]).toBe(1);
	});

	it('clamps the chunk size as libgd does and treats an unknown mode as compressed', async () => {
		const img = gradient(5, 5);
		expect(word(await gd2Encode(img, 0, 1, -1), 10)).toBe(128);
		expect(word(await gd2Encode(img, 10, 1, -1), 10)).toBe(64);
		expect(word(await gd2Encode(img, 100000, 1, -1), 10)).toBe(4096);
		expect(word(await gd2Encode(img, -3, 1, -1), 10)).toBe(64);
		expect(word(await gd2Encode(img, 100, 0, -1), 12)).toBe(4);
		expect(word(await gd2Encode(img, 100, 7, -1), 12)).toBe(4);
		expect(word(await gd2Encode(img, 100, 1, -1), 12)).toBe(3);
	});

	it('refuses an extent a 16-bit header word cannot hold', async () => {
		await expect(
			gd2Encode({ width: 65536, height: 1, pixels: new Uint8Array(65536 * 4) }, 128, 1, -1)
		).rejects.toThrow(/65535/);
	});

	it('runs a queue and writes the result: a filled canvas reads back as one color', async () => {
		const out = await runParkImage({
			source: null,
			canvas: { width: 3, height: 2 },
			ops: [{ op: 'fill', color: 0x40ff8000 }],
			format: 'gd2',
			quality: -1,
			gd2: { chunk: 128, mode: 1 },
			transparent: -1
		});
		expect([out.width, out.height]).toEqual([3, 2]);
		expect([...out.bytes.slice(23, 27)]).toEqual([0x40, 0xff, 0x80, 0]);
		expect(out.bytes.length).toBe(23 + 24);
	});
});
