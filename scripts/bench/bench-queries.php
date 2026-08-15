<?php

/**
 * Does Drupal actually generate queries that exceed a backend's bound-parameter
 * cap? The 100-placeholder limit was called out as unsolved, so measure it
 * rather than argue about it.
 *
 * D1 caps bound parameters at 100. SQLite's own SQLITE_MAX_VARIABLE_NUMBER is
 * 32766 in modern builds, so the cap is a D1 property, not a SQLite one --
 * which means it disappears entirely on Durable Object SQLite.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off bench-queries.php <root>
 */

use Drupal\Core\Database\Database;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$root = $argv[1] ?? null;
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-queries.php <drupal-root>\n");
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

Database::startLog('bench');

$response = $kernel->handle($request);
$status = $response->getStatusCode();

$log = Database::getLog('bench', 'default');

$counts = [];
$worst = ['sql' => null, 'args' => 0];
$named = 0;
$positional = 0;

foreach ($log as $entry) {
	$n = is_array($entry['args'] ?? null) ? count($entry['args']) : 0;
	$counts[] = $n;
	if ($n > $worst['args']) {
		$worst = ['sql' => substr((string) $entry['query'], 0, 300), 'args' => $n];
	}
	foreach (array_keys($entry['args'] ?? []) as $k) {
		if (is_string($k) && str_starts_with($k, ':')) {
			$named++;
		} else {
			$positional++;
		}
	}
}

sort($counts);
$total = count($counts);

echo json_encode(
	[
		'status' => $status,
		'queries' => $total,
		'placeholders' => [
			'max' => $total ? max($counts) : 0,
			'median' => $total ? $counts[intdiv($total, 2)] : 0,
			'over100' => count(array_filter($counts, fn($n) => $n > 100)),
			'over32766' => count(array_filter($counts, fn($n) => $n > 32766)),
		],
		'bindingStyle' => [
			'namedArgs' => $named,
			'positionalArgs' => $positional,
		],
		'worstQuery' => $worst,
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
