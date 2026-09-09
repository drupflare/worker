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
use Drupal\Core\Recipe\Recipe;
use Drupal\Core\Recipe\RecipeRunner;
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
	// the directory itself, before the walk. Drupal's installer hardens the site directory to 0555,
	// and an entry cannot be removed FROM a directory with no write bit -- so the walk below chmod'd
	// every file, failed every unlink under `@`, and the next run warned `mkdir(): File exists`
	@chmod($absSite, 0775);
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
// `require`, never `require_once`, and guarded on the VALUE: the once form answers `true` when the
// file is already included, and the next line calls a method on it. composer's getLoader()
// memoizes, so re-requiring costs nothing
$classLoader = require $root . '/autoload.php';
if (!is_object($classLoader)) {
	fwrite(STDERR, "autoload.php returned no ClassLoader\n");
	exit(1);
}
// the packed tree aliases Fiber so the wasm runtime can find it; a native install must not trip
// over the alias being absent
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}
// The library the driver layer extends, which composer did not install into this tree.
//
// `drupflare`'s HttpsStreamWrapper extends the packaged `Drupflare\StreamHttp\HttpsStreamWrapper`,
// and Drupal registers a namespace per MODULE -- a `libraries/` directory is not one, so enabling
// the module fatals on the parent class the moment ModuleHandler::load() includes its .module. On
// the edge the same root is registered in both autoloader sites; here it is one addPsr4.
$streamHttp = $root . '/libraries/drupflare-stream-http/src/';
if (is_dir($streamHttp)) {
	$classLoader->addPsr4('Drupflare\\StreamHttp\\', $streamHttp);
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
$extra = array_filter(explode(',', (string) $opt('extra-modules', 'media,drupflare')));
$installedExtra = [];
foreach ($extra as $module) {
	if (!Drupal::moduleHandler()->moduleExists($module)) {
		$installer->install([$module]);
		$installedExtra[] = $module;
	}
}

// #region the recipe, which is where the `page` content type comes from
// The shipping pack has one, and Drupal 11.4's `standard` profile ships NO node type at all --
// `page` and `article` are recipes under `core/recipes/`. So a stock install produces a site with no
// content type and the pack was assumed to differ for some other reason.
$recipesApplied = [];
foreach (array_filter(explode(',', (string) $opt('recipes', 'page_content_type'))) as $name) {
	$dir = $root . '/core/recipes/' . $name;
	if (!is_dir($dir)) {
		fwrite(STDERR, "no recipe at $dir\n");
		exit(1);
	}
	RecipeRunner::processRecipe(Recipe::createFromDirectory($dir));
	$recipesApplied[] = $name;
}
// a recipe rebuilds the container and the entity definitions, so the kernel this script goes on to
// use has to be the one the recipe left behind rather than the one that applied it
$kernel = Drupal::service('kernel');
// #endregion

// #region the four config values the shipped pack disagrees with a stock install about
// THROUGH ConfigFactory, NEVER SQL. `save()` clears `cache_config` and invalidates `config:<name>`;
// a direct UPDATE leaves the serialized copy in the bin, Drupal reads the bin first, and the edit is
// inert. That is not hypothetical -- commit 18b0aa85 shipped exactly that and the max_age fix did
// nothing on any site until a later commit happened to move the cached row too.
$configEdits = [
	// 0 is the installer default and correct for a host that configures a reverse proxy separately.
	// Here the reverse proxy IS the product: at 0 every render answers `private, no-store`,
	// `fillOne()` declines the upsert, and the page table stays empty on every site ever created
	'system.performance' => [
		'cache.page.max_age' => 300,
		// the aggregates are built at pack time and served from `/agg/`, so Drupal preprocessing
		// them again at request time would produce a second set nothing publishes
		'css.preprocess' => false,
		'js.preprocess' => false,
	],
	// the host owns the schedule; Drupal firing its own on a request would run cron inside a serve
	'automated_cron.settings' => ['interval' => 0],
];
$factory = Drupal::configFactory();
foreach ($configEdits as $name => $values) {
	$editable = $factory->getEditable($name);
	foreach ($values as $key => $value) {
		$editable->set($key, $value);
	}
	$editable->save();
}

// `system.advisories` IS LEFT ON, reversing what this script used to do. It forced `enabled` false
// on the reasoning that SystemHooks::cron() GETs updates.drupal.org and this runtime has no outbound
// socket. Both halves of that expired: the stream wrapper and the park landed, `CRON_HOOKS` runs
// `system` and `update`, and advisory detection is the host's `cron:advisories`. The shipped pack has
// carried `enabled: true` in all six of its committed versions, so the trim was also already wrong
// about what it was reproducing.
// #endregion

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

// Through DRUPAL's connection everywhere below, not a fresh PDO handle. The user tables are
// declared `COLLATE NOCASE_UTF8`, a collation the sqlite driver registers per connection
// (Connection.php:151), so a raw `new PDO()` cannot rebuild an index over them and fails with
// "no such collation sequence". A plain sqlite3 client reading this file hits the same wall.
$db = Drupal::database();

// #region the cache secondary indexes, dropped because this runtime charges a row for each of them
// Every cache bin ships `<bin>_created` and `<bin>_expire`. On the edge nothing reads either:
// `DatabaseBackend::getMultiple()` selects by cid, and `garbageCollection()` never runs because the
// host sweeps expiry itself from `EXPIRED_ROW_RULES`. Each surviving index is a charged row on every
// insert into the bin, and the fill path is what free's row budget binds.
//
// `cache_data` KEEPS both, and that exception is the whole reason this is a list rather than a
// wildcard: `gcPass()` caps that bin with `ORDER BY created` and sweeps it with `expire < ?`, so
// dropping them turns every alarm into a full scan. `tests/node/index-audit.spec.ts` asserts both
// halves -- 13 bins at one charged row, `cache_data` at three.
$keepIndexesOn = array_filter(explode(',', (string) $opt('keep-cache-indexes', 'cache_data')));
$droppedIndexes = [];
$bins = $db
	->query(
		"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cache\\_%' ESCAPE '\\'",
	)
	->fetchCol();
foreach ($bins as $bin) {
	if (in_array($bin, $keepIndexesOn, true)) {
		continue;
	}
	foreach (['created', 'expire'] as $column) {
		$index = $bin . '_' . $column;
		// asked of sqlite_master rather than wrapped in try/catch: a caught-and-ignored DROP still
		// dirties sqlite_master, and that took the serve path into `migrate: starting` once already
		$present = (int) $db
			->query("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=:n", [
				':n' => $index,
			])
			->fetchField();
		if ($present === 0) {
			continue;
		}
		$db->query('DROP INDEX ' . $index);
		$droppedIndexes[] = $index;
	}
}
// #endregion

// WAL first, or the copy loses whatever the last transactions wrote: the installer leaves a -wal
// and a -shm beside the database and copying the main file alone drops both. The VACUUM after it
// reclaims what the dropped indexes and the truncate freed, so the artifact carries no free pages;
// the shipped file has 739 of them because nothing ever vacuumed it after an edit.
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
		'recipesApplied' => $recipesApplied,
		'configEdited' => array_keys($configEdits),
		'cacheIndexesDropped' => count($droppedIndexes),
		'cacheIndexesKept' => $keepIndexesOn,
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
