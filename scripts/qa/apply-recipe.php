<?php

/**
 * Applies a core recipe to a COPY of the shipped site database, and reports the delta.
 *
 *   php scripts/qa/apply-recipe.php <sqlite-copy> <recipe-dir> [<delta-out.json>]
 *
 * Uses core's OWN sqlite driver, not the edge driver: this is a build-time operation on a real
 * filesystem, and `drupflare`'s driver exists to reach Durable Object storage which is not present
 * here.
 */

$target = $argv[1] ?? '';
$recipeDir = $argv[2] ?? '';
$deltaOut = $argv[3] ?? '';

if ($target === '' || $recipeDir === '') {
	fwrite(STDERR, "usage: apply-recipe.php <sqlite-copy> <recipe-dir> [<delta-out.json>]\n");
	exit(2);
}
if (!is_file($target)) {
	fwrite(STDERR, "no such database: $target\n");
	exit(2);
}
// the guard that matters: the shipped artifact is not a scratch file
if (str_contains(realpath($target) ?: $target, '/assets/')) {
	fwrite(STDERR, "refusing to write to a database under assets/; copy it first\n");
	exit(2);
}

// resolved BEFORE the chdir below, or a relative recipe path stops resolving
$recipeDir = realpath($recipeDir) ?: $recipeDir;
$target = realpath($target) ?: $target;

$root = dirname(__DIR__, 2) . '/drupal-src';
if (!is_dir($root . '/core')) {
	fwrite(STDERR, "no Drupal at $root\n");
	exit(2);
}

/**
 * A PDO handle that can read a Drupal sqlite database.
 *
 * `NOCASE_UTF8` is a collation Drupal's own sqlite driver registers at connect time; a raw PDO
 * handle has never heard of it, so any index or column declared with it makes even `COUNT(*)` fail
 * with `no such collation sequence`. Registering the same two collations is what makes a read-only
 * snapshot possible outside Drupal's connection.
 */
function openDb(string $path): PDO
{
	$db = new PDO('sqlite:' . $path);
	$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
	$db->sqliteCreateCollation('NOCASE_UTF8', 'strcasecmp');
	$db->sqliteCreateFunction('LIKE_BINARY', 'strcmp', 2);
	return $db;
}

/** Every table and its row count, so a delta is a comparison rather than a guess. */
function snapshot(PDO $db): array
{
	$out = [];
	$tables = $db
		->query(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		->fetchAll(PDO::FETCH_COLUMN);
	foreach ($tables as $t) {
		$quoted = '"' . str_replace('"', '""', $t) . '"';
		$out[$t] = (int) $db->query("SELECT COUNT(*) FROM $quoted")->fetchColumn();
	}
	return $out;
}

/** Config object names, which is the human-readable half of the delta. */
function configNames(PDO $db): array
{
	try {
		return $db->query('SELECT name FROM config ORDER BY name')->fetchAll(PDO::FETCH_COLUMN);
	} catch (Throwable) {
		return [];
	}
}

$db = openDb($target);
$before = snapshot($db);
$beforeConfig = configNames($db);
$db = null;

// #region bootstrap
$autoloader = require $root . '/autoload.php';
chdir($root);

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = $root . '/index.php';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'cli';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

use Drupal\Core\Database\Database;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Recipe\Recipe;
use Drupal\Core\Recipe\RecipeRunner;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$request = Request::create('/');
DrupalKernel::bootEnvironment();

// the sqlite driver ships as a MODULE in Drupal 11, so its classes are normally autoloaded once
// `core.extension` is read -- which is after the database is needed. `settings.php` solves that
// with an `autoload` key that DrupalKernel registers; declaring the connection in code means
// registering the PSR-4 root by hand, or `Database::openConnection()` fatals on a missing class
$autoloader->addPsr4(
	'Drupal\\sqlite\\Driver\\Database\\sqlite\\',
	$root . '/core/modules/sqlite/src/Driver/Database/sqlite',
);
$autoloader->addPsr4('Drupal\\sqlite\\', $root . '/core/modules/sqlite/src');

// the connection is declared here rather than in a settings.php, so no file is written into a
// Drupal tree that other build steps read
Database::addConnectionInfo('default', 'default', [
	'driver' => 'sqlite',
	'database' => $target,
	'namespace' => 'Drupal\\sqlite\\Driver\\Database\\sqlite',
	'autoload' => 'core/modules/sqlite/src/Driver/Database/sqlite/',
]);

$kernel = new DrupalKernel('prod', $autoloader, false);
$kernel->setSitePath('sites/default');
Settings::initialize($root, 'sites/default', $autoloader);
$kernel->boot();
$kernel->preHandle($request);
// #endregion

$result = ['recipe' => $recipeDir, 'ok' => false];

try {
	$recipe = Recipe::createFromDirectory($recipeDir);
	$result['name'] = $recipe->name;
	RecipeRunner::processRecipe($recipe);
	$result['ok'] = true;
} catch (Throwable $e) {
	$result['error'] = get_class($e) . ': ' . $e->getMessage();
	$result['at'] = $e->getFile() . ':' . $e->getLine();
}

$db = openDb($target);
$after = snapshot($db);
$afterConfig = configNames($db);

$tableDelta = [];
foreach ($after as $table => $count) {
	$was = $before[$table] ?? null;
	if ($was === null) {
		$tableDelta[$table] = ['created' => true, 'rows' => $count];
	} elseif ($was !== $count) {
		$tableDelta[$table] = ['before' => $was, 'after' => $count, 'delta' => $count - $was];
	}
}
foreach ($before as $table => $count) {
	if (!array_key_exists($table, $after)) {
		$tableDelta[$table] = ['dropped' => true, 'rows' => $count];
	}
}

$result['tables'] = $tableDelta;
$result['configAdded'] = array_values(array_diff($afterConfig, $beforeConfig));
$result['configRemoved'] = array_values(array_diff($beforeConfig, $afterConfig));
$result['configBefore'] = count($beforeConfig);
$result['configAfter'] = count($afterConfig);

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
if ($deltaOut !== '') {
	file_put_contents(
		$deltaOut,
		json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
	);
}
exit($result['ok'] ? 0 : 1);
