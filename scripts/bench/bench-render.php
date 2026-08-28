<?php

/**
 * Prices a full uncached Drupal render natively, mirroring the wasm
 * anon(render) measurement so the remaining unattributed time can be checked
 * against the 3.2x wasm penalty.
 *
 * A unique query string per iteration is what makes it uncached: without it
 * page_cache serves a stored page and the measurement is a cache lookup, which
 * is the mistake that invalidated a dozen earlier numbers.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off bench-render.php <drupal-root> [n]
 */

use Drupal\Core\Database\Database;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\HttpKernelInterface;

$root = $argv[1] ?? null;
$n = (int) ($argv[2] ?? 10);
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-render.php <drupal-root> [n]\n");
	exit(1);
}

// resolve before chdir: the require below is built from $root, and a relative
// $root stops resolving once the cwd changes
$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';

// scripts/patch-drupal.mjs rewrote core's five \Fiber call sites to
// \PhpWasmSyncFiber because emscripten has no ucontext. Native PHP has real
// Fibers, and Drupal's call sites are written against them, so alias straight
// back rather than running the synchronous stand-in here.
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}

$t = fn() => microtime(true) * 1000;

// fresh kernel per request, matching the wasm freshPerRequestMs shape
$serve = function (string $path) use ($root, $autoloader): array {
	$req = Request::create($path, 'GET');
	$kernel = new DrupalKernel('prod', $autoloader);
	DrupalKernel::bootEnvironment();
	$sitePath = DrupalKernel::findSitePath($req);
	$kernel->setSitePath($sitePath);
	Settings::initialize($root, $sitePath, $autoloader);
	$kernel->boot();
	$response = $kernel->handle($req, HttpKernelInterface::MAIN_REQUEST, false);
	if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) {
		@session_write_close();
	}
	return [$response, $kernel];
};

$out = [];

// query count for one render, taken LAST-ish but on its own connection state;
// startLog can never be undone (Database::openConnection attaches the logger to
// every future connection), so this runs after the timing loops
$bust = fn(int $i) => '/?cb=' . $i . '_' . mt_rand();

[$r0] = $serve($bust(0));
$body = (string) $r0->getContent();
$out['warmup'] = [
	'status' => $r0->getStatusCode(),
	'bytes' => strlen($body),
	'page' => $r0->headers->get('x-drupal-cache') ?: '-',
	'dynamic' => $r0->headers->get('x-drupal-dynamic-cache') ?: '-',
];

$a = $t();
for ($i = 0; $i < $n; $i++) {
	$serve($bust(100 + $i));
}
$out['freshPerRequestMs'] = round(($t() - $a) / $n, 2);

// same-kernel repeat, matching warmPerRequestMs
$req = Request::create($bust(1), 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$kernel->setSitePath(DrupalKernel::findSitePath($req));
Settings::initialize($root, $kernel->getSitePath(), $autoloader);
$kernel->boot();
$prepared = new ReflectionProperty(DrupalKernel::class, 'prepared');
$prepared->setAccessible(true);

$warmServe = function (string $path) use ($kernel, $prepared) {
	$req = Request::create($path, 'GET');
	$prepared->setValue($kernel, false);
	$stack = Drupal::service('request_stack');
	while ($stack->getCurrentRequest() !== null) {
		$stack->pop();
	}
	if (function_exists('drupal_static_reset')) {
		drupal_static_reset();
	}
	return $kernel->handle($req, HttpKernelInterface::MAIN_REQUEST, false);
};

$warmServe($bust(2));
$a = $t();
for ($i = 0; $i < $n; $i++) {
	$warmServe($bust(200 + $i));
}
$out['warmPerRequestMs'] = round(($t() - $a) / $n, 2);

// query count last, because startLog is irreversible in-process
Database::startLog('bench');
$warmServe($bust(3));
$out['warmQueries'] = count(Database::getLog('bench', 'default'));

echo json_encode($out, JSON_PRETTY_PRINT), "\n";
