<?php

/**
 * Prices one route on one site profile natively, so a minimal+Stark node page
 * can be compared against the standard+Olivero front page that every existing
 * figure in TECHNICAL_REPORT.md was taken from.
 *
 * The measurement itself lives in pw_bench_profile() inside pw-probe.php, which
 * src/min.js calls with the same arguments inside wasm -- so a native figure and
 * a wasm figure differ only in the interpreter, not in the harness.
 *
 * Same shape as bench-render.php: unique query string per request so
 * page_cache MISSES, warm kernel via the $prepared reset, fresh kernel by
 * rebooting per request. Reports the median and the spread rather than a mean,
 * because this machine runs other builds.
 *
 * warm and fresh are separate invocations by design: DrupalKernel::boot() calls
 * Drupal::setContainer(), so a fresh kernel silently repoints every Drupal::
 * static and the two cannot coexist in one interpreter.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bench/bench-minimal.php \
 *       <drupal-root> <route> warm|fresh [n] [--probe=<path to pw-probe.php>]
 */

$root = $argv[1] ?? null;
$route = $argv[2] ?? '/';
$mode = $argv[3] ?? 'warm';
$n = (int) ($argv[4] ?? 10);
$probe = null;
foreach ($argv as $a) {
	if (str_starts_with((string) $a, '--probe=')) {
		$probe = substr($a, 8);
	}
}

if (!$root || !is_dir($root) || !in_array($mode, ['warm', 'fresh'], true)) {
	fwrite(
		STDERR,
		"usage: bench-minimal.php <drupal-root> <route> warm|fresh [n] [--probe=<path>]\n",
	);
	exit(1);
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
require_once $probe ?? $root . '/pw-probe.php';

// the tree is patched for wasm (\Fiber -> \PhpWasmSyncFiber); native has real
// fibers and Drupal's call sites are written against them, so alias straight
// back rather than running the synchronous stand-in here
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}

$out = pw_bench_profile([
	'root' => $root,
	'route' => $route,
	'mode' => $mode,
	'n' => $n,
	'autoloader' => $autoloader,
]);

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
