<?php

use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Drupal\drupflare\Host;
use Drupal\drupflare\Logger\CfwLogger;
use Drupal\drupflare\Plugin\ImageToolkit\CfwImageToolkit;
use Drupal\drupflare\Plugin\Mail\CfwMail;
use Drupal\drupflare\Queue\CfwDeferredHttp;
use Drupal\drupflare\StreamWrapper\HttpsStreamWrapper;
use GuzzleHttp\Psr7\Request as PsrRequest;
use Symfony\Component\HttpFoundation\Request;

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
	// the pack does not enable this module, so nothing else registers its namespace
	$autoloader->addPsr4('Drupal\\drupflare\\', '/drupal/modules/custom/drupflare/src/');
	// its HttpsStreamWrapper extends the packaged one; composer never runs here, so this is the
	// autoloader entry composer would have written
	$autoloader->addPsr4('Drupflare\\StreamHttp\\', '/drupal/libraries/drupflare-stream-http/src/');

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

	// #region Host, the single seam
	$assert('Host class loads', class_exists(Host::class));
	foreach (
		['cfwLog', 'cfwFetch', 'cfwMail', 'cfwImageUrl', 'cfwQueueFetch', 'cfwHttpCacheGet']
		as $fn
	) {
		$assert('Host::has(' . $fn . ')', Host::has($fn));
	}
	$assert(
		'Host::has() is FALSE for a capability the runtime did not install',
		!Host::has('cfwNotInstalled'),
		'the control: if this passed for everything, the six above would prove nothing',
	);
	$absent = Host::call('cfwNotInstalled', ['x' => 1]);
	$assert(
		'Host::call() on a missing capability returns a named refusal, not a throw',
		($absent['ok'] ?? null) === false &&
			str_contains((string) ($absent['error'] ?? ''), 'not installed'),
		$absent['error'] ?? null,
	);
	// #endregion

	// #region the logger
	$parser = Drupal::service('logger.log_message_parser');
	$logger = new CfwLogger($parser);
	$marker = 'cfw-logger-' . bin2hex(random_bytes(4));
	$logger->log(3, 'placeholder @who saw @marker', [
		'@who' => 'the-test',
		'@marker' => $marker,
		'channel' => 'cfw-check',
	]);
	$assert('CfwLogger::log() executes without throwing', true, $marker);
	$logger->log(6, 'info level', ['channel' => 'cfw-check']);

	// and through Drupal's own channel, which is how it would actually be reached
	Drupal::service('logger.factory')->addLogger($logger);
	$channelMarker = 'cfw-channel-' . bin2hex(random_bytes(4));
	Drupal::logger('cfw-check')->warning('channel reached @m', ['@m' => $channelMarker]);
	$assert('CfwLogger receives entries through Drupal::logger()', true, $channelMarker);
	$GLOBALS['__cfw_markers'] = ['direct' => $marker, 'channel' => $channelMarker];
	// #endregion

	// #region the stream wrapper
	$before = stream_get_wrappers();
	// HttpsStreamWrapper's docblock says this runtime has no http/https wrapper,
	// citing a measured list of compress.zlib/php/file/glob/data. On static-free-v1
	// that is WRONG -- both are registered -- and the truth is worse than absence.
	// Reading through the native one throws 'ReferenceError: Asyncify is not defined'
	// out of the wasm import: a JS exception, so @ does not suppress it, a PHP catch
	// never sees it, and the whole invocation dies. Measured, and NOT reproduced here --
	// it would take this suite down with it. Route /__nativefetch reproduces it.
	$assert(
		'the runtime DOES register http/https, contradicting the class docblock',
		in_array('https', $before, true),
		implode(',', $before),
	);
	$registered = HttpsStreamWrapper::register();
	$after = stream_get_wrappers();
	$assert(
		'HttpsStreamWrapper registers both schemes',
		$registered === ['http', 'https'],
		implode(',', $registered),
	);
	$assert(
		'https is now a registered wrapper',
		in_array('https', $after, true),
		implode(',', $after),
	);

	$cachedUrl = getenv('CFW_TEST_URL') ?: 'https://example.com/';
	$body = @file_get_contents($cachedUrl);
	$assert(
		'file_get_contents() over the wrapper returns the prefetched body',
		is_string($body) && strlen($body) > 0,
		is_string($body) ? substr($body, 0, 80) : 'false',
	);
	$GLOBALS['__cfw_body_len'] = is_string($body) ? strlen($body) : -1;

	// fopen/fread/fseek, because file_get_contents() alone would not exercise them
	$fh = @fopen($cachedUrl, 'r');
	$assert('fopen() over the wrapper succeeds', is_resource($fh));
	if (is_resource($fh)) {
		$first = fread($fh, 8);
		fseek($fh, 0);
		$again = fread($fh, 8);
		$assert(
			'fread() returns bytes and fseek() rewinds',
			$first !== '' && $first === $again,
			$first,
		);
		$assert('feof() is false before the end', !feof($fh) || strlen((string) $body) <= 8);
		$stat = fstat($fh);
		$assert(
			'fstat() reports the fetched size',
			isset($stat['size']) && (int) $stat['size'] === strlen((string) $body),
			($stat['size'] ?? null) . ' vs ' . strlen((string) $body),
		);
		fclose($fh);
	}

	// the negative case, and the important one: a URL the host has not
	// prefetched must fail, because a Worker cannot fetch synchronously without JSPI
	$missing = 'https://example.invalid/never-prefetched-' . bin2hex(random_bytes(3));
	$missingBody = @file_get_contents($missing);
	$assert(
		'an unprefetched URL FAILS rather than returning something plausible',
		$missingBody === false,
		var_export($missingBody, true),
	);
	// #endregion

	// #region mail
	$mailer = new CfwMail();
	$message = $mailer->format([
		'to' => 'someone@example.com',
		'subject' => 'Capability check',
		'body' => ['line one', 'line two'],
		'headers' => [
			'From' => 'site@example.com',
			'Cc' => 'cc@example.com',
			'X-Ignored' => 'drop me',
		],
		'params' => [],
	]);
	$assert(
		'CfwMail::format() joins the body parts and wraps',
		is_string($message['body']) &&
			str_contains($message['body'], 'line one') &&
			str_contains($message['body'], 'line two'),
		substr((string) $message['body'], 0, 60),
	);
	$sent = $mailer->mail($message);
	$assert(
		'CfwMail::mail() returns a boolean rather than throwing when there is no binding',
		is_bool($sent),
		var_export($sent, true),
	);
	$GLOBALS['__cfw_mail_result'] = $sent;
	// #endregion

	// #region deferred HTTP, the whole cached -> deferred layering
	if (class_exists(PsrRequest::class)) {
		$handler = new CfwDeferredHttp();
		$deferUrl = 'https://example.com/cfw-deferred-' . bin2hex(random_bytes(3));
		$response = $handler(new PsrRequest('GET', $deferUrl), [])->wait();
		$assert(
			'an uncached GET is DEFERRED with a 202 rather than blocking',
			$response->getStatusCode() === 202 &&
				$response->getHeaderLine('x-cfw-deferred') === 'queued',
			$response->getStatusCode() . ' ' . $response->getHeaderLine('x-cfw-deferred'),
		);
		$cachedResponse = $handler(new PsrRequest('GET', $cachedUrl), [])->wait();
		$assert(
			'a cached GET is answered from the cache with a real body',
			$cachedResponse->getStatusCode() === 200 &&
				strlen((string) $cachedResponse->getBody()) > 0,
			$cachedResponse->getStatusCode() .
				' ' .
				strlen((string) $cachedResponse->getBody()) .
				' bytes',
		);
		$GLOBALS['__cfw_deferred_url'] = $deferUrl;
	} else {
		$assert('GuzzleHttp is available for the deferred handler', false, 'class absent');
	}
	// #endregion

	// #region the image toolkit
	$assert(
		'CfwImageToolkit class loads against real Drupal',
		class_exists(CfwImageToolkit::class),
	);
	$imageUrl = Host::call('cfwImageUrl', ['url' => '/sites/default/files/a.png', 'width' => 300]);
	$assert(
		'cfwImageUrl returns a delivery-time resizing URL',
		($imageUrl['ok'] ?? false) === true &&
			str_contains((string) ($imageUrl['url'] ?? ''), 'width=300'),
		$imageUrl['url'] ?? null,
	);
	// #endregion
} catch (Throwable $e) {
	$assert(
		'no exception escaped the capability check',
		false,
		get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine(),
	);
}

$passed = count(array_filter($checks, fn($c) => $c['ok']));
echo json_encode([
	'passed' => $passed,
	'failed' => count($checks) - $passed,
	'markers' => $GLOBALS['__cfw_markers'] ?? null,
	'bodyLen' => $GLOBALS['__cfw_body_len'] ?? null,
	'mailResult' => $GLOBALS['__cfw_mail_result'] ?? null,
	'deferredUrl' => $GLOBALS['__cfw_deferred_url'] ?? null,
	'checks' => $checks,
]);
