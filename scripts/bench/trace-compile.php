<?php

/**
 * Records the EXECUTION GRAPH of one render, then classifies every node by what it
 * can vary with.
 *
 * The shell census asked which BYTES repeat. This asks which OPERATIONS repeat, which
 * is the quantity a compiled render plan would replay. Output is a machine-readable
 * trace: every renderer node with its cacheability, its exclusive time and its output
 * length; every render-cache lookup; every theme hook and template; every cache-context
 * token list; every event listener that actually ran, timed individually; every SQL
 * statement.
 *
 * Classification is taken from the node's BUBBLED `#cache` metadata, not from a guess
 * about the element type:
 *
 *   static  - no contexts, no tags: identical for every request forever
 *   profile - contexts are all request-profile dimensions (theme, language, url, format)
 *   content - profile contexts plus cache tags: replayable until a tag is invalidated
 *   user    - a user/session context: must stay dynamic
 *   dynamic - a lazy builder or a placeholder: must stay dynamic
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bench/trace-compile.php \
 *       <drupal-root> [route] [--probe=<path>] [--full] [--out=<file>]
 */

$root = $argv[1] ?? null;
$route = $argv[2] ?? '/';
$probe = null;
$outFile = null;
$full = in_array('--full', $argv, true);
// which page-level bins the traced render empties; `--arm=dpc` leaves dynamic_page_cache
// warm, so the trace is of the ASSEMBLY path rather than of a fresh render
$arm = in_array('--arm=dpc', $argv, true)
	? 'dpc'
	: (in_array('--arm=bare', $argv, true)
		? 'bare'
		: 'full');
foreach ($argv as $a) {
	if (str_starts_with((string) $a, '--probe=')) {
		$probe = substr($a, 8);
	}
	if (str_starts_with((string) $a, '--out=')) {
		$outFile = substr($a, 6);
	}
}

if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: trace-compile.php <drupal-root> [route] [--full] [--out=file]\n");
	exit(1);
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
require_once $probe ?? $root . '/pw-probe.php';
require_once __DIR__ . '/pw-edge-policy.php';

if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}

/** the recorder every decorator writes into */
final class Tc
{
	public static bool $on = false;

	/** ordered operation log */
	public static array $ops = [];

	/** [label, startedAt, childSeconds] */
	private static array $stack = [];

	public static int $depth = 0;

	public static function reset(): void
	{
		self::$ops = [];
		self::$stack = [];
		self::$depth = 0;
	}

	public static function enter(): int
	{
		if (!self::$on) {
			return -1;
		}
		self::$stack[] = [microtime(true), 0.0];
		self::$depth++;
		return count(self::$stack) - 1;
	}

	/** closes the frame opened by enter() and appends one op row */
	public static function leave(array $row): void
	{
		if (!self::$on) {
			return;
		}
		$frame = array_pop(self::$stack);
		self::$depth--;
		if ($frame === null) {
			return;
		}
		$dur = microtime(true) - $frame[0];
		$n = count(self::$stack);
		if ($n > 0) {
			self::$stack[$n - 1][1] += $dur;
		}
		$row['depth'] = self::$depth;
		$row['inclUs'] = round($dur * 1e6, 1);
		$row['selfUs'] = round(($dur - $frame[1]) * 1e6, 1);
		self::$ops[] = $row;
	}

	public static function note(array $row): void
	{
		if (!self::$on) {
			return;
		}
		$row['depth'] = self::$depth;
		self::$ops[] = $row;
	}
}

final class TcRenderer extends \Drupal\Core\Render\Renderer
{
	protected function doRender(
		array &$elements,
		\Drupal\Core\Render\RenderContext $context,
	): string|\Drupal\Component\Render\MarkupInterface {
		if (!Tc::$on) {
			return parent::doRender($elements, $context);
		}
		$sig = tc_element_signature($elements);
		Tc::enter();
		try {
			$out = parent::doRender($elements, $context);
			$sig['bytes'] = strlen((string) $out);
			$sig['cacheAfter'] = tc_cache_meta($elements);
			return $out;
		} finally {
			Tc::leave(['op' => 'render.node'] + $sig);
		}
	}

	protected function replacePlaceholders(array &$elements)
	{
		$n = count($elements['#attached']['placeholders'] ?? []);
		Tc::enter();
		try {
			return parent::replacePlaceholders($elements);
		} finally {
			Tc::leave(['op' => 'render.placeholders', 'count' => $n]);
		}
	}

	protected function doCallback($callback_type, $callback, array $args)
	{
		if (!Tc::$on) {
			return parent::doCallback($callback_type, $callback, $args);
		}
		Tc::enter();
		try {
			return parent::doCallback($callback_type, $callback, $args);
		} finally {
			Tc::leave([
				'op' => 'render.callback',
				'kind' => (string) $callback_type,
				'name' => tc_callable_name($callback),
			]);
		}
	}
}

final class TcRenderCache extends \Drupal\Core\Render\PlaceholderingRenderCache
{
	public function get(array $elements)
	{
		Tc::enter();
		$r = false;
		try {
			$r = parent::get($elements);
			return $r;
		} finally {
			Tc::leave([
				'op' => 'render_cache.get',
				'keys' => implode(':', $elements['#cache']['keys'] ?? []),
				'hit' => $r === false ? 0 : 1,
			]);
		}
	}

	public function getMultiple(array $multiple_elements): array
	{
		Tc::enter();
		$r = [];
		try {
			$r = parent::getMultiple($multiple_elements);
			return $r;
		} finally {
			Tc::leave([
				'op' => 'render_cache.getMultiple',
				'asked' => count($multiple_elements),
				'hits' => count(array_filter($r, fn($v) => $v !== false)),
			]);
		}
	}

	public function set(array &$elements, array $pre_bubbling_elements)
	{
		Tc::enter();
		try {
			return parent::set($elements, $pre_bubbling_elements);
		} finally {
			Tc::leave([
				'op' => 'render_cache.set',
				'keys' => implode(':', $pre_bubbling_elements['#cache']['keys'] ?? []),
			]);
		}
	}
}

final class TcCacheContexts extends \Drupal\Core\Cache\Context\CacheContextsManager
{
	public function convertTokensToKeys(array $context_tokens)
	{
		Tc::enter();
		try {
			return parent::convertTokensToKeys($context_tokens);
		} finally {
			Tc::leave([
				'op' => 'cache_contexts.convert',
				'tokens' => implode(',', $context_tokens),
			]);
		}
	}

	public function optimizeTokens(array $context_tokens)
	{
		Tc::enter();
		try {
			return parent::optimizeTokens($context_tokens);
		} finally {
			Tc::leave([
				'op' => 'cache_contexts.optimize',
				'tokens' => implode(',', $context_tokens),
			]);
		}
	}
}

final class TcThemeManager extends \Drupal\Core\Theme\ThemeManager
{
	private array $tcEngines = [];

	public function render($hook, array $variables)
	{
		Tc::enter();
		try {
			return parent::render($hook, $variables);
		} finally {
			Tc::leave([
				'op' => 'theme.render',
				'hook' => is_array($hook) ? implode('|', $hook) : (string) $hook,
			]);
		}
	}

	public function getThemeEngine(string $name): ?\Drupal\Core\Theme\ThemeEngineInterface
	{
		if (!array_key_exists($name, $this->tcEngines)) {
			$inner = parent::getThemeEngine($name);
			$this->tcEngines[$name] = $inner === null ? null : new TcThemeEngine($inner);
		}
		return $this->tcEngines[$name];
	}
}

final class TcThemeEngine implements \Drupal\Core\Theme\ThemeEngineInterface
{
	public function __construct(private \Drupal\Core\Theme\ThemeEngineInterface $inner) {}

	public function theme(array $existing, string $type, string $theme, string $path): ?array
	{
		return $this->inner->theme($existing, $type, $theme, $path);
	}

	public function renderTemplate(
		string $template_file,
		array $variables,
	): string|\Drupal\Component\Render\MarkupInterface {
		Tc::enter();
		try {
			return $this->inner->renderTemplate($template_file, $variables);
		} finally {
			Tc::leave(['op' => 'twig.execute', 'template' => basename($template_file)]);
		}
	}
}

final class TcAssetResolver extends \Drupal\Core\Asset\AssetResolver
{
	public function getCssAssets(
		\Drupal\Core\Asset\AttachedAssetsInterface $assets,
		$optimize,
		?\Drupal\Core\Language\LanguageInterface $language = null,
	) {
		Tc::enter();
		$r = [];
		try {
			$r = parent::getCssAssets($assets, $optimize, $language);
			return $r;
		} finally {
			Tc::leave([
				'op' => 'assets.css',
				'libraries' => implode(',', $assets->getLibraries()),
				'files' => count($r),
			]);
		}
	}

	public function getJsAssets(
		\Drupal\Core\Asset\AttachedAssetsInterface $assets,
		$optimize,
		?\Drupal\Core\Language\LanguageInterface $language = null,
	) {
		Tc::enter();
		$r = [[], []];
		try {
			$r = parent::getJsAssets($assets, $optimize, $language);
			return $r;
		} finally {
			Tc::leave([
				'op' => 'assets.js',
				'libraries' => implode(',', $assets->getLibraries()),
				'files' => count($r[0] ?? []) + count($r[1] ?? []),
			]);
		}
	}
}

final class TcDispatcher extends \Symfony\Component\EventDispatcher\EventDispatcher
{
	public function dispatch(object $event, ?string $eventName = null): object
	{
		Tc::enter();
		try {
			return parent::dispatch($event, $eventName);
		} finally {
			Tc::leave([
				'op' => 'event.dispatch',
				'name' => (string) ($eventName ?? get_class($event)),
			]);
		}
	}

	protected function callListeners(iterable $listeners, string $eventName, object $event): void
	{
		if (!Tc::$on) {
			parent::callListeners($listeners, $eventName, $event);
			return;
		}
		$stoppable = $event instanceof \Psr\EventDispatcher\StoppableEventInterface;
		foreach ($listeners as $listener) {
			if ($stoppable && $event->isPropagationStopped()) {
				break;
			}
			Tc::enter();
			try {
				$listener($event, $eventName, $this);
			} finally {
				Tc::leave([
					'op' => 'event.listener',
					'name' => $eventName,
					'listener' => tc_callable_name($listener),
				]);
			}
		}
	}
}

function tc_callable_name($callback): string
{
	if (is_string($callback)) {
		return $callback;
	}
	if (is_array($callback)) {
		return (is_object($callback[0]) ? get_class($callback[0]) : (string) $callback[0]) .
			'::' .
			$callback[1];
	}
	if ($callback instanceof \Closure) {
		$r = new \ReflectionFunction($callback);
		$scope = $r->getClosureScopeClass();
		// a listener registered as a service method arrives as a closure bound to it
		$this_ = $r->getClosureThis();
		if ($this_ !== null) {
			return get_class($this_) . '::' . $r->getName();
		}
		return ($scope ? $scope->getName() . '::' : '') . $r->getName();
	}
	if (is_object($callback)) {
		return get_class($callback) . '::__invoke';
	}
	return 'unknown';
}

function tc_cache_meta(array $e): array
{
	$c = $e['#cache'] ?? [];
	return [
		'contexts' => implode(',', $c['contexts'] ?? []),
		'tags' => implode(',', $c['tags'] ?? []),
		'maxAge' => array_key_exists('max-age', $c) ? (int) $c['max-age'] : null,
		'keys' => implode(':', $c['keys'] ?? []),
	];
}

function tc_element_signature(array $e): array
{
	$kind = 'array';
	$name = '';
	if (isset($e['#theme'])) {
		$kind = 'theme';
		$name = is_array($e['#theme']) ? implode('|', $e['#theme']) : (string) $e['#theme'];
	} elseif (isset($e['#type'])) {
		$kind = 'type';
		$name = (string) $e['#type'];
	} elseif (isset($e['#markup'])) {
		$kind = 'markup';
	} elseif (isset($e['#plain_text'])) {
		$kind = 'plain_text';
	}
	return [
		'kind' => $kind,
		'name' => $name,
		'lazy' => isset($e['#lazy_builder']) ? 1 : 0,
		'createPlaceholder' => !empty($e['#create_placeholder']) ? 1 : 0,
		'pre' => count($e['#pre_render'] ?? []),
		'post' => count($e['#post_render'] ?? []),
		'access' =>
			array_key_exists('#access', $e) || array_key_exists('#access_callback', $e) ? 1 : 0,
		'children' => count(\Drupal\Core\Render\Element::children($e)),
		'cacheBefore' => tc_cache_meta($e),
	];
}

/** request-profile dimensions: known to the boundary, so a plan can key on them */
const TC_PROFILE_CONTEXTS = [
	'theme',
	'languages',
	'languages:language_interface',
	'languages:language_content',
	'languages:language_url',
	'url',
	'url.site',
	'url.path',
	'url.path.is_front',
	'url.path.parent',
	'url.query_args',
	'url.query_args:_wrapper_format',
	'request_format',
	'ip',
	'headers',
	'timezone',
];

const TC_USER_PREFIXES = ['user', 'session', 'route.book_navigation', 'cookies'];

function tc_classify(array $row): string
{
	if (!empty($row['lazy']) || !empty($row['createPlaceholder'])) {
		return 'dynamic';
	}
	$meta =
		$row['cacheAfter'] ??
		($row['cacheBefore'] ?? ['contexts' => '', 'tags' => '', 'maxAge' => null]);
	if (($meta['maxAge'] ?? null) === 0) {
		return 'dynamic';
	}
	$contexts = array_filter(explode(',', (string) $meta['contexts']));
	foreach ($contexts as $c) {
		$head = explode(':', $c)[0];
		if (in_array($head, TC_USER_PREFIXES, true)) {
			return 'user';
		}
		if (
			!in_array($c, TC_PROFILE_CONTEXTS, true) &&
			!in_array($head, TC_PROFILE_CONTEXTS, true)
		) {
			return 'unknown';
		}
	}
	$tags = array_filter(explode(',', (string) $meta['tags']));
	if ($tags) {
		return 'content';
	}
	return $contexts ? 'profile' : 'static';
}

function tc_install(): array
{
	$container = \Drupal::getContainer();
	$map = [
		'cache_contexts_manager' => 'TcCacheContexts',
		'theme.manager' => 'TcThemeManager',
		'asset.resolver' => 'TcAssetResolver',
		'render_cache' => 'TcRenderCache',
		'renderer' => 'TcRenderer',
		'event_dispatcher' => 'TcDispatcher',
	];
	$rp = new \ReflectionProperty(
		\Drupal\Component\DependencyInjection\Container::class,
		'services',
	);
	$already = $rp->getValue($container);
	$out = [];
	foreach ($map as $id => $cls) {
		try {
			$original = $container->get($id);
			if ($original instanceof $cls) {
				$out[$id] = 'already';
				continue;
			}
			$container->set($id, pw_rewrap($original, $cls));
			$out[$id] = isset($already[$id]) ? 'preexisting' : 'swapped';
		} catch (\Throwable $e) {
			$out[$id] = 'ERR ' . get_class($e) . ': ' . substr($e->getMessage(), 0, 120);
		}
	}
	return $out;
}

$kernel = pw_boot_kernel($root, $route, $autoloader);
$policy = pw_edge_page_policy();
$probes = tc_install();

// warm: templates compiled, statics filled, render bin populated, DPC populated
for ($i = 0; $i < 3; $i++) {
	pw_purge_page_caches();
	pw_serve($kernel, $route);
}

$traceRoute = $route;
if ($arm === 'full') {
	pw_purge_page_caches();
} elseif ($arm === 'dpc') {
	// leave dynamic_page_cache warm; only page_cache is emptied
	pw_purge_page_cache();
} else {
	$traceRoute = '/session/token';
}
Tc::$on = true;
Tc::reset();
PwDb::start();
$t0 = microtime(true);
$resp = pw_serve($kernel, $traceRoute);
$traceMs = (microtime(true) - $t0) * 1000;
PwDb::stop();
Tc::$on = false;

$ops = Tc::$ops;

$byOp = [];
foreach ($ops as $r) {
	$k = $r['op'];
	$byOp[$k]['calls'] = ($byOp[$k]['calls'] ?? 0) + 1;
	$byOp[$k]['selfUs'] = round(($byOp[$k]['selfUs'] ?? 0) + ($r['selfUs'] ?? 0), 1);
}
uasort($byOp, fn($a, $b) => $b['selfUs'] <=> $a['selfUs']);

// render nodes, classified
$nodes = array_values(array_filter($ops, fn($r) => $r['op'] === 'render.node'));
$classes = [];
foreach ($nodes as &$node) {
	$node['class'] = tc_classify($node);
	$c = $node['class'];
	$classes[$c]['nodes'] = ($classes[$c]['nodes'] ?? 0) + 1;
	$classes[$c]['selfUs'] = round(($classes[$c]['selfUs'] ?? 0) + $node['selfUs'], 1);
	$classes[$c]['bytes'] = ($classes[$c]['bytes'] ?? 0) + ($node['bytes'] ?? 0);
}
unset($node);

// listeners, so the events bucket stops being one number
$listeners = [];
foreach ($ops as $r) {
	if ($r['op'] !== 'event.listener') {
		continue;
	}
	$k = $r['name'] . ' -> ' . $r['listener'];
	$listeners[$k]['calls'] = ($listeners[$k]['calls'] ?? 0) + 1;
	$listeners[$k]['inclUs'] = round(($listeners[$k]['inclUs'] ?? 0) + $r['inclUs'], 1);
	$listeners[$k]['selfUs'] = round(($listeners[$k]['selfUs'] ?? 0) + $r['selfUs'], 1);
}
uasort($listeners, fn($a, $b) => $b['selfUs'] <=> $a['selfUs']);

$themeHooks = [];
$templates = [];
$contextLists = [];
foreach ($ops as $r) {
	if ($r['op'] === 'theme.render') {
		$themeHooks[$r['hook']] = ($themeHooks[$r['hook']] ?? 0) + 1;
	}
	if ($r['op'] === 'twig.execute') {
		$templates[$r['template']] = ($templates[$r['template']] ?? 0) + 1;
	}
	if ($r['op'] === 'cache_contexts.convert') {
		$contextLists[$r['tokens']] = ($contextLists[$r['tokens']] ?? 0) + 1;
	}
}
arsort($themeHooks);
arsort($templates);
arsort($contextLists);

$out = [
	'root' => $root,
	'route' => $traceRoute,
	'arm' => $arm,
	'php' => PHP_VERSION,
	'sapi' => PHP_SAPI,
	'policyRulesDropped' => $policy,
	'probes' => $probes,
	'facts' => pw_response_facts($resp),
	'tracedRenderMs' => round($traceMs, 3),
	'opsRecorded' => count($ops),
	'byOp' => $byOp,
	'renderNodes' => [
		'total' => count($nodes),
		'byClass' => $classes,
	],
	'themeHooks' => $themeHooks,
	'templates' => $templates,
	'contextLists' => $contextLists,
	'listeners' => $listeners,
	'db' => PwDb::report(20),
];

if ($full) {
	$out['nodes'] = $nodes;
	$out['ops'] = $ops;
}

$json = json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
if ($outFile) {
	file_put_contents($outFile, $json . "\n");
	echo "wrote $outFile (" . strlen($json) . " bytes)\n";
} else {
	echo $json, "\n";
}
