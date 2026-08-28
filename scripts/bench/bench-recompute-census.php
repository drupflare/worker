<?php

/**
 * Ranks Drupal's repeated semantic work by repeat rate times cost, across one render.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bench/bench-recompute-census.php \
 *       <drupal-root> <route> [n] [--probe=<path to pw-probe.php>]
 *
 * `bench-context-memo.php` found one instance of a general phenomenon: `convertTokensToKeys()` was
 * asked the same question 51 times over 13 distinct inputs, and memoising it took ~9.7% off a
 * render. That 74.5% repeat rate is not plausibly unique to cache contexts -- Drupal recomputes
 * because a generic CMS cannot assume a value is unchanged, and inside one request many of them are.
 *
 * So this censuses the same shape everywhere it is cheap to look: per method, how many times it is
 * called, how many DISTINCT argument lists it is called with, and how much wall clock it spends.
 * Ranked by repeat rate times cost, which is what A1 scored well on -- cost alone would have ranked
 * the renderer first and the renderer is doing the work, not repeating it.
 *
 * The wrappers are GENERATED from the service's runtime class rather than written per service,
 * because `language_manager` is `ConfigurableLanguageManager` on a site with the language module and
 * `LanguageManager` without it, and a hand-written subclass of the wrong one silently fails to swap.
 *
 * Wall clock here is LOCAL and RELATIVE. RULE 0 reserves an absolute CPU figure for a deployed
 * worker's own meter; what a census needs is the ordering.
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
	fwrite(
		STDERR,
		"usage: bench-recompute-census.php <drupal-root> <route> [n] [--probe=<path>]\n",
	);
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
 * Per-method call records for one request.
 */
final class Census
{
	/** "service::method" => ['calls' => int, 'seconds' => float, 'inputs' => [hash => count]] */
	public static array $rows = [];

	public static bool $on = false;

	public static function reset(): void
	{
		self::$rows = [];
	}

	/**
	 * @param string $key
	 *   "service::method".
	 * @param array $args
	 *   The call's arguments, used only to count distinct inputs.
	 * @param float $seconds
	 *   Wall clock spent inside the call.
	 */
	public static function record(string $key, array $args, float $seconds): void
	{
		if (!self::$on) {
			return;
		}
		// serialize() rather than json_encode(): an argument can be an object or a resource, and a
		// census that silently dropped those would under-count distinct inputs and over-state the
		// repeat rate -- the exact direction that would invent a lever
		try {
			$hash = md5(serialize($args));
		} catch (\Throwable $e) {
			$hash = 'unserialisable:' . spl_object_id((object) []);
		}
		self::$rows[$key]['calls'] = (self::$rows[$key]['calls'] ?? 0) + 1;
		self::$rows[$key]['seconds'] = (self::$rows[$key]['seconds'] ?? 0.0) + $seconds;
		self::$rows[$key]['inputs'][$hash] = (self::$rows[$key]['inputs'][$hash] ?? 0) + 1;
	}
}

/**
 * Generates a counting subclass of whatever class a service currently resolves to.
 *
 * @param string $id
 *   The service id.
 * @param string[] $methods
 *   Methods to count.
 *
 * @return string
 *   'swapped', or why it was not.
 */
function census_wrap(string $id, array $methods): string
{
	$container = \Drupal::getContainer();
	try {
		$original = $container->get($id);
	} catch (\Throwable $e) {
		return 'ERR ' . substr($e->getMessage(), 0, 80);
	}
	if (!is_object($original)) {
		return 'not-an-object';
	}
	$base = get_class($original);
	$reflection = new \ReflectionClass($base);
	if ($reflection->isFinal()) {
		return 'final:' . $base;
	}

	$sub = 'Census_' . preg_replace('/[^A-Za-z0-9]/', '_', $id);
	if (!class_exists($sub, false)) {
		$body = '';
		foreach ($methods as $method) {
			if (!$reflection->hasMethod($method)) {
				continue;
			}
			$rm = $reflection->getMethod($method);
			if ($rm->isFinal() || $rm->isStatic() || $rm->isPrivate()) {
				continue;
			}
			// a by-reference parameter cannot be overridden by a variadic, and Renderer::renderRoot()
			// takes one. Skipped rather than special-cased: forwarding a reference through ...$a
			// would silently break the render it is trying to measure
			$byRef = false;
			foreach ($rm->getParameters() as $parameter) {
				$byRef = $byRef || $parameter->isPassedByReference();
			}
			if ($byRef) {
				continue;
			}
			$ret = $rm->getReturnType();
			$retText = $ret === null ? '' : ': ' . census_type($ret);
			$void = $ret !== null && (string) $ret === 'void';
			// a variadic with no declared type is a legal override of any parameter list, which is
			// what lets one generator cover every service here
			$body .=
				"public function {$method}(...\$a){$retText} {\n" .
				"  \$t = microtime(TRUE);\n" .
				'  try { ' .
				($void ? '' : '$r = ') .
				"parent::{$method}(...\$a); " .
				($void ? '' : 'return $r; ') .
				"}\n" .
				"  finally { Census::record('{$id}::{$method}', \$a, microtime(TRUE) - \$t); }\n" .
				"}\n";
		}
		if ($body === '') {
			return 'no-methods';
		}
		eval("class {$sub} extends \\{$base} {\n{$body}\n}");
	}

	try {
		$container->set($id, pw_rewrap($original, $sub));
		return 'swapped';
	} catch (\Throwable $e) {
		return 'ERR ' . substr($e->getMessage(), 0, 80);
	}
}

/** Renders a reflection type back to source text. */
function census_type(\ReflectionType $type): string
{
	if ($type instanceof \ReflectionNamedType) {
		$name = $type->getName();
		$prefix = $type->allowsNull() && $name !== 'mixed' && $name !== 'null' ? '?' : '';
		return $prefix . ($type->isBuiltin() ? $name : '\\' . $name);
	}
	if ($type instanceof \ReflectionUnionType) {
		return implode('|', array_map('census_type', $type->getTypes()));
	}
	if ($type instanceof \ReflectionIntersectionType) {
		return implode('&', array_map('census_type', $type->getTypes()));
	}
	return 'mixed';
}

$kernel = pw_boot_kernel($root, $route, $autoloader);

// warm twice: the first render compiles Twig and fills cache_render, and neither is the traffic a
// steady-state census describes
pw_serve($kernel, $route);
pw_serve($kernel, $route . '?warm=2');

/**
 * What to census.
 *
 * Chosen because each is a value a request asks for repeatedly and which a generic CMS cannot assume
 * is stable, which is the shape A1 turned out to be. Deliberately NOT the renderer: it is expensive
 * because it is doing the work, and a census ranked by cost alone would put it first and say nothing.
 */
$targets = [
	'language_manager' => ['getCurrentLanguage', 'getLanguages', 'getLanguage'],
	'current_user' => ['hasPermission', 'id', 'getRoles', 'isAuthenticated', 'isAnonymous'],
	'path_alias.manager' => ['getAliasByPath', 'getPathByAlias'],
	'theme.manager' => ['getActiveTheme'],
	'router.route_provider' => ['getRouteByName', 'getRoutesByNames'],
	'module_handler' => ['moduleExists', 'getImplementations', 'invokeAll'],
	'config.factory' => ['get', 'getEditable'],
	'entity_type.manager' => ['getStorage', 'getDefinition'],
	'plugin.manager.element_info' => ['getInfo'],
	'cache_tags.invalidator' => ['invalidateTags'],
	// the three expensive subscribers measured per-listener in the report, censused from the
	// inside. The first census read 1.6% recoverable across ten cheap services, which was a fact
	// about WHICH LAYER was censused: those services carry their own static caches, so a repeat
	// costs a property read. The cost is in here
	'placeholder_strategy' => ['processPlaceholders'],
	'html_response.attachments_processor' => ['processAttachments'],
	'renderer' => ['renderRoot', 'renderInIsolation', 'render'],
	'asset.resolver' => ['getCssAssets', 'getJsAssets'],
	'render_cache' => ['get', 'set'],
];

$probes = [];
foreach ($targets as $id => $methods) {
	$probes[$id] = census_wrap($id, $methods);
}

Census::$on = true;
$rounds = [];
for ($i = 0; $i < $n; $i++) {
	Census::reset();
	$started = microtime(true);
	$response = pw_serve($kernel, $route . (str_contains($route, '?') ? '&' : '?') . 'cb=' . $i);
	$totalMs = (microtime(true) - $started) * 1000;

	$rows = [];
	foreach (Census::$rows as $key => $rec) {
		$calls = $rec['calls'];
		$distinct = count($rec['inputs']);
		$ms = $rec['seconds'] * 1000;
		$repeat = $calls > 0 ? ($calls - $distinct) / $calls : 0.0;
		$rows[] = [
			'key' => $key,
			'calls' => $calls,
			'distinct' => $distinct,
			'repeatShare' => round($repeat, 4),
			'ms' => round($ms, 4),
			// what A1 scored well on: cost that is REPEATED, not cost as such
			'recoverableMs' => round($ms * $repeat, 4),
		];
	}
	usort($rows, fn($a, $b) => $b['recoverableMs'] <=> $a['recoverableMs']);
	// THE CONTROL, and without it this instrument lies. A service whose consumer captured it at
	// construction is swapped in the container and never called, so it records nothing -- which
	// reads identically to a service with no repeated work. `placeholder_strategy`,
	// `html_response.attachments_processor`, `asset.resolver` and `render_cache` all did exactly
	// that here. Named separately so a zero is never mistaken for a measurement
	$reached = [];
	foreach (array_keys($targets) as $id) {
		if ($probes[$id] !== 'swapped') {
			continue;
		}
		$seen = false;
		foreach (array_keys(Census::$rows) as $key) {
			$seen = $seen || str_starts_with($key, $id . '::');
		}
		if (!$seen) {
			$reached[] = $id;
		}
	}
	$rounds[] = [
		'totalMs' => round($totalMs, 3),
		'bytes' => strlen((string) $response->getContent()),
		'recoverableMsTotal' => round(array_sum(array_column($rows, 'recoverableMs')), 4),
		'swappedButNeverCalled' => $reached,
		'rows' => $rows,
	];
}

echo json_encode(
	[
		'root' => $root,
		'route' => $route,
		'n' => $n,
		'php' => PHP_VERSION,
		'probes' => $probes,
		'rounds' => $rounds,
	],
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES,
),
	"\n";
