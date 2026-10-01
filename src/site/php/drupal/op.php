<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');

$out = ['ok' => false];

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
	if (!isset($GLOBALS['__pw_kernel'])) {
		$boot = Request::create('/', 'GET');
		$kernel = new DrupalKernel('prod', $autoloader);
		DrupalKernel::bootEnvironment();
		$sitePath = DrupalKernel::findSitePath($boot);
		$kernel->setSitePath($sitePath);
		Settings::initialize('/drupal', $sitePath, $autoloader);
		$kernel->boot();
		// A FRESHLY BOOTED KERNEL HAS AN EMPTY REQUEST STACK, and anything reaching routing then dies
		// on RequestContext::fromRequest(null). Invisible while every caller ran after a render had
		// pushed one; the provisioning drops made a cold container the ordinary case.
		$stack = $kernel->getContainer()->get('request_stack');
		if ($stack->getCurrentRequest() === null) {
			$stack->push($boot);
			$kernel->getContainer()->get('router.request_context')->fromRequest($boot);
		}
		// and the .module FILES, which only the HTTP kernel path loads. Without this a cold container
		// has services but no procedural half: saving a user reached _user_mail_notify() and died
		// "Call to undefined function"
		$kernel->getContainer()->get('module_handler')->loadAll();
		$GLOBALS['__pw_kernel'] = $kernel;
		$out['bootedKernel'] = 1;
	}

	if (!defined('SAVED_NEW')) {
		require_once '/drupal/core/includes/common.inc';
	}

	// __CFW_SCHEMA_REPAIR__

	// __CFW_BODY__

	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 600);
}
echo json_encode($out);
