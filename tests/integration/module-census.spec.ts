import { describe, expect, it } from 'vitest';
import { drupalOp, renderPage } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Which modules a cold render actually loads, and what share of the kernel each one costs.
 *
 * The census a route-aware lazy module boot has to be scored against. Counts and bytes only: there
 * is no opcache, so compiled source scales with bytes included, and a millisecond read in-isolate is
 * not the edge's. Each arm starts from a dropped interpreter, so every figure is a cold one.
 */

type Bucket = { files: number; bytes: number };
type ServiceBucket = { defined: number; definitionBytes: number; initialized: number };
type Census = {
	ok: boolean;
	error?: string;
	enabled: string[];
	profile: string;
	includedFiles: number;
	includedBytes: number;
	files: Record<string, Bucket>;
	services: Record<string, ServiceBucket>;
	moduleFiles: { present: number; included: number };
};

const REQUEST_TIMEOUT = 900_000;
const ROUTES = ['/', '/user/login', '/user/password'];

// buckets a file or class by enabled module, then core/lib, then vendor package
const CENSUS = drupalOp(String.raw`
$root = rtrim(\Drupal::root(), '/') . '/';
$paths = [];
foreach (\Drupal::moduleHandler()->getModuleList() as $name => $ext) {
  $paths[$root . $ext->getPath() . '/'] = 'module:' . $name;
}
foreach (\Drupal::service('theme_handler')->listInfo() as $name => $ext) {
  $paths[$root . $ext->getPath() . '/'] = 'theme:' . $name;
}
uksort($paths, fn ($a, $b) => strlen($b) <=> strlen($a));
$fileBucket = function (string $file) use ($paths, $root): string {
  foreach ($paths as $prefix => $label) {
    if (str_starts_with($file, $prefix)) return $label;
  }
  if (str_starts_with($file, $root . 'core/lib/')) return 'core:lib';
  if (str_starts_with($file, $root . 'core/includes/')) return 'core:includes';
  if (preg_match('#/vendor/([^/]+/[^/]+)/#', $file, $m)) return 'vendor:' . $m[1];
  return 'other';
};
$enabled = array_keys(\Drupal::moduleHandler()->getModuleList());
$classBucket = function (string $class) use ($enabled): string {
  $parts = explode('\\', ltrim($class, '\\'));
  if (($parts[0] ?? '') === 'Drupal' && isset($parts[1])) {
    if ($parts[1] === 'Core' || $parts[1] === 'Component') return 'core:lib';
    if (in_array($parts[1], $enabled, true)) return 'module:' . $parts[1];
  }
  return 'vendor:' . strtolower($parts[0] ?? 'unknown');
};

$files = [];
$includedBytes = 0;
$included = get_included_files();
foreach ($included as $file) {
  $b = $fileBucket($file);
  $size = (int) @filesize($file);
  $files[$b] ??= ['files' => 0, 'bytes' => 0];
  $files[$b]['files']++;
  $files[$b]['bytes'] += $size;
  $includedBytes += $size;
}

$present = 0;
$moduleIncluded = 0;
$set = array_flip($included);
foreach (\Drupal::moduleHandler()->getModuleList() as $name => $ext) {
  $file = $root . $ext->getPath() . '/' . $name . '.module';
  if (is_file($file)) {
    $present++;
    if (isset($set[$file])) $moduleIncluded++;
  }
}

$container = \Drupal::getContainer();
$services = [];
$prop = new \ReflectionProperty($container, 'serviceDefinitions');
foreach ($prop->getValue($container) as $id => $def) {
  $raw = is_string($def) ? $def : serialize($def);
  $decoded = is_string($def) ? @unserialize($def, ['allowed_classes' => false]) : $def;
  $class = is_array($decoded) ? (string) ($decoded['class'] ?? '') : '';
  $b = $class === '' ? 'unclassed' : $classBucket($class);
  $services[$b] ??= ['defined' => 0, 'definitionBytes' => 0, 'initialized' => 0];
  $services[$b]['defined']++;
  $services[$b]['definitionBytes'] += strlen($raw);
  if ($container->initialized($id)) $services[$b]['initialized']++;
}

$out = [
  'ok' => true,
  'enabled' => $enabled,
  'profile' => (string) \Drupal::installProfile(),
  'includedFiles' => count($included),
  'includedBytes' => $includedBytes,
  'files' => $files,
  'services' => $services,
  'moduleFiles' => ['present' => $present, 'included' => $moduleIncluded],
];`);

async function cold(site: ServeDo, path: string | null): Promise<Census> {
	site.php = null;
	if (path !== null) {
		const page = (await site.runJson(renderPage(path, [], false, {}))) as { status?: number };
		if (page.status !== 200) throw new Error(`${path} answered ${page.status}`);
	}
	return (await site.runJson(CENSUS)) as Census;
}

const sum = (
	rows: Record<string, { files?: number; defined?: number }>,
	key: 'files' | 'defined'
) => Object.values(rows).reduce((n, r) => n + Number(r[key] ?? 0), 0);

describe('module-load census', () => {
	it(
		'attributes every included file and container service to a module, core or vendor',
		async () => {
			const arms = await inObject(freshSite(), async (site) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const out: Record<string, Census> = { boot: await cold(site, null) };
				for (const path of ROUTES) out[path] = await cold(site, path);
				return out;
			});
			console.log(`[module-census] ${JSON.stringify(arms)}`);

			for (const [arm, c] of Object.entries(arms)) {
				expect(c.ok, `${arm}: ${c.error ?? ''}`).toBe(true);
				expect(sum(c.files, 'files'), arm).toBe(c.includedFiles);
				expect(Object.keys(c.services).length, arm).toBeGreaterThan(0);
				// the kernel boot already includes every enabled .module, before any route is known
				expect(c.moduleFiles.included, arm).toBe(c.moduleFiles.present);
			}
			const boot = arms['boot']!;
			for (const path of ROUTES) {
				const c = arms[path]!;
				// the container is the same object on every arm, so only what was instantiated moves
				expect(sum(c.services, 'defined')).toBe(sum(boot.services, 'defined'));
				// every module but the profile builds a service on every route, which is what leaves
				// a per-route lazy module boot nothing to skip; revisit that refusal if this moves
				const idle = c.enabled.filter(
					(m) => m !== c.profile && (c.services[`module:${m}`]?.initialized ?? 0) === 0
				);
				expect(idle, path).toEqual([]);
			}
		},
		REQUEST_TIMEOUT
	);
});
