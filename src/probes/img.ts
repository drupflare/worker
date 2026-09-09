import { runImageTransform } from '../ops/image-runtime.js';
import type { Transform } from '../ops/image-transform.js';

/**
 * What an image derivative costs on the EDGE, which is the only instrument for it.
 *
 * The figures the arm was scoped on are laptop wall clock in `wrangler dev` -- 3 / 7 / 22 / 32 ms
 * across the four shipped styles. RULE 0 says an absolute CPU figure comes only from `cpuTime` on a
 * deployed worker, and the free arm needs its own reading because `FREE_CPU_MS_CAP` is 10 while a
 * measured cold boot is 1,398 ms and succeeds. Whether a 42 ms transform fits on free is exactly the
 * kind of question this project has been wrong about in both directions.
 *
 * ONE TRANSFORM PER INVOCATION. `cpuTime` bounds an invocation, so anything that runs several and
 * divides is reporting a mean the meter never measured -- and at 1 ms granularity the small styles
 * need amortising, which is what `?n=` is for: it says out loud that the reading is a total over N
 * and not a per-transform figure.
 *
 * `?style=` picks one of the four the standard profile ships. `?mode=fancy` is the other arm.
 */

const STYLES: Record<string, Transform> = {
	thumbnail: { width: 100, height: 100, fit: 'cover', format: 'webp', quality: 80 },
	medium: { width: 220, height: 220, fit: 'cover', format: 'webp', quality: 80 },
	large: { width: 480, height: 480, fit: 'cover', format: 'webp', quality: 80 },
	wide: { width: 1090, height: 1090, fit: 'cover', format: 'webp', quality: 80 }
};

/**
 * A source image built in the worker, so the probe fetches nothing.
 *
 * A subrequest would put network time inside the invocation this is trying to measure. PNG rather
 * than JPEG because a valid one can be emitted without an encoder: a single IDAT of raw scanlines,
 * stored uncompressed in a zlib wrapper.
 */
function sourcePng(width: number, height: number): Uint8Array {
	const crcTable = (() => {
		const t = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			t[n] = c >>> 0;
		}
		return t;
	})();
	const crc32 = (bytes: Uint8Array): number => {
		let c = 0xffffffff;
		for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const be = (n: number): Uint8Array =>
		new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
	const chunk = (type: string, body: Uint8Array): Uint8Array => {
		const name = new TextEncoder().encode(type);
		const payload = new Uint8Array(name.length + body.length);
		payload.set(name);
		payload.set(body, name.length);
		const out = new Uint8Array(4 + payload.length + 4);
		out.set(be(body.length));
		out.set(payload, 4);
		out.set(be(crc32(payload)), 4 + payload.length);
		return out;
	};

	// raw scanlines: a filter byte plus RGB per pixel, with a gradient so the encoder has real work
	const raw = new Uint8Array(height * (1 + width * 3));
	let at = 0;
	for (let y = 0; y < height; y++) {
		raw[at++] = 0;
		for (let x = 0; x < width; x++) {
			raw[at++] = (x * 7) & 255;
			raw[at++] = (y * 5) & 255;
			raw[at++] = ((x + y) * 3) & 255;
		}
	}
	// zlib with STORED deflate blocks; no compressor needed and every decoder accepts it
	const blocks: number[] = [0x78, 0x01];
	for (let i = 0; i < raw.length; i += 65535) {
		const size = Math.min(65535, raw.length - i);
		blocks.push(
			i + size >= raw.length ? 1 : 0,
			size & 255,
			size >>> 8,
			~size & 255,
			(~size >>> 8) & 255
		);
		for (let j = 0; j < size; j++) blocks.push(raw[i + j] as number);
	}
	let a = 1;
	let b = 0;
	for (const byte of raw) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	const adler = ((b << 16) | a) >>> 0;
	const idat = new Uint8Array(blocks.length + 4);
	idat.set(blocks);
	idat.set(be(adler), blocks.length);

	const ihdr = new Uint8Array(13);
	ihdr.set(be(width));
	ihdr.set(be(height), 4);
	ihdr.set([8, 2, 0, 0, 0], 8);

	const parts = [
		new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', idat),
		chunk('IEND', new Uint8Array(0))
	];
	const total = parts.reduce((n, p) => n + p.length, 0);
	const png = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		png.set(part, offset);
		offset += part.length;
	}
	return png;
}

/** built once per isolate, so the measured invocation pays for the transform and nothing else */
const sources = new Map<number, Uint8Array>();

function source(width: number): Uint8Array {
	let png = sources.get(width);
	if (png === undefined) {
		png = sourcePng(width, Math.round(width * 0.667));
		sources.set(width, png);
	}
	return png;
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const style = url.searchParams.get('style') ?? 'medium';
		const transform = STYLES[style];
		if (!transform) {
			return Response.json({ ok: false, error: `unknown style ${style}` }, { status: 400 });
		}
		const n = Math.max(1, Math.min(Number(url.searchParams.get('n') ?? 1), 200));
		const mode = url.searchParams.get('mode') === 'fancy' ? 'fancy' : 'fast';
		const width = Math.max(64, Math.min(Number(url.searchParams.get('src') ?? 768), 2048));

		if (url.pathname === '/warm') {
			// the module is compiled at worker startup; this is the first CALL, which pays whatever
			// one-time work the decoder does and must not be inside a measured invocation
			const png = source(width);
			await runImageTransform(png, STYLES.thumbnail as Transform);
			return Response.json({ ok: true, warmed: true, sourceBytes: png.length });
		}

		// THE SOURCE IS NOT THE MEASUREMENT, and the first run of this probe measured it anyway.
		// `sourcePng()` builds an uncompressed PNG in JS, and inside the invocation it dominated:
		// thumbnail, medium and large all read ~125-142 ms of cpuTime, which is flat where the
		// transform is not. Cached across invocations, and `?only=source` is the CONTROL rather
		// than a subtraction taken on faith
		const png = source(width);
		if (url.searchParams.get('only') === 'source') {
			return Response.json({ ok: true, only: 'source', sourceBytes: png.length });
		}
		let bytes = 0;
		for (let i = 0; i < n; i++) {
			const out = await runImageTransform(png, { ...transform, mode });
			bytes = out.bytes.length;
		}
		return Response.json({
			ok: true,
			style,
			mode,
			n,
			sourceBytes: png.length,
			outputBytes: bytes,
			// NOT a duration. `Date.now()` does not advance across synchronous work in a Worker, so
			// the only reading that means anything is `cpuTime` from the tail event
			note: 'read cpuTime from wrangler tail; this reply carries no timing on purpose'
		});
	}
};
