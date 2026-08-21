/**
 * PHP fragments for the decomposed cron, run inside the Durable Object.
 *
 * They are eval'd through pib_run, so a `use` statement at the top of a fragment
 * is invalid and every class name is fully qualified. Each one prints a single
 * JSON object and nothing else, because the caller parses from the first `{`.
 *
 * NONE of these calls drupal_cron(). A full run was measured at 187 queries and
 * 227-275 ms of CPU against a 10 ms free-plan invocation budget, and four of the
 * six cron implementations on this site either need a socket or duplicate work
 * that src/cron.js already does in SQL. See CRON_HOOKS in src/cron.js for which
 * ones are skipped and why.
 */

/**
 * Drupal's Fiber use has to resolve to something before Drupal loads.
 *
 * A third guarded copy rather than an import: the original is a private const in
 * src/site-php.js, and src/drupal-boot.js and src/min.js already each carry their
 * own copy, so duplication is this repo's existing answer. The class_exists guard
 * makes a second installation a no-op, so whichever fragment runs first wins.
 */
const FIBER_SHIM = String.raw`
if (!class_exists('PhpWasmSyncFiber', false)) { eval('
class PhpWasmSyncFiber {
  private $callable;
  private $result = null;
  private $started = false;
  public function __construct(callable $callable) { $this->callable = $callable; }
  public function start(...$args) { $this->started = true; $this->result = ($this->callable)(...$args); return null; }
  public function isStarted(): bool { return $this->started; }
  public function isSuspended(): bool { return false; }
  public function isRunning(): bool { return false; }
  public function isTerminated(): bool { return $this->started; }
  public function resume($value = null) { return null; }
  public function throw(\\Throwable $e) { throw $e; }
  public function getReturn() { return $this->result; }
  public static function getCurrent(): ?object { return null; }
  public static function suspend($value = null) { return null; }
}
'); }
`;

/**
 * The $_SERVER block and the memoized kernel boot, matching renderPage().
 *
 * Identical to the preamble in `site-php.ts`: a cron fragment that booted differently from the
 * render path would be measuring a different site.
 *
 * THE ORIGIN MATTERS MORE HERE THAN ON A RENDER. A render's absolute URLs are mostly relative in
 * the markup, but cron is where mail is sent -- and `user_pass_reset_url()` builds an absolute link
 * from the request. Booted against `localhost`, every link Drupal mails from cron points the
 * recipient at their own machine. `Request::create()` builds its own server bag and never reads
 * `$_SERVER`, so the URI it is given is the only thing that sets the host.
 *
 * @param origin - a `scheme://host[:port]`, already JSON-encoded as a PHP string literal
 */
const kernelBoot = (origin: string) => String.raw`
$origin = json_decode(${origin});
$__host = $origin === '' ? 'localhost' : (string) parse_url($origin, PHP_URL_HOST);
$__port = $origin === '' ? 80 : (int) (parse_url($origin, PHP_URL_PORT) ?: (strncmp($origin, 'https:', 6) === 0 ? 443 : 80));
$_SERVER['HTTP_HOST'] = $__port === 80 || $__port === 443 ? $__host : $__host . ':' . $__port;
$_SERVER['SERVER_NAME'] = $__host;
$_SERVER['SERVER_PORT'] = (string) $__port;
if (strncmp($origin, 'https:', 6) === 0) { $_SERVER['HTTPS'] = 'on'; } else { unset($_SERVER['HTTPS']); }
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

if (!isset($GLOBALS['__pw_autoloader'])) {
  $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
}
$autoloader = $GLOBALS['__pw_autoloader'];

if (!isset($GLOBALS['__pw_kernel'])) {
  $request = \Symfony\Component\HttpFoundation\Request::create($origin === '' ? '/' : rtrim($origin, '/') . '/', 'GET');
  $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
  \Drupal\Core\DrupalKernel::bootEnvironment();
  $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
  $kernel->setSitePath($sitePath);
  \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
  $kernel->boot();
  $GLOBALS['__pw_kernel'] = $kernel;
  $out['bootedKernel'] = 1;
}
// the request stack is what Drupal's URL generator reads for the host, and a cron fragment
// pushes none of its own -- so without this an absolute URL falls back to a default it invents
try {
  if ($origin !== '' && \Drupal::hasContainer()) {
    \Drupal::service('request_stack')->push(
      \Symfony\Component\HttpFoundation\Request::create(rtrim($origin, '/') . '/', 'GET')
    );
  }
} catch (\Throwable $e) {}
`;

/**
 * Collects the cron listeners the way Drupal\Core\Cron does, keyed by module.
 *
 * invokeAllWith() rather than invoke(): iterateByModule() is a generator, so
 * collecting the callables runs none of them, and this is the exact code path
 * Cron::invokeCronHandlers() uses. ModuleHandler::invoke($module, 'cron') does
 * also work in 11.4.5 -- verified by reading ModuleHandler.php:347-358, which
 * resolves through the same ImplementationList before falling back to a
 * $module_$hook function -- but it throws LogicException on a second
 * implementation, and a periodic unattended alarm should report that rather than
 * die of it.
 */
const COLLECT_CRON_LISTENERS = String.raw`
$found = [];
\Drupal::moduleHandler()->invokeAllWith('cron', function (callable $hook, string $m) use (&$found) {
  $found[$m][] = $hook;
});
$out['available'] = array_keys($found);
`;

/** describes a collected listener without calling it */
const LISTENER_SHAPE = String.raw`
if (!function_exists('cfw_listener_shape')) { eval('
function cfw_listener_shape($c) {
  if (is_array($c)) { return (is_object($c[0]) ? get_class($c[0]) : (string) $c[0]) . "::" . $c[1]; }
  if ($c instanceof \\Closure) { return "Closure"; }
  if (is_object($c)) { return get_class($c) . "::__invoke"; }
  return gettype($c);
}
'); }
`;

/**
 * Lists every cron implementation the booted site has, running none of them.
 *
 * Exists so the skip list in src/cron.js can be CHECKED against the site instead
 * of trusted: the measured set on this install is announcements_feed, dblog,
 * file, layout_builder, system, update, and a module added later has to show up
 * here before it can be scheduled.
 */
export function cronHookList(origin = ''): string {
	return String.raw`<?php
${FIBER_SHIM}
${LISTENER_SHAPE}
chdir('/drupal');

$out = [];
$clock = function () { return microtime(true) * 1000; };
$t0 = $clock();

try {
${kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))}
${COLLECT_CRON_LISTENERS}
  $shapes = [];
  foreach ($found as $m => $listeners) {
    foreach ($listeners as $listener) { $shapes[$m][] = cfw_listener_shape($listener); }
  }
  $out['shapes'] = $shapes;
  $out['queues'] = [];
  foreach (\Drupal::service('plugin.manager.queue_worker')->getDefinitions() as $id => $def) {
    $out['queues'][$id] = isset($def['cron']) ? ($def['cron']['time'] ?? 0) : null;
  }
  $out['advisoriesEnabled'] = (bool) \Drupal::config('system.advisories')->get('enabled');
  $out['dblogRowLimit'] = (int) \Drupal::config('dblog.settings')->get('row_limit');
  $out['cacheDataMaxRows'] = (int) \Drupal::service('cache.data')->getMaxRows();
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
`;
}

/**
 * Runs exactly ONE named module's cron implementation, and nothing else.
 *
 * This is what the decomposition is for: the free plan caps an alarm
 * invocation at the same 10 ms of CPU as a request, so the unit of work has to be
 * one hook rather than one cron run.
 *
 * Two departures from Drupal\Core\Cron::run():
 *
 *   1. No 'cron' lock is acquired. The Durable Object gate already guarantees one
 *      caller in the interpreter at a time, and a DatabaseLockBackend lock taken
 *      here would outlive the invocation with no process shutdown to release it --
 *      after which Lock::wait() usleep()s inside a synchronous wasm call and
 *      stalls rather than fails.
 *   2. system.cron_last is NOT written here. It is one serialized integer in
 *      key_value, so src/cron.js writes it in SQL once the round completes, which
 *      keeps this fragment to a single concern.
 *
 * The account switch IS kept, because it is not bookkeeping: hooks that run
 * entity queries see different results as an authenticated user, and Cron::run()
 * switches to anonymous for exactly that reason.
 *
 * @param {string} module machine name; anything else returns a refusal
 */
export function runCronHook(module: string, origin = ''): string {
	const name = String(module ?? '');
	if (!/^[a-z][a-z0-9_]*$/.test(name)) {
		return String.raw`<?php echo json_encode(['ran' => false, 'error' => 'refused module name']);`;
	}
	return String.raw`<?php
${FIBER_SHIM}
chdir('/drupal');

$module = json_decode(${JSON.stringify(JSON.stringify(name))});
$out = ['module' => $module, 'ran' => false];
$clock = function () { return microtime(true) * 1000; };
$t0 = $clock();

try {
${kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))}
${COLLECT_CRON_LISTENERS}

  if (!isset($found[$module])) {
    $out['reason'] = 'no cron implementation';
  } elseif (count($found[$module]) > 1) {
    // core's own invariant; ModuleHandler::invoke() raises LogicException here
    $out['reason'] = 'more than one implementation';
    $out['count'] = count($found[$module]);
  } else {
    $switcher = null;
    try {
      $switcher = \Drupal::service('account_switcher');
      $switcher->switchTo(new \Drupal\Core\Session\AnonymousUserSession());
    } catch (\Throwable $e) {
      $out['switchError'] = $e->getMessage();
      $switcher = null;
    }
    $fn = $found[$module][0];
    $a = $clock();
    try {
      call_user_func($fn);
      $out['ran'] = true;
    } catch (\Throwable $e) {
      $out['error'] = get_class($e) . ': ' . $e->getMessage();
      $out['trace'] = substr($e->getTraceAsString(), 0, 800);
    }
    $out['hookMs'] = round($clock() - $a, 2);
    if ($switcher !== null) {
      try { $switcher->switchBack(); } catch (\Throwable $e) {}
    }
  }
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
`;
}

/**
 * Processes at most $maxItems items from ONE named queue, then stops.
 *
 * Drupal\Core\Cron::processQueue() loops on the wall clock until the worker's
 * declared lease elapses -- 60 s for the only cron queue on this site,
 * media_entity_thumbnail. That bound is meaningless here and the CPU one is
 * fatal, so the loop is bounded by item count instead and the cursor in
 * src/cron.js carries the chain across invocations.
 *
 * The exception handling mirrors Cron::processQueue() case for case, because each
 * branch decides whether an item is deleted, released or left leased, and getting
 * that wrong either loses work or replays it forever. The one addition is the
 * catch-all break: core logs and keeps going, but a failing item here has usually
 * failed because a socket is missing, so continuing would spend the invocation
 * discovering that again.
 *
 * @param {string} name queue (and queue worker plugin) id
 * @param {number} maxItems items this invocation may process
 */
export function runCronQueue(name: string, maxItems = 5, origin = ''): string {
	const queue = String(name ?? '');
	if (!/^[a-z][a-z0-9_:.-]*$/.test(queue)) {
		return String.raw`<?php echo json_encode(['ran' => false, 'error' => 'refused queue name']);`;
	}
	const max =
		Number.isFinite(Number(maxItems)) && Number(maxItems) >= 1
			? Math.min(Math.floor(Number(maxItems)), 50)
			: 5;
	return String.raw`<?php
${FIBER_SHIM}
chdir('/drupal');

$name = json_decode(${JSON.stringify(JSON.stringify(queue))});
$max = ${max};
$out = ['queue' => $name, 'processed' => 0, 'failed' => 0, 'requeued' => 0, 'delayed' => 0, 'suspended' => false];
$clock = function () { return microtime(true) * 1000; };
$t0 = $clock();

try {
${kernelBoot(JSON.stringify(JSON.stringify(String(origin ?? ''))))}

  $manager = \Drupal::service('plugin.manager.queue_worker');
  $definitions = $manager->getDefinitions();
  if (!isset($definitions[$name])) {
    $out['reason'] = 'no queue worker plugin';
  } else {
    $lease = (int) ($definitions[$name]['cron']['time'] ?? 60);
    $queue = \Drupal::queue($name);
    try { $queue->createQueue(); } catch (\Throwable $e) {}
    $worker = $manager->createInstance($name);
    $switcher = null;
    try {
      $switcher = \Drupal::service('account_switcher');
      $switcher->switchTo(new \Drupal\Core\Session\AnonymousUserSession());
    } catch (\Throwable $e) { $switcher = null; }

    for ($i = 0; $i < $max; $i++) {
      $item = $queue->claimItem($lease);
      if (!$item) { break; }
      try {
        $worker->processItem($item->data);
        $queue->deleteItem($item);
        $out['processed']++;
      } catch (\Drupal\Core\Queue\DelayedRequeueException $e) {
        // leave the lease alone unless the queue can extend it itself
        if ($queue instanceof \Drupal\Core\Queue\DelayableQueueInterface) {
          $queue->delayItem($item, $e->getDelay());
        }
        $out['delayed']++;
      } catch (\Drupal\Core\Queue\RequeueException $e) {
        $queue->releaseItem($item);
        $out['requeued']++;
      } catch (\Drupal\Core\Queue\SuspendQueueException $e) {
        $queue->releaseItem($item);
        $out['suspended'] = true;
        break;
      } catch (\Throwable $e) {
        // left leased, exactly as core does, so it retries after the lease
        $out['failed']++;
        $out['lastError'] = get_class($e) . ': ' . $e->getMessage();
        break;
      }
    }

    if ($switcher !== null) {
      try { $switcher->switchBack(); } catch (\Throwable $e) {}
    }
    try { $out['remaining'] = (int) $queue->numberOfItems(); } catch (\Throwable $e) {}
    $out['ran'] = true;
  }
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}

$out['ms'] = round($clock() - $t0, 2);
echo json_encode($out);
`;
}
