<?php

/**
 * Does Drupal generate queries with more than 100 bound parameters?
 *
 * A front page peaks at 12, which says nothing about the shape that actually
 * risks it: entity/Views queries whose IN() sets scale with result count. This
 * drives those directly rather than hoping a content page happens to hit them.
 *
 * Placeholder generation is the query builder's behaviour, so it is
 * backend-independent -- measuring natively is both valid and much faster than
 * building hundreds of nodes inside wasm.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off bench-placeholders.php <root>
 */

use Drupal\Core\Database\Database;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$root = $argv[1] ?? null;
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-placeholders.php <drupal-root>\n");
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
$kernel->preHandle($request);

$results = [];

/** Runs a callable with query logging and reports the largest bound-arg count. */
function measure(string $label, callable $fn): array
{
	$key = 'ph_' . md5($label);
	Database::startLog($key);
	$error = null;
	try {
		$fn();
	} catch (\Throwable $e) {
		$error = get_class($e) . ': ' . substr($e->getMessage(), 0, 120);
	}
	$log = Database::getLog($key, 'default');
	$max = 0;
	$worst = '';
	$total = 0;
	foreach ($log as $entry) {
		$n = is_array($entry['args'] ?? null) ? count($entry['args']) : 0;
		$total++;
		if ($n > $max) {
			$max = $n;
			$worst = substr((string) $entry['query'], 0, 160);
		}
	}
	return [
		'label' => $label,
		'queries' => $total,
		'maxPlaceholders' => $max,
		'over100' => $max > 100,
		'worst' => $worst,
		'error' => $error,
	];
}

// 1. Entity query with a large IN() set -- the canonical risk shape.
foreach ([50, 150, 500, 2000] as $n) {
	$results[] = measure("entityQuery nid IN ($n ids)", function () use ($n) {
		Drupal::entityQuery('node')
			->accessCheck(false)
			->condition('nid', range(1, $n), 'IN')
			->execute();
	});
}

// 2. Loading many entities at once -- what a Views page does after its query.
$results[] = measure('loadMultiple(500 nids)', function () {
	Drupal::entityTypeManager()->getStorage('node')->loadMultiple(range(1, 500));
});

// 3. Config entity load, which fans out into key_value reads.
$results[] = measure('config entity loadMultiple', function () {
	Drupal::entityTypeManager()->getStorage('node_type')->loadMultiple();
});

// 4. Direct select with a large IN(), bypassing the entity layer.
$results[] = measure('select IN (1000)', function () {
	Drupal::database()
		->select('node_field_data', 'n')
		->fields('n', ['nid'])
		->condition('nid', range(1, 1000), 'IN')
		->execute()
		->fetchAll();
});

echo json_encode(
	[
		'note' => 'D1 caps bound parameters at 100; SQLite itself allows 32766',
		'results' => $results,
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
