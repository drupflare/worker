<?php

/**
 * Uninstalls one module (and whatever depends on it) from a Drupal site, then
 * reports the module set that actually went away.
 *
 * ModuleInstaller::uninstall() expands the list to include reverse
 * dependencies, so "uninstall contextual" and "uninstall views" are not the same
 * size of change; the expanded set is what gets reported so the saving is
 * attributed to the right unit.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/probe/probe-uninstall.php \
 *       <drupal-root> <module>
 */

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$root = $argv[1] ?? null;
$module = $argv[2] ?? null;
if (!$root || !is_dir($root) || !$module) {
	fwrite(STDERR, "usage: probe-uninstall.php <drupal-root> <module>\n");
	exit(2);
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(\Fiber::class, 'PhpWasmSyncFiber');
}

$request = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($request);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();
$kernel->preHandle($request);

$before = array_keys(\Drupal::service('module_handler')->getModuleList());
$error = null;
$ok = null;
$t0 = microtime(true);
try {
	$ok = \Drupal::service('module_installer')->uninstall([$module], true);
} catch (\Throwable $e) {
	$error = get_class($e) . ': ' . $e->getMessage();
}
$ms = round((microtime(true) - $t0) * 1000, 1);
$after = array_keys(\Drupal::service('module_handler')->getModuleList());

echo json_encode(
	[
		'requested' => $module,
		'ok' => $ok,
		'error' => $error,
		'uninstallMs' => $ms,
		'removed' => array_values(array_diff($before, $after)),
		'moduleCountBefore' => count($before),
		'moduleCountAfter' => count($after),
	],
	JSON_UNESCAPED_SLASHES,
),
	"\n";
