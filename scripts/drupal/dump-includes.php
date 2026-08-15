<?php

/**
 * Dumps the exact file set a cold Drupal request touches, so the VFS can be
 * packed from real files rather than synthetic ones. Writes JSON to stdout:
 * [{path, bytes}], paths relative to the Drupal root.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off dump-includes.php <root>
 */

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$root = $argv[1] ?? null;
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: dump-includes.php <drupal-root>\n");
	exit(1);
}

chdir($root);

$autoloader = require_once $root . '/autoload.php';
$request = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($request);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();
$kernel->handle($request);

$real = realpath($root);
$out = [];
$total = 0;

foreach (get_included_files() as $f) {
	$size = @filesize($f);
	if ($size === false) {
		continue;
	}
	$rel = str_starts_with($f, $real) ? ltrim(substr($f, strlen($real)), '/') : $f;
	$out[] = ['path' => $rel, 'bytes' => $size];
	$total += $size;
}

fwrite(STDERR, sprintf("%d files, %d bytes (%.1f MB)\n", count($out), $total, $total / 1048576));
echo json_encode($out), "\n";
