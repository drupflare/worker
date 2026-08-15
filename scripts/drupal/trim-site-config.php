<?php

/**
 * Turns off the two things a shipped Drupal-on-Workers site cannot do anything
 * with, and reports the before/after so the change is a measurement rather than
 * an assertion.
 *
 * Both exist because this runtime has no outbound socket and no real filesystem:
 *
 *   - `system.advisories.enabled` is CONFIG. SystemHooks::cron() hands it to
 *     SecurityAdvisoriesFetcher, which GETs updates.drupal.org; with it TRUE the
 *     whole `system` cron hook has to stay skipped.
 *   - `auto_create_htaccess` is a SETTING, not config, despite living next to
 *     `system.file` in every discussion of it. HtaccessWriter::write() and
 *     ::ensureHtaccess() both read `Settings::get('auto_create_htaccess', TRUE)`,
 *     so the only place to turn it off is settings.php, which ships inside the
 *     pack.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/drupal/trim-site-config.php \
 *       <drupal-root>
 */

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$root = $argv[1] ?? null;
if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: trim-site-config.php <drupal-root>\n");
	exit(2);
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(\Fiber::class, 'PhpWasmSyncFiber');
}

$request = Request::create('/', 'GET');
$kernel = new DrupalKernel('prod', $autoloader);
DrupalKernel::bootEnvironment();
$sitePath = DrupalKernel::findSitePath($request);
$kernel->setSitePath($sitePath);
Settings::initialize($root, $sitePath, $autoloader);
$kernel->boot();
$kernel->preHandle($request);

$factory = \Drupal::configFactory();
$advisories = $factory->getEditable('system.advisories');
$before = $advisories->get('enabled');
$advisories->set('enabled', false)->save();
$after = \Drupal::config('system.advisories')->get('enabled');

// settings.php is shipped read-only in this tree, so widen it for the append and
// put the mode back
$settingsFile = $root . '/' . $sitePath . '/settings.php';
$source = file_get_contents($settingsFile);
// anchored and comment-aware: default.settings.php ships the line
// commented out at :623, so a plain strpos() reports it as already applied
$pattern = "/^[ \t]*\\\$settings\\['auto_create_htaccess'\\]/m";
$appended = false;
if (!preg_match($pattern, $source)) {
	$mode = fileperms($settingsFile) & 0777;
	chmod($settingsFile, 0644);
	file_put_contents(
		$settingsFile,
		$source .
			"\n// no real filesystem, so the .htaccess writes have nothing to protect\n" .
			"\$settings['auto_create_htaccess'] = FALSE;\n",
	);
	chmod($settingsFile, $mode);
	$appended = true;
}

echo json_encode(
	[
		'system.advisories:enabled' => ['before' => $before, 'after' => $after],
		'auto_create_htaccess' => [
			'file' => $sitePath . '/settings.php',
			'appended' => $appended,
			'alreadyPresent' => !$appended,
		],
	],
	JSON_UNESCAPED_SLASHES,
),
	"\n";
