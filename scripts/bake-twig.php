<?php

/**
 * Bakes precompiled Twig templates into the packed tree.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bake-twig.php <drupal-root> [--dry]
 *     [--prefix=<twig_cache_prefix>] [--target-minor=3] [--keys=<runtime-keys.json>]
 *
 * This is not "run twig:compile". A precompiled Twig cache is only reachable if THREE
 * separate identities line up, and every one of them was wrong before this script existed:
 *
 *  1. `twig_cache_prefix`. Drupal keeps it in State under `twig_extension_hash_prefix` and only
 *     regenerates it when the container's `%twig_extension_hash%` disagrees with the stored one
 *     (core/lib/Drupal/Core/Template/TwigEnvironment.php:83). So the prefix is taken from the
 *     SHIPPED database, not from the local one, and the local container's hash is asserted against
 *     the shipped row -- if those disagree the runtime would mint a fresh uniqid() prefix and every
 *     baked file would be unreachable with nothing looking wrong.
 *
 *  2. The template class name. `Twig\Environment::getTemplateClass()` hashes the loader cache key
 *     together with `optionsHash`, and optionsHash contains PHP_MAJOR_VERSION and
 *     PHP_MINOR_VERSION (vendor/twig/twig/src/Environment.php:941). Native PHP here is 8.5 and the
 *     wasm runtime is 8.3.11, so a locally compiled cache carries class names the runtime never
 *     asks for. MEASURED: a cold edge render wrote 14 NEW `twig:` cache rows next to the 26 shipped
 *     ones, same prefix, different class hash. That is the whole failure. So each class name is
 *     recomputed for the target minor and substituted into the compiled body.
 *
 *  3. The file path. The default `MTimeProtectedFileStorage` hashes the CONTAINING DIRECTORY's
 *     mtime into the filename, and a MEMFS directory's mtime is mount time -- unknowable at build
 *     time. `sites/default/settings.php` therefore pins the twig bin to plain `FileStorage`, whose
 *     path is `<dir>/<key>` and depends on nothing the mount invents. Drupal documents exactly this
 *     case (see TwigEnvironment::renderInline's note about read-only PHPStorage and build steps).
 *
 * The loader cache key is NOT a divergence: Drupal's loader passes no rootPath, so Twig uses
 * getcwd(), every Drupal entry point chdir()s to its root, and getCacheKey() strips that prefix --
 * leaving a relative path that reads the same here and at `/drupal`.
 *
 * --keys takes the runtime's own `twig:` cache ids (SELECT cid FROM cache_default WHERE cid LIKE
 * 'twig:%') and requires every one of them to be produced here. That is the only check that proves
 * the retarget arithmetic matches the runtime rather than matching itself.
 */

use Drupal\Component\Utility\Crypt;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Drupal\Core\Template\TwigPhpStorageCache;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\HttpKernelInterface;
use Twig\Environment;
use Twig\Template;

$root = $argv[1] ?? null;
$dry = in_array('--dry', $argv, true);
$prefixArg = null;
/**
 * The PHP minor the SHIPPING binary runs, read from wrangler's alias rather than hardcoded.
 *
 * It was `3`, from when the runtime was 8.3. The interpreter moved to 8.5 and this did not, so every
 * bake produced class names the runtime never asks for -- Twig folds PHP_MAJOR_VERSION and
 * PHP_MINOR_VERSION into each one -- and all of them missed, recompiled and wrote a `twig:` row on a
 * cold render. The gate that should have caught it was reading a seam nobody ships.
 *
 * `--target-minor=N` still overrides, for baking against a binary that is not the current default.
 */
$targetMinor = (static function (): int {
	$config = @file_get_contents(__DIR__ . '/../wrangler.jsonc');
	if ($config !== false && preg_match('/php-binary-(\d)(\d)\.ts/', $config, $m) === 1) {
		return (int) $m[2];
	}
	// a seam named php-binary-85.ts gives 5; anything unreadable falls back to the shipped default
	if ($config !== false && preg_match('/php-binary-8(\d)\.ts/', $config, $m) === 1) {
		return (int) $m[1];
	}
	return 5;
})();
$keysPath = null;
$paths = ['/'];
/**
 * Theme HOOKS to compile that no baked path loads.
 *
 * A path-driven bake only reaches templates a render of that path pulls in, and these two are not
 * reachable that way: the wasm runtime compiled `menu-local-task(s)` on a cold render while no native
 * render of `/`, `/user/login` or `/filter/tips` did -- measured as `twig:` rows 26 shipped against 28
 * on a fresh boot.
 *
 * Hooks, not paths, and that distinction is the fix. Naming
 * `core/modules/system/templates/menu-local-task.html.twig` compiled the wrong file: olivero ships its
 * own `templates/navigation/menu-local-task.html.twig`, so the active theme resolves the hook there and
 * the class -- hence the compiled filename -- differs. The baked file landed at a path the runtime
 * never looks up (`..._Kjn-deppa...` against the runtime's `..._zuZddZ9m...`) and the bake silently
 * achieved nothing. Going through the theme registry means this follows whatever theme is active
 * instead of hardcoding one.
 */
$extraHooks = ['menu_local_task', 'menu_local_tasks'];
$extraTemplates = [];
foreach ($argv as $arg) {
	if (str_starts_with($arg, '--prefix=')) {
		$prefixArg = substr($arg, 9);
	} elseif (str_starts_with($arg, '--target-minor=')) {
		$targetMinor = (int) substr($arg, 15);
	} elseif (str_starts_with($arg, '--keys=')) {
		$keysPath = substr($arg, 7);
	} elseif (str_starts_with($arg, '--path=')) {
		$paths = array_values(array_filter(explode(',', substr($arg, 7))));
	} elseif (str_starts_with($arg, '--hook=')) {
		$extraHooks = array_values(array_filter(explode(',', substr($arg, 7))));
	} elseif (str_starts_with($arg, '--template=')) {
		$extraTemplates = array_values(array_filter(explode(',', substr($arg, 11))));
	} elseif ($arg === '--no-extra-templates') {
		$extraHooks = [];
		$extraTemplates = [];
	}
}
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bake-twig.php <drupal-root> [--dry] [--prefix=X] [--target-minor=N]\n");
	exit(1);
}
$root = realpath($root);
$repo = realpath(__DIR__ . '/..');

/** the prefix the RUNTIME will use, which lives in the shipped database and nowhere else */
$shipped = $repo . '/assets/drupal/site.sqlite';
$shippedRow = null;
if (is_file($shipped)) {
	$pdo = new PDO('sqlite:' . $shipped);
	$st = $pdo->prepare('SELECT value FROM key_value WHERE collection = ? AND name = ?');
	$st->execute(['state', 'twig_extension_hash_prefix']);
	$raw = $st->fetchColumn();
	if (is_string($raw)) {
		$shippedRow = unserialize($raw);
	}
}
$prefix = $prefixArg ?? ($shippedRow['twig_cache_prefix'] ?? null);
if (!$prefix) {
	fwrite(STDERR, "no twig_cache_prefix: pass --prefix= or fix {$shipped}\n");
	exit(1);
}

chdir($root);
$autoloader = require_once $root . '/autoload.php';

// scripts/patch-drupal.mjs rewrote core's \Fiber call sites to \PhpWasmSyncFiber for emscripten,
// which has no ucontext; native PHP has real Fibers, so alias straight back
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(\Fiber::class, 'PhpWasmSyncFiber');
}

$req = Request::create($paths[0], 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($req);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();

$rendered = [];
foreach ($paths as $path) {
	$r = Request::create($path, 'GET');
	$response = $kernel->handle($r, HttpKernelInterface::MAIN_REQUEST, false);
	$rendered[$path] = [
		'status' => $response->getStatusCode(),
		'bytes' => strlen((string) $response->getContent()),
	];
}

// after the render, never before: several `twig.extension` services depend on `url_generator`,
// which needs a request on the stack, so building the twig service early throws
/** @var \Drupal\Core\Template\TwigEnvironment $twig */
$twig = \Drupal::service('twig');

// resolve each extra hook through the theme registry, so the ACTIVE theme's override wins
$registry = \Drupal::service('theme.registry')->get();
foreach ($extraHooks as $hook) {
	if (!isset($registry[$hook]['template'])) {
		$extraTemplates[] = "!! hook $hook is not in the theme registry";
		continue;
	}
	$info = $registry[$hook];
	$dir = isset($info['path']) ? rtrim((string) $info['path'], '/') . '/' : '';
	$extraTemplates[] = $dir . $info['template'] . '.html.twig';
}

// force the unreachable-by-path templates into `loadedTemplates` so they flow through the SAME
// pipeline as a rendered one -- including the class-name self-check below, which is what makes a
// baked file trustworthy. Loading rather than compiling directly, for exactly that reason.
$forced = [];
foreach ($extraTemplates as $name) {
	if (str_starts_with($name, '!!')) {
		$forced[$name] = 'unresolved';
		continue;
	}
	try {
		$twig->load($name);
		$forced[$name] = 'loaded';
	} catch (\Throwable $e) {
		// a template that no longer exists must be visible, not silently dropped: it would leave the
		// runtime compiling it again with nothing saying why
		$forced[$name] = get_class($e) . ': ' . $e->getMessage();
	}
}
$localHash = \Drupal::getContainer()->getParameter('twig_extension_hash');

// #region the retarget
/**
 * optionsHash exactly as Twig\Environment::updateOptionsHash() builds it, with the PHP minor
 * left open so the same code can produce the local value (for the self-check) and the target one.
 */
$optionsHash = function (int $minor) use ($twig): string {
	return implode(':', [
		json_encode(array_keys($twig->getExtensions())),
		PHP_MAJOR_VERSION,
		$minor,
		Environment::VERSION,
		(int) $twig->isDebug(),
		(int) $twig->isStrictVariables(),
		$twig->useYield() ? '1' : '0',
	]);
};
$localOptions = $optionsHash(PHP_MINOR_VERSION);
$targetOptions = $optionsHash($targetMinor);

$templateClass = function (string $cacheKey, string $options): string {
	return '__TwigTemplate_' .
		hash(PHP_VERSION_ID < 80100 ? 'sha256' : 'xxh128', $cacheKey . $options);
};

/** TwigPhpStorageCache::generateKey(), reimplemented over a class name we chose rather than Twig's */
$storageKey = function (string $name, string $class) use ($prefix): string {
	$len = TwigPhpStorageCache::SUFFIX_SUBSTRING_LENGTH;
	if (str_starts_with($name, '{# inline_template_start #}')) {
		$name = 'inline-template';
	} else {
		$name = str_replace(':', '_', basename($name));
	}
	return $prefix .
		'_' .
		substr($name, 0, $len) .
		'_' .
		substr(Crypt::hashBase64($class), 0, $len);
};

// Every template the render actually loaded, read off the environment. An
// embedded template is registered under `<class>___<n>` but shares its parent's compiled file, so
// the suffix is dropped and the set deduplicated.
$loaded = (new ReflectionProperty(Environment::class, 'loadedTemplates'))->getValue($twig) ?: [];
$names = [];
foreach ($loaded as $cls => $template) {
	if (!($template instanceof Template)) {
		continue;
	}
	$names[$template->getTemplateName()] = preg_replace('/___\d+$/', '', (string) $cls);
}

$files = [];
$manifest = [];
$mismatched = [];
foreach ($names as $name => $localClass) {
	$cacheKey = $twig->getLoader()->getCacheKey($name);
	// self-check: if this arithmetic cannot reproduce the class name the local environment just
	// used, it cannot be trusted to predict the runtime's either
	if ($templateClass($cacheKey, $localOptions) !== $localClass) {
		$mismatched[$name] = [
			'expected' => $localClass,
			'computed' => $templateClass($cacheKey, $localOptions),
		];
		continue;
	}
	$targetClass = $templateClass($cacheKey, $targetOptions);
	$body = $twig->compileSource($twig->getLoader()->getSourceContext($name));
	// the class name, then the build machine's absolute paths that Twig bakes into
	// getSourceContext() for error reporting
	$body = str_replace($localClass, $targetClass, $body);
	$body = str_replace($root, '/drupal', $body);
	$key = $storageKey($name, $targetClass);
	$files[$key] = $body;
	$manifest[$key] = ['name' => $name, 'cacheKey' => $cacheKey, 'class' => $targetClass];
}
// #endregion

$dir = $root . '/' . Settings::get('file_public_path', 'sites/default/files') . '/php/twig';
$written = [];
$removed = 0;
if (!$dry) {
	// The whole directory goes, not just the files this run replaces: what was there is the
	// MTimeProtected layout (a directory per template) plus whatever the render above wrote under
	// the LOCAL prefix, and both are unreachable from the runtime.
	$rm = function (string $p) use (&$rm, &$removed) {
		if (is_dir($p)) {
			foreach (scandir($p) as $e) {
				if ($e !== '.' && $e !== '..') {
					$rm($p . '/' . $e);
				}
			}
			@chmod($p, 0777);
			@rmdir($p);
			return;
		}
		@chmod($p, 0666);
		if (@unlink($p)) {
			$removed++;
		}
	};
	if (is_dir($dir)) {
		foreach (scandir($dir) as $e) {
			if ($e !== '.' && $e !== '..' && $e !== '.htaccess') {
				$rm($dir . '/' . $e);
			}
		}
	} else {
		mkdir($dir, 0777, true);
	}
	foreach ($files as $key => $body) {
		file_put_contents($dir . '/' . $key, $body);
		$written[] = 'sites/default/files/php/twig/' . $key;
	}
}

/**
 * The file list both packs are built from.
 *
 * `scripts/pack-perfile.ts` and `PACK_INDEX=1 scripts/pack-drupal.mjs` take their
 * file set from an existing index rather than re-globbing the tree, so a rebuild measures the tree
 * and not the completion rules. That also means neither of them can ever notice a file this script
 * just created. So the list is written here: the old index minus every compiled-Twig path (the
 * MTimeProtected layout, now unreachable) plus the ones written above.
 */
$listPath = $repo . '/assets/drupal/core.list.json';
$list = null;
if (!$dry && $written) {
	$indexPath = $repo . '/assets/drupal/core.json';
	if (!is_file($indexPath)) {
		fwrite(STDERR, "no {$indexPath}: cannot build the pack list\n");
		exit(1);
	}
	$old = json_decode((string) file_get_contents($indexPath), true) ?: [];
	$paths = [];
	foreach ($old as $entry) {
		$p = $entry['p'] ?? ($entry['path'] ?? null);
		if (is_string($p) && !str_starts_with($p, 'sites/default/files/php/twig/')) {
			$paths[] = $p;
		}
	}
	$kept = count($paths);
	foreach ($written as $p) {
		$paths[] = $p;
	}
	file_put_contents($listPath, json_encode(array_map(fn($p) => ['p' => $p], $paths)));
	$list = [
		'path' => 'assets/drupal/core.list.json',
		'files' => count($paths),
		'carriedOver' => $kept,
	];
}

/**
 * The build record, so the invariants are checkable without a Drupal bootstrap.
 *
 * `tests/node/twig-bake.spec.ts` reads this and requires the pack to agree with it: the prefix
 * against the shipped database's State row, each key's class-hash suffix against the class actually
 * declared inside the packed file, and `targetPhp` against the minor in the shipping binary's
 * filename. A repack that forgot to bake, a drupal-src refetch that lost the settings patch, or a
 * binary bumped to a new PHP minor all break the cache silently -- this is what makes them loud.
 */
$manifestPath = $repo . '/assets/drupal/twig-bake.json';
if (!$dry && $files) {
	file_put_contents(
		$manifestPath,
		json_encode(
			[
				'prefix' => $prefix,
				'targetPhp' => PHP_MAJOR_VERSION . '.' . $targetMinor,
				'builtByPhp' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
				'twigVersion' => Environment::VERSION,
				'extensionHash' => $localHash,
				'storageClass' => Settings::get('php_storage')['twig']['class'] ?? null,
				'templates' => $manifest,
			],
			JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
		) . "\n",
	);
}

/** the runtime's own keys, when handed some, are the only external check on the retarget */
$coverage = null;
if ($keysPath && is_file($keysPath)) {
	$want = json_decode((string) file_get_contents($keysPath), true) ?: [];
	$want = array_map(fn($k) => preg_replace('/^twig:/', '', (string) $k), $want);
	$have = array_keys($files);
	$coverage = [
		'wanted' => count($want),
		'covered' => count(array_intersect($want, $have)),
		'missing' => array_values(array_diff($want, $have)),
	];
}

$bytes = array_sum(array_map('strlen', $files));
echo json_encode(
	[
		'dry' => $dry,
		'rendered' => $rendered,
		// reported rather than assumed: a template named here that failed to load would otherwise be
		// recompiled by the runtime with nothing explaining why
		'forcedTemplates' => $forced,
		'prefix' => $prefix,
		'localPhp' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
		'targetPhp' => PHP_MAJOR_VERSION . '.' . $targetMinor,
		// the extension set, which is what the prefix is keyed to; a disagreement here means the
		// runtime will discard the prefix and every baked file with it
		'localExtensionHash' => $localHash,
		'shippedExtensionHash' => $shippedRow['twig_extension_hash'] ?? null,
		'extensionHashAgrees' => $localHash === ($shippedRow['twig_extension_hash'] ?? null),
		'templates' => count($files),
		'selfCheckFailures' => $mismatched,
		'bytes' => $bytes,
		'removed' => $removed,
		'packList' => $list,
		'coverage' => $coverage,
		'written' => $written,
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
