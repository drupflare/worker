<?php

/**
 * Counts what a render asks the cache-context system for, and how much of it repeats.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bench/bench-context-memo.php \
 *       <drupal-root> <route> [n] [--probe=<path to pw-probe.php>]
 *
 * `bench-render-breakdown.php` prices the bucket: 113 calls and 0.598 ms of a 5.676 ms steady-state
 * render, so ~10.5%. That says how much a PERFECT memo could return and nothing about whether one
 * is possible. This answers the other half -- how many of those calls repeat a token list already
 * answered in the same request, and whether the answer is stable when they do.
 *
 * Measured at the `convertTokensToKeys()` boundary rather than per context service, because that is
 * the function a memo would wrap: its input is the token list and its output is the keys. Counting
 * individual `getContext()` calls would price a different, more invasive change.
 *
 * A memo is only sound if a repeated token list gives an identical answer WITHIN one request, so
 * that is reported per token list rather than assumed. Anything with more than one distinct answer
 * is named and excluded from the saving.
 */

$root = $argv[1] ?? null;
$route = $argv[2] ?? '/';
$n = (int) ($argv[3] ?? 5);
$probe = null;
foreach ($argv as $a) {
	if (str_starts_with((string) $a, '--probe=')) {
		$probe = substr($a, 8);
	}
}

if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-context-memo.php <drupal-root> <route> [n] [--probe=<path>]\n");
	exit(1);
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
require_once $probe ?? $root . '/pw-probe.php';

if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}

/**
 * Records every token list a request converts, and the keys it got back.
 *
 * Keyed by the token list as written, because that is what a memo would key on. `optimizeTokens()`
 * is counted separately: it is the other half of the same service and a memo over it is a different
 * change with a different risk.
 */
final class MemoCounter
{
	/** token list => ['calls' => int, 'answers' => [keys => count]] */
	public static array $convert = [];

	/** token list => calls */
	public static array $optimize = [];

	/** reset between requests, so "repeat within one request" is what is counted */
	public static function reset(): void
	{
		self::$convert = [];
		self::$optimize = [];
	}

	public static function convert(array $tokens, array $keys): void
	{
		$k = implode(',', $tokens);
		$v = implode('|', $keys);
		self::$convert[$k]['calls'] = (self::$convert[$k]['calls'] ?? 0) + 1;
		self::$convert[$k]['answers'][$v] = (self::$convert[$k]['answers'][$v] ?? 0) + 1;
	}

	public static function optimize(array $tokens): void
	{
		$k = implode(',', $tokens);
		self::$optimize[$k] = (self::$optimize[$k] ?? 0) + 1;
	}
}

final class CountingCacheContextsManager extends \Drupal\Core\Cache\Context\CacheContextsManager
{
	public function convertTokensToKeys(array $context_tokens)
	{
		$result = parent::convertTokensToKeys($context_tokens);
		MemoCounter::convert($context_tokens, $result->getKeys());
		return $result;
	}

	public function optimizeTokens(array $context_tokens)
	{
		MemoCounter::optimize($context_tokens);
		return parent::optimizeTokens($context_tokens);
	}
}

/**
 * The treatment arm: the shipped memo, counting how many calls still reach core.
 *
 * The class is required by path because `drupal-src` carries no drupflare module -- only the packed
 * tree does -- so composer's autoloader cannot map the namespace here.
 */
$memoClass = dirname(__DIR__, 2) . '/../drupflare/src/Cache/MemoizedCacheContextsManager.php';
$haveMemo = is_file($memoClass);
if ($haveMemo) {
	require_once $memoClass;
}

/**
 * Route matching, which no existing probe decorates.
 *
 * `pw_install_probes()` wraps eight services and the router is not among them, so route matching
 * lands in the breakdown's RESIDUAL. Concluding it is cheap because it has no bucket would be a
 * statement about the instrument; this counts and times it instead.
 */
final class RouteCounter
{
	public static int $calls = 0;

	public static float $seconds = 0.0;

	/** matched path => times matched, so a repeat within one request is visible */
	public static array $paths = [];

	public static function reset(): void
	{
		self::$calls = 0;
		self::$seconds = 0.0;
		self::$paths = [];
	}
}

/**
 * Per-EVENT dispatch cost, which the shared `events` bucket cannot show.
 *
 * `PwEventDispatcher` charges every dispatch to one bucket, so 26.6% of a render is attributed to
 * "events" with no way to see which of the seven costs it. Anonymous specialisation has to know
 * which listeners are worth skipping, so the name is recorded here.
 */
final class EventCounter
{
	/** event name => ['calls' => int, 'seconds' => float] */
	public static array $events = [];

	public static function reset(): void
	{
		self::$events = [];
	}

	/** a readable name for a closure, an array callable or an object */
	public static function name(callable $listener): string
	{
		if (is_array($listener)) {
			return (is_object($listener[0]) ? get_class($listener[0]) : (string) $listener[0]) .
				'::' .
				$listener[1];
		}
		if (is_string($listener)) {
			return $listener;
		}
		if ($listener instanceof \Closure) {
			$r = new \ReflectionFunction($listener);
			return 'closure@' . basename((string) $r->getFileName()) . ':' . $r->getStartLine();
		}
		return get_debug_type($listener);
	}

	public static function record(string $name, float $seconds): void
	{
		self::$events[$name]['calls'] = (self::$events[$name]['calls'] ?? 0) + 1;
		self::$events[$name]['seconds'] = (self::$events[$name]['seconds'] ?? 0.0) + $seconds;
	}
}

final class CountingDispatcher extends \Symfony\Component\EventDispatcher\EventDispatcher
{
	public function dispatch(object $event, ?string $eventName = null): object
	{
		$name = $eventName ?? get_class($event);
		$started = microtime(true);
		try {
			return parent::dispatch($event, $eventName);
		} finally {
			EventCounter::record($name, microtime(true) - $started);
		}
	}

	/**
	 * Times each listener, because the event total does not say which one is expensive.
	 *
	 * Naming the callable is what makes the result actionable: a specialisation has to skip a
	 * NAMED subscriber, and "kernel.response costs 1.272 ms" names nothing.
	 */
	protected function callListeners(iterable $listeners, string $eventName, object $event): void
	{
		foreach ($listeners as $listener) {
			if ($event instanceof \Symfony\Contracts\EventDispatcher\StoppableEventInterface) {
				if ($event->isPropagationStopped()) {
					break;
				}
			}
			$started = microtime(true);
			$listener($event, $eventName, $this);
			EventCounter::record(
				$eventName . ' :: ' . EventCounter::name($listener),
				microtime(true) - $started,
			);
		}
	}
}

final class CountingRouter extends \Drupal\Core\Routing\AccessAwareRouter
{
	public function matchRequest(\Symfony\Component\HttpFoundation\Request $request): array
	{
		$started = microtime(true);
		try {
			return parent::matchRequest($request);
		} finally {
			RouteCounter::$seconds += microtime(true) - $started;
			RouteCounter::$calls++;
			$p = $request->getPathInfo();
			RouteCounter::$paths[$p] = (RouteCounter::$paths[$p] ?? 0) + 1;
		}
	}
}

$kernel = pw_boot_kernel($root, $route, $autoloader);
$container = \Drupal::getContainer();
try {
	$container->set(
		'event_dispatcher',
		pw_rewrap($container->get('event_dispatcher'), 'CountingDispatcher'),
	);
} catch (\Throwable $e) {
	// the count simply stays empty; a partial probe must not take the whole bench down
}

/**
 * `--memo` installs the SHIPPED class rather than a counting subclass of it, because that class is
 * final and un-finalling production code to measure it is the wrong trade. It does not need
 * counting: the memo computes once per distinct token list by construction, so `distinctTokenLists`
 * from the control arm IS its compute count. What this arm proves is the half a count cannot --
 * that the rendered bytes are unchanged.
 */
$useMemo = in_array('--memo', $argv, true) && $haveMemo;
$container->set(
	'cache_contexts_manager',
	pw_rewrap(
		$container->get('cache_contexts_manager'),
		$useMemo
			? \Drupal\drupflare\Cache\MemoizedCacheContextsManager::class
			: 'CountingCacheContextsManager',
	),
);

// warm once: a first render compiles Twig and fills cache_render, and its context traffic is not
// the traffic the ceiling is priced on
pw_serve($kernel, $route);

// AFTER the first render, not before. Asking the container for `router` straight after boot() trips
// a real circular reference -- router -> router.no_access_checks -> router.request_context ->
// router_listener -- which is the same reason pw-probe.php reaches Twig through its engine
$routerProbed = false;
try {
	$counting = pw_rewrap($container->get('router'), 'CountingRouter');
	$container->set('router', $counting);
	// AND REBIND THE CONSUMER. router_listener captured the original object when it was built
	// during the warm render, so replacing the container entry alone leaves it calling the
	// original -- which reads as "routing costs nothing" rather than as a failed probe. Same
	// technique pw_probe_twig_in_engine() uses on the theme engine
	$listener = $container->get('router_listener');
	foreach ((new \ReflectionObject($listener))->getProperties() as $property) {
		if ($property->isStatic() || !$property->isInitialized($listener)) {
			continue;
		}
		if ($property->getValue($listener) instanceof \Symfony\Component\Routing\RouterInterface) {
			$property->setValue($listener, $counting);
			$routerProbed = true;
		}
	}
} catch (\Throwable $e) {
	$routerProbed = false;
}

$perRequest = [];
$bodies = [];
$times = [];
for ($i = 0; $i < $n; $i++) {
	MemoCounter::reset();
	RouteCounter::reset();
	EventCounter::reset();
	$started = microtime(true);
	$response = pw_serve($kernel, $route . (str_contains($route, '?') ? '&' : '?') . 'cb=' . $i);
	$times[] = (microtime(true) - $started) * 1000;
	$bodies[] = strlen((string) $response->getContent());
	$calls = 0;
	$distinct = 0;
	$repeated = 0;
	$unstable = [];
	foreach (MemoCounter::$convert as $tokens => $rec) {
		$calls += $rec['calls'];
		$distinct++;
		$repeated += $rec['calls'] - 1;
		if (count($rec['answers']) > 1) {
			$unstable[$tokens] = count($rec['answers']);
		}
	}
	$perRequest[] = [
		'convertCalls' => $calls,
		'distinctTokenLists' => $distinct,
		'redundantCalls' => $repeated,
		'redundantShare' => $calls ? round($repeated / $calls, 4) : 0.0,
		'unstableTokenLists' => $unstable,
		'optimizeCalls' => array_sum(MemoCounter::$optimize),
		'distinctOptimizeLists' => count(MemoCounter::$optimize),
		'routeMatchCalls' => RouteCounter::$calls,
		'routeMatchMs' => round(RouteCounter::$seconds * 1000, 4),
		'routeRepeats' => array_sum(RouteCounter::$paths) - count(RouteCounter::$paths),
		'events' => array_map(
			fn(array $e): array => [
				'calls' => $e['calls'],
				'ms' => round($e['seconds'] * 1000, 4),
			],
			EventCounter::$events,
		),
	];
}

// the last request's table, so the shape is visible rather than only the totals
$top = MemoCounter::$convert;
uasort($top, fn($a, $b) => $b['calls'] <=> $a['calls']);
$table = [];
foreach (array_slice($top, 0, 12, true) as $tokens => $rec) {
	$table[] = [
		'tokens' => $tokens,
		'calls' => $rec['calls'],
		'distinctAnswers' => count($rec['answers']),
	];
}

echo json_encode(
	[
		'root' => $root,
		'route' => $route,
		'n' => $n,
		'php' => PHP_VERSION,
		'arm' => $useMemo ? 'memoized' : 'control',
		'routerProbed' => $routerProbed,
		// LOCAL AND RELATIVE. RULE 0 reserves absolute CPU for a deployed worker's own meter; this
		// is two arms on one machine in one process, which is what a ratio needs
		'medianMs' => (function (array $ms): float {
			sort($ms);
			$c = count($ms);
			return $c
				? round($c % 2 ? $ms[intdiv($c, 2)] : ($ms[$c / 2 - 1] + $ms[$c / 2]) / 2, 3)
				: 0.0;
		})($times),
		// the comparison that a call count cannot make: identical bytes across arms
		'bodyBytes' => $bodies,
		'perRequest' => $perRequest,
		'heaviestTokenLists' => $table,
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
