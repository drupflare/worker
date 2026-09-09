import { TinyImgModule, mimeFor, transform as tinyTransform } from '@gmitch215/tinyimg';
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
 * The decoder, compiled once at MODULE SCOPE.
 *
 * That placement is a platform requirement rather than an optimisation: workerd permits wasm
 * codegen at worker STARTUP and refuses it at request time, so compiling inside the handler throws.
 * The `.wasm` import arrives pre-compiled through wrangler's `CompiledWasm` rule, which is the same
 * mechanism the interpreter's own seam uses.
 *
 * Separate from `image-transform.ts` so that module stays importable by the gate and by the object
 * without pulling a second wasm module into either.
 */
const tinyimg = TinyImgModule.load(wasm);

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
	const result = await tinyTransform(tinyimg, source, {
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
