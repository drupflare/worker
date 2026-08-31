<?php

/**
 * What compiling each render subsystem away is worth, measured by replaying a recorded plan.
 *
 * `pw-plan-replay.php` records one render's decorated calls and replays them by position on
 * later renders. Each arm switches one bucket to replay, so the arm's saving is what a
 * perfect compiled plan for that subsystem would return -- a ceiling, not an estimate of any
 * particular implementation.
 *
 * The `all` arm is the ceiling of the whole compiled-render-tree direction on this route.
 *
 * Every arm reports how many bytes its page differs from the base render's, against a
 * base-vs-base control, because `form_build_id` is minted per render and a naive equality
 * check would refuse a correct replay.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bench/bench-plan-arms.php \
 *       <drupal-root> [route] [n] [--probe=<path>]
 */

$root = $argv[1] ?? null;
$route = $argv[2] ?? '/user/login';
$n = (int) ($argv[3] ?? 40);
$probe = null;
foreach ($argv as $a) {
	if (str_starts_with((string) $a, '--probe=')) {
		$probe = substr($a, 8);
	}
}

if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-plan-arms.php <drupal-root> [route] [n]\n");
	exit(1);
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
require_once $probe ?? $root . '/pw-probe.php';
require_once __DIR__ . '/pw-edge-policy.php';
require_once __DIR__ . '/pw-plan-replay.php';

if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}

$kernel = pw_boot_kernel($root, $route, $autoloader);
$policy = pw_edge_page_policy();
$install = pw_install_plan();

$emit = function (object $response): string {
	if (!method_exists($response, 'sendContent')) {
		return (string) $response->getContent();
	}
	$depth = ob_get_level();
	ob_start();
	try {
		$response->sendContent();
		return (string) ob_get_clean();
	} catch (\Throwable $e) {
		while (ob_get_level() > $depth) {
			@ob_end_clean();
		}
		return (string) $response->getContent();
	}
};

$render = function () use ($kernel, $route, $emit): string {
	pw_purge_page_caches();
	return $emit(pw_serve($kernel, $route));
};

for ($i = 0; $i < 4; $i++) {
	$render();
}

// the recording pass
PlanReplay::reset();
PlanReplay::$recording = true;
$baseHtml = $render();
PlanReplay::$recording = false;
$recorded = array_map('count', PlanReplay::$rec);

$buckets = ['assets', 'contexts', 'render_cache', 'theme', 'renderer', 'attach'];
$arms = ['base' => []];
foreach ($buckets as $b) {
	$arms[$b] = [$b];
}
// the pair that tests whether recording the BUBBLE is what a return-value plan was missing
$arms['theme+attach'] = ['theme', 'attach'];
// every bucket that keeps the page intact: the compiled-plan ceiling with a correct page.
// `renderer` is left out because replaying it does not produce one
$arms['plan'] = ['theme', 'attach', 'assets', 'contexts', 'render_cache'];
$arms['all'] = $buckets;

$t = fn(): float => microtime(true) * 1000;
$samples = [];
$last = [];
foreach (array_keys($arms) as $k) {
	$samples[$k] = [];
}

for ($i = 0; $i < $n; $i++) {
	$order = $i % 2 === 0 ? array_keys($arms) : array_reverse(array_keys($arms));
	foreach ($order as $k) {
		PlanReplay::$on = array_fill_keys($arms[$k], true);
		PlanReplay::$missed = [];
		$a = $t();
		$html = $render();
		$samples[$k][] = $t() - $a;
		$last[$k] = ['html' => $html, 'missed' => PlanReplay::$missed];
	}
}
PlanReplay::$on = [];

/**
 * Length-tolerant: the shared prefix and suffix, and what is left between them.
 *
 * A byte-for-byte comparison at equal offsets is useless here -- `form_build_id` is minted
 * per render and one extra byte in it shifts every later offset, so two correct renders read
 * as 2,803 differing bytes. `divergentBytes` is what neither end explains, and it is compared
 * against the base-vs-base control rather than against zero.
 */
$diff = function (string $a, string $b): array {
	$la = strlen($a);
	$lb = strlen($b);
	$min = min($la, $lb);
	$p = 0;
	while ($p < $min && $a[$p] === $b[$p]) {
		$p++;
	}
	$s = 0;
	while ($s < $min - $p && $a[$la - 1 - $s] === $b[$lb - 1 - $s]) {
		$s++;
	}
	return [
		'bytes' => $lb,
		'commonPrefix' => $p,
		'commonSuffix' => $s,
		'divergentBytes' => max($la, $lb) - $p - $s,
	];
};

$controlA = $render();
$controlB = $render();

$stat = function (array $ms): array {
	sort($ms);
	$c = count($ms);
	$q = fn(float $p) => round($ms[(int) floor($p * ($c - 1))], 3);
	return ['n' => $c, 'min' => $q(0.0), 'p25' => $q(0.25), 'median' => $q(0.5)];
};

$out = [
	'root' => $root,
	'route' => $route,
	'n' => $n,
	'php' => PHP_VERSION,
	'policyRulesDropped' => $policy,
	'install' => $install,
	'recordedCalls' => $recorded,
	'baseBytes' => strlen($baseHtml),
	'control' => $diff($controlA, $controlB),
	'arms' => [],
];

foreach ($arms as $k => $on) {
	$out['arms'][$k] =
		$stat($samples[$k]) + [
			'replays' => $on,
			'missed' => $last[$k]['missed'],
		] +
		$diff($controlA, $last[$k]['html']);
}

$m = fn(string $k, string $s) => $out['arms'][$k][$s];
foreach (['min', 'p25', 'median'] as $s) {
	foreach (array_keys($arms) as $k) {
		if ($k === 'base') {
			continue;
		}
		$out['saving'][$s][$k] = round($m('base', $s) - $m($k, $s), 3);
	}
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
