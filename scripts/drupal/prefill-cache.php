<?php

/**
 * Renders pages on NATIVE PHP and ships the results, so no edge visitor pays a fill.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/drupal/prefill-cache.php \
 *       <drupal-root> [--paths=/,/user/login] [--out=assets/prefill.json]
 *
 * WHY. A render costs 6.53-9.47 ms natively and 2,127 ms of edge cpuTime (n=10), and
 * the free plan gives an invocation 10 ms. So the cheapest render is the one that
 * already happened somewhere else. This produces two artifacts from one pass:
 *
 *   1. A warm `cache_render` in the site database, which turns an edge MISS from a
 *      full render into cache assembly. Render 2 is 15.8x cheaper than render 1 on
 *      native minimal, measured, and that saving is what gets shipped.
 *   2. assets/prefill.json -- the rendered HTML per path, which the Durable Object
 *      loads straight into its cfw_page table at migrate time. Those pages are HITs
 *      from the very first request.
 *
 * The trap this routes around: `PHP_SAPI` is 'cli' here, so Drupal's
 * CommandLineOrUnsafeMethod policy marks every request UNCACHEABLE and `cache_page`
 * is never written -- a naive prefill silently produces nothing. `cache_render` is
 * NOT subject to the request policy and does warm up, so that half works; the page
 * HTML is captured directly instead of hoping the page cache catches it.
 */

$root = $argv[1] ?? null;
if ($root === null || !is_file($root . '/vendor/autoload.php')) {
	fwrite(STDERR, "usage: prefill-cache.php <drupal-root> [--paths=...] [--out=...]\n");
	exit(2);
}

$flag = function (string $name, ?string $default) use ($argv): ?string {
	foreach ($argv as $arg) {
		if (str_starts_with($arg, "--$name=")) {
			return substr($arg, strlen($name) + 3);
		}
	}
	return $default;
};

$paths = array_values(
	array_filter(array_map('trim', explode(',', (string) $flag('paths', '/,/user/login')))),
);
// resolved BEFORE the chdir below, or a relative --out lands inside the Drupal tree
$out = $flag('out', 'assets/prefill.json');
if ($out !== null && $out[0] !== '/') {
	$out = getcwd() . '/' . $out;
}
$repeat = (int) $flag('repeat', '2');

/**
 * The shipped tree is Fiber-PATCHED, so it cannot render on stock PHP.
 *
 * scripts/patch-drupal.mjs rewrites core's five `new \Fiber()` sites to
 * `new \PhpWasmSyncFiber()` because emscripten has no ucontext. That class is
 * normally defined by the wasm runtime before Drupal loads, so a native render of
 * the same tree dies with "Class PhpWasmSyncFiber not found" -- which is exactly
 * what a CI prefill is. Defining it here is not a workaround: the stand-in runs the
 * callable eagerly on start(), which is already established to produce identical
 * output, so the cache entries this warms are the ones wasm would have produced.
 */
if (!class_exists('PhpWasmSyncFiber', false)) {
	eval('
  class PhpWasmSyncFiber {
    private $callable; private $result = null; private $started = false;
    public function __construct(callable $callable) { $this->callable = $callable; }
    public function start(...$args) { $this->started = true; $this->result = ($this->callable)(...$args); return null; }
    public function isStarted(): bool { return $this->started; }
    public function isSuspended(): bool { return false; }
    public function isRunning(): bool { return false; }
    public function isTerminated(): bool { return $this->started; }
    public function resume($value = null) { return null; }
    public function throw(\Throwable $e) { throw $e; }
    public function getReturn() { return $this->result; }
    public static function getCurrent(): ?object { return null; }
    public static function suspend($value = null) { return null; }
  }
  ');
}

// realpath BEFORE chdir, or a relative root becomes invalid the moment we move --
// the same trap already fixed in bench-dbal.php and bench-render.php
$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/vendor/autoload.php';

use Drupal\Component\Utility\Html;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\HttpKernelInterface;

$request = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($request);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();

$clock = static fn(): float => microtime(true) * 1000;
$results = [];
$prefill = [];

foreach ($paths as $path) {
	// Rendered $repeat times. Render 1 pays cold cache_render and Twig
	// class generation; render 2 is what a warm site actually costs, and it is the
	// one whose cache state we want to ship. Steady state arrives at render 3, so 2
	// is the floor rather than the optimum.
	$last = null;
	$timings = [];
	for ($i = 0; $i < max(1, $repeat); $i++) {
		$req = Request::create($path, 'GET');
		// preHandle() is guarded by $prepared, so a persistent kernel routes every
		// later request against the FIRST path unless the flag is cleared
		try {
			$rp = new ReflectionProperty(DrupalKernel::class, 'prepared');
			$rp->setAccessible(true);
			$rp->setValue($kernel, false);
		} catch (Throwable) {
		}
		try {
			$stack = Drupal::service('request_stack');
			while ($stack->getCurrentRequest() !== null) {
				$stack->pop();
			}
		} catch (Throwable) {
		}
		if (function_exists('drupal_static_reset')) {
			drupal_static_reset();
		}
		// Html::$seenIds is a plain static, NOT registered through drupal_static(), so
		// drupal_static_reset() leaves it populated. Without this every id in render 2 -- the
		// render actually shipped -- comes back suffixed `--2`, and the prefilled page differs
		// from what the site produces on a re-render
		if (method_exists(Html::class, 'resetSeenIds')) {
			Html::resetSeenIds();
		}

		$t0 = $clock();
		try {
			$last = $kernel->handle($req, HttpKernelInterface::MAIN_REQUEST, false);
			$timings[] = round($clock() - $t0, 2);
		} catch (Throwable $e) {
			$results[$path] = ['error' => get_class($e) . ': ' . $e->getMessage()];
			$last = null;
			break;
		}
	}

	if ($last === null) {
		continue;
	}
	$body = (string) $last->getContent();
	$results[$path] = [
		'status' => $last->getStatusCode(),
		'bytes' => strlen($body),
		'ms' => $timings,
		// recorded so a reader can tell a render from a lookup, per this project's rule 3
		'pageCache' => $last->headers->get('x-drupal-cache'),
		'dynamicCache' => $last->headers->get('x-drupal-dynamic-cache'),
	];
	if ($last->getStatusCode() === 200 && $body !== '') {
		$prefill[$path] = [
			'status' => $last->getStatusCode(),
			'contentType' => $last->headers->get('content-type') ?: 'text/html; charset=utf-8',
			'html' => $body,
			'renderMs' => $timings[count($timings) - 1] ?? null,
		];
	}
}

// what actually warmed, so the shipped database can be verified rather than assumed
$db = Drupal::database();
$bins = [];
foreach (['cache_render', 'cache_page', 'cache_dynamic_page_cache', 'cache_default'] as $bin) {
	try {
		$bins[$bin] = (int) $db->select($bin)->countQuery()->execute()->fetchField();
	} catch (Throwable) {
		$bins[$bin] = 'absent';
	}
}

$json = json_encode($prefill, JSON_UNESCAPED_SLASHES);
if (!is_dir(dirname($out))) {
	@mkdir(dirname($out), 0777, true);
}
file_put_contents($out, $json === false ? '{}' : $json);

echo json_encode(
	[
		'renderedPaths' => count($prefill),
		'results' => $results,
		'cacheRowsAfter' => $bins,
		'wrote' => $out,
		'bytes' => strlen((string) $json),
		'note' =>
			'PHP_SAPI is cli here, so cache_page stays empty by design; cache_render is what warms and what ships',
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
