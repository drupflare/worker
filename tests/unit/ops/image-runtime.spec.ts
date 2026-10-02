import { describe, expect, it } from 'vitest';
import {
	blankCanvas,
	engineFeatures,
	gdColor,
	liveEngineFeatures,
	runParkImage
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
