<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

$origin = json_decode(__CFW_ORIGIN__);
$__host = $origin === '' ? 'localhost' : (string) parse_url($origin, PHP_URL_HOST);
$__port =
	$origin === ''
		? 80
		: (int) (parse_url($origin, PHP_URL_PORT) ?:
		(strncmp($origin, 'https:', 6) === 0
			? 443
			: 80));
$_SERVER['HTTP_HOST'] = $__port === 80 || $__port === 443 ? $__host : $__host . ':' . $__port;
$_SERVER['SERVER_NAME'] = $__host;
$_SERVER['SERVER_PORT'] = (string) $__port;
if (strncmp($origin, 'https:', 6) === 0) {
	$_SERVER['HTTPS'] = 'on';
} else {
	unset($_SERVER['HTTPS']);
}
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

// require rather than require_once: the latter returns TRUE on a second call, and a heap restore
// reaches that state; see the note in site-php.ts
if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
	$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
}
$autoloader = $GLOBALS['__pw_autoloader'];

if (!isset($GLOBALS['__pw_kernel'])) {
	$request = Request::create($origin === '' ? '/' : rtrim($origin, '/') . '/', 'GET');
	$kernel = new DrupalKernel('prod', $autoloader);
	DrupalKernel::bootEnvironment();
	$sitePath = DrupalKernel::findSitePath($request);
	$kernel->setSitePath($sitePath);
	Settings::initialize('/drupal', $sitePath, $autoloader);
	$kernel->boot();
	$GLOBALS['__pw_kernel'] = $kernel;
	$out['bootedKernel'] = 1;
}
// the request stack is what Drupal's URL generator reads for the host, and a cron fragment
// pushes none of its own -- so without this an absolute URL falls back to a default it invents
try {
	if ($origin !== '' && Drupal::hasContainer()) {
		Drupal::service('request_stack')->push(Request::create(rtrim($origin, '/') . '/', 'GET'));
	}
} catch (Throwable $e) {
}
