<?php

use Drupal\drupflare\Http\CachedFetchHandler;
use Drupal\drupflare\StreamWrapper\HttpsStreamWrapper;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Handler\StreamHandler;
use GuzzleHttp\HandlerStack;

// __CFW_FIBER_SHIM__
// __CFW_HOST_HELPERS__
chdir('/drupal');

$checks = [];
$assert = function (string $label, bool $ok, $detail = null) use (&$checks) {
	$checks[] = ['label' => $label, 'ok' => $ok, 'detail' => $detail];
};

try {
	if (!isset($GLOBALS['__pw_autoloader']) || !is_object($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];
	$autoloader->addPsr4('Drupal\\drupflare\\', '/drupal/modules/custom/drupflare/src/');
	$autoloader->addPsr4('Drupflare\\StreamHttp\\', '/drupal/libraries/drupflare-stream-http/src/');

	HttpsStreamWrapper::register();
	$url = getenv('CFW_TEST_URL') ?: 'https://example.com/';

	// the mechanism, measured rather than reasoned: no userland wrapper can populate either the
	// magic local or its 8.4 replacement, so the consumer has nothing to read
	$fh = @fopen($url, 'r');
	$assert('the wrapper opens the seeded url', is_resource($fh));
	if (is_resource($fh)) {
		$assert('and the body is there to be read', stream_get_contents($fh) !== '');
		$assert(
			'but $http_response_header is not set',
			!array_key_exists('http_response_header', get_defined_vars()),
		);
		if (function_exists('http_get_last_response_headers')) {
			$assert(
				'and the 8.4 replacement answers NULL for the same reason',
				http_get_last_response_headers() === null,
			);
		}
		fclose($fh);
	}

	// CONTROL: core's handler, over the working wrapper. It must still fail.
	$core = HandlerStack::create(new StreamHandler());
	$coreClient = new Client(['handler' => $core]);
	$coreFailed = false;
	$coreReason = '';
	try {
		$coreClient->get($url);
	} catch (Throwable $e) {
		$coreFailed = true;
		$coreReason = get_class($e) . ': ' . $e->getMessage();
	}
	$assert('CONTROL: core StreamHandler still cannot build a response', $coreFailed, $coreReason);
	$assert(
		'and it fails where the report says it does',
		str_contains($coreReason, 'creating the response'),
		$coreReason,
	);

	// the fix, through the class the service provider now installs
	$stack = HandlerStack::create(new CachedFetchHandler());
	$client = new Client(['handler' => $stack]);
	$response = $client->get($url);
	$assert(
		'CachedFetchHandler answers 200',
		$response->getStatusCode() === 200,
		$response->getStatusCode(),
	);
	$assert(
		'with a body',
		strlen((string) $response->getBody()) > 0,
		strlen((string) $response->getBody()),
	);
	$assert(
		'and the headers the drain stored',
		$response->getHeaderLine('content-type') !== '',
		$response->getHeaderLine('content-type'),
	);

	// the negative case: an uncached url is a refusal a caller's error path already handles, never
	// a 2xx carrying an explanation
	$missing = 'https://example.invalid/never-prefetched-' . bin2hex(random_bytes(3));
	$refused = '';
	try {
		$client->get($missing);
	} catch (Throwable $e) {
		$refused = get_class($e);
	}
	$assert('an uncached url rejects', $refused !== '', $refused);
	$assert(
		'as a ConnectException, which is what a failed socket raises too',
		$refused === ConnectException::class,
		$refused,
	);
} catch (Throwable $e) {
	$assert(
		'no exception escaped the guzzle check',
		false,
		get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine(),
	);
}

$passed = count(array_filter($checks, fn($c) => $c['ok']));
echo json_encode([
	'passed' => $passed,
	'failed' => count($checks) - $passed,
	'checks' => $checks,
]);
