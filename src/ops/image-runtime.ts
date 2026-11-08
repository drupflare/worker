import { Image, TinyImgModule, mimeFor, transform as tinyTransform } from '@gmitch215/tinyimg';
import wasm from '@gmitch215/tinyimg/tinyimg.wasm';
import type { Transform } from './image-transform';

export {
	IMAGE_ROUTE_PREFIX,
	imageEngine,
	imagesDeliveryUrl,
	normaliseTransform,
	parseTransformPath,
	readImageRequest,
	supportedExtensions,
	transformIdentity,
	transformIsLarge,
	transformPath,
	type ImageUrlRequest,
	type Transform
} from './image-transform';

/**
 * The decoder module, compiled at module scope and instantiated on first use.
 *
 * workerd permits wasm codegen at startup and refuses it at request time, so the `.wasm` import
 * (`CompiledWasm`) stays at module scope; instantiating is not codegen and waits for the first
 * transform (1 MiB of linear memory per isolate). Separate from `image-transform.ts`, which the
 * gate and the object import without a second wasm module.
 */
let tinyimg: TinyImgModule | undefined;
const engine = (): TinyImgModule => (tinyimg ??= TinyImgModule.load(wasm));

/**
 * The decoder and its `transform`, as spool's WebP encoder adapter takes them. The module is not
 * touched until the encoder runs, so wiring it in costs an isolate nothing until an image converts.
 */
export const tinyimgBinding = () => ({ module: engine(), transform: tinyTransform });

/** whether anything has instantiated the decoder in this isolate */
export const engineLoaded = (): boolean => tinyimg !== undefined;

/**
 * What the shipped engine can encode, without instantiating it (the 1.1 build's `features`). The
 * package's type union also lists `heif`, which has no feature flag; `image-derivatives.spec.ts`
 * compares this list with a live instance.
 */
const SHIPPED_FEATURES = [
	'simd',
	'png',
	'jpeg',
	'bmp',
	'gif',
	'tiff',
	'webp',
	'avif',
	'text',
	'detect',
	'icc'
] as const;

/** the features the shipped engine can encode */
export function engineFeatures(): readonly string[] {
	return SHIPPED_FEATURES;
}

/** the decoder's own report of its features; instantiates it */
export const liveEngineFeatures = (): readonly string[] => engine().features;

/** what a transform produced */
export type TransformResult = { bytes: Uint8Array; contentType: string };

/**
 * Applies one Drupal image style.
 *
 * `fit` defaults to `cover` and the format to `webp`, matching {@link normaliseTransform} (the URL
 * identity must describe the transform performed).
 */
export async function runImageTransform(
	source: Uint8Array,
	transform: Transform
): Promise<TransformResult> {
	const format = transform.format ?? 'webp';
	const result = await tinyTransform(engine(), source, {
		...(transform.width === undefined ? {} : { width: transform.width }),
		...(transform.height === undefined ? {} : { height: transform.height }),
		fit: (transform.fit ?? 'cover') as never,
		format: format as never,
		quality: transform.quality ?? 80,
		// fast unless the style asks (`fancy` is 2 to 5% smaller for 1 to 10 ms more)
		...(transform.mode === 'fancy' ? { effort: 'fancy' as never } : {})
	});
	return {
		bytes: new Uint8Array(await result.bytes()),
		contentType: mimeFor(format as never)
	};
}

// #region queued gd operations

/** a gd handle's content: its source or blank canvas and the operations queued on it */
export type ParkImageSource = {
	source: string | null;
	canvas: { width: number; height: number } | null;
	ops: ParkImageOp[];
};

/** one operation a gd handle queued, as the drupflare module's gd shim writes it */
export type ParkImageOp =
	| { op: 'crop'; x: number; y: number; width: number; height: number }
	| {
			op: 'resize';
			width: number;
			height: number;
			filter?: 'nearest' | 'bilinear' | 'stretch';
	  }
	| { op: 'rotate'; degrees: number; background?: number; width?: number; height?: number }
	| { op: 'flip'; mode: number }
	| { op: 'fill'; x: number; y: number; color: number }
	| {
			op: 'copy';
			src: ParkImageSource;
			dx: number;
			dy: number;
			sx: number;
			sy: number;
			width: number;
			height: number;
			merge?: number;
			blend: boolean;
			skip?: number;
	  }
	| { op: 'filter'; type: number; arg1?: number };

/** a queued gd handle: its source or canvas, its operations and the output encoding */
export type ParkImageRequest = ParkImageSource & {
	format: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'gd2';
	quality: number;
	progressive?: boolean;
	transparent?: number | null;
	gd2?: { chunk: number; mode: number };
};

/** pixels a blank canvas may hold (a canvas is raw decoder memory before it is a file) */
const CANVAS_MAX_PIXELS = 16_000_000;

/** copies nested inside copies a request may carry, which bounds the work a descriptor can ask for */
const COPY_DEPTH_MAX = 4;

/** a black opaque 24-bit BMP, the smallest thing the decoder opens that has no source file */
export function blankCanvas(width: number, height: number): Uint8Array {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1 ||
		width * height > CANVAS_MAX_PIXELS
	) {
		throw new RangeError(
			`a canvas of ${width}x${height} is outside 1 to ${CANVAS_MAX_PIXELS} pixels`
		);
	}
	const row = Math.ceil((width * 3) / 4) * 4;
	const size = 54 + row * height;
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	out[0] = 0x42;
	out[1] = 0x4d;
	view.setUint32(2, size, true);
	view.setUint32(10, 54, true);
	view.setUint32(14, 40, true);
	view.setInt32(18, width, true);
	view.setInt32(22, height, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, 24, true);
	view.setUint32(34, row * height, true);
	return out;
}

/** gd's ARGB integer (alpha 0 opaque to 127 clear) as red, green, blue, alpha */
export function gdColor(color: number): [number, number, number, number] {
	const c = color >>> 0;
	const alpha = Math.min(127, (c >>> 24) & 0x7f);
	return [(c >>> 16) & 255, (c >>> 8) & 255, c & 255, 255 - alpha * 2];
}

// #region gd pixel arithmetic

/** libgd's constants for the filter types the queue serves, as PHP defines them */
export const GD_FILTER = {
	negate: 0,
	grayscale: 1,
	brightness: 2,
	contrast: 3,
	edgedetect: 5,
	emboss: 6,
	meanRemoval: 9,
	smooth: 10
} as const;

const f32 = Math.fround;

/** a pixel of an RGBA buffer as libgd holds it: alpha 0 opaque to 127 clear in the top byte */
function gdAt(p: Uint8Array, i: number): number {
	return ((127 - (p[i + 3]! >> 1)) << 24) | (p[i]! << 16) | (p[i + 1]! << 8) | p[i + 2]!;
}

/** writes libgd's ARGB integer back as RGBA, mapping alpha 127 to 0 and 0 to 255 */
function gdPut(p: Uint8Array, i: number, c: number): void {
	const opacity = 127 - ((c >>> 24) & 127);
	p[i] = (c >>> 16) & 255;
	p[i + 1] = (c >>> 8) & 255;
	p[i + 2] = c & 255;
	p[i + 3] = (opacity << 1) + (opacity >> 6);
}

/** libgd's `gdAlphaBlend`, integer division and all */
export function gdAlphaBlend(dst: number, src: number): number {
	const srcAlpha = (src >>> 24) & 127;
	if (srcAlpha === 0) return src;
	const dstAlpha = (dst >>> 24) & 127;
	if (srcAlpha === 127) return dst;
	if (dstAlpha === 127) return src;
	const srcWeight = 127 - srcAlpha;
	const dstWeight = Math.trunc(((127 - dstAlpha) * srcAlpha) / 127);
	const total = srcWeight + dstWeight;
	const alpha = Math.trunc((srcAlpha * dstAlpha) / 127);
	const mix = (shift: number) =>
		Math.trunc(
			(((src >>> shift) & 255) * srcWeight + ((dst >>> shift) & 255) * dstWeight) / total
		);
	return (alpha << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/** the pixels as RGBA, widening a 1, 2 or 3 channel decode */
function toRgba(width: number, height: number, channels: number, p: Uint8Array): Uint8Array {
	if (channels === 4) return p;
	const out = new Uint8Array(width * height * 4);
	for (let i = 0, o = 0; o < out.length; i += channels, o += 4) {
		const gray = channels <= 2;
		out[o] = p[i]!;
		out[o + 1] = gray ? p[i]! : p[i + 1]!;
		out[o + 2] = gray ? p[i]! : p[i + 2]!;
		out[o + 3] = channels === 2 ? p[i + 1]! : channels === 4 ? p[i + 3]! : 255;
	}
	return out;
}

/** a whole-canvas fill, which gd runs with alpha blending off */
function gdFill(dst: Uint8Array, color: number): void {
	for (let i = 0; i < dst.length; i += 4) gdPut(dst, i, color);
}

type Raw = { width: number; height: number; pixels: Uint8Array };

/**
 * `imagecopy` and `imagecopymerge` of a source rectangle onto `dst` at an offset.
 *
 * Copy runs libgd's per-pixel blend when alpha blending is on and a plain store when it is off. A
 * merge is libgd's `gdImageCopyMerge`: each channel is truncated from a float mix and the result is
 * opaque. A destination pixel outside the canvas is skipped, as libgd does, and so is a source
 * pixel of the source's transparent color: `skip` is that packed color, or -2 for an indexed
 * source, whose transparent entry decodes to alpha 0.
 */
export function gdCopy(
	dst: Raw,
	src: Raw,
	op: {
		dx: number;
		dy: number;
		sx: number;
		sy: number;
		width: number;
		height: number;
		skip?: number;
	},
	merge: number | undefined,
	blend: boolean
): void {
	for (let y = 0; y < op.height; y++) {
		const ty = op.dy + y;
		const sy = op.sy + y;
		if (ty < 0 || ty >= dst.height || sy < 0 || sy >= src.height) continue;
		for (let x = 0; x < op.width; x++) {
			const tx = op.dx + x;
			const sx = op.sx + x;
			if (tx < 0 || tx >= dst.width || sx < 0 || sx >= src.width) continue;
			const si = (sy * src.width + sx) * 4;
			const di = (ty * dst.width + tx) * 4;
			const s = gdAt(src.pixels, si);
			if (op.skip !== undefined && (op.skip === -2 ? s >>> 24 === 127 : s === op.skip))
				continue;
			if (merge === undefined) {
				gdPut(dst.pixels, di, blend ? gdAlphaBlend(gdAt(dst.pixels, di), s) : s);
				continue;
			}
			const d = gdAt(dst.pixels, di);
			const mix = (shift: number) =>
				Math.trunc(
					((s >>> shift) & 255) * (merge / 100) +
						(((d >>> shift) & 255) * (100 - merge)) / 100
				);
			const merged = (mix(16) << 16) | (mix(8) << 8) | mix(0);
			gdPut(dst.pixels, di, blend ? gdAlphaBlend(d, merged) : merged);
		}
	}
}

/**
 * The source index libgd's `gdImageCopyResized` writes destination index `k` from.
 *
 * It repeats source pixel `i` over the destination run `[floor(dst * i / src), floor(dst * (i + 1) /
 * src))`, so a reduction keeps the last source pixel of each run where a pixel-center sampler keeps
 * the middle one.
 */
export function stretchIndex(k: number, src: number, dst: number): number {
	return Math.floor(((k + 1) * src - 1) / dst);
}

/**
 * The source index libgd's `gdImageScale` takes for destination index `k` with nearest sampling:
 * a 24.8 fixed-point step of `src / dst` computed in single precision, truncated.
 */
export function scaleIndex(k: number, src: number, dst: number): number {
	const step = Math.trunc(f32(f32(src) / f32(dst)) * 256);
	return Math.floor((k * step) / 256);
}

/** nearest-neighbor resampling with libgd's source mapping, pixels copied unchanged */
function gdNearest(
	src: Raw,
	width: number,
	height: number,
	index: (k: number, src: number, dst: number) => number
): Raw {
	const pixels = new Uint8Array(width * height * 4);
	const cols = Array.from({ length: width }, (_, x) => index(x, src.width, width) * 4);
	for (let y = 0; y < height; y++) {
		const row = index(y, src.height, height) * src.width * 4;
		for (let x = 0; x < width; x++) {
			const from = row + cols[x]!;
			const to = (y * width + x) * 4;
			pixels[to] = src.pixels[from]!;
			pixels[to + 1] = src.pixels[from + 1]!;
			pixels[to + 2] = src.pixels[from + 2]!;
			pixels[to + 3] = src.pixels[from + 3]!;
		}
	}
	return { width, height, pixels };
}

/** the 3x3 kernels libgd's `imagefilter` types are built from: weights, divisor and offset */
function kernelFor(type: number, arg: number): { k: number[]; div: number; offset: number } {
	if (type === GD_FILTER.edgedetect) {
		return { k: [-1, 0, -1, 0, 4, 0, -1, 0, -1], div: 1, offset: 127 };
	}
	if (type === GD_FILTER.emboss) {
		return { k: [1.5, 0, 0, 0, 0, 0, 0, 0, -1.5], div: 1, offset: 127 };
	}
	if (type === GD_FILTER.meanRemoval) {
		return { k: [-1, -1, -1, -1, 9, -1, -1, -1, -1], div: 1, offset: 0 };
	}
	return { k: [1, 1, 1, 1, arg, 1, 1, 1, 1], div: arg + 8, offset: 0 };
}

/** libgd's `gdImageConvolution`: float accumulation, neighbors clamped to the edge, truncation */
function gdConvolve(img: Raw, kernel: { k: number[]; div: number; offset: number }): void {
	const { width, height, pixels } = img;
	const back = pixels.slice();
	const div = f32(kernel.div);
	const offset = f32(kernel.offset);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = f32(0);
			let g = f32(0);
			let b = f32(0);
			for (let j = 0; j < 3; j++) {
				const yy = Math.min(height - 1, Math.max(0, y - 1 + j));
				for (let i = 0; i < 3; i++) {
					const xx = Math.min(width - 1, Math.max(0, x - 1 + i));
					const at = (yy * width + xx) * 4;
					const w = f32(kernel.k[j * 3 + i]!);
					// libgd convolves a copy made with alpha blending on, which reads a fully clear pixel as black
					const clear = back[at + 3]! >> 1 === 0;
					r = f32(r + f32((clear ? 0 : back[at]!) * w));
					g = f32(g + f32((clear ? 0 : back[at + 1]!) * w));
					b = f32(b + f32((clear ? 0 : back[at + 2]!) * w));
				}
			}
			const out = (y * width + x) * 4;
			const fin = (v: number) => {
				const c = f32(f32(v / div) + offset);
				return c > 255 ? 255 : c < 0 ? 0 : Math.trunc(c);
			};
			pixels[out] = fin(r);
			pixels[out + 1] = fin(g);
			pixels[out + 2] = fin(b);
		}
	}
}

/**
 * `imagefilter` for the eight types a CMS calls. Alpha is left alone by every one of them.
 *
 * @throws RangeError For a type the queue does not serve.
 */
export function gdFilter(img: Raw, type: number, arg1 = 0): void {
	const p = img.pixels;
	const clamp = (v: number) => (v > 255 ? 255 : v < 0 ? 0 : v);
	if (type === GD_FILTER.negate) {
		for (let i = 0; i < p.length; i += 4) {
			p[i] = 255 - p[i]!;
			p[i + 1] = 255 - p[i + 1]!;
			p[i + 2] = 255 - p[i + 2]!;
		}
	} else if (type === GD_FILTER.grayscale) {
		for (let i = 0; i < p.length; i += 4) {
			const y = Math.trunc(0.299 * p[i]! + 0.587 * p[i + 1]! + 0.114 * p[i + 2]!);
			p[i] = p[i + 1] = p[i + 2] = y;
		}
	} else if (type === GD_FILTER.brightness) {
		const add = Math.max(-255, Math.min(255, Math.trunc(arg1)));
		for (let i = 0; i < p.length; i += 4) {
			p[i] = clamp(p[i]! + add);
			p[i + 1] = clamp(p[i + 1]! + add);
			p[i + 2] = clamp(p[i + 2]! + add);
		}
	} else if (type === GD_FILTER.contrast) {
		const level = ((100 - arg1) / 100) ** 2;
		const map = (v: number) => {
			const out = ((v / 255 - 0.5) * level + 0.5) * 255;
			return out > 255 ? 255 : out < 0 ? 0 : Math.trunc(out);
		};
		for (let i = 0; i < p.length; i += 4) {
			p[i] = map(p[i]!);
			p[i + 1] = map(p[i + 1]!);
			p[i + 2] = map(p[i + 2]!);
		}
	} else if (
		type === GD_FILTER.edgedetect ||
		type === GD_FILTER.emboss ||
		type === GD_FILTER.meanRemoval ||
		type === GD_FILTER.smooth
	) {
		gdConvolve(img, kernelFor(type, arg1));
	} else {
		throw new RangeError(`imagefilter type ${type} is not served by the queue`);
	}
}

// #endregion

/** the encoded or blank source of a handle, as bytes the decoder opens */
function sourceBytes(request: ParkImageSource): Uint8Array {
	const source =
		request.source !== null
			? Uint8Array.from(atob(request.source), (ch) => ch.charCodeAt(0))
			: request.canvas
				? blankCanvas(request.canvas.width, request.canvas.height)
				: null;
	if (source === null) throw new TypeError('the request carries neither a source nor a canvas');
	return source;
}

/**
 * Gives a rotated image the extent gd would have produced.
 *
 * The decoder rounds the rotated extent where gd takes the ceiling, so a free angle can land one
 * pixel short. The rotated pixels are centered on a canvas of the extent PHP reports through
 * `imagesx()`, filled with the rotation's background.
 */
async function fitExtent(
	image: Image,
	width: number,
	height: number,
	background: number
): Promise<Image> {
	const raw = await image.pixels();
	if (raw.width === width && raw.height === height) return image;
	const layer: Raw = {
		width: raw.width,
		height: raw.height,
		pixels: toRgba(raw.width, raw.height, raw.channels, raw.pixels)
	};
	image.dispose();
	const canvas = await Image.open(engine(), blankCanvas(width, height));
	canvas.edit((target) => {
		gdFill(target.pixels, background);
		gdCopy(
			target,
			layer,
			{
				dx: Math.floor((width - raw.width) / 2),
				dy: Math.floor((height - raw.height) / 2),
				sx: 0,
				sy: 0,
				width: raw.width,
				height: raw.height
			},
			undefined,
			false
		);
	});
	return canvas;
}

/**
 * Runs a handle's queue and returns the image holding its result.
 *
 * `Image` runs every plan operation before any after-plan step, so a geometry operation that
 * follows a pixel operation first writes the pixels out losslessly and reopens them, which keeps
 * the queue's order.
 */
async function realize(request: ParkImageSource, depth: number): Promise<Image> {
	let image = await Image.open(engine(), sourceBytes(request));
	let dirty = false;
	try {
		for (const op of request.ops) {
			const sampled =
				op.op === 'resize' && op.filter !== undefined && op.filter !== 'bilinear';
			if (dirty && !sampled && op.op !== 'fill' && op.op !== 'filter' && op.op !== 'copy') {
				const png = await image.bytes('png', { compression: 'fast' });
				image.dispose();
				image = await Image.open(engine(), png);
				dirty = false;
			}
			if (op.op === 'crop') image.crop(op.x, op.y, op.width, op.height);
			else if (op.op === 'resize' && sampled) {
				const raw = await image.pixels();
				const layer: Raw = {
					width: raw.width,
					height: raw.height,
					pixels: toRgba(raw.width, raw.height, raw.channels, raw.pixels)
				};
				const out = gdNearest(
					layer,
					op.width,
					op.height,
					op.filter === 'stretch' ? stretchIndex : scaleIndex
				);
				image.dispose();
				image = await Image.open(engine(), blankCanvas(op.width, op.height));
				image.edit((target) => target.pixels.set(out.pixels));
				dirty = true;
			} else if (op.op === 'resize') image.resize(op.width, op.height, 'bilinear');
			else if (op.op === 'flip') {
				image.flip(op.mode === 3 ? 'both' : op.mode === 2 ? 'vertical' : 'horizontal');
			} else if (op.op === 'rotate') {
				if (op.background !== undefined) image.background(gdColor(op.background));
				image.rotateFree(op.degrees);
				dirty = op.degrees % 90 !== 0;
				if (dirty && op.width !== undefined && op.height !== undefined) {
					image = await fitExtent(image, op.width, op.height, op.background ?? 0);
				}
			} else if (op.op === 'fill') {
				image.edit((raw) => gdFill(raw.pixels, op.color));
				dirty = true;
			} else if (op.op === 'filter') {
				image.edit((raw) => gdFilter(raw, op.type, op.arg1 ?? 0));
				dirty = true;
			} else if (op.op === 'copy') {
				if (depth >= COPY_DEPTH_MAX) throw new RangeError('copies nest too deeply');
				const sub = await realize(op.src, depth + 1);
				let layer: Raw;
				try {
					const raw = await sub.pixels();
					layer = {
						width: raw.width,
						height: raw.height,
						pixels: toRgba(raw.width, raw.height, raw.channels, raw.pixels)
					};
				} finally {
					sub.dispose();
				}
				image.edit((raw) => gdCopy(raw, layer, op, op.merge, op.blend));
				dirty = true;
			}
		}
		return image;
	} catch (e) {
		image.dispose();
		throw e;
	}
}

/**
 * Writes the alpha libgd's GIF writer gives a true color image: none, except that pixels equal to
 * the image's transparent color become the GIF's transparent color.
 */
function gdGifAlpha(raw: Raw, transparent: number | null): void {
	const p = raw.pixels;
	for (let i = 0; i < p.length; i += 4) {
		p[i + 3] = transparent !== null && gdAt(p, i) === transparent ? 0 : 255;
	}
}

/** the AVIF encoder writes no alpha channel, so an image that has one is refused rather than flattened */
function assertOpaque(raw: Raw): void {
	const p = raw.pixels;
	for (let i = 3; i < p.length; i += 4) {
		if (p[i]! !== 255) throw new RangeError('the AVIF encoder writes no alpha channel');
	}
}

// #region gd2

const GD2_CHUNK_DEFAULT = 128;
const GD2_CHUNK_MIN = 64;
const GD2_CHUNK_MAX = 4096;
const GD2_FMT_RAW = 1;
const GD2_FMT_TRUECOLOR_RAW = 3;
const GD2_FMT_TRUECOLOR_COMPRESSED = 4;

/** zlib-wrapped deflate at the default level, which is what libgd's `compress()` writes */
async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The bytes `imagegd2` writes for a true color image, laid out as libgd 2.3.3 `_gdImageGd2` does.
 *
 * The header is the id `gd2` and its NUL, then big-endian words for the version, extent, chunk
 * size, format and chunk counts. A compressed file carries an index of offset and size per chunk
 * before the color block; a raw file carries none. Chunks run in row-major order and each holds
 * its rows as alpha (0 opaque to 127 clear), red, green, blue. `chunk` follows libgd: 0 is 128 and
 * anything else is clamped to 64 through 4096. A mode other than 1 (raw) writes compressed, as
 * libgd forces it. `transparent` is the image's transparent color, -1 for none.
 */
export async function gd2Encode(
	raw: Raw,
	chunk: number,
	mode: number,
	transparent: number
): Promise<Uint8Array> {
	const { width, height, pixels } = raw;
	if (width > 65535 || height > 65535) {
		throw new RangeError(
			`a GD2 file holds at most 65535 pixels per side, not ${width}x${height}`
		);
	}
	const cs =
		chunk === 0
			? GD2_CHUNK_DEFAULT
			: Math.min(GD2_CHUNK_MAX, Math.max(GD2_CHUNK_MIN, Math.trunc(chunk)));
	const compressed = mode !== GD2_FMT_RAW;
	const ncx = Math.ceil(width / cs);
	const ncy = Math.ceil(height / cs);
	const header = new Uint8Array(18);
	const hv = new DataView(header.buffer);
	header.set([0x67, 0x64, 0x32, 0]);
	hv.setUint16(4, 2);
	hv.setUint16(6, width);
	hv.setUint16(8, height);
	hv.setUint16(10, cs);
	hv.setUint16(12, compressed ? GD2_FMT_TRUECOLOR_COMPRESSED : GD2_FMT_TRUECOLOR_RAW);
	hv.setUint16(14, ncx);
	hv.setUint16(16, ncy);
	const colors = new Uint8Array(5);
	colors[0] = 1;
	new DataView(colors.buffer).setInt32(1, transparent | 0);
	const chunks: Uint8Array[] = [];
	for (let cy = 0; cy < ncy; cy++) {
		for (let cx = 0; cx < ncx; cx++) {
			const ylo = cy * cs;
			const yhi = Math.min(height, ylo + cs);
			const xlo = cx * cs;
			const xhi = Math.min(width, xlo + cs);
			const data = new Uint8Array((yhi - ylo) * (xhi - xlo) * 4);
			let o = 0;
			for (let y = ylo; y < yhi; y++) {
				for (let x = xlo, i = (y * width + xlo) * 4; x < xhi; x++, i += 4) {
					data[o++] = 127 - (pixels[i + 3]! >> 1);
					data[o++] = pixels[i]!;
					data[o++] = pixels[i + 1]!;
					data[o++] = pixels[i + 2]!;
				}
			}
			chunks.push(compressed ? await zlibDeflate(data) : data);
		}
	}
	const index = new Uint8Array(compressed ? chunks.length * 8 : 0);
	let at = header.length + index.length + colors.length;
	const iv = new DataView(index.buffer);
	if (compressed) {
		chunks.forEach((c, n) => {
			iv.setInt32(n * 8, at);
			iv.setInt32(n * 8 + 4, c.length);
			at += c.length;
		});
	}
	const out = new Uint8Array(
		header.length + index.length + colors.length + chunks.reduce((n, c) => n + c.length, 0)
	);
	out.set(header);
	out.set(index, header.length);
	out.set(colors, header.length + index.length);
	let pos = header.length + index.length + colors.length;
	for (const c of chunks) {
		out.set(c, pos);
		pos += c.length;
	}
	return out;
}

// #endregion

/** applies a gd handle's queue to its source (or a blank canvas) and encodes the result */
export async function runParkImage(
	request: ParkImageRequest
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
	const image = await realize(request, 0);
	try {
		if (request.format === 'gd2') {
			const { chunk, mode } = request.gd2 ?? { chunk: 0, mode: GD2_FMT_RAW };
			const px = await image.pixels();
			const layer: Raw = {
				width: px.width,
				height: px.height,
				pixels: toRgba(px.width, px.height, px.channels, px.pixels)
			};
			const bytes = await gd2Encode(layer, chunk, mode, request.transparent ?? -1);
			return { bytes, width: px.width, height: px.height };
		}
		if (request.format === 'gif' && request.transparent !== undefined) {
			const transparent = request.transparent;
			image.edit((raw) => gdGifAlpha(raw, transparent));
		} else if (request.format === 'avif') {
			image.edit(assertOpaque);
		}
		const size = image.decide().output;
		const quality = request.format === 'png' || request.quality < 0 ? 0 : request.quality;
		const bytes = await image.bytes(request.format, {
			quality,
			...(request.progressive ? { progressive: true } : {})
		});
		return { bytes, width: size.width, height: size.height };
	} finally {
		image.dispose();
	}
}

// #endregion
