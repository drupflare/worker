import { describe, expect, it } from 'vitest';
import {
	IMAGE_ROUTE_PREFIX,
	INLINE_TRANSFORM_MAX_EDGE,
	imageEngine,
	imagesDeliveryUrl,
	normaliseTransform,
	parseTransformPath,
	readImageRequest,
	supportedExtensions,
	transformIdentity,
	transformIsLarge,
	transformPath
} from '../../../src/ops/image-transform';

/**
 * The image arm, on a wasm engine rather than a delivery product.
 *
 * `FREE_QUOTAS.imageTransformsPerMonth` is 5,000 and it is a CAP: four shipped styles means 1,250
 * images a month before a site stops generating derivatives at all. Neither Cloudflare mechanism
 * exists on `*.workers.dev` and neither carries a session, so `private://` was never reachable
 * through either.
 */

describe('the request contract, which was broken on both sides at once', () => {
	it('reads what PHP actually sends', () => {
		// PHP sends `{uri, transform}` and the host read `req.url` with a flat `req.width`, so
		// `cfwImageUrl` returned null on every call -- and both lanes passed, because neither put
		// the two halves together
		const out = readImageRequest({
			uri: 'public://cake.jpg',
			transform: { width: 220, height: 220, fit: 'cover', quality: 80, format: 'webp' }
		});
		expect(out.uri).toBe('public://cake.jpg');
		expect(out.transform).toEqual({
			width: 220,
			height: 220,
			fit: 'cover',
			quality: 80,
			format: 'webp'
		});
	});

	it('still reads the older flat shape, so an unpacked driver does not answer null', () => {
		const out = readImageRequest({ url: 'public://a.png', width: 100, height: 50 });
		expect(out.uri).toBe('public://a.png');
		expect(out.transform.width).toBe(100);
		expect(out.transform.height).toBe(50);
	});

	it('drops values it does not recognise rather than passing them through', () => {
		const out = readImageRequest({
			uri: 'public://a.png',
			transform: { fit: 'sideways', format: 'bmp', quality: 900, mode: 'turbo', width: -3 }
		});
		expect(out.transform).toEqual({});
	});

	it('normalises jpg to jpeg, so two spellings are one identity', () => {
		expect(readImageRequest({ uri: 'x', transform: { format: 'jpg' } }).transform.format).toBe(
			'jpeg'
		);
	});
});

describe('the derivative identity', () => {
	it('is the same for two spellings of one transform', () => {
		const a = transformIdentity('public://a.png', { width: 100, fit: 'cover', quality: 80 });
		const b = transformIdentity('public://a.png', { quality: 80, fit: 'cover', width: 100 });
		expect(a).toBe(b);
	});

	it('moves when the style moves, so an old derivative stays addressable', () => {
		const before = transformIdentity('public://a.png', { width: 100 });
		const after = transformIdentity('public://a.png', { width: 120 });
		expect(before).not.toBe(after);
	});

	it('moves when the source moves', () => {
		expect(transformIdentity('public://a.png', { width: 100 })).not.toBe(
			transformIdentity('public://b.png', { width: 100 })
		);
	});

	it('fills in the defaults the runtime actually applies', () => {
		// the normalisation and the runtime have to agree, or the identity in the URL describes a
		// transform nothing performs
		expect(normaliseTransform({})).toBe('fit=cover&q=80&f=webp&m=fast');
	});
});

describe('the delivery path round-trips, and refuses one that was edited', () => {
	const transform = { width: 220, height: 220, fit: 'cover', quality: 80, format: 'webp' };

	it('parses back exactly what it emitted', () => {
		const path = transformPath('public://cake.jpg', transform);
		const url = new URL(`https://site.test${path}`);
		const back = parseTransformPath(url.pathname, url.search);
		expect(back?.uri).toBe('public://cake.jpg');
		// NORMALISED, not identical: the path carries the defaults the runtime applies, so `mode`
		// comes back as `fast` even though the caller did not name it. Anything else would mean the
		// URL described a transform and the runtime performed another
		expect(back?.transform).toEqual({ ...transform, mode: 'fast' });
		expect(normaliseTransform(back?.transform ?? {})).toBe(normaliseTransform(transform));
	});

	it('refuses a query someone widened', () => {
		// re-deriving the identity is what stops a caller asking for any transform of any file, and
		// spending the site's CPU on work nobody wanted
		const path = transformPath('public://cake.jpg', transform);
		const url = new URL(`https://site.test${path}`);
		url.searchParams.set('w', '4000');
		expect(parseTransformPath(url.pathname, url.search)).toBeNull();
	});

	it('refuses a swapped source under a valid identity', () => {
		const path = transformPath('public://cake.jpg', transform);
		const url = new URL(`https://site.test${path}`);
		const swapped = url.pathname.replace('cake.jpg', 'secret.jpg');
		expect(parseTransformPath(swapped, url.search)).toBeNull();
	});

	it('refuses anything that is not this route', () => {
		expect(parseTransformPath('/serve', '')).toBeNull();
		expect(parseTransformPath(`${IMAGE_ROUTE_PREFIX}/`, '')).toBeNull();
		expect(parseTransformPath(`${IMAGE_ROUTE_PREFIX}/abc`, '')).toBeNull();
	});

	it('survives a uri with characters that need encoding', () => {
		const uri = 'public://a b/c&d?e.png';
		const path = transformPath(uri, { width: 100 });
		const url = new URL(`https://site.test${path}`);
		expect(parseTransformPath(url.pathname, url.search)?.uri).toBe(uri);
	});
});

describe('which engine answers, and what it may claim', () => {
	it('defaults to the wasm engine', () => {
		expect(imageEngine()).toBe('tinyimg');
		expect(imageEngine({})).toBe('tinyimg');
		expect(imageEngine({ IMAGE_ENGINE: 'tinyimg' })).toBe('tinyimg');
	});

	it('hands over to Cloudflare Images when a zone asks', () => {
		expect(imageEngine({ IMAGE_ENGINE: 'images' })).toBe('images');
		expect(imageEngine({ IMAGE_ENGINE: 'Images' })).toBe('images');
	});

	/**
	 * THE HALF THAT WOULD HAVE SHIPPED BROKEN.
	 *
	 * All four shipped styles are `image_scale` + `image_convert_avif`.
	 * `AvifImageEffect::applyEffect()` calls `isAvifSupported()` first and falls through to its
	 * parent when the toolkit says no, and the shipped fallback extension is `webp`. So core
	 * degrades by itself -- provided the toolkit tells the truth. Claiming `avif` on an engine that
	 * cannot produce it makes the effect call `convert('avif')`, get FALSE, and log a failed
	 * derivative rather than falling back.
	 */
	it('claims avif only on the engine that encodes it', () => {
		expect(supportedExtensions('images')).toContain('avif');
		// the wasm arm answers from what the loaded module reports, so both directions are real
		expect(supportedExtensions('tinyimg', ['png', 'jpeg', 'webp'])).not.toContain('avif');
		expect(supportedExtensions('tinyimg', ['png', 'jpeg', 'webp', 'avif'])).toContain('avif');
	});

	/**
	 * The reason this stopped being a function of the engine NAME.
	 *
	 * tinyimg 1.0 could not encode AVIF and 1.1 can. With the capability hardcoded against the
	 * name, all four shipped styles went on degrading to webp after the upgrade and nothing said
	 * so -- the same shape as a `run: false` outliving the limit that justified it.
	 */
	it('reads the wasm arm from the features it was handed, not from its name', () => {
		const shipped = ['simd', 'png', 'jpeg', 'bmp', 'gif', 'tiff', 'webp', 'avif', 'icc'];
		const claimed = supportedExtensions('tinyimg', shipped);
		expect(claimed).toContain('avif');
		expect(claimed).toContain('tiff');
		// `simd` and `icc` are capabilities rather than formats, so neither becomes an extension
		expect(claimed).not.toContain('simd');
		expect(claimed).not.toContain('icc');
		// jpeg is reachable by three, and Drupal matches on the extension rather than the format
		expect(claimed).toEqual(expect.arrayContaining(['jpe', 'jpeg', 'jpg']));
	});

	it('falls back to the pre-1.1 set when no features are named', () => {
		// an older host answers no `extensions`, and claiming a format it cannot encode is the one
		// failure this list exists to avoid
		expect(supportedExtensions('tinyimg')).toEqual([
			'png',
			'jpe',
			'jpeg',
			'jpg',
			'gif',
			'webp'
		]);
	});

	it('claims webp on both, which is what the fallback lands on', () => {
		expect(supportedExtensions('tinyimg', ['webp'])).toContain('webp');
		expect(supportedExtensions('images')).toContain('webp');
	});

	it('still builds an Images delivery URL for a zone that wants one', () => {
		expect(imagesDeliveryUrl('public://a.png', { width: 100, format: 'avif' })).toBe(
			'/cdn-cgi/image/width=100,fit=cover,format=avif' + 'public://a.png'
		);
	});
});

describe('where a transform runs', () => {
	/**
	 * THE THRESHOLD IS MEASURED, and the first one was a guess that put a 63 ms style on the queue.
	 *
	 * Deployed free worker, `cpuTime` amortised over ten transforms per invocation, median of
	 * twelve, source-only control at 0 ms: 36.3 ms at 100px, 48.6 at 220, 63.5 at 480, 188.2 at
	 * 1090. The laptop wall clock the arm was scoped on understates that by 6 to 12x.
	 */
	it('keeps every style up to the measured knee inline', () => {
		expect(transformIsLarge({ width: 100 })).toBe(false);
		expect(transformIsLarge({ width: 220, height: 220 })).toBe(false);
		expect(transformIsLarge({ width: 480, height: 480 })).toBe(false);
	});

	it('sends the one above it to the queue', () => {
		expect(transformIsLarge({ width: INLINE_TRANSFORM_MAX_EDGE + 1 })).toBe(true);
		expect(transformIsLarge({ width: 1090 })).toBe(true);
		expect(transformIsLarge({ height: 1090 })).toBe(true);
	});

	it('decides on the LONGEST edge, not on the area', () => {
		// a 1090x100 banner costs what its long edge costs; averaging the two would call it small
		expect(transformIsLarge({ width: 1090, height: 100 })).toBe(true);
	});

	it('puts the knee where the measurement put it', () => {
		expect(INLINE_TRANSFORM_MAX_EDGE).toBe(480);
	});
});
