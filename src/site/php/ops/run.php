<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Drupal\drupflare\Ops\OpsRunner;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
chdir('/drupal');

$out = ['ok' => false];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();
$req = json_decode(__CFW_REQUEST__, true);

try {
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];

	if (!isset($GLOBALS['__pw_kernel'])) {
		$request = Request::create('/', 'GET');
		$kernel = new DrupalKernel('prod', $autoloader);
		DrupalKernel::bootEnvironment();
		$sitePath = DrupalKernel::findSitePath($request);
		$kernel->setSitePath($sitePath);
		Settings::initialize('/drupal', $sitePath, $autoloader);
		$kernel->boot();
		$GLOBALS['__pw_kernel'] = $kernel;
	}
	// several operations reach a service that reads the current request; a fragment pushes none
	if (Drupal::hasContainer()) {
		Drupal::service('request_stack')->push(Request::create('/', 'GET'));
	}

	$path = '/drupal/modules/custom/drupflare/src/Ops/OpsRunner.php';
	if (!class_exists(OpsRunner::class, false) && is_file($path)) {
		require_once $path;
	}
	$cls = OpsRunner::class;
	if (!class_exists($cls)) {
		$out['error'] = 'OpsRunner is not in the mount';
	} else {
		$out = $cls::run(
			(string) ($req['name'] ?? ''),
			(array) ($req['args'] ?? []),
			(array) ($req['options'] ?? []),
		);
	}
} catch (Throwable $e) {
	$out['ok'] = false;
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
