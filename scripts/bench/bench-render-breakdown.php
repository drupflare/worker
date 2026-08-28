<?php

/**
 * Attributes a warm-kernel render's CPU to named buckets instead of leaving
 * 97.5% of it unexplained.
 *
 * Boot was profiled into parse / YAML / container / discovery long ago; the
 * render never was. What was known is that 24 queries x 0.035 ms is 0.84 ms of
 * 33.8 ms, and "the rest is the uniform interpreter penalty" was an inference
 * from an aggregate cpubench ratio, not a measurement of the render.
 *
 * The measurement lives in pw_bench_breakdown() inside pw-probe.php, which
 * src/min.js calls with the same arguments inside wasm. Attribution is
 * exclusive, so the buckets sum without double counting and the residual is
 * what is genuinely elsewhere. Instrumentation cost is measured, not assumed:
 * one loop runs with the decorators installed but the timer off and the
 * difference is reported.
 *
 * Warm kernel only. A fresh kernel calls Drupal::setContainer() and would
 * repoint every Drupal:: static at a container whose services are not the
 * decorated ones.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bench/bench-render-breakdown.php \
 *       <drupal-root> <route> [n] [--cold-twig] [--probe=<path to pw-probe.php>]
 */

$root = $argv[1] ?? null;
$route = $argv[2] ?? '/';
$n = (int) ($argv[3] ?? 10);
$coldTwig = in_array('--cold-twig', $argv, true);
$probe = null;
foreach ($argv as $a) {
	if (str_starts_with((string) $a, '--probe=')) {
		$probe = substr($a, 8);
	}
}

if (!$root || !is_dir($root)) {
	fwrite(
		STDERR,
		"usage: bench-render-breakdown.php <drupal-root> <route> [n] [--cold-twig] [--probe=<path>]\n",
	);
	exit(1);
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
require_once $probe ?? $root . '/pw-probe.php';

if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}

$out = pw_bench_breakdown([
	'root' => $root,
	'route' => $route,
	'n' => $n,
	'autoloader' => $autoloader,
	'coldTwig' => $coldTwig,
]);

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
