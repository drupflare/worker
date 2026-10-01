<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');

$clock = function () {
	return microtime(true) * 1000;
};
$mark = [];
$t0 = $clock();

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];
	$mark['alreadyBooted'] = isset($GLOBALS['__pw_site_booted']) ? 1 : 0;

	if (!isset($GLOBALS['__pw_kernel'])) {
		$a = $clock();
		$request = Request::create('/', 'GET');
		$kernel = new DrupalKernel('prod', $autoloader);
		DrupalKernel::bootEnvironment();
		$sitePath = DrupalKernel::findSitePath($request);
		$kernel->setSitePath($sitePath);
		Settings::initialize('/drupal', $sitePath, $autoloader);
		$kernel->boot();
		$mark['kernelBootMs'] = round($clock() - $a, 2);
		$GLOBALS['__pw_kernel'] = $kernel;
		$GLOBALS['__pw_site_booted'] = true;
	}

	// the container has to be reachable, or the "booted" claim is empty
	$container = Drupal::hasContainer() ? Drupal::getContainer() : null;
	$mark['ok'] = $container !== null;
	$mark['hasDb'] = $container !== null && $container->has('database');
	$mark['totalMs'] = round($clock() - $t0, 2);
	echo json_encode($mark);
} catch (Throwable $e) {
	echo json_encode(['ok' => false, 'error' => get_class($e) . ': ' . $e->getMessage()]);
}
