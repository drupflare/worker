<?php

/**
 * Prices Drupal's database abstraction layer natively, mirroring the /dbal
 * route in src/static.js loop-for-loop so the wasm:native ratio is measured
 * rather than assumed.
 *
 * This exists because raw PDO was measured both ways (0.0026 ms native /
 * 0.008 ms wasm, 3.1x) but Drupal's Connection::query() only in wasm
 * (0.866 ms), leaving the interesting question open: is the DBAL simply
 * expensive everywhere, or does wasm amplify it specifically?
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off bench-dbal.php <drupal-root> [n]
 */

use Drupal\Core\Database\Database;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$root = $argv[1] ?? null;
$n = (int) ($argv[2] ?? 2000);
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-dbal.php <drupal-root> [n]\n");
	exit(1);
}

// resolve before chdir: the require below is built from $root, and a relative
// $root stops resolving once the cwd changes
$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
$request = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($request);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();

$t = fn() => microtime(true) * 1000;
$out = [];
$db = \Drupal::database();

// the wasm run's first number was taken with three loggers still attached; prove
// this one is not
$out['loggingActive'] = Database::getLog('pw', 'default') === null ? 0 : 1;

$drupalBench = function (int $n) use ($db, $t): array {
	$db->query('SELECT 1')->fetchAll();
	$a = $t();
	for ($i = 0; $i < $n; $i++) {
		$db->query('SELECT 1')->fetchAll();
	}
	$triv = ($t() - $a) / $n;
	$a = $t();
	for ($i = 0; $i < $n; $i++) {
		$db->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [
			':c' => 'pw_' . $i,
		])->fetchAll();
	}
	return [round($triv, 4), round(($t() - $a) / $n, 4)];
};

[$a1, $b1] = $drupalBench($n);
$out['drupalNoLogging'] = ['trivialMs' => $a1, 'indexedMs' => $b1];

$m = new PDO('sqlite::memory:');
$m->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$m->exec('CREATE TABLE cache_discovery (cid TEXT PRIMARY KEY, data BLOB)');
$m->query('SELECT 1')->fetchAll();
$a = $t();
for ($i = 0; $i < $n; $i++) {
	$m->query('SELECT 1')->fetchAll();
}
$out['rawPdo']['trivialMs'] = round(($t() - $a) / $n, 4);
$a = $t();
for ($i = 0; $i < $n; $i++) {
	$st = $m->prepare('SELECT cid FROM cache_discovery WHERE cid = :c');
	$st->execute([':c' => 'x_' . $i]);
	$st->fetchAll();
}
$out['rawPdo']['indexedMs'] = round(($t() - $a) / $n, 4);

// Does PHP's global-scope variable penalty explain the wasm figure, or is wasm
// amplifying it? Same A/B as the /dbal route: global scope keeps variables in a
// hashtable, function scope compiles them to CVs.
$M = 400;
$dbz = \Drupal::database();
$dbz->query('SELECT 1')->fetchAll();
$a = $t();
for ($i3 = 0; $i3 < $M; $i3++) {
	$dbz->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [
		':c' => 'g_' . $i3,
	])->fetchAll();
}
$globalMs = ($t() - $a) / $M;
$fn = function ($M, $dbz, $t) {
	$a = $t();
	for ($i = 0; $i < $M; $i++) {
		$dbz->query('SELECT [cid] FROM {cache_discovery} WHERE [cid] = :c', [
			':c' => 'f_' . $i,
		])->fetchAll();
	}
	return ($t() - $a) / $M;
};
$fnMs = $fn($M, $dbz, $t);
$out['scopeAB'] = [
	'globalScopeMs' => round($globalMs, 4),
	'functionScopeMs' => round($fnMs, 4),
	'multiple' => $fnMs > 0 ? round($globalMs / $fnMs, 1) : 0,
];

Database::startLog('pw');
[$a2, $b2] = $drupalBench($n);
$out['drupalWithLogging'] = ['trivialMs' => $a2, 'indexedMs' => $b2];
$out['loggingTaxMs'] = round($b2 - $b1, 4);

$out['pcreJit'] = (string) ini_get('pcre.jit');
$subject =
	'SELECT [cid] FROM {cache_discovery} c INNER JOIN {users_field_data} u ON u.[uid] = c.[uid] WHERE [cid] = :c';
$a = $t();
for ($i = 0; $i < $n; $i++) {
	preg_replace_callback('/{(\S*)}/', fn($mm) => 'x' . $mm[1], $subject);
}
$out['pregReplaceCallbackMs'] = round(($t() - $a) / $n, 4);
$a = $t();
for ($i = 0; $i < $n; $i++) {
	preg_match('#^/user/(\d+)/edit$#', '/user/12345/edit', $mm);
}
$out['pregMatchMs'] = round(($t() - $a) / $n, 4);
$a = $t();
for ($i = 0; $i < $n; $i++) {
	str_replace(['{', '}'], ['p_', ''], $subject);
}
$out['strReplaceMs'] = round(($t() - $a) / $n, 4);

echo json_encode($out, JSON_PRETTY_PRINT), "\n";
