<?php

use Drupal\Component\Utility\Html;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
// __CFW_PW_SERVE_INLINE__
chdir('/drupal');

$path = json_decode(__CFW_PATH__);
$cookie = json_decode(__CFW_COOKIE__);
$origin = json_decode(__CFW_ORIGIN__);
$recipes = json_decode(__CFW_RECIPES__, true);
$out = ['ok' => false, 'path' => $path, 'fragments' => [], 'fragmentTags' => [], 'failed' => []];
$clock = function () {
	return microtime(true) * 1000;
};

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

	$t0 = $clock();

	if (function_exists('header_remove')) {
		header_remove();
	}

	$cookies = [];
	foreach (explode(';', $cookie) as $pair) {
		$pair = trim($pair);
		if ($pair === '') {
			continue;
		}
		$split = strpos($pair, '=');
		if ($split === false) {
			continue;
		}
		$cookies[urldecode(substr($pair, 0, $split))] = urldecode(substr($pair, $split + 1));
	}
	$server = $cookie === '' ? [] : ['HTTP_COOKIE' => $cookie];
	$url = $origin === '' ? $path : rtrim($origin, '/') . $path;
	$request = Request::create($url, 'GET', [], $cookies, [], $server);

	// THE SUPERGLOBALS ARE NOT DECORATION HERE. session_start() reads its id out of $_COOKIE, not out
	// of the Request object, so without this the fragment renders as whoever the interpreter served
	// last -- measured: one visitor's cookie came back uid 1 because admin had rendered before
	$_SERVER['HTTP_HOST'] = $request->getHttpHost();
	$_SERVER['SERVER_NAME'] = $request->getHost();
	$_SERVER['SERVER_PORT'] = (string) $request->getPort();
	if ($request->isSecure()) {
		$_SERVER['HTTPS'] = 'on';
	} else {
		unset($_SERVER['HTTPS']);
	}
	$_SERVER['REQUEST_METHOD'] = 'GET';
	$_SERVER['REQUEST_URI'] = $path;
	$_POST = [];
	$_GET = [];
	$_FILES = [];
	$_REQUEST = [];
	$_COOKIE = $cookies;
	if ($cookie !== '') {
		$_SERVER['HTTP_COOKIE'] = $cookie;
	} else {
		unset($_SERVER['HTTP_COOKIE']);
	}

	// AFTER the superglobals and BEFORE the session starts, which is the order cfw_serve() uses and
	// the order that matters: the resetter closes the previous session, and a reset that runs before
	// $_COOKIE is replaced closes one session and reopens the same one
	try {
		$container = Drupal::getContainer();
		if ($container !== null && $container->has('drupflare.request_resetter')) {
			$GLOBALS['__pw_reset'] = $container->get('drupflare.request_resetter')->reset();
		} elseif (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) {
			@session_write_close();
			$_SESSION = [];
		}
	} catch (Throwable $e) {
	}

	$stack = Drupal::service('request_stack');
	while ($stack->getCurrentRequest() !== null) {
		$stack->pop();
	}
	$stack->push($request);

	// ids are deduplicated per RENDER, and this interpreter is where "per render" stops being
	// automatic; without it the second fragment of a session gets id--2 suffixes
	if ((new ReflectionClass(Html::class))->hasMethod('resetSeenIds')) {
		Html::resetSeenIds();
	}

	// and the ajax flag beside it, which resetSeenIds() does not clear; left true it sends
	// getUniqueId() down its random branch for the rest of the incarnation
	if ((new ReflectionClass(Html::class))->hasMethod('setIsAjax')) {
		Html::setIsAjax(false);
	}

	// THE ID IS SET EXPLICITLY, and skipping it is a session HANDOVER rather than a missing session.
	// session_write_close() leaves session_id() holding the previous visitor's id, and session_start()
	// prefers that id over $_COOKIE -- so without this, bob's cookie loaded admin's row and the
	// fragment rendered as uid 1 with no error anywhere. Measured; the middleware never has to do it
	// because a real SAPI starts each request with no id at all.
	$session = Drupal::service('session');
	// matched by SHAPE rather than asked of session_configuration, whose getName() is protected:
	// Drupal names the cookie SESS/SSESS + md5 of the site url, and that is the only cookie with it
	$sessionName = '';
	foreach (array_keys($cookies) as $name) {
		if (preg_match('/^S?SESS[0-9a-f]{32}$/', $name) === 1) {
			$sessionName = $name;
			break;
		}
	}
	if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) {
		@session_write_close();
	}
	if (isset($cookies[$sessionName])) {
		try {
			$session->setId($cookies[$sessionName]);
		} catch (Throwable $e) {
			$out['setIdError'] = $e->getMessage();
		}
	}
	$request->setSession($session);
	try {
		$session->start();
	} catch (Throwable $e) {
		$out['sessionError'] = $e->getMessage();
	}

	$account = Drupal::service('authentication')->authenticate($request);
	if ($account !== null) {
		Drupal::service('current_user')->setAccount($account);
	}
	$out['uid'] = (int) Drupal::currentUser()->id();

	try {
		$request->attributes->add(Drupal::service('router')->matchRequest($request));
	} catch (Throwable $e) {
		$out['routeError'] = get_class($e) . ': ' . $e->getMessage();
	}

	$renderer = Drupal::service('renderer');
	$out['contextMs'] = round($clock() - $t0, 2);

	// the values normaliseShell() slots out of the stored shell, read for THIS session. Free here
	// -- the context is already built -- and unobtainable at the edge, which has no PHP
	$identity = ['uid' => (string) Drupal::currentUser()->id()];
	try {
		$identity['permissionsHash'] = Drupal::service('user_permissions_hash_generator')->generate(
			Drupal::currentUser(),
		);
	} catch (Throwable $e) {
	}
	try {
		$identity['csrf'] = ['user/logout' => Drupal::csrfToken()->get('user/logout')];
	} catch (Throwable $e) {
	}
	// the edge plan is keyed on this and a shell response carried none, so a path the shell tier
	// answered could never collect a sample and the plan tier starved for the whole session
	try {
		$roles = array_values(Drupal::currentUser()->getRoles());
		sort($roles);
		$out['roles'] = $roles;
	} catch (Throwable $e) {
	}
	$out['identity'] = $identity;

	$t1 = $clock();
	foreach ($recipes as $id => $recipe) {
		if (!is_array($recipe)) {
			$out['failed'][] = $id;
			continue;
		}
		try {
			$elements = ['#markup' => $id, '#attached' => ['placeholders' => [$id => $recipe]]];
			$rendered = $renderer->renderPlaceholder($id, $elements);
			$out['fragments'][$id] = (string) ($rendered['#markup'] ?? '');
			// renderPlaceholder() merges the placeholder bubbleable metadata into $elements, so this is
			// the fragment own dependency set rather than the page one
			$out['fragmentTags'][$id] = array_values($rendered['#cache']['tags'] ?? []);
		} catch (Throwable $e) {
			$out['failed'][] = $id;
			$out['failure'][$id] = get_class($e) . ': ' . $e->getMessage();
		}
	}
	$out['renderMs'] = round($clock() - $t1, 2);
	$out['totalMs'] = round($clock() - $t0, 2);
	$out['ok'] = count($out['failed']) === 0;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 900);
}

echo json_encode($out);
