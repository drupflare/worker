<?php

/**
 * Bakes the missing cache-collector entries into the packed database.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bake-collectors.php <drupal-root> [--dry]
 *
 * Not bench-render.php. The shipped database is permanently missing
 * four collector entries, and no edge request will ever add them because nothing completes the
 * request lifecycle. 100% of the measured cost is the `library_info` + `library.parsing_cache` PAIR
 * and only when BOTH are missing (+16.76 ms); either one alone short-circuits the work, which is why
 * the effect is superlinear. Every other entry sits inside the 1.93 ms noise floor.
 *
 * A plain render does NOT create them, which was verified:
 * `bench-render.php drupal-src 1` rendered 12,340 bytes and left all three entries absent. The reason
 * is that `CacheCollector` subclasses persist on destruct, and the destruct loop is inline in
 * `DrupalKernel::terminate()` (core/lib/Drupal/Core/DrupalKernel.php:726), iterating the container
 * parameter. `bench-render.php` never calls terminate, since it prices a render, so
 * the collectors never flush.
 *
 * So the ONLY difference that matters here is the `terminate()` call below. This is a separate script
 * rather than a flag on bench-render.php because that file is a cited measurement instrument: its
 * numbers appear in TECHNICAL_REPORT.md and changing what it does invalidates them.
 *
 * The render is NOT cache-busted. bench-render.php appends a unique query string to force an uncached
 * render, which is correct for pricing one, but the entries we want are keyed to the real front page
 * (`library_info:olivero`), so this asks for the page a visitor asks for.
 */

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\HttpKernelInterface;

$root = $argv[1] ?? null;
$dry = in_array('--dry', $argv, true);
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bake-collectors.php <drupal-root> [--dry]\n");
	exit(1);
}

// resolve before chdir: the require below is built from $root, and a relative $root stops
// resolving once the cwd changes
$root = realpath($root);

/** the four entries, and which bin each lands in */
$targets = [
	['cache_discovery', 'library_info:olivero'],
	['cache_file_parsing', 'library.parsing_cache'],
	['cache_bootstrap', 'theme_registry:runtime:olivero'],
];

/** counts straight out of sqlite, so the check does not depend on Drupal's cache API */
$probe = function (string $db) use ($targets): array {
	$out = [];
	$pdo = new PDO('sqlite:' . $db);
	foreach ($targets as [$bin, $cid]) {
		try {
			$st = $pdo->prepare("SELECT LENGTH(data) FROM {$bin} WHERE cid = ?");
			$st->execute([$cid]);
			$len = $st->fetchColumn();
			$out["{$bin}/{$cid}"] = $len === false ? null : (int) $len;
		} catch (PDOException $e) {
			$out["{$bin}/{$cid}"] = 'no such table';
		}
	}
	return $out;
};

$db = $root . '/sites/default/files/.sqlite';
if (!is_file($db)) {
	fwrite(STDERR, "no database at {$db}\n");
	exit(1);
}

$before = $probe($db);

chdir($root);
$autoloader = require_once $root . '/autoload.php';

// scripts/patch-drupal.mjs rewrote core's \Fiber call sites to \PhpWasmSyncFiber for emscripten,
// which has no ucontext. Native PHP has real Fibers, so alias straight back
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}

$req = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($req);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();
$response = $kernel->handle($req, HttpKernelInterface::MAIN_REQUEST, false);
$body = (string) $response->getContent();

if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) {
	@session_write_close();
}

// what this script is for. terminate() runs the inline destruct loop over the container's
// registered services, which is what makes CacheCollector::destruct() persist the collected items
if (!$dry) {
	$kernel->terminate($req, $response);
}

$after = $probe($db);

$gained = [];
foreach ($after as $key => $len) {
	if (is_int($len) && !is_int($before[$key] ?? null)) {
		$gained[] = $key;
	}
}

echo json_encode(
	[
		'dry' => $dry,
		'status' => $response->getStatusCode(),
		'bytes' => strlen($body),
		'cache' => $response->headers->get('x-drupal-cache') ?: '-',
		'before' => $before,
		'after' => $after,
		'gained' => $gained,
		// the pair is what carries the whole 16.76 ms; the third entry is 1 query and no measurable cpu
		'pairPresent' =>
			is_int($after['cache_discovery/library_info:olivero'] ?? null) &&
			is_int($after['cache_file_parsing/library.parsing_cache'] ?? null),
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
