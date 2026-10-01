<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

// require rather than require_once: the latter returns TRUE on a second call, and a heap restore
// reaches that state; see the note in site-php.ts
if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
	$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
}
$autoloader = $GLOBALS['__pw_autoloader'];

if (!isset($GLOBALS['__pw_kernel'])) {
	$bootRequest = Request::create('/', 'GET');
	$kernel = new DrupalKernel('prod', $autoloader);
	DrupalKernel::bootEnvironment();
	$sitePath = DrupalKernel::findSitePath($bootRequest);
	$kernel->setSitePath($sitePath);
	Settings::initialize('/drupal', $sitePath, $autoloader);
	$kernel->boot();
	$GLOBALS['__pw_kernel'] = $kernel;
	$out['bootedKernel'] = 1;
}

try {
	$stack = Drupal::service('request_stack');
	if ($stack->getCurrentRequest() === null) {
		$stack->push(Request::create('/update.php', 'GET'));
		$out['pushedRequest'] = 1;
	}
} catch (Throwable $e) {
	$out['requestStackError'] = get_class($e) . ': ' . $e->getMessage();
}

require_once '/drupal/core/includes/common.inc';
require_once '/drupal/core/includes/install.inc';
require_once '/drupal/core/includes/update.inc';
// procedural hooks live in .module files, which a bare boot never includes: the cache_flush step
// read scheduler_cache_flush as a class name and halted every Thunder update
Drupal::moduleHandler()->loadAll();
drupal_load_updates();
