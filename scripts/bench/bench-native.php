<?php

/**
 * Baseline: what does a Drupal 11 request cost on native PHP with no opcache?
 *
 * Two numbers come out of this and both are load-bearing for the Workers
 * question. The file count is the subrequest budget if every include is an
 * env.ASSETS.fetch(). The CPU time is the floor that php-wasm multiplies.
 *
 * Run with opcache off to match the wasm environment:
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off bench-native.php <drupal-root>
 */

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$root = $argv[1] ?? null;
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-native.php <drupal-root>\n");
	exit(1);
}

chdir($root);

/** wall + cpu, so we can separate I/O wait from the part Cloudflare bills */
function marks(): array
{
	$r = getrusage();
	return [
		'wall' => microtime(true),
		'cpu' =>
			$r['ru_utime.tv_sec'] +
			$r['ru_utime.tv_usec'] / 1e6 +
			($r['ru_stime.tv_sec'] + $r['ru_stime.tv_usec'] / 1e6),
	];
}

function delta(array $a, array $b): array
{
	return [
		'wallMs' => round(($b['wall'] - $a['wall']) * 1000, 1),
		'cpuMs' => round(($b['cpu'] - $a['cpu']) * 1000, 1),
	];
}

$phases = [];
$t = marks();
$filesStart = count(get_included_files());

// #region autoload
$autoloader = require_once $root . '/autoload.php';
$t2 = marks();
$phases['autoload'] = delta($t, $t2) + ['files' => count(get_included_files()) - $filesStart];
// #endregion

// #region kernel boot
$request = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $autoloader);

// the sequence DrupalKernel::handle() runs internally via initializeSettings()
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($request);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();
$t3 = marks();
$phases['boot'] = delta($t2, $t3) + ['files' => count(get_included_files())];
// #endregion

// #region handle requests
// request 1 is cold; later ones reuse the booted kernel, which is exactly the
// warm-isolate model the architecture depends on
$status = null;
$bytes = 0;
$requests = [];
$prev = $t3;
for ($i = 0; $i < 3; $i++) {
	$filesBefore = count(get_included_files());
	try {
		$response = $kernel->handle(Request::create('/', 'GET'));
		$status = $response->getStatusCode();
		$bytes = strlen((string) $response->getContent());
	} catch (\Throwable $e) {
		$status = 'ERROR: ' . get_class($e) . ': ' . $e->getMessage();
	}
	$now = marks();
	$requests[] = delta($prev, $now) + [
		'newFiles' => count(get_included_files()) - $filesBefore,
		'totalFiles' => count(get_included_files()),
		'status' => $status,
	];
	$prev = $now;
}
$t4 = $prev;
$phases['handle'] = delta($t3, $t4) + ['files' => count(get_included_files())];
$phases['perRequest'] = $requests;
// #endregion

$included = get_included_files();
$phpFiles = array_filter($included, fn($f) => str_ends_with($f, '.php'));
$twig = array_filter($included, fn($f) => str_contains($f, 'twig') || str_ends_with($f, '.twig'));

echo json_encode(
	[
		'php' => PHP_VERSION,
		'opcache' => function_exists('opcache_get_status') && @opcache_get_status() !== false,
		'status' => $status,
		'responseBytes' => $bytes,
		'phases' => $phases,
		'total' => delta($t, $t4),
		'includedFiles' => count($included),
		'includedPhpFiles' => count($phpFiles),
		'includedTwig' => count($twig),
		'peakMemoryBytes' => memory_get_peak_usage(true),
		'peakMemoryMb' => round(memory_get_peak_usage(true) / 1048576, 1),
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
