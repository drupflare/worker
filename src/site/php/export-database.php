<?php
// __CFW_HOST_HELPERS__

$cap = __CFW_CAP__;
$out = ['ok' => false, 'statements' => 0, 'bytes' => 0, 'tables' => [], 'sql' => ''];
$lines = [];

$master = cfw_sql(
	"SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
);
if (($master['ok'] ?? false) !== true) {
	echo json_encode(['ok' => false, 'error' => $master['error'] ?? 'cannot read sqlite_master']);
	return;
}

$tables = [];
foreach ($master['rows'] as $row) {
	$name = (string) ($row['name'] ?? '');
	// engine-owned objects refuse to be created, and miniflare adds bookkeeping
	if (
		$name === '' ||
		str_starts_with($name, 'sqlite_') ||
		str_starts_with($name, '__miniflare')
	) {
		continue;
	}
	$lines[] = rtrim((string) $row['sql'], ";\n\r\t ") . ';';
	if (($row['type'] ?? '') === 'table') {
		$tables[] = $name;
	}
}

$quote = function ($v) {
	if ($v === null) {
		return 'NULL';
	}
	if (is_array($v)) {
		$v = (string) ($v['__phpint'] ?? '');
	}
	if (is_int($v) || is_float($v)) {
		return (string) $v;
	}
	$s = (string) $v;
	// a decimal string is emitted bare so INTEGER affinity survives a round trip
	if ($s !== '' && preg_match('/^-?[0-9]{1,18}$/', $s) === 1) {
		return $s;
	}
	return "'" . str_replace("'", "''", $s) . "'";
};

foreach ($tables as $table) {
	$sql = 'SELECT * FROM "' . str_replace('"', '""', $table) . '"';
	if ($cap > 0) {
		$sql .= ' LIMIT ' . $cap;
	}
	$rows = cfw_sql($sql);
	if (($rows['ok'] ?? false) !== true) {
		$out['tables'][$table] = 'ERROR: ' . ($rows['error'] ?? 'unknown');
		continue;
	}
	$n = 0;
	foreach ($rows['rows'] as $row) {
		$cols = array_keys($row);
		if (!$cols) {
			continue;
		}
		$quoted = array_map(function ($c) {
			return '"' . str_replace('"', '""', $c) . '"';
		}, $cols);
		$vals = array_map($quote, array_values($row));
		$lines[] =
			'INSERT INTO "' .
			$table .
			'" (' .
			implode(', ', $quoted) .
			') VALUES (' .
			implode(', ', $vals) .
			');';
		$n++;
	}
	$out['tables'][$table] = $n;
}

$dump = implode("\n", $lines);
$out['ok'] = true;
$out['statements'] = count($lines);
$out['bytes'] = strlen($dump);
$out['sha1'] = sha1($dump);
// the caller decides whether to ship the body; a fleet backup streams it to R2
$out['sql'] = $dump;
echo json_encode($out);
