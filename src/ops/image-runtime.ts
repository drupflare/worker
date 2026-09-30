import { Image, TinyImgModule, mimeFor, transform as tinyTransform } from '@gmitch215/tinyimg';
import wasm from '@gmitch215/tinyimg/tinyimg.wasm';
import type { Transform } from './image-transform.js';

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
} from './image-transform.js';

/**
 * The decoder module, compiled at MODULE SCOPE and instantiated on first use.
 *
 * Compiling at module scope is a platform requirement: workerd permits wasm codegen at worker
 * STARTUP and refuses it at request time, so the `.wasm` import (pre-compiled through wrangler's
 * `CompiledWasm` rule) is what stays at module scope. Instantiating it is not codegen, so it waits
 * for the first transform: an instance holds a linear memory (1 MiB at load) in every isolate that
 * imports this module, and a site with no images never needs it.
 *
 * Separate from `image-transform.ts` so that module stays importable by the gate and by the object
 * without pulling a second wasm module into either.
 */
let tinyimg: TinyImgModule | undefined;
const engine = (): TinyImgModule => (tinyimg ??= TinyImgModule.load(wasm));

/** whether anything has instantiated the decoder in this isolate */
export const engineLoaded = (): boolean => tinyimg !== undefined;

/**
 * What the shipped engine reports it can encode, answered without instantiating it.
 *
 * Read off the 1.1 build's `features`; the type union in `@gmitch215/tinyimg` lists `heif` too and
 * there is NO feature flag for it, so a format being in that union says nothing about this build
 * encoding it. `image-derivatives.spec.ts` compares this list with a live instance, so a package
 * bump that changes it fails there instead of silently degrading styles.
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
 * `fit` defaults to `cover` and the format to `webp`, which is what
 * {@link normaliseTransform} already assumes -- the two have to agree or the identity in the URL
 * describes a transform the runtime does not perform.
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
		// FAST unless the style asked otherwise. Measured across the four shipped styles, `fancy` is
		// 2 to 5% smaller for 1 to 10 ms more; on a derivative that is written once and served many
		// times that trade is worth offering and not worth defaulting to
		...(transform.mode === 'fancy' ? { effort: 'fancy' as never } : {})
	});
	return {
		bytes: new Uint8Array(await result.bytes()),
		contentType: mimeFor(format as never)
	};
}

// #region queued gd operations

/** one operation a gd handle queued, as the drupflare module's gd shim writes it */
export type ParkImageOp =
	| { op: 'crop'; x: number; y: number; width: number; height: number }
	| { op: 'resize'; width: number; height: number; filter?: 'nearest' | 'bilinear' }
	| { op: 'rotate'; degrees: number; background?: number };

export type ParkImageRequest = {
	source: string | null;
	canvas: { width: number; height: number } | null;
	ops: ParkImageOp[];
	format: 'jpeg' | 'png' | 'webp' | 'gif';
	quality: number;
};

/** pixels a blank canvas may hold; a canvas is raw memory in the decoder before it is a file */
const CANVAS_MAX_PIXELS = 16_000_000;

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

/** applies a gd handle's queue to its source (or a blank canvas) and encodes the result */
export async function runParkImage(
	request: ParkImageRequest
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
	const source =
		request.source !== null
			? Uint8Array.from(atob(request.source), (ch) => ch.charCodeAt(0))
			: request.canvas
				? blankCanvas(request.canvas.width, request.canvas.height)
				: null;
	if (source === null) throw new TypeError('the request carries neither a source nor a canvas');
	const image = await Image.open(engine(), source);
	try {
		for (const op of request.ops) {
			if (op.op === 'crop') image.crop(op.x, op.y, op.width, op.height);
			else if (op.op === 'resize') image.resize(op.width, op.height, op.filter ?? 'bilinear');
			else if (op.op === 'rotate') {
				if (op.background !== undefined) image.background(gdColor(op.background));
				image.rotateFree(op.degrees);
			}
		}
		const size = image.decide().output;
		const quality = request.format === 'png' || request.quality < 0 ? 0 : request.quality;
		const bytes = await image.bytes(request.format, { quality });
		return { bytes, width: size.width, height: size.height };
	} finally {
		image.dispose();
	}
}

// #endregion
