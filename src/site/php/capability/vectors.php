<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');

$out = [];
$meta = [];
$why = [];

try {
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];
	if (!isset($GLOBALS['__pw_kernel'])) {
		$boot = Request::create('/', 'GET');
		$kernel = new DrupalKernel('prod', $autoloader);
		DrupalKernel::bootEnvironment();
		$sitePath = DrupalKernel::findSitePath($boot);
		$kernel->setSitePath($sitePath);
		Settings::initialize('/drupal', $sitePath, $autoloader);
		$kernel->boot();
		$GLOBALS['__pw_kernel'] = $kernel;
	}
	$meta['booted'] = true;
} catch (Throwable $e) {
	// a probe that needs no kernel still answers; one that does will report false, which is honest
	$meta['bootError'] = get_class($e) . ': ' . $e->getMessage();
}

// __CFW_CASES__

$meta['php'] = PHP_VERSION;
$meta['intSize'] = PHP_INT_SIZE;
$meta['extensions'] = get_loaded_extensions();
echo json_encode(['vectors' => $out, 'why' => $why, 'meta' => $meta]);
