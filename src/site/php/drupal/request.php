<?php

use Drupal\Core\Database\Database;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
// __CFW_PW_SERVE_INLINE__
chdir('/drupal');

$path = json_decode(__CFW_PATH__);
$repeat = __CFW_REPEAT__;
$bins = json_decode(__CFW_BINS__, true);
$resetCid = __CFW_RESET_CID__;

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = $path;
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['HTTP_USER_AGENT'] = 'workerd-site';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

$mark = [];
$clock = function () {
	return microtime(true) * 1000;
};
$statements = function () {
	return json_decode(cfw_host('cfwStats')(), true)['queryCount'] ?? 0;
};

$t0 = $clock();
try {
	// require_once returns true rather than the autoloader once the interpreter
	// has already loaded the file, and the interpreter persists between requests
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];
	$mark['autoloadMs'] = round($clock() - $t0, 2);
	$mark['warmInterpreter'] = isset($GLOBALS['__pw_site_booted']) ? 1 : 0;

	if (!isset($GLOBALS['__pw_kernel'])) {
		$a = $clock();
		$request = Request::create($path, 'GET');
		$kernel = new DrupalKernel('prod', $autoloader);
		DrupalKernel::bootEnvironment();
		$sitePath = DrupalKernel::findSitePath($request);
		$kernel->setSitePath($sitePath);
		Settings::initialize('/drupal', $sitePath, $autoloader);
		$mark['settingsMs'] = round($clock() - $a, 2);

		// prove the driver Drupal actually connected with, before anything renders
		$info = Database::getConnectionInfo('default');
		$mark['configuredDriver'] = $info['default']['driver'] ?? null;

		$a = $clock();
		$kernel->boot();
		$mark['kernelBootMs'] = round($clock() - $a, 2);
		$GLOBALS['__pw_kernel'] = $kernel;
		$GLOBALS['__pw_site_booted'] = true;
	}
	$kernel = $GLOBALS['__pw_kernel'];

	$connection = Database::getConnection();
	$mark['connectionClass'] = get_class($connection);
	$mark['driver'] = $connection->driver();
	$mark['engineVersion'] = $connection->version();
	$mark['engineVersionIsFloor'] = method_exists($connection, 'engineVersionIsFloor')
		? $connection->engineVersionIsFloor()
		: null;

	$runs = [];
	for ($i = 0; $i < $repeat; $i++) {
		// Rule 3, and a query string is NOT enough to get past it. PageCache
		// memoizes $this->cid on the middleware instance, so on a persistent kernel
		// every URL maps to the first request's cid and re-serves its page -- the
		// measured shape was MISS then five HITs at 1 ms with byte-identical output
		// for six different URLs. Emptying the bin is what forces a real render.
		// $bust=0 leaves the cached path measurable.
		$target = $path;
		foreach ($bins as $bin) {
			try {
				Drupal::cache($bin)->deleteAll();
			} catch (Throwable $e) {
			}
		}
		// PageCache memoizes $this->cid on the middleware instance, so a persistent
		// kernel maps every later URL onto the first request's cid and re-serves its
		// page. Measured: six different URLs returned byte-identical output. Nulling
		// it is what makes a distinct path actually route.
		if ($resetCid) {
			try {
				$middleware = Drupal::service('http_middleware.page_cache');
				$rp = new ReflectionProperty($middleware, 'cid');
				$rp->setValue($middleware, null);
			} catch (Throwable $e) {
			}
		}
		$before = $statements();
		$a = $clock();
		$response = cfw_serve($target);
		$ms = round($clock() - $a, 2);
		$body = (string) $response->getContent();
		$runs[] = [
			'ms' => $ms,
			'status' => $response->getStatusCode(),
			'bytes' => strlen($body),
			'pageCache' => $response->headers->get('x-drupal-cache'),
			'dynamicCache' => $response->headers->get('x-drupal-dynamic-cache'),
			'hostStatements' => $statements() - $before,
			'titleFound' => str_contains($body, '<title>') ? 1 : 0,
			'sha1' => substr(sha1($body), 0, 12),
		];
	}
	$mark['runs'] = $runs;
} catch (Throwable $e) {
	$mark['error'] = get_class($e) . ': ' . $e->getMessage();
	$mark['trace'] = substr($e->getTraceAsString(), 0, 1400);
}

$mark['totalMs'] = round($clock() - $t0, 2);
$mark['includedFiles'] = count(get_included_files());
echo json_encode($mark);
