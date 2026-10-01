<?php
// __CFW_HOST_HELPERS__

$out = [];
$out['vrzno_env'] = function_exists('vrzno_env');
$exec = cfw_host('cfwSqlExec');
$txn = cfw_host('cfwSqlTxn');

// Question 6: does vrzno_env() return something PHP can invoke as $fn($json)?
// The driver accepts any object and lets the call fail rather than gating on
// is_callable(), precisely because this was unverified.
$out['bridge'] = [
	'execType' => get_debug_type($exec),
	'txnType' => get_debug_type($txn),
	'execIsCallable' => is_callable($exec),
	'txnIsCallable' => is_callable($txn),
	'execIsObject' => is_object($exec),
];

$probe = function ($label, $sql, $params = []) use (&$out) {
	$r = cfw_sql($sql, $params);
	$out['q'][$label] = [
		'sql' => $sql,
		'ok' => ($r['ok'] ?? false) === true,
		'error' => $r['error'] ?? null,
		'rows' => array_slice($r['rows'] ?? [], 0, 6),
		'rowCount' => count($r['rows'] ?? []),
	];
	return $out['q'][$label]['ok'];
};

// a table to introspect
$probe('setup_drop', 'DROP TABLE IF EXISTS cfw_probe');
$probe('setup_create', 'CREATE TABLE cfw_probe (x INTEGER PRIMARY KEY, t TEXT, big INTEGER)');
$probe('setup_insert', 'INSERT INTO cfw_probe (x, t, big) VALUES (1, :t, 0)', [':t' => 'hello']);

// Q1: PRAGMA table_info -- the inherited Schema introspection needs it
$probe('pragma_table_info', 'PRAGMA table_info(cfw_probe)');

// Q2: PRAGMA index_list
$probe('create_index', 'CREATE INDEX cfw_probe_t ON cfw_probe (t)');
$probe('pragma_index_list', 'PRAGMA index_list(cfw_probe)');
$probe('pragma_index_info', 'PRAGMA index_info(cfw_probe_t)');

// Q3: schema-qualified sqlite_master, which findTables() emits
$probe('qualified_master', 'SELECT name FROM "main".sqlite_master WHERE type = :t ORDER BY name', [
	':t' => 'table',
]);
$probe('bare_master', 'SELECT name FROM sqlite_master WHERE type = :t ORDER BY name', [
	':t' => 'table',
]);

// Q4: CREATE TEMPORARY TABLE, which queryTemporary() needs
$probe('temp_create', 'CREATE TEMPORARY TABLE cfw_tmp (x INTEGER)');
$probe('temp_insert', 'INSERT INTO cfw_tmp (x) VALUES (42)');
$probe('temp_select', 'SELECT x FROM cfw_tmp');

// Q5: schema-qualified index name, which Schema::createIndexSql() emits
$probe('qualified_index', 'CREATE INDEX "main"."cfw_probe_q" ON cfw_probe (x)');
$probe('qualified_index_bare', 'CREATE INDEX main.cfw_probe_q2 ON cfw_probe (t, x)');

// Q6 continued: the SQLite version and every builtin the function audit assumed
$fns = [
	'version' => 'SELECT sqlite_version() AS v',
	'concat' => "SELECT concat('a','b') AS v",
	'concat_ws' => "SELECT concat_ws('-','a','b') AS v",
	'pow' => 'SELECT pow(2,3) AS v',
	'exp' => 'SELECT exp(1) AS v',
	'iif' => 'SELECT iif(1,2,3) AS v',
	'max_variadic' => 'SELECT max(1,2,3) AS v',
	'min_variadic' => 'SELECT min(3,2,1) AS v',
	'random' => 'SELECT random() IS NOT NULL AS v',
	'substr' => "SELECT substr('abcdef',2,3) AS v",
	'substring' => "SELECT substring('abcdef',2,3) AS v",
	'length_chars' => "SELECT length('naive') AS v",
	'md5' => "SELECT md5('a') AS v",
	'regexp' => "SELECT 'abc' REGEXP 'b' AS v",
	'nocase_eq' => "SELECT ('Hello' = 'hello' COLLATE NOCASE) AS v",
	'nocase_utf8' => "SELECT ('A' = 'a' COLLATE NOCASE_UTF8) AS v",
];
foreach ($fns as $label => $sql) {
	$probe('fn_' . $label, $sql);
}

// A version ladder, because the engine refuses to report its own version and
// Drupal 11.4.5 gates installation on SQLite >= 3.45. Each row is a feature that
// landed in exactly one release, so the highest passing row is a proven floor.
$ladder = [
	'3.32' => 'SELECT iif(1,2,3) AS v',
	'3.35' => 'SELECT pow(2,3) AS v',
	'3.38' => "SELECT ('{\"a\":1}' ->> '$.a') AS v",
	'3.44' => "SELECT concat('a','b') AS v",
	'3.45' => "SELECT hex(jsonb('{\"a\":1}')) AS v",
	'3.46' => "SELECT unhex('41') AS v",
];
$floor = null;
foreach ($ladder as $release => $sql) {
	if ($probe('ver_' . $release, $sql)) {
		$floor = $release;
	}
}
$out['versionFloor'] = $floor;
$out['meetsDrupalMinimum'] = $floor !== null && version_compare($floor . '.0', '3.45', '>=');

// builtin GLOB semantics, which decide whether likeToGlob() can be wired in
$globs = [
	'glob_star' => "SELECT ('abc' GLOB 'a*') AS v",
	'glob_question' => "SELECT ('abc' GLOB 'a?c') AS v",
	'glob_percent_literal' => "SELECT ('a%c' GLOB 'a%c') AS v",
	'glob_percent_not_wildcard' => "SELECT ('abc' GLOB 'a%c') AS v",
	'glob_bracket_quote_star' => "SELECT ('a*c' GLOB 'a[*]c') AS v",
	'glob_bracket_quote_question' => "SELECT ('a?c' GLOB 'a[?]c') AS v",
	'glob_bracket_quote_bracket' => "SELECT ('a[c' GLOB 'a[[]c') AS v",
	'glob_case_sensitive' => "SELECT ('ABC' GLOB 'abc') AS v",
	'glob_with_escape_clause' => "SELECT ('abc' GLOB 'abc' ESCAPE '\\') AS v",
	'like_case_insensitive' => "SELECT ('ABC' LIKE 'abc') AS v",
	'like_with_escape_clause' => "SELECT ('a%c' LIKE 'a\\%c' ESCAPE '\\') AS v",
];
foreach ($globs as $label => $sql) {
	$probe($label, $sql);
}

// Q7: does sql.exec() bind a JS BigInt? The codec produces one for an integer
// beyond Number.MAX_SAFE_INTEGER, which JSON cannot carry and a JS number cannot
// hold exactly, so the envelope is the only way the value travels at all.
$wide = '9007199254740993';
$probe('bigint_write_envelope', 'UPDATE cfw_probe SET big = :b WHERE x = 1', [
	':b' => ['__phpint' => $wide],
]);
$probe('bigint_read_envelope', 'SELECT big FROM cfw_probe WHERE x = 1');

// the fallback the driver has to use if a BigInt cannot be bound: a decimal
// string, relying on the column's INTEGER affinity to convert it
$probe('bigint_write_string', 'UPDATE cfw_probe SET big = :b WHERE x = 1', [':b' => $wide]);
$probe('bigint_read_string', 'SELECT big FROM cfw_probe WHERE x = 1');
$probe(
	'bigint_typeof',
	'SELECT typeof(big) AS t, big + 0 AS n, CAST(big AS TEXT) AS s FROM cfw_probe WHERE x = 1',
);
$probe('bigint_match_string', 'SELECT COUNT(*) AS c FROM cfw_probe WHERE big = :b', [
	':b' => $wide,
]);
$probe('bigint_max', 'UPDATE cfw_probe SET big = :b WHERE x = 1', [':b' => '9223372036854775807']);
$probe('bigint_max_read', 'SELECT CAST(big AS TEXT) AS s FROM cfw_probe WHERE x = 1');

$resolve = function ($v) {
	return is_array($v) ? $v['__phpint'] ?? json_encode($v) : $v;
};
$out['bigint'] = [
	'sent' => $wide,
	'envelopeBindOk' => $out['q']['bigint_write_envelope']['ok'],
	'envelopeBindError' => $out['q']['bigint_write_envelope']['error'],
	'stringBindOk' => $out['q']['bigint_write_string']['ok'],
	'readBackRaw' => $resolve($out['q']['bigint_read_string']['rows'][0]['big'] ?? null),
	'readBackExact' =>
		(string) $resolve($out['q']['bigint_read_string']['rows'][0]['big'] ?? null) === $wide,
	'storedType' => $out['q']['bigint_typeof']['rows'][0]['t'] ?? null,
	'castToTextExact' =>
		(string) $resolve($out['q']['bigint_typeof']['rows'][0]['s'] ?? null) === $wide,
	'matchedByStringBind' =>
		(string) $resolve($out['q']['bigint_match_string']['rows'][0]['c'] ?? null) === '1',
	'int64MaxCastExact' =>
		(string) $resolve($out['q']['bigint_max_read']['rows'][0]['s'] ?? null) ===
		'9223372036854775807',
];

// the transaction bridge, against real storage rather than a PDO stand-in
$t = cfw_txn(
	[
		[
			'sql' => 'INSERT INTO cfw_probe (x, t, big) VALUES (2, :t, 0)',
			'params' => [':t' => 'speculative'],
		],
	],
	false,
	['sql' => 'SELECT COUNT(*) AS c FROM cfw_probe', 'params' => []],
);
$after = cfw_sql('SELECT COUNT(*) AS c FROM cfw_probe');
$out['txn'] = [
	'ok' => ($t['ok'] ?? false) === true,
	'error' => $t['error'] ?? null,
	'speculativeCount' => $t['readResult']['rows'][0]['c'] ?? null,
	'committedCount' => $after['rows'][0]['c'] ?? null,
	'leftNothingBehind' =>
		($t['readResult']['rows'][0]['c'] ?? null) !== ($after['rows'][0]['c'] ?? null),
];

$probe('cleanup', 'DROP TABLE IF EXISTS cfw_probe');

$out['phpVersion'] = PHP_VERSION;
$out['intSize'] = PHP_INT_SIZE;
echo json_encode($out);
