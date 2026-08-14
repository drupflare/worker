/**
 * Boots Drupal inside wasm and reports timings from PHP's own clock.
 *
 * Fully-qualified names throughout because this is eval'd through pib_run,
 * where a `use` statement at the top of the fragment is not valid.
 */
export const DRUPAL_BOOT = `<?php
chdir('/drupal');

/**
 * Synchronous stand-in for \\Fiber.
 *
 * PHP builds Fibers on ucontext when --disable-fiber-asm is set, and emscripten
 * has no ucontext, so a real Fiber aborts the runtime. Drupal's five call sites
 * all follow construct -> start -> resume-until-terminated -> getReturn, so
 * running the callable eagerly on start() and reporting terminated satisfies
 * every one. scripts/patch-drupal.mjs rewrites core to use this.
 */
// guarded: the interpreter persists between requests, so a bare declaration
// fatals on the second one
if (!class_exists('PhpWasmSyncFiber', false)) { eval('
class PhpWasmSyncFiber {
	private $callable;
	private $result = null;
	private $started = false;
	private $error = null;

	public function __construct(callable $callable) { $this->callable = $callable; }

	public function start(...$args) {
		$this->started = true;
		$this->result = ($this->callable)(...$args);
		return null;
	}

	public function isStarted(): bool { return $this->started; }
	public function isSuspended(): bool { return false; }
	public function isRunning(): bool { return false; }
	public function isTerminated(): bool { return $this->started; }
	public function resume($value = null) { return null; }
	public function throw(\\Throwable $e) { throw $e; }
	public function getReturn() { return $this->result; }

	// never inside a fiber, so callers skip their suspend branches
	public static function getCurrent(): ?object { return null; }
	public static function suspend($value = null) { return null; }
}
'); }

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
$_SERVER['HTTP_USER_AGENT'] = 'workerd-bench';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

$mark = [];
$t = function() { return microtime(true) * 1000; };
$t0 = $t();

try {
	// require_once returns true, not the autoloader, once the interpreter has
	// already loaded the file -- and the interpreter persists between requests.
	// Cache the instance instead. This is the request-isolation problem in
	// miniature.
	if (!isset($GLOBALS['__pw_autoloader'])) {
		$GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
	}
	$autoloader = $GLOBALS['__pw_autoloader'];
	$mark['autoloadMs'] = round($t() - $t0, 1);
	$mark['warm'] = isset($GLOBALS['__pw_booted']) ? 1 : 0;
	$GLOBALS['__pw_booted'] = true;

	$a = $t();
	$request = \\Symfony\\Component\\HttpFoundation\\Request::create('/', 'GET');
	$kernel = new \\Drupal\\Core\\DrupalKernel('prod', $autoloader);
	\\Drupal\\Core\\DrupalKernel::bootEnvironment();
	$sitePath = \\Drupal\\Core\\DrupalKernel::findSitePath($request);
	$kernel->setSitePath($sitePath);
	\\Drupal\\Core\\Site\\Settings::initialize('/drupal', $sitePath, $autoloader);
	$mark['settingsMs'] = round($t() - $a, 1);

	$a = $t();
	$kernel->boot();
	$mark['bootMs'] = round($t() - $a, 1);

	// kept so DRUPAL_EXERCISE can drive more routes through the same kernel
	$GLOBALS['__pw_kernel'] = $kernel;

	$a = $t();
	$response = $kernel->handle($request);
	$mark['handleMs'] = round($t() - $a, 1);

	$body = (string) $response->getContent();
	$mark['status'] = $response->getStatusCode();
	$mark['bytes'] = strlen($body);
	$mark['titleFound'] = str_contains($body, '<title>') ? 1 : 0;
} catch (\\Throwable $e) {
	$mark['error'] = get_class($e) . ': ' . $e->getMessage();
	$mark['trace'] = substr($e->getTraceAsString(), 0, 900);
}

$mark['totalMs'] = round($t() - $t0, 1);
$mark['peakMemMb'] = round(memory_get_peak_usage(true) / 1048576, 1);
$mark['files'] = count(get_included_files());

echo json_encode($mark);
`;

/**
 * Captures the include set from inside wasm.
 *
 * Profiling on the host is wrong: a host PHP with intl/mbstring/iconv skips
 * Symfony's polyfills entirely, and conditionally-loaded driver classes never
 * appear. Profiling here sees the real extension set and the real conditional
 * branches, so the resulting pack is both complete and small.
 *
 * Run after DRUPAL_BOOT in the same instance.
 */
export const DRUPAL_PROFILE = `<?php
$root = '/drupal/';
$out = [];
foreach (get_included_files() as $f) {
	if (str_starts_with($f, $root)) {
		$out[] = substr($f, strlen($root));
	}
}
sort($out);
echo json_encode($out);
`;

/**
 * Exercises more of the codebase than a single front-page render, so the
 * profile is the union of realistic paths rather than one lucky route.
 * Anything that throws is recorded and skipped -- a route failing here still
 * tells us which files it pulled in before it failed.
 */
/**
 * Serves one request against a persistent kernel, correctly.
 *
 * DrupalKernel::preHandle() is guarded by $this->prepared, so it pushes onto
 * request_stack only on the FIRST handle(). Every later call therefore routes
 * against the first request's path -- measured directly:
 *
 *   reqUri=/admin/content  pathInfo=/admin/content
 *   current_path=/node     route=view.frontpage.page_1   stack=/
 *
 * So a naive loop over handle() silently re-serves the front page and every
 * per-route number is meaningless. This pushes and pops the stack explicitly
 * and resets the path/route state that is derived from it.
 *
 * This is the same class of defect as the drupal_static leak: Drupal assumes a
 * process boundary where there is none.
 */
export const PW_SERVE = `
if (!function_exists('pw_serve')) { eval('
function pw_serve($path) {
  $kernel = $GLOBALS["__pw_kernel"];
  $request = \\\\Symfony\\\\Component\\\\HttpFoundation\\\\Request::create($path, "GET");

  // DrupalKernel::preHandle() is guarded by $prepared, so it pushes onto
  // request_stack only on the FIRST handle(). Every later call then routes
  // against the first request path -- measured: reqUri=/admin/content but
  // route=view.frontpage.page_1 and stack=/. Clearing the flag makes Drupal
  // re-initialize per-request state the way a fresh process would.
  try {
    $rp = new \\\\ReflectionProperty(\\\\Drupal\\\\Core\\\\DrupalKernel::class, "prepared");
    $rp->setAccessible(true);
    $rp->setValue($kernel, false);
  } catch (\\\\Throwable $e) {}

  // drop anything a previous request left on the stack
  try {
    $stack = \\\\Drupal::service("request_stack");
    while ($stack->getCurrentRequest() !== null) { $stack->pop(); }
  } catch (\\\\Throwable $e) {}

  if (function_exists("drupal_static_reset")) { drupal_static_reset(); }

  return $kernel->handle($request, \\\\Symfony\\\\Component\\\\HttpKernel\\\\HttpKernelInterface::MAIN_REQUEST, false);
}
'); }
`;

export const DRUPAL_EXERCISE = `<?php
${PW_SERVE}
// Anonymous pass. Cache-busting query strings matter: without them Drupal's
// page cache serves the second request and the trace sees nothing new, which is
// why an earlier six-route pass added only 2 files.
$done = [];
$anon = ['/', '/user/login', '/user/register', '/node/1', '/robots.txt'];
foreach ($anon as $p) {
	try {
		$res = pw_serve($p);
		$done['anon ' . $p] = $res->getStatusCode() . ':' . strlen((string) $res->getContent());
	} catch (\\Throwable $e) {
		$done['anon ' . $p] = 'ERR: ' . substr($e->getMessage(), 0, 70);
	}
}

// Authenticated pass.
//
// This is the path the pack currently cannot serve at all: User was never
// loaded, so its class was never traced, so it was never packed. Switching the
// account exercises the authenticated render path -- access checks, node
// grants, admin theme, Views with an exposed filter -- without needing cookies.
try {
	$user = \\Drupal\\user\\Entity\\User::load(1);
	if ($user) {
		\\Drupal::service('account_switcher')->switchTo($user);
		$done['switched_to_uid'] = (int) \\Drupal::currentUser()->id();

		$authed = [
			'/',
			'/user/1',
			'/user/1/edit',
			'/admin',
			'/admin/content',        // a View with an exposed filter
			'/admin/structure',
			'/admin/modules',
			'/admin/config',
			'/admin/reports/status',
			'/node/add',
			'/node/1/edit',
			'/admin/people',
		];
		foreach ($authed as $p) {
			try {
				$res = pw_serve($p);
				$done['auth ' . $p] = $res->getStatusCode() . ':' . strlen((string) $res->getContent());
			} catch (\\Throwable $e) {
				$done['auth ' . $p] = 'ERR: ' . substr($e->getMessage(), 0, 70);
			}
		}
		\\Drupal::service('account_switcher')->switchBack();
	} else {
		$done['user_load'] = 'uid 1 not loadable';
	}
} catch (\\Throwable $e) {
	$done['auth_setup'] = get_class($e) . ': ' . substr($e->getMessage(), 0, 90);
}

echo json_encode(['routes' => $done, 'files' => count(get_included_files())]);
`;
