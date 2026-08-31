<?php

/**
 * Prices the FIXED FLOOR under a render: what one request costs before any of the
 * render pipeline runs.
 *
 * Every compiled-render-plan lever is bounded by this. If serving a request that
 * renders nothing already costs most of the budget, a compiled render tree cannot
 * reach the target no matter how good it is, and that is a mechanism-level answer
 * rather than another A/B.
 *
 * Arms, on ONE warm kernel, interleaved round-robin so no arm sits later in a
 * warming ramp:
 *
 *   full  - page + dynamic_page_cache purged; the whole pipeline runs
 *   dpc   - page purged only; dynamic_page_cache answers, render arrays reused
 *   pgc   - nothing purged; page_cache answers, no render at all
 *   bare  - a route whose controller returns a Response directly (no render array)
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/bench/bench-floor-ladder.php \
 *       <drupal-root> [route] [n] [--bare=/robots.txt] [--probe=<path>]
 */

$root = $argv[1] ?? null;
$route = $argv[2] ?? '/';
$n = (int) ($argv[3] ?? 40);
$bare = '/session/token';
$probe = null;
foreach ($argv as $a) {
	if (str_starts_with((string) $a, '--probe=')) {
		$probe = substr($a, 8);
	}
	if (str_starts_with((string) $a, '--bare=')) {
		$bare = substr($a, 7);
	}
}

if (!$root || !is_dir($root)) {
	fwrite(STDERR, "usage: bench-floor-ladder.php <drupal-root> [route] [n] [--bare=path]\n");
	exit(1);
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';
require_once $probe ?? $root . '/pw-probe.php';

if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(Fiber::class, 'PhpWasmSyncFiber');
}

$kernel = pw_boot_kernel($root, $route, $autoloader);

require_once __DIR__ . '/pw-edge-policy.php';
$policyEdit = pw_edge_page_policy();

$t = fn(): float => microtime(true) * 1000;

$purgePage = function (): void {
	try {
		\Drupal::cache('page')->deleteAll();
	} catch (\Throwable $e) {
	}
};
$purgeDpc = function (): void {
	try {
		\Drupal::cache('dynamic_page_cache')->deleteAll();
	} catch (\Throwable $e) {
	}
};

// warm every arm's caches before the clock starts on any of them
for ($i = 0; $i < 4; $i++) {
	$purgePage();
	$purgeDpc();
	pw_serve($kernel, $route);
	pw_serve($kernel, $route);
	pw_serve($kernel, $bare);
}

$arms = [
	'full' => function () use ($kernel, $route, $purgePage, $purgeDpc) {
		$purgePage();
		$purgeDpc();
		return pw_serve($kernel, $route);
	},
	'dpc' => function () use ($kernel, $route, $purgePage) {
		$purgePage();
		return pw_serve($kernel, $route);
	},
	'pgc' => function () use ($kernel, $route) {
		return pw_serve($kernel, $route);
	},
	'bare' => function () use ($kernel, $bare) {
		return pw_serve($kernel, $bare);
	},
];

$samples = [];
$facts = [];
foreach (array_keys($arms) as $k) {
	$samples[$k] = [];
}

$order = array_keys($arms);
for ($i = 0; $i < $n; $i++) {
	// reverse the arm order on odd rounds so no arm is always first after a purge
	$round = $i % 2 === 0 ? $order : array_reverse($order);
	foreach ($round as $k) {
		$a = $t();
		$resp = $arms[$k]();
		$samples[$k][] = $t() - $a;
		if (!isset($facts[$k])) {
			$facts[$k] = pw_response_facts($resp);
		}
	}
}

$stat = function (array $ms): array {
	sort($ms);
	$c = count($ms);
	$q = fn(float $p) => round($ms[(int) floor($p * ($c - 1))], 3);
	return [
		'n' => $c,
		'min' => $q(0.0),
		'p25' => $q(0.25),
		'median' => $q(0.5),
		'p75' => $q(0.75),
	];
};

$out = [
	'root' => $root,
	'route' => $route,
	'bare' => $bare,
	'n' => $n,
	'php' => PHP_VERSION,
	'sapi' => PHP_SAPI,
	'policyRulesDropped' => $policyEdit,
];
foreach ($samples as $k => $ms) {
	$out['arms'][$k] = $stat($ms) + ['facts' => $facts[$k]];
}

$m = fn(string $k, string $s) => $out['arms'][$k][$s];
foreach (['min', 'p25', 'median'] as $s) {
	$out['deltas'][$s] = [
		'render_pipeline (full-dpc)' => round($m('full', $s) - $m('dpc', $s), 3),
		'dpc_assembly (dpc-pgc)' => round($m('dpc', $s) - $m('pgc', $s), 3),
		'page_cache_serve (pgc-bare)' => round($m('pgc', $s) - $m('bare', $s), 3),
		'kernel_floor (bare)' => $m('bare', $s),
		'floor_share_of_full' => round($m('bare', $s) / max(0.001, $m('full', $s)), 4),
	];
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
