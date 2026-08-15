<?php

/**
 * Makes the packed Drupal container definition portable, so the edge gets a cache HIT.
 *
 *   php scripts/bake-container.php [--db=assets/drupal/site.sqlite] [--apply]
 *
 * `DrupalKernel::getContainerCacheKey()` (:962) keys the compiled container on
 * `PHP_OS` and on the absolute paths in `Settings::get('container_yamls')`. Both are properties of
 * the machine that BUILT the pack, so every packed row says `Darwin` and carries a build path, and
 * the edge -- which is Linux with the tree mounted at `/drupal` -- asks for a key that cannot
 * possibly be there. The miss costs the whole container compile on every single boot: 70 Symfony
 * passes at 1,571 ms, an extension scan at 579 ms, 2,788 ms of local wall clock in total, against a
 * measured 4-5 ms when the row is found.
 *
 * The definition cannot simply be re-keyed. `%app.root%` is resolved at DUMP time, so the build path
 * is baked into service argument lists roughly two dozen times over -- re-keying alone would ship a
 * container pointing at a directory that does not exist on the edge. So this rewrites the paths
 * first, then stores the result under the key the runtime actually computes.
 *
 * It REUSES an already-compiled definition rather than compiling a fresh one:
 * the packed row is known to correspond to the packed tree, and recompiling here would introduce a
 * second source of truth that could disagree with it.
 *
 * Dry by default. `--apply` is what writes.
 */

const RUNTIME_ROOT = '/drupal';
const RUNTIME_OS = 'Linux';

$db = 'assets/drupal/site.sqlite';
$apply = false;
foreach ($argv as $a) {
	if (str_starts_with((string) $a, '--db=')) {
		$db = substr($a, 5);
	}
	if ($a === '--apply') {
		$apply = true;
	}
}
if (!is_file($db)) {
	fwrite(STDERR, "no database at {$db}\n");
	exit(1);
}

$pdo = new PDO('sqlite:' . $db);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$rows = $pdo->query('SELECT cid, data FROM cache_container')->fetchAll(PDO::FETCH_ASSOC);
if (!$rows) {
	fwrite(STDERR, "no cache_container rows in {$db}\n");
	exit(1);
}

/** the versions hash and the yaml list live inside the cid, so parse it out */
function parseCid(string $cid): ?array
{
	// service_container:<env>:<hash>:<deployment>:<os>:<serialized yamls>
	if (!preg_match('/^service_container:([^:]*):([^:]*):([^:]*):([^:]*):(a:.*)$/', $cid, $m)) {
		return null;
	}
	return ['env' => $m[1], 'hash' => $m[2], 'deploy' => $m[3], 'os' => $m[4], 'yamls' => $m[5]];
}

/** rewrites every string under $from to $to, recursively, counting what it touched */
function rewritePaths(mixed $value, string $from, string $to, int &$count): mixed
{
	if (is_string($value)) {
		if (str_contains($value, $from)) {
			$count += substr_count($value, $from);
			return str_replace($from, $to, $value);
		}
		return $value;
	}
	if (is_array($value)) {
		$out = [];
		foreach ($value as $k => $v) {
			$newKey = is_string($k) && str_contains($k, $from) ? str_replace($from, $to, $k) : $k;
			if ($newKey !== $k) {
				$count += substr_count((string) $k, $from);
			}
			$out[$newKey] = rewritePaths($v, $from, $to, $count);
		}
		return $out;
	}
	// objects are left alone: a Definition graph does not survive this dump format, and anything
	// object-shaped here would mean the row is not a plain dumped array
	return $value;
}

$best = null;
foreach ($rows as $r) {
	$parts = parseCid($r['cid']);
	if (!$parts) {
		continue;
	}
	$yamls = @unserialize($parts['yamls']);
	if (!is_array($yamls) || !$yamls) {
		continue;
	}
	// prefer the row whose yaml path is a real absolute build path; a relative './sites/...' row
	// carries the same definition but tells us nothing about the root to rewrite
	$path = (string) reset($yamls);
	if (!str_starts_with($path, '/')) {
		continue;
	}
	$root = substr($path, 0, strrpos($path, '/sites/'));
	if ($root === '' || $root === RUNTIME_ROOT) {
		continue;
	}
	$best = ['cid' => $r['cid'], 'data' => $r['data'], 'parts' => $parts, 'root' => $root];
	break;
}

/** every distinct versions hash in the table; the runtime computes exactly one and we cannot tell
 *  which from here, so all of them get a portable row */
$hashes = [];
foreach ($rows as $r) {
	$parts = parseCid($r['cid']);
	if ($parts && $parts['hash'] !== '') {
		$hashes[$parts['hash']] = true;
	}
}
$hashes = array_keys($hashes);

if (!$best) {
	fwrite(STDERR, "no row with an absolute build path found; nothing to make portable\n");
	exit(1);
}

$definition = unserialize($best['data']);
if (!is_array($definition)) {
	fwrite(STDERR, "row {$best['cid']} did not unserialize to an array\n");
	exit(1);
}

$count = 0;
$portable = rewritePaths($definition, $best['root'], RUNTIME_ROOT, $count);

// nothing may reference the build machine afterwards, and a leftover is a silent breakage: the
// service would be constructed with a path that does not exist and fail at first use, not at boot
$reserialized = serialize($portable);
$leftover = substr_count($reserialized, $best['root']);

$targets = [];
foreach ($hashes as $hash) {
	$targets[] = implode(':', [
		'service_container',
		$best['parts']['env'],
		$hash,
		$best['parts']['deploy'],
		RUNTIME_OS,
		serialize([RUNTIME_ROOT . '/sites/default/services.yml']),
	]);
}

$report = [
	'db' => $db,
	'sourceCid' => $best['cid'],
	'buildRoot' => $best['root'],
	'pathsRewritten' => $count,
	'buildRootLeftover' => $leftover,
	'sourceBytes' => strlen($best['data']),
	'portableBytes' => strlen($reserialized),
	'versionsHashes' => $hashes,
	'targetCids' => $targets,
	'applied' => false,
];

if ($leftover !== 0) {
	$report['error'] = "refusing: {$leftover} references to the build root survived the rewrite";
	echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
	exit(1);
}

if ($apply) {
	$stmt = $pdo->prepare(
		'INSERT OR REPLACE INTO cache_container (cid, data, expire, created, serialized, tags, checksum)
		 VALUES (?, ?, -1, ?, 1, \'\', \'0\')',
	);
	$report['readback'] = [];
	foreach ($targets as $cid) {
		$stmt->execute([$cid, $reserialized, microtime(true)]);
		$len = (int) $pdo
			->query('SELECT LENGTH(data) FROM cache_container WHERE cid = ' . $pdo->quote($cid))
			->fetchColumn();
		$report['readback'][$cid] = ['bytes' => $len, 'matches' => $len === strlen($reserialized)];
	}
	$report['applied'] = true;
}

echo json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
