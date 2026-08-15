<?php

/**
 * Renders one route in a fresh process, with or without $kernel->terminate(),
 * so the cache rows the terminate path writes can be diffed from the outside.
 *
 * WHY A FRESH PROCESS PER ARM. CacheCollector keeps its accumulated entries in
 * the service instance, so a second render on the same kernel is served from
 * memory whether or not anything was ever persisted. The defect only shows
 * across a process boundary, which is exactly what an isolate restart is.
 *
 * Query counting does NOT use Database::startLog() -- that attaches a logger to
 * every future connection and cannot be undone. Instead a \PDOStatement
 * subclass is installed on the live client connection via ATTR_STATEMENT_CLASS
 * and counts execute() calls. Transaction control (BEGIN/COMMIT, issued on the
 * PDO object rather than a statement) is therefore excluded.
 *
 *   php -d opcache.enable_cli=0 -d xdebug.mode=off scripts/probe/probe-terminate.php \
 *       <drupal-root> [route] [--terminate] [--count] [--n=1] [--run-cron]
 */

use Drupal\Core\Database\Database;
use Drupal\Core\DrupalKernel;
use Drupal\Core\Site\Settings;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\HttpKernelInterface;

// #region counting statement
final class ProbeCountingStatement extends \PDOStatement
{
	public static int $count = 0;

	public static array $queries = [];

	public static bool $record = false;

	protected function __construct() {}

	public function execute(?array $params = null): bool
	{
		self::$count++;
		if (self::$record) {
			self::$queries[] = $this->queryString;
		}
		return parent::execute($params);
	}
}
// #endregion

$root = $argv[1] ?? null;
$route = $argv[2] ?? '/';
if (!$root || !is_dir($root)) {
	fwrite(
		STDERR,
		"usage: probe-terminate.php <drupal-root> [route] [--terminate] [--count] [--n=1] [--run-cron]\n",
	);
	exit(2);
}
$terminate = in_array('--terminate', $argv, true);
$count = in_array('--count', $argv, true);
$record = in_array('--record', $argv, true);
$runCron = in_array('--run-cron', $argv, true);
$n = 1;
$warmup = 0;
foreach ($argv as $a) {
	if (str_starts_with((string) $a, '--n=')) {
		$n = max(1, (int) substr($a, 4));
	}
	if (str_starts_with((string) $a, '--warmup=')) {
		$warmup = max(0, (int) substr($a, 9));
	}
}

$root = realpath($root);
chdir($root);
$autoloader = require_once $root . '/autoload.php';

// the shipped tree is Fiber-patched for emscripten; native PHP has real Fibers
if (!class_exists('PhpWasmSyncFiber', false)) {
	class_alias(\Fiber::class, 'PhpWasmSyncFiber');
}

$ms = fn() => microtime(true) * 1000;

/**
 * One fresh kernel, one handle(), optionally one terminate().
 */
$serve = function (string $path) use (
	$root,
	$autoloader,
	$terminate,
	$count,
	$record,
	$runCron,
): array {
	$req = Request::create($path, 'GET');
	$kernel = new DrupalKernel('prod', $autoloader);
	DrupalKernel::bootEnvironment();
	$sitePath = DrupalKernel::findSitePath($req);
	$kernel->setSitePath($sitePath);
	Settings::initialize($root, $sitePath, $autoloader);

	$tBoot0 = microtime(true);
	$kernel->boot();
	$tBoot1 = microtime(true);

	// installed AFTER boot so container-build queries are excluded, and only
	// when asked, because the extra userland frame is not free
	if ($count) {
		ProbeCountingStatement::$count = 0;
		ProbeCountingStatement::$queries = [];
		ProbeCountingStatement::$record = $record;
		$pdo = Database::getConnection()->getClientConnection();
		$pdo->setAttribute(\PDO::ATTR_STATEMENT_CLASS, [ProbeCountingStatement::class, []]);
	}

	// wall time on a laptop swings 2x on scheduling alone, so CPU is the figure
	// the comparison rests on; both are native, neither is an edge number
	$cpu = function (): float {
		$r = getrusage();
		return $r['ru_utime.tv_sec'] +
			$r['ru_utime.tv_usec'] / 1e6 +
			($r['ru_stime.tv_sec'] + $r['ru_stime.tv_usec'] / 1e6);
	};

	$cH0 = $cpu();
	$tH0 = microtime(true);
	$response = $kernel->handle($req, HttpKernelInterface::MAIN_REQUEST, false);
	$tH1 = microtime(true);
	$cH1 = $cpu();

	$handleQueries = $count ? ProbeCountingStatement::$count : null;

	$cT0 = $cpu();
	$tT0 = microtime(true);
	if ($terminate) {
		$kernel->terminate($req, $response);
	}
	$tT1 = microtime(true);
	$cT1 = $cpu();

	$cronMs = null;
	$cronCpuMs = null;
	$cronQueries = null;
	$cronPerModule = [];
	if ($runCron) {
		$q0 = ProbeCountingStatement::$count;
		$k0 = $cpu();
		$c0 = microtime(true);
		\Drupal::service('cron')->run();
		$cronMs = round((microtime(true) - $c0) * 1000, 2);
		$cronCpuMs = round(($cpu() - $k0) * 1000, 2);
		$cronQueries = ProbeCountingStatement::$count - $q0;
		// Cron::invokeCronHandlers() already wraps every implementation in
		// Timer::start('cron_<module>'), so the per-module split is free
		$t = new \ReflectionProperty(\Drupal\Component\Utility\Timer::class, 'timers');
		$t->setAccessible(true);
		foreach ($t->getValue() as $name => $info) {
			if (str_starts_with((string) $name, 'cron_')) {
				$cronPerModule[substr((string) $name, 5)] = $info['time'] ?? null;
			}
		}
	}

	$body = (string) $response->getContent();

	return [
		'path' => $path,
		'status' => $response->getStatusCode(),
		'bytes' => strlen($body),
		'bodyHash' => substr(hash('sha256', $body), 0, 12),
		// a MISS wearing a HIT's label has burned this project before
		'x-drupal-cache' => $response->headers->get('x-drupal-cache') ?: '(absent)',
		'x-drupal-dynamic-cache' => $response->headers->get('x-drupal-dynamic-cache') ?: '(absent)',
		'bootMs' => round(($tBoot1 - $tBoot0) * 1000, 2),
		'handleMs' => round(($tH1 - $tH0) * 1000, 2),
		'handleCpuMs' => round(($cH1 - $cH0) * 1000, 2),
		'terminateMs' => round(($tT1 - $tT0) * 1000, 2),
		'terminateCpuMs' => round(($cT1 - $cT0) * 1000, 2),
		'cronMs' => $cronMs,
		'cronCpuMs' => $cronCpuMs,
		'cronQueries' => $cronQueries,
		'cronPerModuleMs' => $cronPerModule,
		'handleQueries' => $handleQueries,
		'totalQueries' => $count ? ProbeCountingStatement::$count : null,
		'terminateQueries' => $count ? ProbeCountingStatement::$count - $handleQueries : null,
	];
};

// read cron_last straight off the key_value table so instantiating the state
// collector is not itself part of the measurement
$cronLast = function () use ($root): ?string {
	$db = $root . '/sites/default/files/.sqlite';
	$pdo = new \PDO('sqlite:' . $db);
	$row = $pdo
		->query("select value from key_value where collection='state' and name='system.cron_last'")
		->fetchColumn();
	return $row === false ? null : (string) unserialize((string) $row);
};

$out = [
	'sapi' => PHP_SAPI,
	'terminate' => $terminate,
	'runCron' => $runCron,
	'cronLastBefore' => $cronLast(),
	'renders' => [],
];

// discarded renders, so the measured ones are not paying to autoload and parse
// ~2,000 core files with opcache off -- that cost dominates and hides the signal
for ($i = 0; $i < $warmup; $i++) {
	$out['warmup'][] = $serve($route);
}

for ($i = 0; $i < $n; $i++) {
	// same route every time: the DB is reset between arms by the driver, so a
	// cache buster would only add a variable
	$out['renders'][] = $serve($route);
}

$out['cronLastAfter'] = $cronLast();
if ($record) {
	$out['queries'] = ProbeCountingStatement::$queries;
}

echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
