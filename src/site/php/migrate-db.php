<?php
// __CFW_HOST_HELPERS__

$out = ['ok' => false];
$path = '/drupal/sites/default/files/.sqlite';
if (!file_exists($path)) {
	echo json_encode(['ok' => false, 'error' => 'no packed database at ' . $path]);
	return;
}

$t0 = microtime(true) * 1000;
$pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);

$rewrite = function (string $sql): string {
	// no user-defined collations on the host; ASCII folding is the documented gap
	return str_ireplace('NOCASE_UTF8', 'NOCASE', $sql);
};

$objects = $pdo
	->query(
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END",
	)
	->fetchAll(PDO::FETCH_ASSOC);

$ddl = [];
$tables = [];
foreach ($objects as $o) {
	if (str_starts_with($o['name'], 'sqlite_')) {
		continue;
	}
	$ddl[] = ['sql' => $rewrite($o['sql']), 'params' => []];
	if ($o['type'] === 'table') {
		$tables[] = $o['name'];
	}
}

// schema first, in one transaction, so a partial schema cannot survive
$schemaResult = cfw_txn($ddl, true);
if (($schemaResult['ok'] ?? false) !== true) {
	echo json_encode([
		'ok' => false,
		'stage' => 'schema',
		'error' => $schemaResult['error'] ?? 'unknown',
		'statements' => count($ddl),
	]);
	return;
}

$rowsCopied = 0;
$batches = 0;
$perTable = [];
$batchSize = 200;
foreach ($tables as $table) {
	$cols = $pdo->query('PRAGMA table_info("' . $table . '")')->fetchAll(PDO::FETCH_ASSOC);
	$names = array_map(function (array $c): string {
		return $c['name'];
	}, $cols);
	if (!$names) {
		continue;
	}
	$quoted = implode(
		', ',
		array_map(function (string $n): string {
			return '"' . $n . '"';
		}, $names),
	);
	$marks = implode(', ', array_fill(0, count($names), '?'));
	$insert = 'INSERT INTO "' . $table . '" (' . $quoted . ') VALUES (' . $marks . ')';

	$stmt = $pdo->query('SELECT ' . $quoted . ' FROM "' . $table . '"');
	$pending = [];
	$count = 0;
	while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
		$params = [];
		foreach ($names as $n) {
			$params[] = $row[$n];
		}
		$pending[] = ['sql' => $insert, 'params' => $params];
		$count++;
		if (count($pending) >= $batchSize) {
			$r = cfw_txn($pending, true);
			$batches++;
			if (($r['ok'] ?? false) !== true) {
				echo json_encode([
					'ok' => false,
					'stage' => 'rows',
					'table' => $table,
					'error' => $r['error'] ?? 'unknown',
					'rowsCopied' => $rowsCopied,
				]);
				return;
			}
			$rowsCopied += count($pending);
			$pending = [];
		}
	}
	if ($pending) {
		$r = cfw_txn($pending, true);
		$batches++;
		if (($r['ok'] ?? false) !== true) {
			echo json_encode([
				'ok' => false,
				'stage' => 'rows',
				'table' => $table,
				'error' => $r['error'] ?? 'unknown',
				'rowsCopied' => $rowsCopied,
			]);
			return;
		}
		$rowsCopied += count($pending);
	}
	$perTable[$table] = $count;
}

// The packed database has NO sessions table: Drupal creates it lazily on the
// first session write, and a pack built by browsing anonymously never writes one.
// Nothing on a read path notices; the first entity save fails the whole transaction
// replay with "no such table: sessions". Created here, outside any transaction,
// because doing it mid-save turns every later read into a speculative replay --
// DDL dirties sqlite_master, and that is the documented O(W x R) cost.
$sessionsCreated = 'already present';
$check = cfw_sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'");
if (($check['ok'] ?? false) === true && count($check['rows'] ?? []) === 0) {
	// NOT $ddl: MIGRATE_DB already uses that name for the ARRAY of schema statements,
	// and overwriting it with a string made the final count($ddl) fatal
	$sessionsDdl =
		"CREATE TABLE sessions (uid INTEGER NOT NULL DEFAULT 0, sid VARCHAR(128) NOT NULL PRIMARY KEY, hostname VARCHAR(128) NOT NULL DEFAULT '', timestamp INTEGER NOT NULL DEFAULT 0, session BLOB)";
	$made = cfw_sql($sessionsDdl);
	$sessionsCreated =
		($made['ok'] ?? false) === true ? 'created' : 'FAILED: ' . ($made['error'] ?? '?');
	if (($made['ok'] ?? false) === true) {
		cfw_sql('CREATE INDEX sessions_timestamp ON sessions (timestamp)');
		cfw_sql('CREATE INDEX sessions_uid ON sessions (uid)');
	}
}

arsort($perTable);
echo json_encode([
	'sessionsTable' => $sessionsCreated,
	'ok' => true,
	'tables' => count($tables),
	'ddlStatements' => count($ddl),
	'rowsCopied' => $rowsCopied,
	'batches' => $batches,
	'biggestTables' => array_slice($perTable, 0, 12, true),
	'elapsedMs' => round(microtime(true) * 1000 - $t0, 1),
]);
