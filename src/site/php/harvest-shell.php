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
$cookie = json_decode(__CFW_COOKIE__);
$origin = json_decode(__CFW_ORIGIN__);
$out = ['ok' => false, 'path' => $path];
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

	// the render bin is the gate on whether holes exist at all; emptying dynamic_page_cache alone
	// produces a MISS with the placeholders already substituted, which reads as "no shell"
	foreach (['dynamic_page_cache', 'render'] as $bin) {
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

	$t0 = $clock();
	$response = cfw_serve($path, false, 'GET', '', '', $cookie, $origin, '');
	$out['harvestMs'] = round($clock() - $t0, 2);

	// BEFORE sendContent(), which consumes them
	$attachments = method_exists($response, 'getAttachments') ? $response->getAttachments() : [];
	$recipes = $attachments['big_pipe_placeholders'] ?? [];
	$out['recipes'] = $recipes;
	$out['recipeCount'] = count($recipes);

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
			// same reason as the fill path: the throw skipped BigPipe's own session save
			$out['sendError'] = get_class($e) . ': ' . $e->getMessage();
			$out['sessionClosed'] = cfw_close_session();
			$body = (string) $response->getContent();
		}
	} else {
		$body = (string) $response->getContent();
	}

	$out['html'] = $body;
	$out['bytes'] = strlen($body);
	$out['status'] = $response->getStatusCode();
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
	$out['uid'] = (int) Drupal::currentUser()->id();
	$out['roles'] = array_values(Drupal::currentUser()->getRoles());
	$out['ok'] = true;
} catch (Throwable $e) {
	$out['error'] = get_class($e) . ': ' . $e->getMessage();
	$out['trace'] = substr($e->getTraceAsString(), 0, 900);
}

echo json_encode($out);
