<?php

/**
 * What does installing a Drupal module actually cost?
 *
 * This is the measurement behind the "admin operations spike memory, so they
 * need their own execution path" argument. If installing a module really does
 * push peak memory far above a normal request, a long-lived request-serving
 * instance cannot also run admin work -- wasm linear memory never shrinks, so
 * the spike becomes a permanent floor.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off bench-module.php <root> <module>
 */

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$root = $argv[1] ?? null;
$module = $argv[2] ?? 'media';
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-module.php <drupal-root> [module]\n");
	exit(1);
}

chdir($root);

function marks(): array
{
	$r = getrusage();
	return [
		'wall' => microtime(true),
		'cpu' =>
			$r['ru_utime.tv_sec'] +
			$r['ru_utime.tv_usec'] / 1e6 +
			($r['ru_stime.tv_sec'] + $r['ru_stime.tv_usec'] / 1e6),
		'mem' => memory_get_peak_usage(true),
	];
}

function delta(array $a, array $b): array
{
	return [
		'wallMs' => round(($b['wall'] - $a['wall']) * 1000, 1),
		'cpuMs' => round(($b['cpu'] - $a['cpu']) * 1000, 1),
		'peakMemoryMb' => round($b['mem'] / 1048576, 1),
	];
}

$t0 = marks();

$autoloader = require_once $root . '/autoload.php';
$request = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($request);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();
$kernel->preHandle($request);

$tBoot = marks();

$installer = \Drupal::service('module_installer');
$handler = \Drupal::service('module_handler');
$already = $handler->moduleExists($module);

$result = null;
$error = null;
if ($already) {
	$error = "module '$module' already installed; uninstall first for a clean measurement";
} else {
	try {
		$result = $installer->install([$module], true);
	} catch (\Throwable $e) {
		$error = get_class($e) . ': ' . $e->getMessage();
	}
}

$tInstall = marks();

// cache rebuild is the expensive half of any admin write, and the part a
// request-serving instance would rather never do
drupal_flush_all_caches();
$tRebuild = marks();

echo json_encode(
	[
		'module' => $module,
		'alreadyInstalled' => $already,
		'installed' => $result,
		'error' => $error,
		'boot' => delta($t0, $tBoot),
		'install' => delta($tBoot, $tInstall),
		'cacheRebuild' => delta($tInstall, $tRebuild),
		'total' => delta($t0, $tRebuild),
		'peakMemoryMb' => round(memory_get_peak_usage(true) / 1048576, 1),
		'includedFiles' => count(get_included_files()),
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
