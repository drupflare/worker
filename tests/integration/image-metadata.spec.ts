import { describe, expect, it } from 'vitest';
import { runImageTransform } from '../../src/ops/image-runtime';
import { druplicon } from '../fixtures/png';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * `getimagesize()` on the shipping interpreter, which is the whole of what a gd-less toolkit needs.
 *
 * `CfwImageToolkit::parseFile()` answers width, height and mime from `getimagesize()` and says in its
 * own docblock that the function is core rather than gd. That is TRUE of php-src and says nothing
 * about a build: `ext/standard`'s image reader is compiled in unconditionally, but a wasm build that
 * dropped it, or one whose WebP branch is absent, would leave the toolkit returning null dimensions
 * on every upload with no error anywhere. Image fields would store no width or height, responsive
 * images would lose their `srcset` candidates, and `max_resolution` validation would pass everything.
 * A toolkit that cannot measure is the {@link https://example.invalid inert-shim-guard} shape aimed
 * at an image field.
 *
 * So the claim is measured against the real binary, and against the format the delivery path actually
 * produces: derivatives come out of tinyimg as WebP, so a WebP that PHP cannot parse would break the
 * round trip even though every PNG read fine.
 */

type Interp = ServeDo & { run: (code: string) => Promise<string> };

function probe(files: Record<string, Uint8Array>): string {
	const writes = Object.entries(files)
		.map(([name, bytes]) => {
			const b64 = Buffer.from(bytes).toString('base64');
			return `file_put_contents('/tmp/${name}', base64_decode('${b64}'));`;
		})
		.join('\n');
	const names = Object.keys(files)
		.map((name) => `'${name}'`)
		.join(', ');
	return `<?php
${writes}
$out = ['have' => function_exists('getimagesize'), 'read' => []];
foreach ([${names}] as $name) {
  $info = @getimagesize('/tmp/' . $name);
  $out['read'][$name] = $info === false
    ? false
    : ['w' => $info[0], 'h' => $info[1], 'type' => $info[2], 'mime' => $info['mime'] ?? null];
}
$out['constants'] = [
  'png' => defined('IMAGETYPE_PNG') ? IMAGETYPE_PNG : null,
  'jpeg' => defined('IMAGETYPE_JPEG') ? IMAGETYPE_JPEG : null,
  'webp' => defined('IMAGETYPE_WEBP') ? IMAGETYPE_WEBP : null,
];
$out['gd'] = extension_loaded('gd');
echo json_encode($out);`;
}

describe('image metadata without gd', () => {
	it('reads dimensions and mime for every format the delivery path produces', async () => {
		const png = druplicon();
		const webp = (await runImageTransform(png, { width: 80, format: 'webp' })).bytes;
		const jpeg = (await runImageTransform(png, { width: 60, format: 'jpeg' })).bytes;

		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const text = await (site as Interp).run(
				probe({
					'a.png': png,
					'b.webp': webp,
					'c.jpg': jpeg,
					// the refusal direction: a file that is not an image at all
					'd.txt': new TextEncoder().encode('this is not an image, not even close')
				})
			);
			const at = text.indexOf('{');
			if (at < 0) throw new Error(`no JSON printed; PHP said: ${text.slice(0, 600)}`);
			return JSON.parse(text.slice(at)) as Record<string, unknown>;
		});
		console.log(`[image-metadata] ${JSON.stringify(seen)}`);

		expect(seen['have']).toBe(true);
		// the premise: no gd, so every reading below is the gd-free path and not gd answering
		expect(seen['gd']).toBe(false);

		const read = seen['read'] as unknown as Record<string, { w: number; h: number } | false>;
		expect(read['a.png']).toMatchObject({ w: 88, h: 100, mime: 'image/png' });
		expect(read['b.webp']).toMatchObject({ w: 80, mime: 'image/webp' });
		expect(read['c.jpg']).toMatchObject({ w: 60, mime: 'image/jpeg' });
		// a non-image reads false rather than zero dimensions, which is what `isValid()` rests on
		expect(read['d.txt']).toBe(false);
	}, 900_000);
});
