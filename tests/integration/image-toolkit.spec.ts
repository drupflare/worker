import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL, drupalOp } from '../../src/drupal/site-php';
import { parseTransformPath } from '../../src/ops/image-transform';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Image styles have a toolkit, and it produces a derivative.
 *
 * `cfw_images` is the default toolkit. gd reports loaded and `GDToolkit` is available, because
 * the shim defines `imagegd2`, but it is selected only by hand. The manager scans the subdir
 * `Plugin/ImageToolkit`, and a class outside it is undiscovered and the site has none
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 600_000;

const call = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<Payload>);

/** asked with the request state a render has; the discovery cache is deleted so this is discovery */
const TOOLKIT_PROBE = String.raw`<?php
$out = ['ok' => false];
try {
  $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
  \Drupal::service('request_stack')->push($request);
  \Drupal::service('router.request_context')->fromRequest($request);
  \Drupal::moduleHandler()->loadAll();

  $manager = \Drupal::service('image.toolkit.manager');
  $out['gd'] = extension_loaded('gd') ? 1 : 0;
  $out['drupflareEnabled'] = \Drupal::moduleHandler()->moduleExists('drupflare') ? 1 : 0;
  $out['configuredBefore'] = \Drupal::config('system.image')->get('toolkit');
  $out['replaced'] = \Drupal\drupflare\Image\ToolkitDefault::apply() ? 1 : 0;
  $out['replacedAgain'] = \Drupal\drupflare\Image\ToolkitDefault::apply() ? 1 : 0;
  $out['configured'] = \Drupal::config('system.image')->get('toolkit');

  // the discovered path, which is the whole defect: not src/ImageToolkit
  $out['fileExists'] = file_exists('modules/custom/drupflare/src/Plugin/ImageToolkit/CfwImageToolkit.php') ? 1 : 0;
  $out['classExists'] = class_exists('\Drupal\drupflare\Plugin\ImageToolkit\CfwImageToolkit') ? 1 : 0;
  $ns = \Drupal::getContainer()->getParameter('container.namespaces');
  $out['containerHasNamespace'] = isset($ns['Drupal\\drupflare']) ? 1 : 0;

  \Drupal::cache('discovery')->delete('image_toolkit_plugins');
  $manager->clearCachedDefinitions();
  $out['definitions'] = array_keys($manager->getDefinitions());
  $out['available'] = array_keys($manager->getAvailableToolkits());
  $out['defaultToolkit'] = $manager->getDefaultToolkit() === false ? 'FALSE' : 'object';

  $out['factoryToolkitId'] = \Drupal::service('image.factory')->getToolkitId();

  // end to end: a real file, a real style, and the derivative read back off disk
  $dir = 'public://cfw-toolkit';
  \Drupal::service('file_system')->prepareDirectory(
    $dir,
    \Drupal\Core\File\FileSystemInterface::CREATE_DIRECTORY
  );
  $png = base64_decode(
    'iVBORw0KGgoAAAANSUhEUgAAAPAAAAB4CAIAAABD1OhwAAAACXBIWXMAAA7EAAAOxAGVKw4b' .
    'AAAEeUlEQVR42u2bS29TRxSAz9z0x7Dy4v4GVKlCqEIovMpjCGmCEh6KEEKwKbAoCihNE5IU' .
    'B8cZAuSBG0UIIaQKse5qFvOLWEBIXBL7njS2546/T944OnM8987no/HJXCNyxIgUfGUiRpwm' .
    'WIxYTXCh/FnTW6sJbpM/2+OPVhO8b/5s3w+1muA98mdtbpfVBDflzwottNUEf81fOFiM2Ezj' .
    '5w+SCUAyIDQgNABCAyA0AEJDXws9wE0AKjQAQgMgNABCA0IDIDRAbELTtgMqNEC0QjvlEKuM' .
    'Jz/5u5efCg1sOQAQGgChAbRC07YDKjQAQgMgNABCA0IDIDRAdELTtgMqNABCAyA0gFJoqxzi' .
    'lPHkJ3/38lOhgS0HQLxC07brAA+28iJhUyc894oKHSO/b4YDjLq1lYvsDJw9WeFOInQvmWyE' .
    'Q8x2Y/tbsTCI2QjdRaY2Qkfzj21/T6qnMRuhO8n0Wujmx41uBBF5fhatEfqwmXkdevXRv64F' .
    'EVn6Ba0R+jB4+jLEMI0rr4OILF+gMdJaaNp2LZlzIar5XH6ZO4vTVOgDMV/PI5yVdfmLIZxG' .
    'aCULtTzauV2q5yvDOI3QxXi2mMc/yYu1XERejaA1Qrek+iwv0WzPL+arV3EaoVOCFdyFkZF/' .
    'jUjBVyZixGqCxYjTBBfKnzW9dZrgNvlrc6GMq7h2rbL/RbmWd+P7l9UE7+TPilpkNcFixGUa' .
    'P2nb7VCbCSWd+dm5sH6Tf7uw5djF0nQo9fzPzISNCZxGaDbTCJ0e9Schgas4PRXe3K4gND5T' .
    'pBE6IZYfhWSu5dRkaNytIDRQpJMRmrZdYgz0udD9/YV290NiVzT4MPx9v4LQwK4DoQGhERoQ' .
    'GqEBoREaoftRaNp26dHHa2pk8ojyPLRTnoe2yvPQTnke2irPQ/83v5vIU1rRxrRvcf47K3y+' .
    'ufCpZas8D+2U56Gt8jw0Ww72G+yhAaEROlIuz/vl8UR2HW/mvUFooDwjdFIMVX19tPRFeqPa' .
    '7+VZaNslBUtJhf7GlbpfGipxkV6vU54Ruplh52u2lE6vOWxG6L0YWfGLF0vm9OoKNiN0SrCC' .
    'CN2C0VVfPVeaIv1q1WesIEK35uq6NyJ/nYla65V1b0TYbHwnNL2efRhr+IXBSJ1+0fCGhaNC' .
    'axnf9PMno3PabfIrEKEPyrWtytyJiJ4MX97C5jZCO+UQqy0oZc9//a03IrM/97hUL739smnu' .
    'u/tPhe4IN995I/Ln8R5o/fwdv/8QujNMvPdG5I9jXdK6+h6VEbrz3Prgvzzw8/injpi98GH7' .
    'MSpWRy003Z//wZ1/vpr36MdDMHt2O1vGolChe8u9j373Q6MPjxZqjEx9rDQ9tMtaIHSc/Pap' .
    '0u7hcwxGaACEBoQGQGiAKISmQwRUaACEBkBoAISGfhbaKoc4ZTz5yd+9/FRoSKxC07YD9tAA' .
    'CA2A0AAIDQgNgNAA0QlN2w6o0AAIDYDQAAgNCA2A0ADRCT3glEOsMp785O9efio0sOUAQGgA' .
    'hAZAaEBogFSE5rQdJMRnq3nplVQ6gLwAAAAASUVORK5CYII='
  );
  $src = $dir . '/probe.png';
  // through the STREAM WRAPPER: public:// is the durable store here, so realpath() is empty
  $out['written'] = (int) file_put_contents($src, $png);
  $out['sourceBytes'] = strlen($png);

  $image = \Drupal::service('image.factory')->get($src);
  $out['imageIsValid'] = $image->isValid() ? 1 : 0;
  $out['width'] = $image->isValid() ? $image->getWidth() : null;
  $out['height'] = $image->isValid() ? $image->getHeight() : null;

  $style = \Drupal::entityTypeManager()->getStorage('image_style')->load('thumbnail');
  $out['styleLoaded'] = $style ? 1 : 0;
  if ($style) {
    $derivative = $style->buildUri($src);
    $out['createDerivative'] = $style->createDerivative($src, $derivative) ? 1 : 0;
    // the stream URI, not realpath(): public:// is the durable store and has no real path
    $out['derivativeUri'] = $derivative;
    $out['derivativeExists'] = file_exists($derivative) ? 1 : 0;
    $out['derivativeBytes'] = $out['derivativeExists'] ? filesize($derivative) : 0;
  }
  // a site that selects gd by hand gets GDToolkit, and a style built through it writes a derivative
  \Drupal::configFactory()->getEditable('system.image')->set('toolkit', 'gd')->save();
  $out['handSelected'] = $manager->getDefaultToolkit()->getPluginId();
  if ($style) {
    $factory = \Drupal::service('image.factory');
    $factory->setToolkitId('gd');
    $gdUri = $dir . '/gd-derivative.png';
    try {
      $img = $factory->get($src);
      $out['gdValid'] = $img->isValid() ? 1 : 0;
      $out['gdToolkitClass'] = get_class($img->getToolkit());
      $out['gdExtensions'] = $img->getToolkit()->getSupportedExtensions();
      foreach ($style->getEffects() as $effect) {
        \Drupal\drupflare\Degradation::reset();
        $out['gdEffect:' . $effect->getPluginId()] = $effect->applyEffect($img) ? 1 : 0;
        $out['gdWhy:' . $effect->getPluginId()] = array_values(array_map(fn($d) => $d['reason'], \Drupal\drupflare\Degradation::all()));
      }
      $out['gdSave'] = $img->save($gdUri) ? 1 : 0;
    } catch (\Throwable $e) {
      $out['gdError'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 300);
    }
    // each core GD operation on its own handle, saved as PNG, then read back for its size
    $ops = [
      'resize' => fn($i) => $i->resize(90, 40),
      'scale' => fn($i) => $i->scale(120),
      'crop' => fn($i) => $i->crop(10, 10, 100, 50),
      'scaleAndCrop' => fn($i) => $i->scaleAndCrop(64, 64),
      'desaturate' => fn($i) => $i->desaturate(),
      'rotate90' => fn($i) => $i->rotate(90),
      'rotate30' => fn($i) => $i->rotate(30, '#ff0000'),
    ];
    foreach ($ops as $name => $apply) {
      $handle = $factory->get($src);
      $dest = $dir . '/gd-op-' . $name . '.png';
      try {
        $applied = $apply($handle) ? 1 : 0;
        $saved = $applied && $handle->save($dest) ? 1 : 0;
        $info = $saved ? @getimagesize($dest) : false;
        $out['gdOp:' . $name] = [$applied, $saved, $info ? [$info[0], $info[1]] : null];
      } catch (\Throwable $e) {
        $out['gdOp:' . $name] = get_class($e) . ': ' . substr($e->getMessage(), 0, 160);
      }
    }
    $out['gdDerivativeExists'] = file_exists($gdUri) ? 1 : 0;
    $gdSize = $out['gdDerivativeExists'] ? @getimagesize($gdUri) : false;
    $out['gdDerivativeSize'] = $gdSize ? [$gdSize[0], $gdSize[1], $gdSize['mime']] : null;
    $out['gdDegradations'] = array_map(
      fn($d) => $d['reason'],
      \Drupal\drupflare\Degradation::all()
    );
  }
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 240);
}
echo json_encode($out);
`;

async function probe(): Promise<Payload> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await call(site, '/__migrate?all=1&prefill=0');
		const booted = (await site.runJson(BOOT_KERNEL)) as Payload;
		if (booted?.['ok'] === false) throw new Error(`boot failed: ${JSON.stringify(booted)}`);
		const internals = site as unknown as {
			runJsonMaybeParked(code: string): Promise<Payload>;
			parkState(): Promise<{ state: string }>;
		};
		await internals.parkState();
		return await internals.runJsonMaybeParked(TOOLKIT_PROBE);
	});
}

let cached: Promise<Payload> | null = null;
const measured = () => (cached ??= probe());

describe('image toolkit discovery on a shipped site', () => {
	it(
		'discovers cfw_images and makes it available',
		async () => {
			const out = await measured();
			expect(out['error'], String(out['error'] ?? '')).toBeUndefined();
			expect(out['gd'], 'the gd shim is reported loaded').toBe(1);
			expect(out['drupflareEnabled']).toBe(1);
			expect(out['fileExists'], 'must sit under src/Plugin/ImageToolkit').toBe(1);
			expect(out['classExists']).toBe(1);
			expect(out['containerHasNamespace']).toBe(1);
			// the cache is deleted and definitions rebuilt inside the run, so this is discovery
			expect(out['definitions']).toContain('cfw_images');
			// isAvailable() reads Host::has('cfwImageUrl'), so this also proves the bridge is up
			expect(out['available']).toContain('cfw_images');
			// GDToolkit::isAvailable() gates on imagegd2, which the shim defines; it is available
			// and stays unselected, because cfw_images is the default (the next test)
			expect(out['available']).toContain('gd');
		},
		REQUEST_TIMEOUT
	);

	it(
		"replaces core's default gd once, and leaves the choice alone afterwards",
		async () => {
			const out = await measured();
			expect(out['configuredBefore'], "a baked site stores core's default").toBe('gd');
			expect(out['replaced']).toBe(1);
			expect(out['replacedAgain']).toBe(0);
			expect(out['configured']).toBe('cfw_images');
		},
		REQUEST_TIMEOUT
	);

	it(
		'builds a derivative through GDToolkit when a site selects gd by hand',
		async () => {
			const out = await measured();
			expect(out['handSelected']).toBe('gd');
			expect(out['gdToolkitClass']).toBe('Drupal\\system\\Plugin\\ImageToolkit\\GDToolkit');
			expect(out['gdExtensions']).toEqual(
				expect.arrayContaining(['png', 'jpeg', 'gif', 'webp', 'avif'])
			);
			expect(out['gdEffect:image_scale']).toBe(1);
			expect(out['gdEffect:image_convert_avif']).toBe(1);
			expect(out['gdSave']).toBe(1);
			expect(out['gdError']).toBeUndefined();
			// 240x120 scaled to the thumbnail's 100 pixels wide, converted and written as AVIF by the host
			expect(out['gdDerivativeSize']).toEqual([100, 50, 'image/avif']);
		},
		REQUEST_TIMEOUT
	);
	it(
		'runs every core GD operation through the shim and saves a derivative of the right size',
		async () => {
			const out = await measured();
			expect(out['gdOp:resize']).toEqual([1, 1, [90, 40]]);
			expect(out['gdOp:scale']).toEqual([1, 1, [120, 60]]);
			expect(out['gdOp:crop']).toEqual([1, 1, [100, 50]]);
			expect(out['gdOp:scaleAndCrop']).toEqual([1, 1, [64, 64]]);
			expect(out['gdOp:desaturate']).toEqual([1, 1, [240, 120]]);
			expect(out['gdOp:rotate90']).toEqual([1, 1, [120, 240]]);
			expect(out['gdOp:rotate30']).toEqual([1, 1, [268, 224]]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'selects it over the available gd, so a style has something to run against',
		async () => {
			const out = await measured();
			expect(out['defaultToolkit']).toBe('object');
			expect(out['factoryToolkitId']).toBe('cfw_images');
		},
		REQUEST_TIMEOUT
	);

	it(
		'writes a derivative and reads it back, deferring the resize to delivery',
		async () => {
			const out = await measured();
			// getimagesize() is ext-standard, so dimensions are right with no gd
			expect(out['imageIsValid']).toBe(1);
			expect(out['written']).toBe(out['sourceBytes']);
			expect(out['width']).toBe(240);
			expect(out['height']).toBe(120);
			expect(out['styleLoaded']).toBe(1);
			expect(out['createDerivative'], 'a style must not report failure').toBe(1);
			// resolving is not producing; a toolkit that returns true and writes nothing is the
			// same defect one layer later
			expect(out['derivativeExists']).toBe(1);
			// the derivative IS the source: the resize happens at /cdn-cgi/image/, not here
			expect(out['derivativeBytes']).toBe(out['sourceBytes']);
		},
		REQUEST_TIMEOUT
	);
});

/**
 * The URL a page emits for a style, which is the half that had been missing.
 *
 * The toolkit copies the source to the derivative path, so the stock style URL served the full-size
 * original on every site, and nothing emitted the delivery path the front worker resizes on. The
 * container is dropped first, because a hook reaches a site only through a container rebuild, which
 * reconciliation performs when the packed driver changes.
 */
describe('an image style URL points at the delivery path', () => {
	it(
		'emits a path the front worker parses, carrying the style as its transform',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await call(site, '/__migrate?all=1&prefill=0');
				site.sql.exec('DELETE FROM cache_container');
				return (await site.runJson(
					drupalOp(`$style = \\Drupal\\image\\Entity\\ImageStyle::load('medium');
$out['url'] = $style->buildUrl('public://2026-09/cat.jpg');`)
				)) as Payload;
			});
			expect(out['error'], String(out['error'] ?? '')).toBeUndefined();
			const url = new URL(String(out['url']), 'https://site.example');
			expect(url.pathname.startsWith('/cfw-img/'), url.toString()).toBe(true);
			const parsed = parseTransformPath(url.pathname, url.search);
			expect(parsed?.uri).toBe('public://2026-09/cat.jpg');
			expect(parsed?.transform).toMatchObject({
				width: 220,
				height: 220,
				fit: 'scale-down'
			});
			// the itok Drupal appends rides along without breaking the identity check
			expect(url.searchParams.has('itok')).toBe(true);
		},
		REQUEST_TIMEOUT
	);
});
