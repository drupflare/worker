<?php

use Drupal\Core\Cache\CacheableResponseInterface;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
// __CFW_PW_SERVE_INLINE__
chdir('/drupal');

$path = json_decode(__CFW_PATH__);
$origin = json_decode(__CFW_ORIGIN__);

// the host trio is derived from the ORIGIN rather than hardcoded, and cfw_serve() overwrites it
// again from the request it builds, so the superglobals and the Request object cannot disagree
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
$_SERVER['REQUEST_URI'] = $path;
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

$out = [];
$clock = function () {
	return microtime(true) * 1000;
};
$t0 = $clock();

try {
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];

	if (!isset($GLOBALS['__pw_kernel'])) {
		$request = Request::create($path, 'GET');
		$kernel = new DrupalKernel('prod', $autoloader);
		DrupalKernel::bootEnvironment();
		$sitePath = DrupalKernel::findSitePath($request);
		$kernel->setSitePath($sitePath);
		Settings::initialize('/drupal', $sitePath, $autoloader);
		$kernel->boot();
		$GLOBALS['__pw_kernel'] = $kernel;
		$out['bootedKernel'] = 1;
	}

	// a fill must render, so clear what would otherwise answer for it
	foreach (json_decode(__CFW_BINS__, true) as $bin) {
		try {
			Drupal::cache($bin)->deleteAll();
		} catch (Throwable $e) {
		}
	}
	try {
		$middleware = Drupal::service('http_middleware.page_cache');
		$rp = new ReflectionProperty($middleware, 'cid');
		$rp->setValue($middleware, null);
	} catch (Throwable $e) {
	}

	$response = cfw_serve($path, __CFW_SERVE_ARGS__);
	$out['destructed'] = $GLOBALS['__pw_destructed'] ?? null;
	// sendContent() RATHER THAN getContent(), and the difference is whether forms work at all.
	// BigPipe replaces the CSRF token with a lazy placeholder and substitutes it during
	// BigPipeResponse::sendContent(); getContent() returns the pre-substitution HTML, so every form
	// shipped a big_pipe_nojs_placeholder_attribute_safe marker where its token belonged, and every
	// submission came back "The form has become outdated".
	//
	// Buffered rather than sent, because there is no SAPI here to send to. Safe for a plain
	// Response, whose sendContent() only echoes what getContent() returns; a throw falls back to it.
	$body = '';
	if (method_exists($response, 'sendContent')) {
		$depth = ob_get_level();
		ob_start();
		try {
			$response->sendContent();
			$body = (string) ob_get_clean();
		} catch (Throwable $e) {
			while (ob_get_level() > $depth) {
				@ob_end_clean();
			}
			$out['sendError'] = get_class($e) . ': ' . $e->getMessage();
			// BigPipe::sendContent() has no try/finally around performPostSendTasks(), so a throw here
			// skips the session save -- and the CSRF seed is minted during placeholder replacement,
			// which is inside the call that just threw. Closing it is what a SAPI shutdown would do.
			$out['sessionClosed'] = cfw_close_session();
			$body = (string) $response->getContent();
		}
	} else {
		$body = (string) $response->getContent();
	}
	$out['status'] = $response->getStatusCode();
	$out['html'] = $body;
	$out['bytes'] = strlen($body);
	$out['pageCache'] = $response->headers->get('x-drupal-cache');
	$out['dynamicCache'] = $response->headers->get('x-drupal-dynamic-cache');
	// the cache tags this render bubbled, so a compiled plan can be invalidated by the same tags
	// Drupal would invalidate the render cache with
	try {
		$out['cacheTags'] =
			$response instanceof CacheableResponseInterface
				? array_values($response->getCacheableMetadata()->getCacheTags())
				: [];
	} catch (Throwable $e) {
		$out['cacheTags'] = [];
	}
	$out['contentType'] = $response->headers->get('content-type');
	$out['location'] = $response->headers->get('location');
	// what Drupal said about storing this, which page_cache_kill_switch and any module with a
	// reason to opt out both express here and nowhere else
	$out['cacheControl'] = $response->headers->get('cache-control');
	// EVERY x-drupal-* HEADER, because dropping one silently changed what the BROWSER does.
	// ajax.js refuses a response whose url is not in drupalSettings.ajaxTrustedUrl unless it carries
	// X-Drupal-Ajax-Token, and answers "The response failed verification so will not be processed."
	// -- so every AJAX interaction that was not a plain form submit died at the client with a valid
	// response in hand. Measured on Add field. A prefix rather than a list, so the next one core adds
	// is carried without anybody having to notice.
	$passed = [];
	foreach ($response->headers->all() as $name => $values) {
		if (stripos((string) $name, 'x-drupal-') !== 0) {
			continue;
		}
		$first = is_array($values) ? $values[0] ?? null : $values;
		if ($first !== null) {
			$passed[(string) $name] = (string) $first;
		}
	}
	$out['passHeaders'] = $passed;
	// BOTH SOURCES, because Drupal sets a session cookie through neither one consistently:
	// a logout or a Symfony-managed cookie lands on the Response, while session_start() emits its
	// own Set-Cookie into PHP's header list, which the Response never sees. Reading one of them
	// would drop the login cookie silently and leave the session unrecoverable by the browser.
	$cookies = [];
	foreach ($response->headers->all('set-cookie') as $line) {
		$cookies[] = (string) $line;
	}
	if (function_exists('headers_list')) {
		foreach (headers_list() as $line) {
			if (stripos($line, 'set-cookie:') === 0) {
				$cookies[] = trim(substr($line, 11));
			}
		}
	}
	$out['setCookie'] = array_values(array_unique($cookies));
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['at'] = $e->getFile() . ':' . $e->getLine();
}

// what the between-request reset actually did, and who Drupal thinks is asking. Both are cheap
// reads and both were needed to find the session leak; a render that comes back as the WRONG USER
// is not distinguishable from a correct one by its bytes
$out['reset'] = $GLOBALS['__pw_reset'] ?? null;
try {
	$out['uid'] = (int) Drupal::currentUser()->id();
} catch (Throwable $e) {
	$out['uid'] = null;
}
// THE ROLE SET, sorted, because the edge plan key is derived from it. A plan keyed on the raw
// cookie is one plan per session per path, which maximises the cold-KV case it was built to avoid;
// keyed on roles it is one per role set. Sorted so two accounts holding the same roles in a
// different order produce one key rather than two
try {
	$__roles = array_values(Drupal::currentUser()->getRoles());
	sort($__roles);
	$out['roles'] = $__roles;
} catch (Throwable $e) {
	$out['roles'] = null;
}

$out['renderMs'] = round($clock() - $t0, 2);
echo json_encode($out);
