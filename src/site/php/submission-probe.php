<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
// __CFW_PW_SERVE_INLINE__
chdir('/drupal');

$opt = json_decode(__CFW_OPTIONS__, true);
$out = ['ok' => false, 'wall' => 'unknown'];

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = $opt['path'];
$_SERVER['REQUEST_METHOD'] = $opt['method'];
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
	$kernel = $GLOBALS['__pw_kernel'];

	// #region wall 1: does Drupal see the POST and its values
	$parameters = [];
	$isForm = stripos($opt['contentType'], 'application/x-www-form-urlencoded') !== false;
	if ($opt['method'] !== 'GET' && $opt['body'] !== '' && $isForm) {
		parse_str($opt['body'], $parameters);
	}
	$server = [];
	if ($opt['contentType'] !== '') {
		$server['CONTENT_TYPE'] = $opt['contentType'];
	}
	if ($opt['body'] !== '') {
		$server['CONTENT_LENGTH'] = (string) strlen($opt['body']);
	}

	$request = Request::create(
		$opt['path'],
		$opt['method'],
		$parameters,
		[],
		[],
		$server,
		$opt['body'],
	);

	$out['methodSeen'] = $request->getMethod();
	$out['requestKeys'] = array_keys($request->request->all());
	$out['parsedKeys'] = array_keys($parameters);
	$out['contentLength'] = strlen($request->getContent());
	$out['isMethodPost'] = $request->isMethod('POST');
	// #endregion

	// #region wall 4: is there a session, and is the request treated as cacheable
	try {
		$out['hasSession'] = $request->hasSession() ? 1 : 0;
		$out['hasPreviousSession'] = $request->hasPreviousSession() ? 1 : 0;
	} catch (Throwable $e) {
		$out['sessionError'] = $e->getMessage();
	}
	try {
		$policy = Drupal::service('page_cache_request_policy');
		$verdict = $policy->check($request);
		// ALLOW means Drupal considers this cacheable, which is only correct for an anonymous GET
		$out['pageCachePolicy'] = is_string($verdict) ? $verdict : json_encode($verdict);
	} catch (Throwable $e) {
		$out['policyError'] = $e->getMessage();
	}
	try {
		$out['currentUserId'] = (int) Drupal::currentUser()->id();
		$out['isAuthenticated'] = Drupal::currentUser()->isAuthenticated() ? 1 : 0;
	} catch (Throwable $e) {
		$out['userError'] = $e->getMessage();
	}
	// #endregion

	// #region walls 2 and 3: build id and token, read off what the handler answers
	try {
		$rp = new ReflectionProperty(DrupalKernel::class, 'prepared');
		$rp->setValue($kernel, false);
	} catch (Throwable $e) {
	}
	try {
		$stack = Drupal::service('request_stack');
		while ($stack->getCurrentRequest() !== null) {
			$stack->pop();
		}
	} catch (Throwable $e) {
	}
	if (function_exists('drupal_static_reset')) {
		drupal_static_reset();
	}

	try {
		$response = $kernel->handle($request);
		$status = $response->getStatusCode();
		$content = (string) $response->getContent();
		$out['status'] = $status;
		$out['bytes'] = strlen($content);
		$out['location'] = $response->headers->get('location');

		// the phrases Drupal uses, each of which names a DIFFERENT wall
		$out['saysOutdated'] = stripos($content, 'form has become outdated') !== false ? 1 : 0;
		$out['saysTokenInvalid'] = stripos($content, 'security token') !== false ? 1 : 0;
		$out['saysAccessDenied'] =
			$status === 403 || stripos($content, 'Access denied') !== false ? 1 : 0;
		$out['saysNotFound'] = $status === 404 ? 1 : 0;
		$out['hasFormBuildId'] = stripos($content, 'form_build_id') !== false ? 1 : 0;
		$out['hasFormToken'] = stripos($content, 'form_token') !== false ? 1 : 0;

		if ($out['saysNotFound']) {
			$out['wall'] = 'route-not-found';
		} elseif ($out['saysAccessDenied']) {
			$out['wall'] = 'access-denied';
		} elseif ($out['saysOutdated']) {
			$out['wall'] = 'form-build-id';
		} elseif ($out['saysTokenInvalid']) {
			$out['wall'] = 'csrf-token';
		} elseif ($status >= 300 && $status < 400) {
			$out['wall'] = 'none-redirected';
		} else {
			$out['wall'] = 'handled-no-effect';
		}
		$out['ok'] = true;
	} catch (Throwable $e) {
		$out['wall'] = 'exception';
		$out['error'] = get_class($e) . ': ' . $e->getMessage();
		$out['at'] = $e->getFile() . ':' . $e->getLine();
	}
	// #endregion
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}

echo json_encode($out);
