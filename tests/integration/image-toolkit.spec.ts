import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Image styles have a toolkit, and it produces a derivative.
 *
 * gd is not compiled in, so `cfw_images` is the only toolkit a site can have; the manager scans the
 * subdir `Plugin/ImageToolkit`, and a class outside it is undiscovered and the site has none
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
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAACiPFNiAAAAFklEQVR4nGP8//8/AzbAxIAD' .
    'jEqMSgAAAP//AwDPogNMxvNSAAAAAElFTkSuQmCC'
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
		return (await site.runJson(TOOLKIT_PROBE)) as Payload;
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
			expect(out['gd'], 'gd is not compiled into this build').toBe(0);
			expect(out['drupflareEnabled']).toBe(1);
			expect(out['fileExists'], 'must sit under src/Plugin/ImageToolkit').toBe(1);
			expect(out['classExists']).toBe(1);
			expect(out['containerHasNamespace']).toBe(1);
			// the cache is deleted and definitions rebuilt inside the run, so this is discovery
			expect(out['definitions']).toContain('cfw_images');
			// isAvailable() reads Host::has('cfwImageUrl'), so this also proves the bridge is up
			expect(out['available']).toContain('cfw_images');
		},
		REQUEST_TIMEOUT
	);

	it(
		'selects it, so a style has something to run against',
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
			expect(out['width']).toBe(4);
			expect(out['height']).toBe(2);
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
