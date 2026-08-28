<?php

/**
 * Produces `site.sqlite` from nothing, which is the artifact that had no producer.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/drupal/install-site-db.php \
 *       drupal-src /tmp/built-site.sqlite [--site-name="CFW Bench"] [--allow-shipping-pack]
 *
 * `assets/drupal/site.sqlite` is the database the edge executes, it is the only
 * TRACKED artifact under `assets/` because nothing regenerates it, and its recipe lived in a chat
 * log. Every fix that touched it -- the collector entries, the container definition -- therefore
 * went in as a surgical insert against a file no one could rebuild. That gates one-click deploy: a
 * clean checkout can fetch Drupal (`scripts/vendor.ts`) and pack every other asset, and then has no
 * way to produce the database those assets are indexed against.
 *
 * It installs into `sites/build` rather than `sites/default`. Core's own `dr install` takes no
 * `--site-path` and refuses outright when a site is already installed, and `drupal-src/sites/default`
 * holds the baked Twig cache plus the working settings. Driving `install_drupal()` directly with an
 * explicit `site_path` is what makes this non-destructive by construction rather than by care.
 *
 * What it cannot do: the output is NOT byte-reproducible. A
 * Drupal install mints a random hash salt, a UUID per config object, an admin password and
 * per-row timestamps, so two runs of this script differ in thousands of bytes while describing the
 * same site. Reproducibility here means STRUCTURAL -- the same tables, the same module set, the same
 * config keys, and a front page that renders the same bytes. `scripts/diff-site-db.ts` is the
 * acceptance check and it compares exactly that.
 *
 * The module set is not a guess. The shipping pack's 39 modules are exactly the `standard` profile's
 * dependency closure, plus `update` (which the install form enables), plus `media`. `media` looks
 * unintentional -- it contributes 11 empty tables and nothing renders it -- but this script
 * reproduces what SHIPS, so it enables it and says so. Dropping it is a separate measured change.
 */

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

$argvRest = array_slice($argv, 1);
$flags = array_values(array_filter($argvRest, fn($a) => str_starts_with($a, '--')));
$positional = array_values(array_filter($argvRest, fn($a) => !str_starts_with($a, '--')));

$root = $positional[0] ?? null;
$out = $positional[1] ?? null;

/** reads --name=value out of the flag list */
$opt = function (string $name, ?string $default = null) use ($flags): ?string {
	foreach ($flags as $flag) {
		if (str_starts_with($flag, "--$name=")) {
			return substr($flag, strlen($name) + 3);
		}
	}
	return $default;
};
$has = fn(string $name): bool => in_array("--$name", $flags, true);

if (!$root || !is_dir($root) || !$out) {
	fwrite(STDERR, "usage: install-site-db.php <drupal-root> <output.sqlite> [--site-name=...]\n");
	exit(2);
}

$root = realpath($root);
$out = str_starts_with($out, '/') ? $out : getcwd() . '/' . $out;

// the shipping pack is the one artifact in this repository that nothing else can rebuild, and this
// script is the first thing that could ever overwrite it. An explicit flag rather than a prompt,
// because the caller is usually a build script
$shipping = realpath(__DIR__ . '/../..') . '/assets/drupal/site.sqlite';
if ($out === $shipping && !$has('allow-shipping-pack')) {
	fwrite(STDERR, "refusing to write the shipping pack without --allow-shipping-pack.\n");
	fwrite(
		STDERR,
		"It is tracked BECAUSE nothing regenerated it; build elsewhere and diff first:\n",
	);
	fwrite(STDERR, "  bun scripts/diff-site-db.ts assets/drupal/site.sqlite <built.sqlite>\n");
	exit(2);
}

$siteName = $opt('site-name', 'CFW Bench');
$siteMail = $opt('site-mail', 'drupal@example.com');
// pinned rather than random so a build log is reproducible; the shipped database is a public
// starter pack, and first-run configuration is what sets a real one per site
$password = $opt('password', 'drupflare-build');
$sitePath = 'sites/' . $opt('site-dir', 'build');

chdir($root);
$absSite = $root . '/' . $sitePath;

// a previous run's site directory would make install_drupal() report an installed site and stop, so
// it goes first. Scoped to the build directory by construction: this path can only ever be
// sites/<something>, never the root and never sites/default unless the caller names it
if ($sitePath === 'sites/default') {
	fwrite(STDERR, "refusing to install into sites/default; it holds the baked Twig cache\n");
	exit(2);
}
if (is_dir($absSite)) {
	$it = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator($absSite, FilesystemIterator::SKIP_DOTS),
		RecursiveIteratorIterator::CHILD_FIRST,
	);
	foreach ($it as $entry) {
		/** @var SplFileInfo $entry */
		@chmod($entry->getPathname(), 0777);
		$entry->isDir() ? @rmdir($entry->getPathname()) : @unlink($entry->getPathname());
	}
	@rmdir($absSite);
}
mkdir($absSite . '/files', 0775, true);
copy($root . '/sites/default/default.settings.php', $absSite . '/settings.php');
chmod($absSite . '/settings.php', 0664);

define('MAINTENANCE_MODE', 'install');
$classLoader = require_once $root . '/autoload.php';
// the packed tree aliases Fiber so the wasm runtime can find it; a native install must not trip
// over the alias being absent
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}
require_once $root . '/core/includes/install.core.inc';

$driver = 'Drupal\\sqlite\\Driver\\Database\\sqlite';
$dbRelative = $sitePath . '/files/.sqlite';

$parameters = [
	'interactive' => false,
	'site_path' => $sitePath,
	'parameters' => [
		'profile' => $opt('profile', 'standard'),
		'langcode' => 'en',
	],
	'forms' => [
		'install_settings_form' => [
			'driver' => $driver,
			$driver => ['database' => $dbRelative],
		],
		'install_configure_form' => [
			'site_name' => $siteName,
			'site_mail' => $siteMail,
			'account' => [
				'name' => 'admin',
				'mail' => 'admin@example.com',
				'pass' => ['pass1' => $password, 'pass2' => $password],
			],
			// this flag is what puts `update` in the module list, so the shipping set depends on it
			'enable_update_status_module' => true,
			// Checkboxes::valueCallback() wants NULL rather than FALSE for a programmatic submit
			'enable_update_status_emails' => null,
		],
	],
];

$tasksRun = 0;
install_drupal($classLoader, $parameters, function () use (&$tasksRun) {
	$tasksRun++;
});

$dbFile = $root . '/' . $dbRelative;
if (!is_file($dbFile)) {
	fwrite(STDERR, "install reported success but $dbRelative does not exist\n");
	exit(1);
}

// #region post-install, the part that turns a stock install into the shipping pack
// Re-boot a kernel against the installed site rather than reusing the installer's: the installer's
// container is built in MAINTENANCE_MODE and its module handler does not reflect a normal request.
$request = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $classLoader);
DrupalKernel::bootEnvironment();
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $classLoader);
$kernel->boot();
$kernel->preHandle($request);

$installer = Drupal::service('module_installer');
$extra = array_filter(explode(',', (string) $opt('extra-modules', 'media')));
$installedExtra = [];
foreach ($extra as $module) {
	if (!Drupal::moduleHandler()->moduleExists($module)) {
		$installer->install([$module]);
		$installedExtra[] = $module;
	}
}

// the same two trims `scripts/drupal/trim-site-config.php` applies to a live tree, because this
// runtime has no outbound socket: with advisories on, SystemHooks::cron() GETs updates.drupal.org
Drupal::configFactory()->getEditable('system.advisories')->set('enabled', false)->save();

$settingsFile = $absSite . '/settings.php';
$source = file_get_contents($settingsFile);
if (!preg_match('/^\s*\$settings\[.auto_create_htaccess.\]/m', $source)) {
	// a SETTING rather than config, despite living beside system.file in every discussion of it:
	// HtaccessWriter reads Settings::get('auto_create_htaccess', TRUE) and nothing else
	chmod($settingsFile, 0664);
	file_put_contents($settingsFile, $source . "\n\$settings['auto_create_htaccess'] = FALSE;\n");
}

// install-time log noise. 40 rows of it shipped in the pack, and a starter database that arrives
// carrying another site's install log is dirt rather than content
$truncated = 0;
if (Drupal::database()->schema()->tableExists('watchdog')) {
	$truncated = (int) Drupal::database()
		->select('watchdog')
		->countQuery()
		->execute()
		->fetchField();
	Drupal::database()->truncate('watchdog')->execute();
}

// WAL first, or the copy loses whatever the last transactions wrote: the installer leaves a -wal
// and a -shm beside the database and copying the main file alone drops both.
//
// Through DRUPAL's connection, not a fresh PDO handle. VACUUM rebuilds every index, and the user
// tables are declared `COLLATE NOCASE_UTF8` -- a collation the sqlite driver registers per
// connection (Connection.php:151), so a raw `new PDO()` cannot rebuild them and fails with
// "no such collation sequence". A plain sqlite3 client reading this file hits the same wall, which
// is worth knowing before debugging one.
$db = Drupal::database();
$db->query('PRAGMA wal_checkpoint(TRUNCATE)');
$db->query('VACUUM');

$kernel->terminate($request, new Response());
// #endregion

@mkdir(dirname($out), 0775, true);
if (!copy($dbFile, $out)) {
	fwrite(STDERR, "could not copy $dbFile to $out\n");
	exit(1);
}
foreach (['-wal', '-shm'] as $suffix) {
	@unlink($out . $suffix);
}

$check = new PDO('sqlite:' . $out);
$tables = (int) $check
	->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table'")
	->fetchColumn();
$configRows = (int) $check->query('SELECT COUNT(*) FROM config')->fetchColumn();
$routes = (int) $check->query('SELECT COUNT(*) FROM router')->fetchColumn();

echo json_encode(
	[
		'out' => $out,
		'bytes' => filesize($out),
		'tables' => $tables,
		'configRows' => $configRows,
		'routes' => $routes,
		'installTasks' => $tasksRun,
		'extraModulesInstalled' => $installedExtra,
		'watchdogRowsTruncated' => $truncated,
		'siteName' => $siteName,
		'buildSitePath' => $sitePath,
		'notReproducibleByBytes' =>
			'hash salt, config UUIDs, admin hash and timestamps differ per run',
		'next' => 'bun scripts/diff-site-db.ts assets/drupal/site.sqlite ' . $out,
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
