<?php

// runs a captured statement log through the upstream MySQL-on-SQLite driver and prints one json
// line per statement, then one table dump per scenario boundary
// usage: php oracle-upstream.php <upstream src dir> <capture.jsonl> <sqlite file> <out.jsonl>

if ($argc < 5) {
	fwrite(STDERR, "usage: oracle-upstream.php <src> <capture.jsonl> <sqlite file> <out.jsonl>\n");
	exit(2);
}

[, $src, $capture, $file, $out] = $argv;
require $src . '/load.php';

@unlink($file);
@unlink($file . '-wal');
@unlink($file . '-shm');

function connect(string $file): WP_MySQL_On_SQLite
{
	return new WP_MySQL_On_SQLite('mysql-on-sqlite:path=' . $file . ';dbname=wp');
}

function text($v): ?string
{
	return $v === null ? null : (string) $v;
}

function outcome(WP_MySQL_On_SQLite $pdo, string $sql): array
{
	try {
		$stmt = $pdo->query($sql);
		if ($stmt->columnCount() > 0) {
			$columns = [];
			for ($i = 0; $i < $stmt->columnCount(); $i++) {
				$columns[] = $stmt->getColumnMeta($i)['name'];
			}
			$rows = [];
			foreach ($stmt->fetchAll(PDO::FETCH_NUM) as $row) {
				$rows[] = array_map('text', $row);
			}
			return ['kind' => 'rows', 'columns' => $columns, 'rows' => $rows];
		}
		if (preg_match('/^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i', $sql) === 1) {
			return [
				'kind' => 'write',
				'affected' => $stmt->rowCount(),
				'insertId' => (int) $pdo->lastInsertId(),
			];
		}
		return ['kind' => 'none'];
	} catch (Throwable $e) {
		$info = $e instanceof PDOException && is_array($e->errorInfo) ? $e->errorInfo : [];
		return [
			'kind' => 'error',
			'errno' => isset($info[1]) ? (int) $info[1] : -1,
			'message' => substr($e->getMessage(), 0, 200),
		];
	}
}

function dump(WP_MySQL_On_SQLite $pdo): array
{
	$tables = [];
	foreach ($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_NUM) as $row) {
		$tables[] = $row[0];
	}
	sort($tables);
	$result = [];
	foreach ($tables as $t) {
		$rows = [];
		foreach ($pdo->query('SELECT * FROM `' . $t . '`')->fetchAll(PDO::FETCH_NUM) as $row) {
			$rows[] = json_encode(
				array_map('text', $row),
				JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
			);
		}
		sort($rows);
		$result[$t] = $rows;
	}
	return $result;
}

$handle = fopen($out, 'w');
$conns = [];
$last = null;
$lastScenario = null;
foreach (file($capture, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
	$rec = json_decode($line, true);
	$thread = (string) $rec['thread'];
	if ($lastScenario !== null && $rec['scenario'] !== $lastScenario && $last !== null) {
		fwrite(
			$handle,
			json_encode(
				['dump' => $lastScenario, 'tables' => dump($last)],
				JSON_UNESCAPED_UNICODE,
			) . "\n",
		);
	}
	$lastScenario = $rec['scenario'];
	if (!isset($conns[$thread])) {
		$conns[$thread] = connect($file);
	}
	$last = $conns[$thread];
	$o = isset($rec['refused']) ? ['kind' => 'none'] : outcome($last, $rec['sql']);
	fwrite($handle, json_encode(['i' => $rec['i'], 'o' => $o], JSON_UNESCAPED_UNICODE) . "\n");
}
if ($last !== null) {
	fwrite(
		$handle,
		json_encode(['dump' => $lastScenario, 'tables' => dump($last)], JSON_UNESCAPED_UNICODE) .
			"\n",
	);
}
fclose($handle);
