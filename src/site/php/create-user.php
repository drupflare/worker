<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Drupal\user\Entity\User;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');

$opt = json_decode(__CFW_PAYLOAD__, true);
$out = ['ok' => false, 'name' => $opt['name']];

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
		$GLOBALS['__pw_kernel'] = $kernel;
		$out['bootedKernel'] = 1;
	}

	if (!defined('SAVED_NEW')) {
		require_once '/drupal/core/includes/common.inc';
		$out['loadedCommonInc'] = true;
	}

	// __CFW_SCHEMA_REPAIR__

	$existing = Drupal::entityTypeManager()
		->getStorage('user')
		->loadByProperties(['name' => $opt['name']]);
	$loaded = $existing ? reset($existing) : null;
	$account = $loaded instanceof User ? $loaded : User::create(['name' => $opt['name']]);
	$account->setEmail($opt['name'] . '@example.invalid');
	$account->setPassword($opt['pass']);
	$account->activate();
	foreach ($opt['roles'] as $role) {
		$account->addRole($role);
	}
	$account->save();

	$out['uid'] = (int) $account->id();
	$out['roles'] = array_values($account->getRoles());
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 600);
}

echo json_encode($out);
