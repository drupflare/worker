<?php

use Drupal\Component\Utility\Html;
use Drupal\Core\DestructableInterface;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Entity\EntityViewBuilder;
use Drupal\drupflare\Terminate;
use Symfony\Component\HttpFoundation\File\UploadedFile;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\HttpKernelInterface;

/**
 * Closes the session an earlier render left open.
 *
 * @return string
 *   What was done, for the probe that reports it.
 */
function cfw_close_session(): string
{
	// THE HOST IS THE SAPI, SO IT OWNS THE CLOSE THAT BigPipe DOES NOT REACH.
	// BigPipe::sendContent() ends with performPostSendTasks(), which is the session save, and there
	// is no try/finally around the three sends before it. StackMiddleware\Session deliberately
	// skipped its own save already, because a BigPipeResponse is ResponseKeepSessionOpenInterface.
	// So a sendContent() that throws loses every session write the render made.
	//
	// The CSRF seed is one of those writes. RouteProcessorCsrf defers a _csrf_token route to a lazy
	// builder on an HTML request, so CsrfTokenGenerator::get() MINTS the seed while placeholders are
	// being replaced -- inside sendContent(). A lost seed makes validate() answer false on the next
	// request, which is a 403 on every _csrf_token link the page carries.
	try {
		$container = Drupal::getContainer();
		if ($container !== null) {
			foreach (['session', 'session_manager'] as $name) {
				if ($container->initialized($name)) {
					$service = $container->get($name);
					if (method_exists($service, 'save')) {
						$service->save();
						return $name;
					}
				}
			}
		}
	} catch (Throwable $e) {
	}
	if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) {
		@session_write_close();
		return 'session_write_close';
	}
	return 'nothing to close';
}
/**
 * Runs one request through the booted kernel and returns the response.
 *
 * @param string $path
 *   The request path, with its query string.
 * @param bool|string $destruct
 *   True, false, or a comma-separated allowlist of service ids to destruct.
 * @param string $method
 *   The HTTP method.
 * @param string $body
 *   The raw request body.
 * @param string $contentType
 *   The request content type.
 * @param string $cookieHeader
 *   The raw Cookie header.
 * @param string $origin
 *   A scheme://host[:port], or an empty string.
 * @param string $clientIp
 *   The visitor's address, or an empty string.
 * @param string $accept
 *   The raw Accept header, or an empty string.
 *
 * @return Response
 *   The kernel's response.
 */
function cfw_serve(
	$path,
	$destruct = true,
	$method = 'GET',
	$body = '',
	$contentType = '',
	$cookieHeader = '',
	$origin = '',
	$clientIp = '',
	$accept = '',
) {
	$kernel = $GLOBALS['__pw_kernel'];

	// PHP'S HEADER LIST OUTLIVES THE REQUEST ON A PERSISTENT INTERPRETER, and session_start()
	// emits its Set-Cookie into exactly that list. Without this, visitor B's response carries
	// visitor A's session cookie -- a session handover, not a stale header. Cleared BEFORE the
	// request rather than after, so a fragment that never reaches the end still cannot leak one.
	if (function_exists('header_remove')) {
		header_remove();
	}

	// THE METHOD AND BODY ARE THREADED FROM THE HOST, and before this every call site passed a
	// literal "GET". No form submission of any kind could work: not login, not a contact form, not
	// node edit. A CMS that cannot accept a form is not a CMS.
	//
	// The parsed parameters are passed to Request::create() rather than only set on $_POST, because
	// Drupal reads the REQUEST OBJECT and not the superglobal. Setting $_POST alone produces a
	// request Drupal treats as an empty submission, which returns 200 and looks like it worked.
	$method = strtoupper($method === '' ? 'GET' : $method);
	$parameters = [];
	$uploads = [];
	$isForm = stripos($contentType, 'application/x-www-form-urlencoded') !== false;
	$isMultipart = stripos($contentType, 'multipart/form-data') !== false;
	if ($method !== 'GET' && $body !== '' && $isForm) {
		parse_str($body, $parameters);
	}

	// the uploads this request may move (CfwFileSystem reads it); a leftover from the last request
	// was never moved, so it is deleted the way PHP deletes an unmoved upload at shutdown
	foreach ($GLOBALS['__cfw_uploads'] ?? [] as $stale => $unused) {
		if (is_file($stale)) {
			@unlink($stale);
		}
	}
	$GLOBALS['__cfw_uploads'] = [];

	// MULTIPART IS PARSED BY HAND, because PHP fills $_POST and $_FILES only for a real POST SAPI and
	// this interpreter has none. Without it every form carrying a file field submitted an EMPTY
	// request: Drupal saw no form_id, rebuilt the form and answered 200, so /user/register and
	// /user/*/edit discarded every submission with no error anywhere. A file field is what sets
	// enctype, so the blast radius is every node type with an image, media add, and both account forms.
	//
	// NO REGEX AND NO APOSTROPHES: this fragment is emitted inside a single-quoted eval string, so an
	// apostrophe closes it and a backslash needs doubling. substr parsing sidesteps both.
	if ($method !== 'GET' && $body !== '' && $isMultipart) {
		$quoted = function (string $line, string $key): ?string {
			$at = stripos($line, $key . "=\"");
			if ($at === false) {
				return null;
			}
			$from = $at + strlen($key) + 2;
			$end = strpos($line, "\"", $from);
			if ($end === false) {
				return null;
			}
			return substr($line, $from, $end - $from);
		};
		$boundary = '';
		$bat = stripos($contentType, 'boundary=');
		if ($bat !== false) {
			$boundary = trim(substr($contentType, $bat + 9));
			$semi = strpos($boundary, ';');
			if ($semi !== false) {
				$boundary = substr($boundary, 0, $semi);
			}
			$boundary = trim($boundary, "\" ");
		}
		if ($boundary !== '') {
			$pairs = [];
			foreach (explode('--' . $boundary, $body) as $part) {
				if (trim($part) === '' || trim($part) === '--') {
					continue;
				}
				$split = strpos($part, "\r\n\r\n");
				if ($split === false) {
					continue;
				}
				$head = substr($part, 0, $split);
				$value = substr($part, $split + 4);
				// the CRLF before the next boundary belongs to the delimiter, not to the value
				if (substr($value, -2) === "\r\n") {
					$value = substr($value, 0, -2);
				}
				$name = '';
				$filename = null;
				$partType = 'application/octet-stream';
				foreach (explode("\r\n", trim($head)) as $line) {
					if (stripos($line, 'content-disposition:') === 0) {
						$got = $quoted($line, 'name');
						if ($got !== null) {
							$name = $got;
						}
						$filename = $quoted($line, 'filename');
					} elseif (stripos($line, 'content-type:') === 0) {
						$partType = trim(substr($line, 13));
					}
				}
				if ($name === '') {
					continue;
				}
				if ($filename === null) {
					$pairs[] = urlencode($name) . '=' . urlencode($value);
					continue;
				}
				// an unchosen file arrives as filename="" with an empty body; treating that as an upload
				// makes Drupal validate a zero-byte file nobody sent
				if ($filename === '') {
					continue;
				}
				$tmp = tempnam(sys_get_temp_dir(), 'cfwup');
				if ($tmp === false) {
					continue;
				}
				file_put_contents($tmp, $value);
				$tmp = realpath($tmp) ?: $tmp;
				$GLOBALS['__cfw_uploads'][$tmp] = true;
				// TEST MODE, because a raw array became an UploadedFile whose isValid() asks
				// is_uploaded_file(), which only a POST SAPI answers true, so every upload was refused
				$entry = new UploadedFile($tmp, $filename, $partType, 0, true);
				// one bracketed level is what a form sends, as in files[user_picture_0]
				$open = strpos($name, '[');
				if ($open !== false && substr($name, -1) === ']') {
					$outer = substr($name, 0, $open);
					$inner = substr($name, $open + 1, strlen($name) - $open - 2);
					$uploads[$outer][$inner] = $entry;
				} else {
					$uploads[$name] = $entry;
				}
			}
			if ($pairs !== []) {
				parse_str(implode('&', $pairs), $parameters);
			}
		}
	}

	$server = [];
	if ($contentType !== '') {
		$server['CONTENT_TYPE'] = $contentType;
	}
	if ($body !== '') {
		$server['CONTENT_LENGTH'] = (string) strlen($body);
	}
	if ($cookieHeader !== '') {
		$server['HTTP_COOKIE'] = $cookieHeader;
	}
	// ON THE REQUEST BAG, not just \$_SERVER: flood control reads \$request->getClientIp(), and
	// Request::create() builds its own bag, so an assignment afterwards is invisible to it
	if ($clientIp !== '') {
		$server['REMOTE_ADDR'] = $clientIp;
	}
	// same reason, and it is why the Web server row on the status report was BLANK: it reads
	// \$request->server->get("SERVER_SOFTWARE") and the \$_SERVER assignment below never reached the bag
	$server['SERVER_SOFTWARE'] = 'Cloudflare Workers';
	// AND WITHOUT THIS, EVERY EXPIRABLE KEYVALUE WRITE LANDS IN 1970. Time::getRequestTime() reads
	// REQUEST_TIME off this bag, so an absent one is 0, and DatabaseStorageExpirable stores
	// REQUEST_TIME + \$ttl -- which for setWithExpire(\$k, \$v, 3600) is an expiry of 01:00 on
	// 1 Jan 1970. The row is written and is already expired, so the next read filters it out and the
	// GC deletes it. Measured on update_project_projects: getProjects() rebuilt it on every request,
	// never saw it again, and update_available_releases stayed empty forever with no error anywhere.
	// The rows that DID survive were the ones core happens to offset by
	// getCurrentTime() - getRequestTime(), which is a full epoch when the second term is 0.
	$now = time();
	$server['REQUEST_TIME'] = $now;
	$server['REQUEST_TIME_FLOAT'] = (float) $now;
	// AND WITHOUT THIS, EVERY AJAX RESPONSE COMES BACK IN A TEXTAREA. AjaxResponseSubscriber wraps
	// the JSON and relabels it text/html when Accept contains text/html, which is an IE9
	// iframe-upload workaround -- and Request::create() supplies a DEFAULT Accept that matches it.
	// So the browser asked for application/json, Drupal answered a wrapped text/html document, and
	// Drupal.AjaxError fired on every AJAX request the admin makes. Measured on Add field.
	if ($accept !== '') {
		$server['HTTP_ACCEPT'] = $accept;
	}

	// THE COOKIE IS WHY AN AUTHENTICATED REQUEST EXISTS AT ALL. Without it every request is uid 0,
	// so Drupal denies a create-entity route at the ROUTING layer and no form is ever built --
	// which is what "the submission does not work" looked like from outside. Parsed by hand rather
	// than through a helper, because the value arrives as one raw header line from the host.
	$cookies = [];
	foreach (explode(';', $cookieHeader) as $pair) {
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

	// THE ORIGIN IS PREPENDED SO SYMFONY PARSES IT, rather than set on $_SERVER afterwards.
	// Request::create() builds its OWN server bag from defaults and does not read $_SERVER, so the
	// HTTP_HOST assignments the fragments make were never what Drupal saw -- an absolute URI is. With
	// a relative one Symfony fills in "localhost", which is why a deployed site put http://localhost
	// into every canonical tag, form action, Location header and password-reset mail.
	$url = $origin === '' ? $path : rtrim($origin, '/') . $path;
	$request = Request::create($url, $method, $parameters, $cookies, $uploads, $server, $body);

	// the superglobals follow the request rather than leading it, so a fragment reading $_POST and
	// one reading the Request agree -- INCLUDING the host trio, which is read directly by code that
	// predates the request object
	$_SERVER['HTTP_HOST'] = $request->getHttpHost();
	$_SERVER['SERVER_NAME'] = $request->getHost();
	$_SERVER['SERVER_PORT'] = (string) $request->getPort();
	if ($request->isSecure()) {
		$_SERVER['HTTPS'] = 'on';
	} else {
		unset($_SERVER['HTTPS']);
	}
	$_SERVER['REQUEST_METHOD'] = $method;
	if ($clientIp !== '') {
		$_SERVER['REMOTE_ADDR'] = $clientIp;
	}
	$_SERVER['SERVER_SOFTWARE'] = $request->server->get('SERVER_SOFTWARE');
	// EVERY input superglobal, not just $_POST. When a CSRF token fails, FormBuilder empties the
	// request and calls $request->overrideGlobals() to make the globals agree
	// (FormBuilder.php:1024-1030); on a real SAPI those globals die with the process and here they
	// do not. Re-initialising all of them is what a SAPI does per request. NOTE: this alone does not
	// fix the residual defect pinned in tests/integration/csrf.spec.ts -- measured, so not claimed.
	$_POST = $parameters;
	$_GET = [];
	$_FILES = [];
	$_REQUEST = $parameters;
	$_COOKIE = $cookies;
	if ($contentType !== '') {
		$_SERVER['CONTENT_TYPE'] = $contentType;
	}
	if ($body !== '') {
		$_SERVER['CONTENT_LENGTH'] = (string) strlen($body);
	}
	if ($cookieHeader !== '') {
		$_SERVER['HTTP_COOKIE'] = $cookieHeader;
	} else {
		unset($_SERVER['HTTP_COOKIE']);
	}

	// THE SESSION HAS TO BE ENDED BEFORE THE NEXT ONE IS READ, and this interpreter is where that
	// stops being automatic. PHP holds $_SESSION and the active id on the PROCESS, and Symfony
	// memoises its started flag on a service that outlives the request -- so without this, request 2
	// is whoever request 1 was. Measured: a second login POST answered
	// "This route can only be accessed by anonymous users".
	//
	// drupflare owns the mechanism because it is the same mechanism drupal_static() and the node
	// grants need; the hand-rolled resets below are the fallback for a site that has not enabled it.
	try {
		$container = Drupal::getContainer();
		if ($container !== null && $container->has('drupflare.request_resetter')) {
			$GLOBALS['__pw_reset'] = $container->get('drupflare.request_resetter')->reset();
		} else {
			if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) {
				@session_write_close();
			}
			$_SESSION = [];
		}
	} catch (Throwable $e) {
		$GLOBALS['__pw_reset'] = ['error' => $e->getMessage()];
	}

	// AND THE ID HAS TO BE SET FROM THIS REQUEST, not left wherever the last one put it.
	// session_start() prefers an id already set on the process over the cookie, so an unset id is
	// not a clean slate -- it is the previous visitor. Always overwrite: the cookie when there is
	// one, a fresh id when there is not.
	if (function_exists('session_id')) {
		$sid = '';
		foreach ($cookies as $cookieName => $cookieValue) {
			if (strncmp($cookieName, 'SESS', 4) === 0 || strncmp($cookieName, 'SSESS', 5) === 0) {
				$sid = (string) $cookieValue;
				break;
			}
		}
		if ($sid !== '' && preg_match("/^[A-Za-z0-9,-]{1,128}$/", $sid) === 1) {
			@session_id($sid);
		} elseif (function_exists('session_create_id')) {
			@session_id(session_create_id());
		}
	}

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

	// Html::$seenIds is a plain static and is NOT registered through drupal_static(), so the line
	// above does not clear it. On a persistent interpreter the id registry accumulates across
	// requests: render 1 is 12,304 bytes, renders 2-5 come back 12,310 with
	// block-olivero-page-title--2 through --5. Measured on a deployed worker, so the same URL stops
	// being byte-reproducible and every anchor, aria-labelledby target and id-based selector moves.
	//
	if ((new ReflectionClass(Html::class))->hasMethod('resetSeenIds')) {
		Html::resetSeenIds();
	}

	// AND Html::$isAjax IS THE SAME STATIC ONE CLASS OVER, which resetSeenIds() does not touch.
	// AjaxResponseSubscriber sets it true on an ajax request and nothing sets it back, so on a
	// persistent interpreter the FIRST ajax request makes getUniqueId() take its random branch --
	// Crypt::randomBytesBase64(8) -- for every later render on that incarnation. Measured in the
	// browser lane: add a field through the field-UI modal, and /node/add/page then renders
	// node-page-form--iGSVurTf0ZU instead of node-page-form, differently on every request. A cached
	// page stops being byte-reproducible and every id-based selector on the site moves.
	if ((new ReflectionClass(Html::class))->hasMethod('setIsAjax')) {
		Html::setIsAjax(false);
	}

	// AND THE PAGE CACHE KILL SWITCH IS THE SAME SHAPE AGAIN, on a container SERVICE this time.
	// KillSwitch::trigger() sets $kill true and core never sets it back, because a real SAPI ends the
	// process instead. Messenger::addMessage() calls it, so ONE saved node or config form makes
	// check() answer DENY for every later render on this incarnation: every page comes back
	// private, no-store, fillOne() refuses the upsert, and cfw_page stops filling for the whole site.
	// Measured in the browser lane -- save a node as admin and the ANONYMOUS front page is
	// uncacheable from then on. The service carries the page_cache and dynamic_page_cache tags both,
	// so one reset covers both policies. Skipped when it was never built, which cannot have set it.
	try {
		$container = Drupal::getContainer();
		if ($container !== null && $container->initialized('page_cache_kill_switch')) {
			$switch = $container->get('page_cache_kill_switch');
			$ref = new ReflectionObject($switch);
			if ($ref->hasProperty('kill')) {
				$ref->getProperty('kill')->setValue($switch, false);
			}
		}
	} catch (Throwable $e) {
	}

	// AND EntityViewBuilder::$recursionKeys, which is the one that costs CONTENT rather than bytes.
	// A key goes in at #pre_render and comes out at #post_render, so a render that throws in between
	// leaves it set -- and on a persistent interpreter every later build of that entity and view mode
	// is marked #printed and renders EMPTY. Measured: save a node, empty the render bin, and the front
	// page comes back 9,981 bytes against 15,055 with the teaser gone, logging "Recursive rendering
	// attempt aborted for node:entity_id:1:1:en:teaser". One failed render blanks that node for the
	// life of the incarnation, and /node/1 still rendering is what makes it look like a view problem.
	try {
		$keys = new ReflectionProperty(EntityViewBuilder::class, 'recursionKeys');
		$keys->setValue(null, []);
	} catch (Throwable $e) {
	}

	// AND Renderer::$isRenderingRoot, which turns every later render into a 500.
	// renderRoot() sets it, and core resets it in a catch -- so an EXCEPTION is handled and an
	// abort is not. This SAPI does not unwind: a run cut short leaves the flag true on a service
	// that outlives the request, and every renderRoot() after it throws "A stray renderRoot()
	// invocation is causing bubbling of attached assets to break". Measured in the e2e lane as the
	// front page answering 500 after an invalidation, with the site otherwise healthy.
	// Walked through any decorator, for the reason the path.matcher walk below gives.
	try {
		$node = Drupal::service('renderer');
		$seen = 0;
		while (is_object($node) && $seen < 8) {
			$seen++;
			$ref = new ReflectionObject($node);
			if ($ref->hasProperty('isRenderingRoot')) {
				$ref->getProperty('isRenderingRoot')->setValue($node, false);
			}
			if (!$ref->hasProperty('decorated')) {
				break;
			}
			$node = $ref->getProperty('decorated')->getValue($node);
		}
	} catch (Throwable $e) {
	}

	// PATH.MATCHER LEAKS ITS FRONT-PAGE VERDICT ACROSS RENDERS, and this fixes markup that was
	// being served wrong to real visitors. isFrontPage() memoises into $isCurrentFrontPage, and on a
	// persistent container the FIRST path rendered decides for every later one. Measured: render /
	// then /user/login on one interpreter and /user/login comes back with class="path-frontpage",
	// no active trail and no breadcrumb -- front-page markup on a page that is not the front page.
	//
	// walked by reflection, and the chain is why. path_alias DECORATES path.matcher, so
	// Drupal::service("path.matcher") is an AliasPathMatcher holding the real one in $decorated --
	// and it declares its OWN $isCurrentFrontPage, memoised with ??=, which shadows the inner
	// matcher entirely. Two earlier attempts missed that: drupal_static_reset() does not touch a
	// protected property, and giving the INNER class a reset() fixed an object whose answer is
	// never consulted. Walking every link means no decoration depth or ordering can hide a memo.
	//
	// NULL rather than FALSE: isFrontPage() guards on the property being unset, so FALSE reads as a
	// computed "not the front page" and pins every later request to it -- the same bug reversed.
	try {
		$node = Drupal::service('path.matcher');
		$seen = 0;
		while (is_object($node) && $seen < 8) {
			$seen++;
			$ref = new ReflectionObject($node);
			if ($ref->hasProperty('isCurrentFrontPage')) {
				$prop = $ref->getProperty('isCurrentFrontPage');
				$prop->setValue($node, null);
			}
			if (!$ref->hasProperty('decorated')) {
				break;
			}
			$inner = $ref->getProperty('decorated');
			$node = $inner->getValue($node);
		}
	} catch (Throwable $e) {
	}

	// NOT releasing locks here, and the reasoning is measured. The mechanism is real:
	// DatabaseLockBackend relies on releaseAll() at PROCESS SHUTDOWN, this interpreter never
	// shuts down, and a lock held forever would be worse than a stale cache because
	// Lock::wait() calls usleep() inside a synchronous wasm call that nothing can interrupt --
	// it stalls instead of failing.
	// But the semaphore table measured EMPTY on every site exercised, including three that ran
	// the destruct pass before any release was added, so nothing actually leaks on these
	// paths: CacheCollector::destruct() releases its own lock. Paying a statement per
	// render for an unobserved leak is the same trade this file just rejected for the
	// destruct pass. Instead: alarm() releases (cheap, periodic, unattended) and
	// test-serve-chain.mjs asserts the semaphore table is empty, so a future leak trips a test
	// rather than stalling a request.

	// $catch = TRUE, which is what index.php passes and what this had wrong. With FALSE, HttpKernel
	// rethrows instead of dispatching KernelEvents::EXCEPTION -- so Drupal's own 403 and 404 pages
	// never rendered, and a successful login came back as a bare
	// Drupal\Core\Form\EnforcedResponseException because the redirect a form sets is DELIVERED as an
	// exception and converted by EnforcedFormResponseSubscriber. Every one of those is a normal
	// response that was being reported as a render failure.
	$response = $kernel->handle($request, HttpKernelInterface::MAIN_REQUEST, true);

	// shutdown callbacks and the named TERMINATE subscribers, which a persistent interpreter never
	// runs by itself; a server error skips them inside drain()
	if (class_exists(Terminate::class)) {
		try {
			Terminate::drain($kernel, $request, $response);
		} catch (Throwable $e) {
		}
	}

	// Nothing had ever completed the request lifecycle, so every needs_destruction
	// service -- theme.registry, library.discovery, library.parsing_cache,
	// menu.active_trail, router.builder, path_alias -- discarded its accumulated
	// CacheCollector entries instead of persisting them. Those writes happen in
	// CacheCollector::destruct().
	//
	// This is NOT $kernel->terminate(). Two measured reasons:
	// First, terminate() dispatches TERMINATE, which automated_cron subscribes to. With
	// system.cron_last absent it runs drupal_cron() inline, cron reaches for
	// outbound HTTP, and the invocation dies with "ReferenceError: Asyncify is
	// not defined" -- a JS exception that catch (Throwable) cannot contain.
	// Second, even with cron disabled, terminate() POISONED the interpreter: the first
	// render returned 12,304 bytes and every render after it returned 0 bytes,
	// with rows-written per render jumping 15 -> 85. terminate() is written for a
	// process that is about to exit; this interpreter is persistent and reuses
	// the same kernel.
	// So iterate the container parameter the compiler pass fills and destruct only the
	// services that were actually initialised this request -- the collector writes we
	// want, none of the process-death semantics we do not.
	// $destruct is true, false, or a comma-separated allowlist of service ids, so the
	// culprit can be bisected
	if ($destruct !== false && $destruct !== '0') {
		$only = is_string($destruct) ? explode(',', $destruct) : null;
		// theme.registry is EXCLUDED, and it is the one service whose destruct() cannot
		// be used here. Bisected one service at a time: state, menu.active_trail,
		// router.builder, library.discovery and library.parsing_cache all destruct
		// safely (12,310-byte render, every render); theme.registry alone gives 12,304
		// on render 1 and then 0 BYTES on every render after it.
		// Registry::destruct() persists the RUNTIME registry, which core's own docblock
		// calls "incomplete". Clearing cache_bootstrap between renders does NOT fix it,
		// so the corruption is the in-memory collector object, which survives because
		// this interpreter reuses the container across requests. Registry::reset() is not
		// an escape either -- it deletes the theme_registry:runtime:* cids that destruct()
		// just wrote, so it undoes the persistence it would be repairing.
		// The COMPLETE registry was never at risk: Registry::get() persists that itself
		// via setCache() when the module handler is loaded, with no destruct() involved.
		$skip = ['theme.registry'];
		try {
			$c = Drupal::getContainer();
			$GLOBALS['__pw_destructed'] = [];
			foreach ($c->getParameter('kernel.destructable_services') as $id) {
				if ($only !== null && !in_array($id, $only, true)) {
					continue;
				}
				if ($only === null && in_array($id, $skip, true)) {
					continue;
				}
				if (!$c->initialized($id)) {
					continue;
				}
				$svc = $c->get($id);
				if ($svc instanceof DestructableInterface) {
					$svc->destruct();
					$GLOBALS['__pw_destructed'][] = $id;
				}
			}
		} catch (Throwable $e) {
		}
	}

	return $response;
}
