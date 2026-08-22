/**
 * PHP fragments that run inside the Durable Object.
 *
 * They are eval'd through pib_run, so a `use` statement at the top of a fragment
 * is invalid and every class name is fully qualified. Each one prints a single
 * JSON object and nothing else, because the caller parses from the first `{`.
 */

/**
 * A host-call helper shared by the fragments below.
 *
 * Every fragment reaches ctx.storage.sql the same way the driver does --
 * vrzno_env('cfwSqlExec') and the pw_encode/pw_decode codec -- so a fragment that
 * works is also evidence the driver's own transport works.
 */
const HOST_HELPERS = String.raw`
if (!function_exists('cfw_host')) { eval('
function cfw_host($name) {
  return function_exists("vrzno_env") ? vrzno_env($name) : null;
}
function cfw_call($fn, array $payload) {
  $invoke = $fn;
  $reply = $invoke(json_encode(pw_encode($payload)));
  if (!is_string($reply)) {
    return ["ok" => false, "error" => "host returned " . get_debug_type($reply) . " where a JSON string was expected"];
  }
  $decoded = json_decode($reply, true);
  if (!is_array($decoded)) {
    return ["ok" => false, "error" => "unparseable host reply: " . substr($reply, 0, 200)];
  }
  return pw_decode($decoded);
}
function cfw_sql($sql, $params = []) {
  return cfw_call(cfw_host("cfwSqlExec"), ["sql" => $sql, "params" => $params]);
}
function cfw_txn(array $statements, $commit = true, $read = null) {
  return cfw_call(cfw_host("cfwSqlTxn"), ["statements" => array_values($statements), "commit" => $commit, "read" => $read]);
}
'); }
`;

/**
 * Settles the runtime questions a PDO stand-in could never answer.
 *
 * DRIVER-NOTES.md "What is proven and what is not" lists six. Each is asked as
 * its own statement so one failure cannot hide the others, and the answer records
 * the engine's own message rather than a boolean, because the message is what
 * tells you whether a feature is missing or merely spelled differently.
 */
export const PROBE_RUNTIME = String.raw`<?php
${HOST_HELPERS}

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
$probe('qualified_master', 'SELECT name FROM "main".sqlite_master WHERE type = :t ORDER BY name', [':t' => 'table']);
$probe('bare_master', 'SELECT name FROM sqlite_master WHERE type = :t ORDER BY name', [':t' => 'table']);

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
foreach ($fns as $label => $sql) { $probe('fn_' . $label, $sql); }

// A version ladder, because the engine refuses to report its own version and
// Drupal 11.4.5 gates installation on SQLite >= 3.45. Each row is a feature that
// landed in exactly one release, so the highest passing row is a proven floor.
$ladder = [
  '3.32' => "SELECT iif(1,2,3) AS v",
  '3.35' => "SELECT pow(2,3) AS v",
  '3.38' => "SELECT ('{\"a\":1}' ->> '$.a') AS v",
  '3.44' => "SELECT concat('a','b') AS v",
  '3.45' => "SELECT hex(jsonb('{\"a\":1}')) AS v",
  '3.46' => "SELECT unhex('41') AS v",
];
$floor = null;
foreach ($ladder as $release => $sql) {
  if ($probe('ver_' . $release, $sql)) { $floor = $release; }
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
foreach ($globs as $label => $sql) { $probe($label, $sql); }

// Q7: does sql.exec() bind a JS BigInt? The codec produces one for an integer
// beyond Number.MAX_SAFE_INTEGER, and 32-bit PHP can only express it as an
// envelope, so this is the only way the value can travel at all.
$wide = '9007199254740993';
$probe('bigint_write_envelope', 'UPDATE cfw_probe SET big = :b WHERE x = 1', [':b' => ['__phpint' => $wide]]);
$probe('bigint_read_envelope', 'SELECT big FROM cfw_probe WHERE x = 1');

// the fallback the driver has to use if a BigInt cannot be bound: a decimal
// string, relying on the column's INTEGER affinity to convert it
$probe('bigint_write_string', 'UPDATE cfw_probe SET big = :b WHERE x = 1', [':b' => $wide]);
$probe('bigint_read_string', 'SELECT big FROM cfw_probe WHERE x = 1');
$probe('bigint_typeof', 'SELECT typeof(big) AS t, big + 0 AS n, CAST(big AS TEXT) AS s FROM cfw_probe WHERE x = 1');
$probe('bigint_match_string', 'SELECT COUNT(*) AS c FROM cfw_probe WHERE big = :b', [':b' => $wide]);
$probe('bigint_max', 'UPDATE cfw_probe SET big = :b WHERE x = 1', [':b' => '9223372036854775807']);
$probe('bigint_max_read', 'SELECT CAST(big AS TEXT) AS s FROM cfw_probe WHERE x = 1');

$resolve = function ($v) {
  return is_array($v) ? ($v['__phpint'] ?? json_encode($v)) : $v;
};
$out['bigint'] = [
  'sent' => $wide,
  'envelopeBindOk' => $out['q']['bigint_write_envelope']['ok'],
  'envelopeBindError' => $out['q']['bigint_write_envelope']['error'],
  'stringBindOk' => $out['q']['bigint_write_string']['ok'],
  'readBackRaw' => $resolve($out['q']['bigint_read_string']['rows'][0]['big'] ?? null),
  'readBackExact' => (string) $resolve($out['q']['bigint_read_string']['rows'][0]['big'] ?? null) === $wide,
  'storedType' => $out['q']['bigint_typeof']['rows'][0]['t'] ?? null,
  'castToTextExact' => (string) $resolve($out['q']['bigint_typeof']['rows'][0]['s'] ?? null) === $wide,
  'matchedByStringBind' => (string) $resolve($out['q']['bigint_match_string']['rows'][0]['c'] ?? null) === '1',
  'int64MaxCastExact' => (string) $resolve($out['q']['bigint_max_read']['rows'][0]['s'] ?? null) === '9223372036854775807',
];

// the transaction bridge, against real storage rather than a PDO stand-in
$t = cfw_txn([
  ['sql' => 'INSERT INTO cfw_probe (x, t, big) VALUES (2, :t, 0)', 'params' => [':t' => 'speculative']],
], false, ['sql' => 'SELECT COUNT(*) AS c FROM cfw_probe', 'params' => []]);
$after = cfw_sql('SELECT COUNT(*) AS c FROM cfw_probe');
$out['txn'] = [
  'ok' => ($t['ok'] ?? false) === true,
  'error' => $t['error'] ?? null,
  'speculativeCount' => $t['readResult']['rows'][0]['c'] ?? null,
  'committedCount' => $after['rows'][0]['c'] ?? null,
  'leftNothingBehind' => ($t['readResult']['rows'][0]['c'] ?? null) !== ($after['rows'][0]['c'] ?? null),
];

$probe('cleanup', 'DROP TABLE IF EXISTS cfw_probe');

$out['phpVersion'] = PHP_VERSION;
$out['intSize'] = PHP_INT_SIZE;
echo json_encode($out);
`;

/**
 * Runs the mb_* invalid-UTF-8 cases inside wasm, where the polyfill is real.
 *
 * The gate test (scripts/test-mb-fix.mjs) proves the sanitiser against native
 * mbstring, but native HAS mbstring, so it cannot exercise the polyfill path that
 * actually carries the bug. This does, and the caller diffs it against the native
 * oracle. It requires /drupal/autoload.php so the Symfony polyfill classes the
 * wrappers delegate to are loadable.
 */
export const MB_CHECK = String.raw`<?php
if (!isset($GLOBALS['__pw_autoloader'])) {
  $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
}

$cases = [
  'ascii' => 'abc',
  'valid accented' => "caf\xc3\xa9",
  'valid CJK' => "\xe4\xbd\xa0\xe5\xa5\xbd",
  'valid astral emoji' => "\xf0\x9f\x98\x80",
  'two bad bytes' => "abc\xff\xfedef",
  'lone continuation' => "abc\x80def",
  'truncated 3-byte end' => "abc\xe4\xbd",
  'truncated 3-byte mid' => "abc\xe4\xbddef",
  'overlong C0' => "abc\xc0\xafdef",
  'surrogate ED A0 80' => "abc\xed\xa0\x80def",
  'truncated 4-byte mid' => "abc\xf0\x9fdef",
  'F5 out of range' => "abc\xf5\x80\x80\x80def",
];

$out = [
  'mbstringExtension' => extension_loaded('mbstring'),
  'iconvExtension' => extension_loaded('iconv'),
  'wrappersInstalled' => function_exists('cfw_mb_installed'),
  'sanitizerPresent' => function_exists('cfw_mb_sanitize'),
  'cases' => [],
];

foreach ($cases as $label => $raw) {
  $out['cases'][$label] = [
    'in' => bin2hex($raw),
    'mb_substr' => mb_substr($raw, 0, 100000),
    'mb_strlen' => mb_strlen($raw),
    'mb_strtolower' => mb_strtolower($raw),
    // must NOT be sanitised: an invalid string has to still report invalid
    'mb_check_encoding' => mb_check_encoding($raw, 'UTF-8'),
  ];
}

echo json_encode($out);
`;

/**
 * Copies the packed SQLite file into ctx.storage.sql.
 *
 * The pack ships site.sqlite because MEMFS was the only store the earlier rounds
 * had. Reading it with the in-wasm PDO and replaying it through the bridge is the
 * one-time move onto durable storage, and it is also the backup/restore primitive
 * in the other direction.
 *
 * Two rewrites are mandatory:
 *
 *   - the DDL in sqlite_master was written by core's sqlite driver, which
 *     registers NOCASE_UTF8 as a real collation. ctx.storage.sql has no
 *     user-defined collations at all, so every NOCASE_UTF8 becomes NOCASE -- the
 *     same substitution Schema.php already makes for new tables.
 *   - sqlite_sequence and sqlite_autoindex_* are engine-owned and refuse to be
 *     created.
 */
export const MIGRATE_DB = String.raw`<?php
${HOST_HELPERS}

$out = ['ok' => false];
$path = '/drupal/sites/default/files/.sqlite';
if (!file_exists($path)) { echo json_encode(['ok' => false, 'error' => 'no packed database at ' . $path]); return; }

$t0 = microtime(true) * 1000;
$pdo = new \PDO('sqlite:' . $path, null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);

$rewrite = function ($sql) {
  // no user-defined collations on the host; ASCII folding is the documented gap
  return str_ireplace('NOCASE_UTF8', 'NOCASE', $sql);
};

$objects = $pdo->query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END")->fetchAll(\PDO::FETCH_ASSOC);

$ddl = [];
$tables = [];
foreach ($objects as $o) {
  if (str_starts_with($o['name'], 'sqlite_')) { continue; }
  $ddl[] = ['sql' => $rewrite($o['sql']), 'params' => []];
  if ($o['type'] === 'table') { $tables[] = $o['name']; }
}

// schema first, in one transaction, so a partial schema cannot survive
$schemaResult = cfw_txn($ddl, true);
if (($schemaResult['ok'] ?? false) !== true) {
  echo json_encode(['ok' => false, 'stage' => 'schema', 'error' => $schemaResult['error'] ?? 'unknown', 'statements' => count($ddl)]);
  return;
}

$rowsCopied = 0;
$batches = 0;
$perTable = [];
$BATCH = 200;
foreach ($tables as $table) {
  $cols = $pdo->query('PRAGMA table_info(' . '"' . $table . '"' . ')')->fetchAll(\PDO::FETCH_ASSOC);
  $names = array_map(function ($c) { return $c['name']; }, $cols);
  if (!$names) { continue; }
  $quoted = implode(', ', array_map(function ($n) { return '"' . $n . '"'; }, $names));
  $marks = implode(', ', array_fill(0, count($names), '?'));
  $insert = 'INSERT INTO "' . $table . '" (' . $quoted . ') VALUES (' . $marks . ')';

  $stmt = $pdo->query('SELECT ' . $quoted . ' FROM "' . $table . '"');
  $pending = [];
  $count = 0;
  while ($row = $stmt->fetch(\PDO::FETCH_ASSOC)) {
    $params = [];
    foreach ($names as $n) { $params[] = $row[$n]; }
    $pending[] = ['sql' => $insert, 'params' => $params];
    $count++;
    if (count($pending) >= $BATCH) {
      $r = cfw_txn($pending, true);
      $batches++;
      if (($r['ok'] ?? false) !== true) {
        echo json_encode(['ok' => false, 'stage' => 'rows', 'table' => $table, 'error' => $r['error'] ?? 'unknown', 'rowsCopied' => $rowsCopied]);
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
      echo json_encode(['ok' => false, 'stage' => 'rows', 'table' => $table, 'error' => $r['error'] ?? 'unknown', 'rowsCopied' => $rowsCopied]);
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
  $sessionsDdl = "CREATE TABLE sessions (uid INTEGER NOT NULL DEFAULT 0, sid VARCHAR(128) NOT NULL PRIMARY KEY, hostname VARCHAR(128) NOT NULL DEFAULT '', timestamp INTEGER NOT NULL DEFAULT 0, session BLOB)";
  $made = cfw_sql($sessionsDdl);
  $sessionsCreated = ($made['ok'] ?? false) === true ? 'created' : ('FAILED: ' . ($made['error'] ?? '?'));
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
`;

/**
 * The synchronous stand-in for \Fiber that the patched tree expects.
 *
 * PHP builds Fibers on ucontext when --disable-fiber-asm is set and emscripten
 * has no ucontext, so a real Fiber aborts the runtime with
 * "Aborted(missing function: getcontext)". scripts/patch-drupal.mjs rewrites
 * core's five call sites to this class; it has to exist before Drupal loads.
 */
const FIBER_SHIM = String.raw`
if (!class_exists('PhpWasmSyncFiber', false)) { eval('
class PhpWasmSyncFiber {
  private $callable;
  private $result = null;
  private $started = false;
  public function __construct(callable $callable) { $this->callable = $callable; }
  public function start(...$args) { $this->started = true; $this->result = ($this->callable)(...$args); return null; }
  public function isStarted(): bool { return $this->started; }
  public function isSuspended(): bool { return false; }
  public function isRunning(): bool { return false; }
  public function isTerminated(): bool { return $this->started; }
  public function resume($value = null) { return null; }
  public function throw(\\Throwable $e) { throw $e; }
  public function getReturn() { return $this->result; }
  public static function getCurrent(): ?object { return null; }
  public static function suspend($value = null) { return null; }
}
'); }
`;

/**
 * Serves one request against a persistent kernel, correctly.
 *
 * DrupalKernel::preHandle() is guarded by $this->prepared, so it pushes onto
 * request_stack only on the FIRST handle(). Every later call therefore routes
 * against the first request's path -- measured in TECHNICAL_REPORT.md: reqUri
 * /admin/content but route view.frontpage.page_1. Clearing the flag and draining
 * the stack makes Drupal re-initialise per-request state the way a fresh process
 * would.
 */
const PW_SERVE_INLINE = String.raw`
if (!function_exists('cfw_serve')) { eval('
function cfw_serve($path, $destruct = true, $method = "GET", $body = "", $contentType = "", $cookieHeader = "", $origin = "", $clientIp = "") {
  $kernel = $GLOBALS["__pw_kernel"];

  // PHP\x27S HEADER LIST OUTLIVES THE REQUEST ON A PERSISTENT INTERPRETER, and session_start()
  // emits its Set-Cookie into exactly that list. Without this, visitor B\x27s response carries
  // visitor A\x27s session cookie -- a session handover, not a stale header. Cleared BEFORE the
  // request rather than after, so a fragment that never reaches the end still cannot leak one.
  if (function_exists("header_remove")) { header_remove(); }

  // THE METHOD AND BODY ARE THREADED FROM THE HOST, and before this every call site passed a
  // literal "GET". No form submission of any kind could work: not login, not a contact form, not
  // node edit. A CMS that cannot accept a form is not a CMS.
  //
  // The parsed parameters are passed to Request::create() rather than only set on $_POST, because
  // Drupal reads the REQUEST OBJECT and not the superglobal. Setting $_POST alone produces a
  // request Drupal treats as an empty submission, which returns 200 and looks like it worked.
  $method = strtoupper($method === "" ? "GET" : $method);
  $parameters = [];
  $isForm = stripos($contentType, "application/x-www-form-urlencoded") !== false;
  if ($method !== "GET" && $body !== "" && $isForm) { parse_str($body, $parameters); }

  $server = [];
  if ($contentType !== "") { $server["CONTENT_TYPE"] = $contentType; }
  if ($body !== "") { $server["CONTENT_LENGTH"] = (string) strlen($body); }
  if ($cookieHeader !== "") { $server["HTTP_COOKIE"] = $cookieHeader; }
  // ON THE REQUEST BAG, not just \$_SERVER: flood control reads \$request->getClientIp(), and
  // Request::create() builds its own bag, so an assignment afterwards is invisible to it
  if ($clientIp !== "") { $server["REMOTE_ADDR"] = $clientIp; }

  // THE COOKIE IS WHY AN AUTHENTICATED REQUEST EXISTS AT ALL. Without it every request is uid 0,
  // so Drupal denies a create-entity route at the ROUTING layer and no form is ever built --
  // which is what "the submission does not work" looked like from outside. Parsed by hand rather
  // than through a helper, because the value arrives as one raw header line from the host.
  $cookies = [];
  foreach (explode(";", $cookieHeader) as $pair) {
    $pair = trim($pair);
    if ($pair === "") { continue; }
    $split = strpos($pair, "=");
    if ($split === false) { continue; }
    $cookies[urldecode(substr($pair, 0, $split))] = urldecode(substr($pair, $split + 1));
  }

  // THE ORIGIN IS PREPENDED SO SYMFONY PARSES IT, rather than set on $_SERVER afterwards.
  // Request::create() builds its OWN server bag from defaults and does not read $_SERVER, so the
  // HTTP_HOST assignments the fragments make were never what Drupal saw -- an absolute URI is. With
  // a relative one Symfony fills in "localhost", which is why a deployed site put http://localhost
  // into every canonical tag, form action, Location header and password-reset mail.
  $url = $origin === "" ? $path : rtrim($origin, "/") . $path;
  $request = \\Symfony\\Component\\HttpFoundation\\Request::create($url, $method, $parameters, $cookies, [], $server, $body);

  // the superglobals follow the request rather than leading it, so a fragment reading $_POST and
  // one reading the Request agree -- INCLUDING the host trio, which is read directly by code that
  // predates the request object
  $_SERVER["HTTP_HOST"] = $request->getHttpHost();
  $_SERVER["SERVER_NAME"] = $request->getHost();
  $_SERVER["SERVER_PORT"] = (string) $request->getPort();
  if ($request->isSecure()) { $_SERVER["HTTPS"] = "on"; } else { unset($_SERVER["HTTPS"]); }
  $_SERVER["REQUEST_METHOD"] = $method;
  if ($clientIp !== "") { $_SERVER["REMOTE_ADDR"] = $clientIp; }
  // EVERY input superglobal, not just $_POST. When a CSRF token fails, FormBuilder empties the
  // request and calls $request->overrideGlobals() to make the globals agree
  // (FormBuilder.php:1024-1030); on a real SAPI those globals die with the process and here they
  // do not. Re-initialising all of them is what a SAPI does per request. NOTE: this alone does not
  // fix the residual defect pinned in tests/integration/csrf.spec.ts -- measured, so not claimed.
  $_POST = $parameters;
  $_GET = [];
  $_FILES = [];
  $_REQUEST = $parameters;
  $_COOKIE = $cookies;
  if ($contentType !== "") { $_SERVER["CONTENT_TYPE"] = $contentType; }
  if ($body !== "") { $_SERVER["CONTENT_LENGTH"] = (string) strlen($body); }
  if ($cookieHeader !== "") { $_SERVER["HTTP_COOKIE"] = $cookieHeader; } else { unset($_SERVER["HTTP_COOKIE"]); }

  // THE SESSION HAS TO BE ENDED BEFORE THE NEXT ONE IS READ, and this interpreter is where that
  // stops being automatic. PHP holds $_SESSION and the active id on the PROCESS, and Symfony
  // memoises its started flag on a service that outlives the request -- so without this, request 2
  // is whoever request 1 was. Measured: a second login POST answered
  // "This route can only be accessed by anonymous users".
  //
  // drupflare owns the mechanism because it is the same mechanism drupal_static() and the node
  // grants need; the hand-rolled resets below are the fallback for a site that has not enabled it.
  try {
    $container = \\Drupal::getContainer();
    if ($container !== null && $container->has("drupflare.request_resetter")) {
      $GLOBALS["__pw_reset"] = $container->get("drupflare.request_resetter")->reset();
    } else {
      if (function_exists("session_status") && session_status() === PHP_SESSION_ACTIVE) {
        @session_write_close();
      }
      $_SESSION = [];
    }
  } catch (\\Throwable $e) { $GLOBALS["__pw_reset"] = ["error" => $e->getMessage()]; }

  // AND THE ID HAS TO BE SET FROM THIS REQUEST, not left wherever the last one put it.
  // session_start() prefers an id already set on the process over the cookie, so an unset id is
  // not a clean slate -- it is the previous visitor. Always overwrite: the cookie when there is
  // one, a fresh id when there is not.
  if (function_exists("session_id")) {
    $sid = "";
    foreach ($cookies as $cookieName => $cookieValue) {
      if (strncmp($cookieName, "SESS", 4) === 0 || strncmp($cookieName, "SSESS", 5) === 0) {
        $sid = (string) $cookieValue;
        break;
      }
    }
    if ($sid !== "" && preg_match("/^[A-Za-z0-9,-]{1,128}$/", $sid) === 1) {
      @session_id($sid);
    } elseif (function_exists("session_create_id")) {
      @session_id(session_create_id());
    }
  }

  try {
    $rp = new \\ReflectionProperty(\\Drupal\\Core\\DrupalKernel::class, "prepared");
    $rp->setValue($kernel, false);
  } catch (\\Throwable $e) {}

  try {
    $stack = \\Drupal::service("request_stack");
    while ($stack->getCurrentRequest() !== null) { $stack->pop(); }
  } catch (\\Throwable $e) {}

  if (function_exists("drupal_static_reset")) { drupal_static_reset(); }

  // Html::$seenIds is a plain static and is NOT registered through drupal_static(), so the line
  // above does not clear it. On a persistent interpreter the id registry accumulates across
  // requests: render 1 is 12,304 bytes, renders 2-5 come back 12,310 with
  // block-olivero-page-title--2 through --5. Measured on a deployed worker, so the same URL stops
  // being byte-reproducible and every anchor, aria-labelledby target and id-based selector moves.
  //
  // Fully qualified because this fragment is assembled as a string and has nowhere legal to put a
  // use block, which is the one documented exception to the import rule.
  if (method_exists("\\Drupal\\Component\\Utility\\Html", "resetSeenIds")) {
    \\Drupal\\Component\\Utility\\Html::resetSeenIds();
  }

  // PATH.MATCHER LEAKS ITS FRONT-PAGE VERDICT ACROSS RENDERS, and this fixes markup that was
  // being served wrong to real visitors. isFrontPage() memoises into $isCurrentFrontPage, and on a
  // persistent container the FIRST path rendered decides for every later one. Measured: render /
  // then /user/login on one interpreter and /user/login comes back with class="path-frontpage",
  // no active trail and no breadcrumb -- front-page markup on a page that is not the front page.
  //
  // walked by reflection, and the chain is why. path_alias DECORATES path.matcher, so
  // \Drupal::service("path.matcher") is an AliasPathMatcher holding the real one in $decorated --
  // and it declares its OWN $isCurrentFrontPage, memoised with ??=, which shadows the inner
  // matcher entirely. Two earlier attempts missed that: drupal_static_reset() does not touch a
  // protected property, and giving the INNER class a reset() fixed an object whose answer is
  // never consulted. Walking every link means no decoration depth or ordering can hide a memo.
  //
  // NULL rather than FALSE: isFrontPage() guards on the property being unset, so FALSE reads as a
  // computed "not the front page" and pins every later request to it -- the same bug reversed.
  try {
    $node = \\Drupal::service("path.matcher");
    $seen = 0;
    while (is_object($node) && $seen < 8) {
      $seen++;
      $ref = new \\ReflectionObject($node);
      if ($ref->hasProperty("isCurrentFrontPage")) {
        $prop = $ref->getProperty("isCurrentFrontPage");
        $prop->setValue($node, null);
      }
      if (!$ref->hasProperty("decorated")) { break; }
      $inner = $ref->getProperty("decorated");
      $node = $inner->getValue($node);
    }
  } catch (\\Throwable $e) {}

  // NOT releasing locks here, and the reasoning is measured. The mechanism is real: DatabaseLockBackend relies on releaseAll() at
  // PROCESS SHUTDOWN, this interpreter never shuts down, and a lock held forever would
  // be worse than a stale cache because Lock::wait() calls usleep() inside a
  // synchronous wasm call that nothing can interrupt -- it stalls instead of failing.
  // But the semaphore table measured EMPTY on every site exercised, including three that ran
  // the destruct pass before any release was added, so nothing actually leaks on these
  // paths: CacheCollector::destruct() releases its own lock. Paying a statement per
  // render for an unobserved leak is the same trade this file just rejected for the
  // destruct pass. Instead: alarm() releases (cheap, periodic, unattended) and
  // test-serve-chain.mjs asserts the semaphore table is empty, so a future leak trips a test
  // rather than stalling a request.

  // $catch = TRUE, which is what index.php passes and what this had wrong. With FALSE, HttpKernel
  // rethrows instead of dispatching KernelEvents::EXCEPTION -- so Drupal\x27s own 403 and 404 pages
  // never rendered, and a successful login came back as a bare
  // Drupal\\Core\\Form\\EnforcedResponseException because the redirect a form sets is DELIVERED as an
  // exception and converted by EnforcedFormResponseSubscriber. Every one of those is a normal
  // response that was being reported as a render failure.
  $response = $kernel->handle($request, \\Symfony\\Component\\HttpKernel\\HttpKernelInterface::MAIN_REQUEST, true);

  // Nothing had ever completed the request lifecycle, so every needs_destruction
  // service -- theme.registry, library.discovery, library.parsing_cache,
  // menu.active_trail, router.builder, path_alias -- discarded its accumulated
  // CacheCollector entries instead of persisting them. Those writes happen in
  // CacheCollector::destruct().
  //
  // This is NOT $kernel->terminate(). Two measured reasons:
  //   1. terminate() dispatches TERMINATE, which automated_cron subscribes to. With
  //      system.cron_last absent it runs drupal_cron() inline, cron reaches for
  //      outbound HTTP, and the invocation dies with "ReferenceError: Asyncify is
  //      not defined" -- a JS exception that catch (\\Throwable) cannot contain.
  //   2. Even with cron disabled, terminate() POISONED the interpreter: the first
  //      render returned 12,304 bytes and every render after it returned 0 bytes,
  //      with rows-written per render jumping 15 -> 85. terminate() is written for a
  //      process that is about to exit; this interpreter is persistent and reuses
  //      the same kernel.
  // So iterate the container parameter the compiler pass fills and destruct only the
  // services that were actually initialised this request -- the collector writes we
  // want, none of the process-death semantics we do not.
  // $destruct is true, false, or a comma-separated allowlist of service ids, so the
  // culprit can be bisected
  if ($destruct !== false && $destruct !== "0") {
    $only = is_string($destruct) ? explode(",", $destruct) : null;
    // theme.registry is EXCLUDED, and it is the one service whose destruct() cannot
    // be used here. Bisected one service at a time: state, menu.active_trail,
    // router.builder, library.discovery and library.parsing_cache all destruct
    // safely (12,310-byte render, every render); theme.registry alone gives 12,304
    // on render 1 and then 0 BYTES on every render after it.
    // Registry::destruct() persists the RUNTIME registry, which core\x27s own docblock
    // calls "incomplete". Clearing cache_bootstrap between renders does NOT fix it,
    // so the corruption is the in-memory collector object, which survives because
    // this interpreter reuses the container across requests. Registry::reset() is not
    // an escape either -- it deletes the theme_registry:runtime:* cids that destruct()
    // just wrote, so it undoes the persistence it would be repairing.
    // The COMPLETE registry was never at risk: Registry::get() persists that itself
    // via setCache() when the module handler is loaded, with no destruct() involved.
    $skip = ["theme.registry"];
    try {
      $c = \\Drupal::getContainer();
      $GLOBALS["__pw_destructed"] = [];
      foreach ($c->getParameter("kernel.destructable_services") as $id) {
        if ($only !== null && !in_array($id, $only, true)) { continue; }
        if ($only === null && in_array($id, $skip, true)) { continue; }
        if (!$c->initialized($id)) { continue; }
        $svc = $c->get($id);
        if ($svc instanceof \\Drupal\\Core\\DestructableInterface) {
          $svc->destruct();
          $GLOBALS["__pw_destructed"][] = $id;
        }
      }
    } catch (\\Throwable $e) {}
  }

  return $response;
}
'); }
`;

/**
 * A real Drupal request whose database is the Durable Object.
 *
 * Rule 3 of this project is applied here rather than trusted: every response
 * reports x-drupal-cache and x-drupal-dynamic-cache, and the caller asserts on
 * them. A dozen figures in TECHNICAL_REPORT.md were page_cache HITs wearing a render's
 * label because Request::create() carries no session cookie, so
 * DefaultRequestPolicy marks the request cacheable and handle() costs 0.5 ms
 * while nothing renders.
 *
 * Timing is taken inside a closure. At the eval'd global scope anything walking a
 * backtrace inflates 12-24x, invisibly.
 */
/**
 * Builds the PHP for one measured Drupal request.
 *
 * `bins` is the load-bearing parameter, because Drupal has three separate
 * caches in front of a render and each one produces a different number wearing
 * the same label. Measured on this driver:
 *
 *   []                              -> page_cache HIT, 1 ms, 1 statement
 *   ['page']                        -> dynamic_page_cache HIT, 8-15 ms, 5 statements
 *   ['page','dynamic_page_cache']   -> a real render
 *
 * So a render figure has to name which bins were emptied. Reporting one
 * without that is how a dozen figures in TECHNICAL_REPORT.md came to be page_cache hits.
 *
 * @param {string} path Drupal path to request.
 * @param {number} repeat How many times, in one interpreter.
 * @param {string[]} bins Cache bins to empty before each run.
 * @param {boolean} resetCid Whether to null PageCache's memoized cid.
 */
/**
 * Boots the Drupal kernel and STOPS. No request is handled.
 *
 * This is the snapshot point a heap restore needs, and "post-boot, pre-render" means exactly here:
 * after the kernel and its container exist, before any request has touched them. A snapshot taken
 * after a render is a request-contaminated heap, which is what collides with the uid-1
 * cache-poisoning bug.
 *
 * It memoises into the same `$GLOBALS['__pw_kernel']` slot the render path uses, so a later render
 * in the same interpreter reuses this kernel rather than booting a second one.
 */
export const BOOT_KERNEL = String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
chdir('/drupal');

$clock = function () { return microtime(true) * 1000; };
$mark = [];
$t0 = $clock();

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];
  $mark['alreadyBooted'] = isset($GLOBALS['__pw_site_booted']) ? 1 : 0;

  if (!isset($GLOBALS['__pw_kernel'])) {
    $a = $clock();
    $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $mark['kernelBootMs'] = round($clock() - $a, 2);
    $GLOBALS['__pw_kernel'] = $kernel;
    $GLOBALS['__pw_site_booted'] = true;
  }

  // the container has to be reachable, or the "booted" claim is empty
  $container = \Drupal::hasContainer() ? \Drupal::getContainer() : null;
  $mark['ok'] = $container !== null;
  $mark['hasDb'] = $container !== null && $container->has('database');
  $mark['totalMs'] = round($clock() - $t0, 2);
  echo json_encode($mark);
} catch (\Throwable $e) {
  echo json_encode(['ok' => false, 'error' => get_class($e) . ': ' . $e->getMessage()]);
}
`;

/**
 * The boot phases, in the order a boot runs them.
 *
 * `container-read` and `container-unserialize` are BRANCHES off `kernel-new`, not steps on the way to
 * `kernel-boot`: both measure what `$kernel->boot()` is about to do without letting it happen, so
 * their baseline is `kernel-new` and so is `kernel-boot`'s. Running them inline before the boot would
 * warm whatever the read touches and make the boot look cheaper than it is.
 */
export const BOOT_PHASES = [
	'autoload',
	'kernel-new',
	'container-read',
	'container-unserialize',
	'kernel-boot',
	'pre-handle',
	'render'
] as const;

export type BootPhase = (typeof BOOT_PHASES)[number];

/**
 * One boot phase, cumulatively: runs every phase up to `phase` and then stops.
 *
 * One invocation per phase. About 850 ms survives a container cache HIT and nothing is attributed
 * inside it -- the largest unexplained cost in the project and 85x the free cap on its own. It cannot
 * be split from inside, because on the edge `microtime()` and `Date.now()` both return 0 (RULE 0), so
 * the only clock that reports anything is `cpuTime` in `wrangler tail`, and that meters an INVOCATION.
 * A phase therefore needs an invocation of its own, and the cost of phase N is
 * `cpuTime(N) - cpuTime(N-1)`.
 *
 * The caller must drop the interpreter before each measurement. `BOOT_KERNEL` memoises the kernel into
 * `$GLOBALS['__pw_kernel']`, so a second phase measured against a warm object measures nothing and
 * reports a plausible small number -- which is how this cost stayed unattributed in the first place.
 *
 * Each fragment echoes what it actually did rather than only how long it took, because the elapsed
 * figure it prints is a LOCAL number and is worthless on the edge. The byte counts are the useful
 * output: `containerBytes` is the row the read had to carry across the host bridge.
 */
export function bootPhaseFragment(phase: BootPhase): string {
	const index = BOOT_PHASES.indexOf(phase);
	if (index < 0) throw new RangeError(`unknown boot phase: ${phase}`);
	const upto = (name: BootPhase): boolean => index >= BOOT_PHASES.indexOf(name);

	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
${upto('render') ? PW_SERVE_INLINE : ''}
chdir('/drupal');

$mark = ['phase' => ${JSON.stringify(phase)}];
$clock = function () { return microtime(true) * 1000; };
$t0 = $clock();

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
  // a warm object would make every phase past this one free, and a free phase reads as a cheap one
  $mark['alreadyBooted'] = isset($GLOBALS['__pw_site_booted']) ? 1 : 0;

  $autoloader = require_once '/drupal/autoload.php';
  $mark['autoloadDone'] = true;
${
	upto('kernel-new')
		? String.raw`
  $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
  $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
  \Drupal\Core\DrupalKernel::bootEnvironment();
  $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
  $kernel->setSitePath($sitePath);
  \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
  $mark['kernelConstructed'] = true;`
		: ''
}
${
	phase === 'container-read' || phase === 'container-unserialize'
		? String.raw`
  // 3.1's suspect, isolated. This is the row $kernel->boot() reads, fetched the same way -- across
  // the host bridge, which encodes every value through json_encode(pw_encode()). Selecting data
  // rather than LENGTH(data): the question is what carrying half a megabyte through that
  // bridge costs, and LENGTH() would answer it with an integer.
  $rows = cfw_sql('SELECT cid, data FROM cache_container LIMIT 1');
  $row = is_array($rows) && isset($rows['rows'][0]) ? $rows['rows'][0] : null;
  $blob = is_array($row) ? (string) ($row['data'] ?? '') : '';
  $mark['containerRowFound'] = $row !== null;
  $mark['containerCid'] = is_array($row) ? substr((string) ($row['cid'] ?? ''), 0, 80) : null;
  $mark['containerBytes'] = strlen($blob);`
		: ''
}
${
	phase === 'container-unserialize'
		? String.raw`
  // and separately, what turning those bytes into an object graph costs. Split from the read because
  // "reading 479 KB is slow" and "unserialising 479 KB is slow" are different problems with different
  // fixes, and the container cache is the only place either would show up.
  $graph = $blob === '' ? null : @unserialize($blob);
  $mark['unserialized'] = $graph !== false && $graph !== null;
  $mark['unserializedType'] = get_debug_type($graph);`
		: ''
}
${
	upto('kernel-boot') && phase !== 'container-read' && phase !== 'container-unserialize'
		? String.raw`
  $kernel->boot();
  $mark['booted'] = \Drupal::hasContainer();`
		: ''
}
${
	upto('pre-handle') && phase !== 'container-read' && phase !== 'container-unserialize'
		? String.raw`
  $kernel->preHandle($request);
  $mark['preHandled'] = true;`
		: ''
}
${
	phase === 'render'
		? String.raw`
  $GLOBALS['__pw_kernel'] = $kernel;
  $GLOBALS['__pw_site_booted'] = true;
  // cfw_serve() hands back a Symfony Response, not a string; treating it as one reported -1 bytes
  // for a render that had in fact succeeded, which is a broken instrument reading as a broken render
  $response = cfw_serve('/');
  $body = is_object($response) && method_exists($response, 'getContent')
    ? (string) $response->getContent()
    : (is_string($response) ? $response : '');
  $mark['renderStatus'] = is_object($response) && method_exists($response, 'getStatusCode')
    ? $response->getStatusCode()
    : null;
  $mark['renderBytes'] = strlen($body);`
		: ''
}
  // a LOCAL figure, kept only so a local run is orderable; it reads 0 on the edge, where the real
  // number is cpuTime from wrangler tail
  $mark['localMs'] = round($clock() - $t0, 2);
  $mark['ok'] = true;
  echo json_encode($mark);
} catch (\Throwable $e) {
  $mark['ok'] = false;
  $mark['error'] = get_class($e) . ': ' . $e->getMessage();
  echo json_encode($mark);
}
`;
}

/**
 * The `cfw_ops` registry, read WITHOUT booting a kernel.
 *
 * `OpsRegistry` is a `final class` with no `use` statements and no constructor -- it returns a literal
 * array of eight operations, each declaring `label`, `writes`, `sliced` and a measured `cost`. So it
 * is reachable by requiring its file directly, which matters: a discovery endpoint that costs a
 * ~1,400 ms kernel boot to answer "what can I run" is not a discovery endpoint. The boot-phase
 * measurement puts `autoload` at the cheap end, and this does not even need that.
 *
 * Requiring by PATH rather than by autoload. Drupal registers module namespaces during
 * kernel boot, so `Drupal\drupflare\Ops\OpsRegistry` does not resolve through the composer
 * autoloader on its own, and relying on it would work only in the one case this fragment exists to
 * avoid.
 */
export const OPS_REGISTRY = String.raw`<?php
$path = '/drupal/modules/custom/drupflare/src/Ops/OpsRegistry.php';
if (!is_file($path)) {
  echo json_encode(['ok' => false, 'error' => 'OpsRegistry is not in the mount at ' . $path]);
  return;
}
require_once $path;
$cls = 'Drupal\\drupflare\\Ops\\OpsRegistry';
if (!class_exists($cls, false)) {
  echo json_encode(['ok' => false, 'error' => 'OpsRegistry did not declare its class']);
  return;
}
$ops = $cls::operations();
echo json_encode([
  'ok' => true,
  'count' => count($ops),
  'operations' => $ops,
  // the fail-closed pair, reported rather than assumed: an unknown name must read as writing and
  // sliced, so a caller that forgets has() cannot expose a mutation as a read
  'failsClosed' => [
    'writes' => $cls::writes('not-a-command'),
    'sliced' => $cls::sliced('not-a-command'),
  ],
  'readOnlyUnsliced' => $cls::readOnlyUnsliced(),
]);
`;

export function drupalRequest(
	path = '/',
	repeat = 1,
	bins: string[] = ['page', 'dynamic_page_cache'],
	resetCid = true
): string {
	const safePath = JSON.stringify(String(path));
	const safeRepeat = Number.isInteger(repeat) && repeat > 0 ? repeat : 1;
	const safeBins = JSON.stringify(
		(Array.isArray(bins) ? bins : []).filter((b) => /^[a-z_]+$/.test(b))
	);
	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
${PW_SERVE_INLINE}
chdir('/drupal');

$path = json_decode(${JSON.stringify(safePath)});
$repeat = ${safeRepeat};
$bins = json_decode(${JSON.stringify(safeBins)}, true);
$resetCid = ${resetCid ? 'true' : 'false'};

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = $path;
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['HTTP_USER_AGENT'] = 'workerd-site';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

$mark = [];
$clock = function () { return microtime(true) * 1000; };
$statements = function () { return json_decode(cfw_host('cfwStats')(), true)['queryCount'] ?? 0; };

$t0 = $clock();
try {
  // require_once returns true rather than the autoloader once the interpreter
  // has already loaded the file, and the interpreter persists between requests
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];
  $mark['autoloadMs'] = round($clock() - $t0, 2);
  $mark['warmInterpreter'] = isset($GLOBALS['__pw_site_booted']) ? 1 : 0;

  if (!isset($GLOBALS['__pw_kernel'])) {
    $a = $clock();
    $request = \Symfony\Component\HttpFoundation\Request::create($path, 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $mark['settingsMs'] = round($clock() - $a, 2);

    // prove the driver Drupal actually connected with, before anything renders
    $info = \Drupal\Core\Database\Database::getConnectionInfo('default');
    $mark['configuredDriver'] = $info['default']['driver'] ?? null;

    $a = $clock();
    $kernel->boot();
    $mark['kernelBootMs'] = round($clock() - $a, 2);
    $GLOBALS['__pw_kernel'] = $kernel;
    $GLOBALS['__pw_site_booted'] = true;
  }
  $kernel = $GLOBALS['__pw_kernel'];

  $connection = \Drupal\Core\Database\Database::getConnection();
  $mark['connectionClass'] = get_class($connection);
  $mark['driver'] = $connection->driver();
  $mark['engineVersion'] = $connection->version();
  $mark['engineVersionIsFloor'] = method_exists($connection, 'engineVersionIsFloor') ? $connection->engineVersionIsFloor() : null;

  $runs = [];
  for ($i = 0; $i < $repeat; $i++) {
    // Rule 3, and a query string is NOT enough to get past it. PageCache
    // memoizes $this->cid on the middleware instance, so on a persistent kernel
    // every URL maps to the first request's cid and re-serves its page -- the
    // measured shape was MISS then five HITs at 1 ms with byte-identical output
    // for six different URLs. Emptying the bin is what forces a real render.
    // $bust=0 leaves the cached path measurable.
    $target = $path;
    foreach ($bins as $bin) {
      try { \Drupal::cache($bin)->deleteAll(); } catch (\Throwable $e) {}
    }
    // PageCache memoizes $this->cid on the middleware instance, so a persistent
    // kernel maps every later URL onto the first request's cid and re-serves its
    // page. Measured: six different URLs returned byte-identical output. Nulling
    // it is what makes a distinct path actually route.
    if ($resetCid) {
      try {
        $middleware = \Drupal::service('http_middleware.page_cache');
        $rp = new \ReflectionProperty($middleware, 'cid');
        $rp->setValue($middleware, NULL);
      } catch (\Throwable $e) {}
    }
    $before = $statements();
    $a = $clock();
    $response = cfw_serve($target);
    $ms = round($clock() - $a, 2);
    $body = (string) $response->getContent();
    $runs[] = [
      'ms' => $ms,
      'status' => $response->getStatusCode(),
      'bytes' => strlen($body),
      'pageCache' => $response->headers->get('x-drupal-cache'),
      'dynamicCache' => $response->headers->get('x-drupal-dynamic-cache'),
      'hostStatements' => $statements() - $before,
      'titleFound' => str_contains($body, '<title>') ? 1 : 0,
      'sha1' => substr(sha1($body), 0, 12),
    ];
  }
  $mark['runs'] = $runs;
} catch (\Throwable $e) {
  $mark['error'] = get_class($e) . ': ' . $e->getMessage();
  $mark['trace'] = substr($e->getTraceAsString(), 0, 1400);
}

$mark['totalMs'] = round($clock() - $t0, 2);
$mark['includedFiles'] = count(get_included_files());
echo json_encode($mark);
`;
}

/**
 * Renders one path and hands the HTML back, for the alarm to store.
 *
 * Separate from drupalRequest() because that one reports timings for measurement
 * and this one produces a cache entry. Both empty the page bin first: the point of
 * an alarm fill is to produce a fresh render, and PageCache would otherwise answer
 * from its own memoized cid.
 *
 * `bins` names what is emptied, and it is load-bearing rather than cosmetic:
 * `['page']` alone leaves `dynamic_page_cache` warm, so the page is REASSEMBLED
 * from cached render arrays instead of rendered. That is the cheap path a
 * pre-filled site takes on a MISS, and the two cost 4.3x different amounts, so a
 * caller has to choose which one it is asking for.
 *
 * `destruct` defaults to FALSE on the render path, and that is a measured decision
 * rather than an oversight.
 *
 * The hypothesis was that nothing ever completed the request lifecycle, so every
 * `needs_destruction` CacheCollector discarded its accumulated entries instead of
 * writing them, and the render paid to rebuild them every time. The mechanism is
 * real. The payoff is not: with the five safe services destructing, a repeated
 * anonymous front-page render costs **17 host statements against 15**, writes the
 * **same 15 rows**, and returns the same 12,310 bytes. Cost, no benefit.
 *
 * The reason is the same property that made `$kernel->terminate()` dangerous here:
 * the interpreter is PERSISTENT, so the collectors are already populated in memory
 * and never re-read from cache. Persistence only pays for a fresh process. On this
 * runtime the in-memory collector IS the cache.
 *
 * Still worth passing `true` on a WRITE path, where `router.builder`'s
 * `rebuildIfNeeded()` and accumulated state flushes are correctness rather than
 * speed. Unmeasured: whether persisted collectors pay for themselves on the COLD
 * path, after a hibernation discards the interpreter.
 *
 * @param {string} path
 * @param {string[]} bins
 * @param {boolean|string} destruct true, false, or an allowlist to bisect with
 */
export interface RenderRequest {
	/**
	 * the `scheme://host[:port]` Drupal renders absolute URLs against.
	 *
	 * Empty means "leave it to Symfony", which fills in `http://localhost` -- correct for a probe
	 * and wrong for anything a visitor sees. `src/ops/site-origin.ts` decides the value; it is a
	 * property of the site rather than of the request, so a forged `Host` cannot move it.
	 */
	origin?: string;
	/** HTTP method; anything other than GET makes this a submission */
	method?: string;
	/** the raw request body, forwarded verbatim */
	body?: string;
	/** the inbound content type, which decides whether the body is parsed as a form */
	contentType?: string;
	/**
	 * the raw `Cookie` header, which is what makes a request authenticated.
	 *
	 * Without it every render is uid 0, so Drupal refuses a create-entity route at the ROUTING
	 * layer and no form is built at all -- see `tests/integration/submission-wall.spec.ts`, which
	 * named that wall before this existed.
	 */
	cookie?: string;
	/**
	 * the visitor's address, from `CF-Connecting-IP`.
	 *
	 * Drupal's flood control identifies by `getClientIp()`, and every render used to report
	 * `127.0.0.1` -- so `user.failed_login_ip` (limit 50, window 3600) was ONE bucket for the whole
	 * site: fifty bad passwords locked every visitor out of `/user/login` for an hour, and per-IP
	 * throttling of contact forms and password resets did nothing. Cloudflare overwrites this header
	 * at the edge, so it is trustworthy there and is whatever the client sent under `wrangler dev`.
	 */
	clientIp?: string;
}

export function renderPage(
	path = '/',
	bins: string[] = ['page', 'dynamic_page_cache'],
	destruct: boolean | string = false,
	request: RenderRequest = {}
): string {
	const safePath = JSON.stringify(String(path));
	const safeBins = JSON.stringify(
		(Array.isArray(bins) ? bins : []).filter((b) => /^[a-z_]+$/.test(b))
	);
	// true | false | an allowlist of service ids to bisect with
	const safeDestruct =
		typeof destruct === 'string'
			? JSON.stringify(
					destruct
						.split(',')
						.filter((id: string) => /^[a-z_][a-z0-9_.]*$/.test(id))
						.join(',')
				)
			: destruct
				? 'true'
				: 'false';
	// JSON-encoded, never interpolated: a body carrying a quote would otherwise close the PHP
	// literal and change what runs, which is the same hazard the file's backtick rule exists for.
	const method = String(request.method ?? 'GET').toUpperCase();
	const origin = String(request.origin ?? '');
	// an ANONYMOUS GET with no origin still emits nothing extra, so every pre-existing caller's
	// source is byte-identical; a cookie is enough on its own to need the argument list, because an
	// authenticated GET is exactly the case this exists for
	const clientIp = String(request.clientIp ?? '');
	const requestArgs =
		method === 'GET' && !request.body && !request.cookie && origin === '' && clientIp === ''
			? ''
			: `, json_decode(${JSON.stringify(JSON.stringify(method))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(String(request.body ?? '')))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(String(request.contentType ?? '')))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(String(request.cookie ?? '')))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(origin))})` +
				`, json_decode(${JSON.stringify(JSON.stringify(clientIp))})`;

	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
${PW_SERVE_INLINE}
chdir('/drupal');

$path = json_decode(${JSON.stringify(safePath)});
$origin = json_decode(${JSON.stringify(JSON.stringify(origin))});

// the host trio is derived from the ORIGIN rather than hardcoded, and cfw_serve() overwrites it
// again from the request it builds, so the superglobals and the Request object cannot disagree
$__host = $origin === '' ? 'localhost' : (string) parse_url($origin, PHP_URL_HOST);
$__port = $origin === '' ? 80 : (int) (parse_url($origin, PHP_URL_PORT) ?: (strncmp($origin, 'https:', 6) === 0 ? 443 : 80));
$_SERVER['HTTP_HOST'] = $__port === 80 || $__port === 443 ? $__host : $__host . ':' . $__port;
$_SERVER['SERVER_NAME'] = $__host;
$_SERVER['SERVER_PORT'] = (string) $__port;
if (strncmp($origin, 'https:', 6) === 0) { $_SERVER['HTTPS'] = 'on'; } else { unset($_SERVER['HTTPS']); }
$_SERVER['REQUEST_URI'] = $path;
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

$out = [];
$clock = function () { return microtime(true) * 1000; };
$t0 = $clock();

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];

  if (!isset($GLOBALS['__pw_kernel'])) {
    $request = \Symfony\Component\HttpFoundation\Request::create($path, 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
    $out['bootedKernel'] = 1;
  }

  // a fill must render, so clear what would otherwise answer for it
  foreach (json_decode(${JSON.stringify(safeBins)}, true) as $bin) {
    try { \Drupal::cache($bin)->deleteAll(); } catch (\Throwable $e) {}
  }
  try {
    $middleware = \Drupal::service('http_middleware.page_cache');
    $rp = new \ReflectionProperty($middleware, 'cid');
    $rp->setValue($middleware, NULL);
  } catch (\Throwable $e) {}

  $response = cfw_serve($path, ${safeDestruct}${requestArgs});
  $out['destructed'] = $GLOBALS["__pw_destructed"] ?? null;
  // sendContent() RATHER THAN getContent(), and the difference is whether forms work at all.
  // BigPipe replaces the CSRF token with a lazy placeholder and substitutes it during
  // BigPipeResponse::sendContent(); getContent() returns the pre-substitution HTML, so every form
  // shipped a big_pipe_nojs_placeholder_attribute_safe marker where its token belonged, and every
  // submission came back "The form has become outdated".
  //
  // Buffered rather than sent, because there is no SAPI here to send to. Safe for a plain
  // Response, whose sendContent() only echoes what getContent() returns; a throw falls back to it.
  $body = '';
  if (method_exists($response, 'sendContent')) {
    $depth = ob_get_level();
    ob_start();
    try {
      $response->sendContent();
      $body = (string) ob_get_clean();
    } catch (\Throwable $e) {
      while (ob_get_level() > $depth) { @ob_end_clean(); }
      $out['sendError'] = get_class($e) . ': ' . $e->getMessage();
      $body = (string) $response->getContent();
    }
  } else {
    $body = (string) $response->getContent();
  }
  $out['status'] = $response->getStatusCode();
  $out['html'] = $body;
  $out['bytes'] = strlen($body);
  $out['pageCache'] = $response->headers->get('x-drupal-cache');
  $out['dynamicCache'] = $response->headers->get('x-drupal-dynamic-cache');
  $out['contentType'] = $response->headers->get('content-type');
  $out['location'] = $response->headers->get('location');
  // what Drupal said about storing this, which page_cache_kill_switch and any module with a
  // reason to opt out both express here and nowhere else
  $out['cacheControl'] = $response->headers->get('cache-control');
  // BOTH SOURCES, because Drupal sets a session cookie through neither one consistently:
  // a logout or a Symfony-managed cookie lands on the Response, while session_start() emits its
  // own Set-Cookie into PHP's header list, which the Response never sees. Reading one of them
  // would drop the login cookie silently and leave the session unrecoverable by the browser.
  $cookies = [];
  foreach ($response->headers->all('set-cookie') as $line) { $cookies[] = (string) $line; }
  if (function_exists('headers_list')) {
    foreach (headers_list() as $line) {
      if (stripos($line, 'set-cookie:') === 0) { $cookies[] = trim(substr($line, 11)); }
    }
  }
  $out['setCookie'] = array_values(array_unique($cookies));
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}

// what the between-request reset actually did, and who Drupal thinks is asking. Both are cheap
// reads and both were needed to find the session leak; a render that comes back as the WRONG USER
// is not distinguishable from a correct one by its bytes
$out['reset'] = $GLOBALS['__pw_reset'] ?? null;
try {
  $out['uid'] = (int) \Drupal::currentUser()->id();
} catch (\Throwable $e) { $out['uid'] = null; }

$out['renderMs'] = round($clock() - $t0, 2);
echo json_encode($out);
`;
}

/**
 * Invalidates cache tags through Drupal's own service, nothing else.
 *
 * Exists so the edge cache's automatic invalidation seam can be PROVEN rather
 * than asserted: `DatabaseCacheTagsChecksum` writes to `cachetags` from here, the
 * write crosses `execSql()`, and the Durable Object bumps its generation. Without
 * this route the trigger could only be exercised by saving a node, which this
 * site has none of.
 *
 * @param {string[]} tags
 */
export function invalidateTags(tags: string[] = ['rendered']): string {
	const safe = JSON.stringify(
		(Array.isArray(tags) ? tags : []).filter((t) => /^[A-Za-z0-9_:.-]+$/.test(t))
	);
	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
chdir('/drupal');

$tags = json_decode(${JSON.stringify(safe)}, true);
$out = ['tags' => $tags];

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];
  if (!isset($GLOBALS['__pw_kernel'])) {
    $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
  }
  \Drupal\Core\Cache\Cache::invalidateTags($tags);
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}

echo json_encode($out);
`;
}

/**
 * The driver's own assertions, run against ctx.storage.sql.
 *
 * `tests/run-driver-suite.php` proves the PHP half against a PDO host. This is
 * the same shapes against the real one, so what it adds is exactly the runtime
 * behaviour a stand-in cannot model. It boots no kernel: the driver is
 * constructed directly, because a failure here should point at the driver rather
 * than at Drupal's container.
 */
export const DRIVER_LIVE_SUITE = String.raw`<?php
${HOST_HELPERS}

$out = ['passed' => 0, 'failed' => 0, 'checks' => []];
$ok = function ($label, $condition, $detail = null) use (&$out) {
  if ($condition) { $out['passed']++; }
  else { $out['failed']++; }
  $out['checks'][] = ['label' => $label, 'ok' => (bool) $condition, 'detail' => $detail];
};

if (!isset($GLOBALS['__pw_autoloader'])) {
  $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
}
$autoloader = $GLOBALS['__pw_autoloader'];
$autoloader->addPsr4('Drupal\\sqlite\\Driver\\Database\\sqlite\\', '/drupal/core/modules/sqlite/src/Driver/Database/sqlite/');
$autoloader->addPsr4('Drupal\\cfw_do_sqlite\\Driver\\Database\\cfw_do_sqlite\\', '/drupal/modules/custom/cfw_do_sqlite/src/Driver/Database/cfw_do_sqlite/');
// this suite constructs the driver directly rather than through settings.php, so it is on its own
// for the userland PDO the statement classes need; see src/site-do.js for the served path
require_once '/drupal/modules/custom/cfw_do_sqlite/src/pdo-shim.php';

try {
  \Drupal\Core\DrupalKernel::bootEnvironment();
} catch (\Throwable $e) {
  // already booted in this interpreter, which is fine
}

try {
  $client = new \Drupal\cfw_do_sqlite\Driver\Database\cfw_do_sqlite\CfwSqlClient();
  $ok('client constructs against the live bridge', true);
  $ok('client reports transaction support', $client->supportsTransactions());

  $connection = new \Drupal\cfw_do_sqlite\Driver\Database\cfw_do_sqlite\Connection($client, ['prefix' => '']);
  $ok('connection constructs', true);
  $ok('driver() is cfw_do_sqlite', $connection->driver() === 'cfw_do_sqlite', $connection->driver());
  $ok('databaseType() is sqlite', $connection->databaseType() === 'sqlite', $connection->databaseType());

  $version = $connection->version();
  $ok('version() returns an engine version through the DBAL', (bool) preg_match('/^3\./', (string) $version), $version);
  $ok('supportsAtomicCommit()', $connection->supportsAtomicCommit());

  $schema = $connection->schema();
  $connection->query('DROP TABLE IF EXISTS cfw_live');
  $schema->createTable('cfw_live', [
    'fields' => [
      'id' => ['type' => 'serial', 'not null' => TRUE],
      // binary FALSE is the only thing that makes core emit a collation clause,
      // which is what Schema then rewrites to builtin NOCASE
      'name' => ['type' => 'varchar', 'length' => 64, 'not null' => TRUE, 'binary' => FALSE],
      'bin' => ['type' => 'varchar', 'length' => 64, 'not null' => FALSE],
      'n' => ['type' => 'int', 'not null' => FALSE],
    ],
    'primary key' => ['id'],
    'indexes' => ['name' => ['name']],
  ]);
  $ddl = $connection->query('SELECT sql FROM sqlite_master WHERE name = :n', [':n' => 'cfw_live'])->fetchField();
  $ok('createTable() emitted COLLATE NOCASE, not NOCASE_UTF8', str_contains((string) $ddl, 'COLLATE NOCASE') && !str_contains((string) $ddl, 'NOCASE_UTF8'), $ddl);
  $ok('schema()->createTable() through the DBAL', $schema->tableExists('cfw_live'));
  $ok('fieldExists() uses PRAGMA table_info', $schema->fieldExists('cfw_live', 'name'));
  $ok('indexExists() uses PRAGMA index_list', $schema->indexExists('cfw_live', 'name'));

  $id = $connection->insert('cfw_live')->fields(['name' => 'first', 'n' => 7])->execute();
  $ok('insert() returns a rowid', (string) $id === '1', $id);

  $connection->insert('cfw_live')->fields(['name' => 'second', 'n' => 8])->execute();
  $count = $connection->select('cfw_live', 'c')->countQuery()->execute()->fetchField();
  $ok('select() countQuery sees both rows', (string) $count === '2', $count);

  $name = $connection->query('SELECT name FROM {cfw_live} WHERE n = :n', [':n' => 8])->fetchField();
  $ok('query() with a named placeholder', $name === 'second', $name);

  $connection->update('cfw_live')->fields(['n' => 9])->condition('name', 'first')->execute();
  $n = $connection->query('SELECT n FROM {cfw_live} WHERE name = :name', [':name' => 'first'])->fetchField();
  $ok('update() through the DBAL', (string) $n === '9', $n);

  // ASCII case-insensitivity survives the NOCASE substitution
  $hit = $connection->query('SELECT COUNT(*) FROM {cfw_live} WHERE name = :name', [':name' => 'FIRST'])->fetchField();
  $ok('NOCASE folds ASCII on a binary=FALSE column', (string) $hit === '1', $hit);

  // the documented limitation, asserted rather than assumed: builtin NOCASE is
  // ASCII-only, so non-ASCII comparison stays case-SENSITIVE
  $connection->insert('cfw_live')->fields(['name' => "\u{00DC}nicode", 'n' => 1])->execute();
  $folded = $connection->query('SELECT COUNT(*) FROM {cfw_live} WHERE name = :name', [':name' => "\u{00FC}nicode"])->fetchField();
  $ok('NOCASE does NOT fold non-ASCII (documented gap)', (string) $folded === '0', $folded);
  $connection->delete('cfw_live')->condition('name', "\u{00DC}nicode")->execute();

  // a column without binary=FALSE gets no collation clause, so it stays
  // case-sensitive; this is the control that proves the check above means
  // something
  $connection->update('cfw_live')->fields(['bin' => 'Exact'])->condition('name', 'first')->execute();
  $binHit = $connection->query('SELECT COUNT(*) FROM {cfw_live} WHERE bin = :v', [':v' => 'exact'])->fetchField();
  $ok('a column with default collation stays case-sensitive (control)', (string) $binHit === '0', $binHit);

  // LIKE BINARY, which threw before likeToGlob() was wired in. Every one of
  // these is a case where builtin GLOB alone would have been silently wrong.
  $connection->insert('cfw_live')->fields(['name' => 'Alpha%Beta', 'n' => 20])->execute();
  $connection->insert('cfw_live')->fields(['name' => 'Alpha*Beta', 'n' => 21])->execute();
  $connection->insert('cfw_live')->fields(['name' => 'alphaxbeta', 'n' => 22])->execute();

  $lb = function ($pattern) use ($connection) {
    return (string) $connection->select('cfw_live', 'c')
      ->condition('name', $pattern, 'LIKE BINARY')
      ->countQuery()->execute()->fetchField();
  };
  $ok('LIKE BINARY no longer throws', TRUE);
  $ok('LIKE BINARY % is a wildcard', $lb('Alpha%') === '2', $lb('Alpha%'));
  $ok('LIKE BINARY is case-sensitive', $lb('alpha%') === '1', $lb('alpha%'));
  $ok('LIKE BINARY _ matches one character', $lb('alpha_beta') === '1', $lb('alpha_beta'));
  $ok('LIKE BINARY treats * as a literal', $lb('%*%') === '1', $lb('%*%'));
  $ok('LIKE BINARY finds a literal percent', $lb('%\\%%') === '0', $lb('%\\%%'));
  $notLike = (string) $connection->select('cfw_live', 'c')
    ->condition('name', 'Alpha%', 'NOT LIKE BINARY')
    ->countQuery()->execute()->fetchField();
  $ok('NOT LIKE BINARY negates', $notLike !== '0', $notLike);

  // the entity-query path that generates LIKE BINARY in the first place
  $starts = (string) $connection->select('cfw_live', 'c')
    ->condition('name', $connection->escapeLike('Alpha') . '%', 'LIKE BINARY')
    ->countQuery()->execute()->fetchField();
  $ok('STARTS_WITH shape through escapeLike()', $starts === '2', $starts);

  $connection->delete('cfw_live')->condition('n', 20, '>=')->execute();

  // a real transaction, buffered in PHP and replayed atomically in the host
  $txn = $connection->startTransaction();
  $connection->insert('cfw_live')->fields(['name' => 'buffered', 'n' => 10])->execute();
  $inside = $connection->select('cfw_live', 'c')->countQuery()->execute()->fetchField();
  $ok('a read inside the transaction sees its own buffered write', (string) $inside === '3', $inside);
  unset($txn);
  $afterCommit = $connection->select('cfw_live', 'c')->countQuery()->execute()->fetchField();
  $ok('commit replays the buffer', (string) $afterCommit === '3', $afterCommit);

  $txn2 = $connection->startTransaction();
  $connection->insert('cfw_live')->fields(['name' => 'doomed', 'n' => 11])->execute();
  $txn2->rollBack();
  unset($txn2);
  $afterRollback = $connection->select('cfw_live', 'c')->countQuery()->execute()->fetchField();
  $ok('rollback writes nothing', (string) $afterRollback === '3', $afterRollback);

  // queryRange, which the core sqlite driver implements with LIMIT/OFFSET
  $range = $connection->queryRange('SELECT name FROM {cfw_live} ORDER BY id', 1, 1)->fetchField();
  $ok('queryRange()', $range === 'second', $range);

  // CREATE TEMPORARY TABLE is refused by the host authorizer, so the contract is
  // that queryTemporary() throws a message naming the reason rather than
  // surfacing a raw SQLITE_AUTH from somewhere deeper
  try {
    $connection->queryTemporary('SELECT name FROM {cfw_live}', []);
    $ok('queryTemporary() refuses loudly', false, 'no exception thrown');
  } catch (\Drupal\Core\Database\InvalidQueryException $e) {
    $ok('queryTemporary() refuses loudly', str_contains($e->getMessage(), 'SQLITE_AUTH'), $e->getMessage());
  }

  // a constraint violation must map onto Drupal's exception, not a raw error
  try {
    $connection->query('INSERT INTO {cfw_live} (id, name, n) VALUES (1, :name, 0)', [':name' => 'dupe']);
    $ok('duplicate primary key throws IntegrityConstraintViolationException', false, 'no exception');
  } catch (\Drupal\Core\Database\IntegrityConstraintViolationException $e) {
    $ok('duplicate primary key throws IntegrityConstraintViolationException', true);
  } catch (\Throwable $e) {
    $ok('duplicate primary key throws IntegrityConstraintViolationException', false, get_class($e) . ': ' . $e->getMessage());
  }

  $out['statementCount'] = $client->statementCount();
  $connection->query('DROP TABLE IF EXISTS cfw_live');
} catch (\Throwable $e) {
  $out['fatal'] = get_class($e) . ': ' . $e->getMessage();
  $out['trace'] = substr($e->getTraceAsString(), 0, 1200);
}

echo json_encode($out);
`;

/**
 * Dumps ctx.storage.sql back out as portable SQL.
 *
 * The other half of MIGRATE_DB, and the half that backup/restore was missing:
 * a site whose data cannot be extracted is not a product. Reads the schema and
 * every row through the SAME bridge the driver uses, so what it exports is exactly
 * what Drupal sees rather than a second opinion from a different path.
 *
 * Emits one statement per line so the caller can stream it to R2 in chunks instead
 * of holding a whole site in memory. NOCASE is left as-is: it is what the host
 * accepts, and rewriting it back to NOCASE_UTF8 would produce a dump that only
 * restores onto a driver with user-defined collations.
 */
export function exportDatabase(limitPerTable = 0): string {
	const cap = Number.isInteger(limitPerTable) && limitPerTable > 0 ? limitPerTable : 0;
	return String.raw`<?php
${HOST_HELPERS}

$cap = ${cap};
$out = ['ok' => false, 'statements' => 0, 'bytes' => 0, 'tables' => [], 'sql' => ''];
$lines = [];

$master = cfw_sql("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name");
if (($master['ok'] ?? false) !== true) {
  echo json_encode(['ok' => false, 'error' => $master['error'] ?? 'cannot read sqlite_master']);
  return;
}

$tables = [];
foreach ($master['rows'] as $row) {
  $name = (string) ($row['name'] ?? '');
  // engine-owned objects refuse to be created, and miniflare adds bookkeeping
  if ($name === '' || str_starts_with($name, 'sqlite_') || str_starts_with($name, '__miniflare')) { continue; }
  $lines[] = rtrim((string) $row['sql'], ";\n\r\t ") . ';';
  if (($row['type'] ?? '') === 'table') { $tables[] = $name; }
}

$quote = function ($v) {
  if ($v === null) { return 'NULL'; }
  if (is_array($v)) { $v = (string) ($v['__phpint'] ?? ''); }
  if (is_int($v) || is_float($v)) { return (string) $v; }
  $s = (string) $v;
  // a decimal string is emitted bare so INTEGER affinity survives a round trip
  if ($s !== '' && preg_match('/^-?[0-9]{1,18}$/', $s) === 1) { return $s; }
  return "'" . str_replace("'", "''", $s) . "'";
};

foreach ($tables as $table) {
  $sql = 'SELECT * FROM "' . str_replace('"', '""', $table) . '"';
  if ($cap > 0) { $sql .= ' LIMIT ' . $cap; }
  $rows = cfw_sql($sql);
  if (($rows['ok'] ?? false) !== true) {
    $out['tables'][$table] = 'ERROR: ' . ($rows['error'] ?? 'unknown');
    continue;
  }
  $n = 0;
  foreach ($rows['rows'] as $row) {
    $cols = array_keys($row);
    if (!$cols) { continue; }
    $quoted = array_map(function ($c) { return '"' . str_replace('"', '""', $c) . '"'; }, $cols);
    $vals = array_map($quote, array_values($row));
    $lines[] = 'INSERT INTO "' . $table . '" (' . implode(', ', $quoted) . ') VALUES (' . implode(', ', $vals) . ');';
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
`;
}

/**
 * First-run configuration, against the already-migrated database.
 *
 * The install story is "ship a pre-installed database and migrate it", which works
 * in 256 ms but means every site boots identical -- same site name, same admin
 * account, same hash salt. That is the literal first thing a user does and it was
 * on no list until now.
 *
 * Deliberately NOT Drupal's installer: that is the heaviest write workload in the
 * product (1,052 ms and a 72.5 MB peak natively, never run in wasm) and it would
 * re-do work the pack already contains. This edits the four things that actually
 * differ per site, through Drupal's own APIs so the caches invalidate correctly.
 */
/**
 * Creates every table a write path needs and a pack does not contain.
 *
 * Extracted because a second concrete caller appeared -- saving a node hits the same
 * missing tables as saving uid 1 -- and duplicating 80 lines of DDL would guarantee
 * the two drift. Expects `$db`, `$out` and a booted kernel in scope; writes
 * `$out['schemaRepair']`.
 *
 * The general fix, not another whack-a-mole. The pack is built by browsing a site
 * anonymously, so it contains no table that only a WRITE path creates: sessions,
 * flood, and whatever the next one would have been. Read paths are not evidence
 * about write paths.
 *
 * `ModuleHandler::invoke($module, 'schema')` returned nothing on Drupal 11 -- it
 * reported `tablesCreated: []` while an insert still failed with "no such table:
 * flood", and those two cannot both be true. So the hook is called directly:
 * `loadAllIncludes()` defines `<module>_schema()` as an ordinary function, and
 * `function_exists()` is a fact rather than a hook-system opinion.
 *
 * Runs outside any transaction. DDL dirties `sqlite_master`, so creating
 * a table mid-save turns every later read in that transaction into a speculative
 * replay -- the documented O(W x R) cost, which wedged the whole local runtime the
 * first time it was attempted.
 */
const SCHEMA_REPAIR = String.raw`
  $db = \Drupal::database();
  $moduleHandler = \Drupal::moduleHandler();
  $moduleHandler->loadAllIncludes('install');
  $created = [];
  $failed = [];
  $walked = 0;
  $defined = 0;
  foreach (array_keys($moduleHandler->getModuleList()) as $module) {
    $walked++;
    $fn = $module . '_schema';
    if (!function_exists($fn)) { continue; }
    $defined++;
    $schema = $fn();
    if (!is_array($schema)) { continue; }
    foreach ($schema as $table => $spec) {
      try {
        if (!$db->schema()->tableExists($table)) {
          $db->schema()->createTable($table, $spec);
          $created[] = $table;
        }
      } catch (\Throwable $e) {
        $failed[$table] = substr($e->getMessage(), 0, 140);
      }
    }
  }
  // The other half, and the reason the hook walk found nothing. Drupal's database
  // backends for flood, queue, semaphore, batch and expirable key-value do NOT
  // declare hook_schema. Each keeps its schema in a class method and creates the
  // table ON DEMAND by catching a failed query -- which cannot work here, because
  // the failure surfaces inside a transaction replay where the catch-and-create
  // path is exactly what the replay refuses. So they are pre-created.
  //
  // Mapped explicitly rather than discovered, because there is nothing to discover
  // from: a class method is not registered anywhere a hook system can see.
  $classTables = [
    'flood' => '\Drupal\Core\Flood\DatabaseBackend',
    'queue' => '\Drupal\Core\Queue\DatabaseQueue',
    'semaphore' => '\Drupal\Core\Lock\DatabaseLockBackend',
    'batch' => '\Drupal\Core\Batch\BatchStorage',
    'key_value_expire' => '\Drupal\Core\KeyValueStore\DatabaseStorageExpirable',
  ];
  foreach ($classTables as $table => $class) {
    try {
      if ($db->schema()->tableExists($table)) { continue; }
      if (!class_exists($class)) { $failed[$table] = 'class absent: ' . $class; continue; }
      $rm = new \ReflectionMethod($class, 'schemaDefinition');
      $spec = $rm->isStatic() ? $rm->invoke(NULL) : $rm->invoke($rm->getDeclaringClass()->newInstanceWithoutConstructor());
      // some return one table spec, some a map of them
      $specs = isset($spec['fields']) ? [$table => $spec] : $spec;
      foreach ($specs as $name => $definition) {
        if (is_array($definition) && isset($definition['fields']) && !$db->schema()->tableExists($name)) {
          $db->schema()->createTable($name, $definition);
          $created[] = $name;
        }
      }
    } catch (\Throwable $e) {
      $failed[$table] = substr($e->getMessage(), 0, 140);
    }
  }

  $out['schemaRepair'] = ['modulesWalked' => $walked, 'withSchemaHook' => $defined, 'created' => $created];
  if ($failed) { $out['schemaRepair']['failed'] = $failed; }
`;

/** the site identity and uid-1 account a first run establishes; every field is validated below */
export type FirstRunOptions = {
	siteName?: string;
	siteMail?: string;
	adminName?: string;
	adminMail?: string;
	adminPass?: string;
	timezone?: string;
};

/** a node to create on the write path, which is the path renders never exercise */
export type SaveNodeOptions = {
	type?: string;
	title?: string;
	body?: string;
};

export function firstRunConfig(options: FirstRunOptions = {}): string {
	const payload = JSON.stringify({
		siteName: typeof options.siteName === 'string' ? options.siteName : null,
		siteMail: typeof options.siteMail === 'string' ? options.siteMail : null,
		adminName: typeof options.adminName === 'string' ? options.adminName : null,
		adminMail: typeof options.adminMail === 'string' ? options.adminMail : null,
		adminPass: typeof options.adminPass === 'string' ? options.adminPass : null,
		timezone: typeof options.timezone === 'string' ? options.timezone : null
	});
	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
chdir('/drupal');

$opt = json_decode(${JSON.stringify(payload)}, true);
$out = ['ok' => false, 'applied' => [], 'skipped' => []];

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];

  if (!isset($GLOBALS['__pw_kernel'])) {
    $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
  }

  // site name, mail and timezone are config, so go through the config factory
  $editable = \Drupal::configFactory()->getEditable('system.site');
  foreach (['siteName' => 'name', 'siteMail' => 'mail'] as $key => $configKey) {
    if (!empty($opt[$key])) {
      $editable->set($configKey, $opt[$key]);
      $out['applied'][] = 'system.site.' . $configKey;
    } else {
      $out['skipped'][] = 'system.site.' . $configKey;
    }
  }
  $editable->save();

  if (!empty($opt['timezone'])) {
    \Drupal::configFactory()->getEditable('system.date')
      ->set('timezone.default', $opt['timezone'])->save();
    $out['applied'][] = 'system.date.timezone.default';
  }

  // MANDATORY, not tidiness. Completing the request lifecycle means calling
  // $kernel->terminate(), and automated_cron subscribes to TERMINATE. With
  // system.cron_last absent it fires drupal_cron() inline on the very first
  // request, cron reaches for outbound HTTP (update, announcements_feed), and the
  // wasm build dies with "ReferenceError: Asyncify is not defined" -- a JS
  // exception, so catch (\Throwable) around terminate() does NOT contain it.
  // Measured: every terminate=1 render 500'd until this was set. Interval 0 is
  // core's own "Never" option. Cron runs from the Durable Object alarm instead.
  if (\Drupal::moduleHandler()->moduleExists('automated_cron')) {
    $cronConfig = \Drupal::configFactory()->getEditable('automated_cron.settings');
    if ((int) $cronConfig->get('interval') !== 0) {
      $cronConfig->set('interval', 0)->save();
      $out['applied'][] = 'automated_cron.settings.interval=0';
    } else {
      $out['skipped'][] = 'automated_cron.settings.interval (already 0)';
    }
  }

  // The first WRITE path anything in this project has exercised, and it found a
  // new instance of the trace-blind class immediately: SAVED_NEW / SAVED_UPDATED
  // are plain constants in core/includes/common.inc, which a render never needs
  // and DrupalKernel::boot() does not include. EntityStorageBase::doSave()
  // returns SAVED_UPDATED, so every entity save fatals with
  // "Undefined constant Drupal\\Core\\Entity\\SAVED_UPDATED" until it is loaded.
  // Read paths are not evidence about write paths.
  if (!defined('SAVED_UPDATED')) {
    require_once '/drupal/core/includes/common.inc';
    $out['loadedCommonInc'] = true;
  }

${SCHEMA_REPAIR}

  // uid 1 through the entity API so the password hasher and the presave hooks run
  $admin = \Drupal\user\Entity\User::load(1);
  if ($admin === NULL) {
    $out['skipped'][] = 'uid1 (not loadable)';
  } else {
    if (!empty($opt['adminName'])) { $admin->setUsername($opt['adminName']); $out['applied'][] = 'uid1.name'; }
    if (!empty($opt['adminMail'])) { $admin->setEmail($opt['adminMail']); $out['applied'][] = 'uid1.mail'; }
    if (!empty($opt['adminPass'])) { $admin->setPassword($opt['adminPass']); $out['applied'][] = 'uid1.pass'; }
    $admin->activate();
    $admin->save();
    $out['adminName'] = $admin->getAccountName();
    $out['adminMail'] = $admin->getEmail();
  }

  // the salt is the HOST's now: src/ops/site-secrets.ts mints one per site at boot, persists it in
  // cfw_meta and appends the assignment to settings.php, so generating another here would replace a
  // live salt with one nothing stores and invalidate every session on the next remount
  $out['hashSalt'] = strlen(\Drupal\Core\Site\Settings::getHashSalt()) > 0 ? 'present' : 'MISSING';

  // config changes have to reach the render caches or the old site name persists
  \Drupal\Core\Cache\Cache::invalidateTags(['config:system.site', 'rendered']);
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['trace'] = substr($e->getTraceAsString(), 0, 900);
}

echo json_encode($out);
`;
}

/**
 * Saves one node and then re-renders, which is the whole write-refresh loop.
 *
 * This is the first CONTENT write anything in this project has exercised. Every
 * earlier measurement was a read, and the one earlier write -- first-run config --
 * already found three tables a pack cannot contain. A content save additionally
 * crosses the two places the standing rules were written for: the transaction replay
 * (an entity save is one transaction with interleaved reads of its own writes) and
 * the 2^53 write guard.
 *
 * The type is discovered rather than assumed. `assets/drupal` is the standard pack
 * and standard ships `article` and `page`, but a minimal pack ships neither, and
 * hard-coding a bundle would fail with an error about the bundle rather than about
 * the save.
 *
 * `promote` is set so the front page changes, because that is what makes this a
 * write-REFRESH measurement rather than an insert.
 *
 * @param {{title?: string, type?: string, body?: string}} options
 */
export function saveNode(options: SaveNodeOptions = {}): string {
	const payload = JSON.stringify({
		title: typeof options.title === 'string' ? options.title : null,
		type: typeof options.type === 'string' ? options.type : null,
		body: typeof options.body === 'string' ? options.body : null
	});
	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
${PW_SERVE_INLINE}
chdir('/drupal');

$opt = json_decode(${JSON.stringify(payload)}, true);
$out = ['ok' => false];
$clock = function () { return microtime(true) * 1000; };
$statements = function () { return json_decode(cfw_host('cfwStats')(), true)['queryCount'] ?? 0; };

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];

  if (!isset($GLOBALS['__pw_kernel'])) {
    $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
    $out['bootedKernel'] = 1;
  }

  // SAVED_NEW / SAVED_UPDATED live in core/includes/common.inc, which boot() does
  // not include and no render needs; EntityStorageBase::doSave() returns one
  if (!defined('SAVED_NEW')) {
    require_once '/drupal/core/includes/common.inc';
    $out['loadedCommonInc'] = true;
  }

${SCHEMA_REPAIR}

  // Whoever owns the content has to be the acting user for the save, or node access
  // denies the save's own reads.
  //
  // and it must be put back. The interpreter persists between requests, so a
  // current-user switch that is never undone leaks into every later render in the
  // process -- measured: the front page went from 12,296 bytes to 90,038 because the
  // alarm chain rendered it as uid 1, and that ADMIN HTML was then stored in the
  // anonymous page cache and served to visitors. A cache-poisoning bug from one
  // unrestored global.
  $previousAccount = \Drupal::currentUser()->getAccount();
  $admin = \Drupal\user\Entity\User::load(1);
  if ($admin !== NULL) {
    \Drupal::currentUser()->setAccount($admin);
    $out['actingUid'] = (int) $admin->id();
  }

  $types = array_keys(\Drupal\node\Entity\NodeType::loadMultiple());
  $out['availableTypes'] = $types;
  $type = $opt['type'] ?? null;
  if ($type === null || !in_array($type, $types, true)) {
    $type = in_array('article', $types, true) ? 'article' : ($types[0] ?? null);
  }
  if ($type === null) {
    throw new \RuntimeException('no node type exists in this site, so nothing can be saved');
  }
  $out['type'] = $type;

  $title = $opt['title'] ?? ('Measured save ' . date('H:i:s'));
  $values = [
    'type' => $type,
    'title' => $title,
    'uid' => 1,
    'status' => 1,
    // promoted, so the FRONT PAGE changes and this measures a refresh
    'promote' => 1,
  ];
  $node = \Drupal\node\Entity\Node::create($values);
  $definitions = \Drupal::service('entity_field.manager')->getFieldDefinitions('node', $type);
  if (isset($definitions['body'])) {
    $node->set('body', [
      'value' => $opt['body'] ?? 'Written from inside a Durable Object.',
      'format' => 'basic_html',
    ]);
    $out['bodySet'] = true;
  }

  $before = $statements();
  $t0 = $clock();
  $result = $node->save();
  $out['saveMs'] = round($clock() - $t0, 2);
  $out['saveStatements'] = $statements() - $before;
  $out['saveResult'] = (int) $result;
  $out['savedIsNew'] = defined('SAVED_NEW') && $result === SAVED_NEW;
  $out['nid'] = (int) $node->id();
  $out['vid'] = (int) $node->getRevisionId();

  // read it back through a FRESH storage handler, so this is the database answering
  // rather than the entity object that was just held in memory
  \Drupal::entityTypeManager()->getStorage('node')->resetCache([$node->id()]);
  $reloaded = \Drupal\node\Entity\Node::load($node->id());
  $out['reloadedTitle'] = $reloaded === NULL ? null : $reloaded->getTitle();
  $out['persisted'] = $reloaded !== NULL && $reloaded->getTitle() === $title;

  // back to whoever was acting before, BEFORE anything renders, so these figures are
  // the anonymous page a visitor gets and comparable to every other render here
  \Drupal::currentUser()->setAccount($previousAccount);
  $out['restoredUid'] = (int) \Drupal::currentUser()->id();

  // and the refresh half: the node's own page, then the front page
  foreach (['/node/' . $node->id() => 'nodePage', '/' => 'frontPage'] as $path => $key) {
    foreach (['page', 'dynamic_page_cache'] as $bin) {
      try { \Drupal::cache($bin)->deleteAll(); } catch (\Throwable $e) {}
    }
    try {
      $middleware = \Drupal::service('http_middleware.page_cache');
      $rp = new \ReflectionProperty($middleware, 'cid');
      $rp->setValue($middleware, NULL);
    } catch (\Throwable $e) {}
    $b = $statements();
    $a = $clock();
    $response = cfw_serve($path);
    $body = (string) $response->getContent();
    $out[$key] = [
      'ms' => round($clock() - $a, 2),
      'status' => $response->getStatusCode(),
      'bytes' => strlen($body),
      'statements' => $statements() - $b,
      'pageCache' => $response->headers->get('x-drupal-cache'),
      'dynamicCache' => $response->headers->get('x-drupal-dynamic-cache'),
      'showsTitle' => str_contains($body, $title) ? 1 : 0,
    ];
  }

  $out['ok'] = $out['persisted'] === true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['trace'] = substr($e->getTraceAsString(), 0, 1200);
} finally {
  // a throw between the switch and the restore would poison every later render in
  // this interpreter, so the restore cannot live only on the happy path
  if (isset($previousAccount)) {
    try { \Drupal::currentUser()->setAccount($previousAccount); } catch (\Throwable $e2) {}
  }
}

echo json_encode($out);
`;
}

/**
 * Executes the capability plugins, which until now were only lint-clean.
 *
 * Five classes in the `drupflare` module had never run. Lint proves a class
 * parses; it says nothing about whether `stream_wrapper_register()` accepts it, or
 * whether the host reply shape the class expects is the shape the host sends. Both
 * of those are exactly the kind of contract this project has already got wrong on
 * paper twice.
 *
 * The module is NOT enabled -- enabling one is Drupal's installer path, the heaviest
 * write workload in the product -- so its namespace is registered in settings.php and
 * the classes are driven directly. That is a real limitation of this check and it is
 * stated rather than implied: it exercises the CLASSES and the host contract, not
 * `hook_install` or the service container wiring.
 *
 * Every assertion names what it proves. A check that cannot fail is not a check, so
 * the negative cases are here too: an uncached URL must FAIL rather than return
 * something, and mail with no binding must return FALSE rather than throw.
 */
export const CAPABILITY_CHECK = String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
chdir('/drupal');

$checks = [];
$assert = function (string $label, bool $ok, $detail = null) use (&$checks) {
  $checks[] = ['label' => $label, 'ok' => $ok, 'detail' => $detail];
};

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];
  // the pack does not enable this module, so nothing else registers its namespace
  $autoloader->addPsr4('Drupal\\drupflare\\', '/drupal/modules/custom/drupflare/src/');
  // its HttpsStreamWrapper extends the packaged one; composer never runs here, so this is the
  // autoloader entry composer would have written
  $autoloader->addPsr4('Drupflare\\StreamHttp\\', '/drupal/libraries/drupflare-stream-http/src/');

  if (!isset($GLOBALS['__pw_kernel'])) {
    $request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($request);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
  }

  // #region Host, the single seam
  $assert('Host class loads', class_exists('\Drupal\drupflare\Host'));
  foreach (['cfwLog', 'cfwFetch', 'cfwMail', 'cfwImageUrl', 'cfwQueueFetch', 'cfwHttpCacheGet'] as $fn) {
    $assert('Host::has(' . $fn . ')', \Drupal\drupflare\Host::has($fn));
  }
  $assert(
    'Host::has() is FALSE for a capability the runtime did not install',
    !\Drupal\drupflare\Host::has('cfwNotInstalled'),
    'the control: if this passed for everything, the six above would prove nothing'
  );
  $absent = \Drupal\drupflare\Host::call('cfwNotInstalled', ['x' => 1]);
  $assert(
    'Host::call() on a missing capability returns a named refusal, not a throw',
    ($absent['ok'] ?? null) === false && str_contains((string) ($absent['error'] ?? ''), 'not installed'),
    $absent['error'] ?? null
  );
  // #endregion

  // #region the logger
  $parser = \Drupal::service('logger.log_message_parser');
  $logger = new \Drupal\drupflare\Logger\CfwLogger($parser);
  $marker = 'cfw-logger-' . bin2hex(random_bytes(4));
  $logger->log(3, 'placeholder @who saw @marker', ['@who' => 'the-test', '@marker' => $marker, 'channel' => 'cfw-check']);
  $assert('CfwLogger::log() executes without throwing', true, $marker);
  $logger->log(6, 'info level', ['channel' => 'cfw-check']);

  // and through Drupal's own channel, which is how it would actually be reached
  \Drupal::service('logger.factory')->addLogger($logger);
  $channelMarker = 'cfw-channel-' . bin2hex(random_bytes(4));
  \Drupal::logger('cfw-check')->warning('channel reached @m', ['@m' => $channelMarker]);
  $assert('CfwLogger receives entries through \Drupal::logger()', true, $channelMarker);
  $GLOBALS['__cfw_markers'] = ['direct' => $marker, 'channel' => $channelMarker];
  // #endregion

  // #region the stream wrapper
  $before = stream_get_wrappers();
  // HttpsStreamWrapper's docblock says this runtime has no http/https wrapper,
  // citing a measured list of compress.zlib/php/file/glob/data. On static-free-v1
  // that is WRONG -- both are registered -- and the truth is worse than absence.
  // Reading through the native one throws 'ReferenceError: Asyncify is not defined'
  // out of the wasm import: a JS exception, so @ does not suppress it, a PHP catch
  // never sees it, and the whole invocation dies. Measured, and NOT reproduced here --
  // it would take this suite down with it. Route /__nativefetch reproduces it.
  $assert(
    'the runtime DOES register http/https, contradicting the class docblock',
    in_array('https', $before, true),
    implode(',', $before)
  );
  $registered = \Drupal\drupflare\StreamWrapper\HttpsStreamWrapper::register();
  $after = stream_get_wrappers();
  $assert(
    'HttpsStreamWrapper registers both schemes',
    $registered === ['http', 'https'],
    implode(',', $registered)
  );
  $assert('https is now a registered wrapper', in_array('https', $after, true), implode(',', $after));

  $cachedUrl = getenv('CFW_TEST_URL') ?: 'https://example.com/';
  $body = @file_get_contents($cachedUrl);
  $assert(
    'file_get_contents() over the wrapper returns the prefetched body',
    is_string($body) && strlen($body) > 0,
    is_string($body) ? substr($body, 0, 80) : 'false'
  );
  $GLOBALS['__cfw_body_len'] = is_string($body) ? strlen($body) : -1;

  // fopen/fread/fseek, because file_get_contents() alone would not exercise them
  $fh = @fopen($cachedUrl, 'r');
  $assert('fopen() over the wrapper succeeds', is_resource($fh));
  if (is_resource($fh)) {
    $first = fread($fh, 8);
    fseek($fh, 0);
    $again = fread($fh, 8);
    $assert('fread() returns bytes and fseek() rewinds', $first !== '' && $first === $again, $first);
    $assert('feof() is false before the end', !feof($fh) || strlen((string) $body) <= 8);
    $stat = fstat($fh);
    $assert(
      'fstat() reports the fetched size',
      isset($stat['size']) && (int) $stat['size'] === strlen((string) $body),
      ($stat['size'] ?? null) . ' vs ' . strlen((string) $body)
    );
    fclose($fh);
  }

  // the negative case, and the important one: a URL the host has not
  // prefetched must fail, because a Worker cannot fetch synchronously without JSPI
  $missing = 'https://example.invalid/never-prefetched-' . bin2hex(random_bytes(3));
  $missingBody = @file_get_contents($missing);
  $assert(
    'an unprefetched URL FAILS rather than returning something plausible',
    $missingBody === false,
    var_export($missingBody, true)
  );
  // #endregion

  // #region mail
  $mailer = new \Drupal\drupflare\Plugin\Mail\CfwMail();
  $message = $mailer->format([
    'to' => 'someone@example.com',
    'subject' => 'Capability check',
    'body' => ['line one', 'line two'],
    'headers' => ['From' => 'site@example.com', 'Cc' => 'cc@example.com', 'X-Ignored' => 'drop me'],
    'params' => [],
  ]);
  $assert(
    'CfwMail::format() joins the body parts and wraps',
    is_string($message['body']) && str_contains($message['body'], 'line one') && str_contains($message['body'], 'line two'),
    substr((string) $message['body'], 0, 60)
  );
  $sent = $mailer->mail($message);
  $assert(
    'CfwMail::mail() returns a boolean rather than throwing when there is no binding',
    is_bool($sent),
    var_export($sent, true)
  );
  $GLOBALS['__cfw_mail_result'] = $sent;
  // #endregion

  // #region deferred HTTP, the whole cached -> deferred layering
  if (class_exists('\GuzzleHttp\Psr7\Request')) {
    $handler = new \Drupal\drupflare\Queue\CfwDeferredHttp();
    $deferUrl = 'https://example.com/cfw-deferred-' . bin2hex(random_bytes(3));
    $response = $handler(new \GuzzleHttp\Psr7\Request('GET', $deferUrl), [])->wait();
    $assert(
      'an uncached GET is DEFERRED with a 202 rather than blocking',
      $response->getStatusCode() === 202 && $response->getHeaderLine('x-cfw-deferred') === 'queued',
      $response->getStatusCode() . ' ' . $response->getHeaderLine('x-cfw-deferred')
    );
    $cachedResponse = $handler(new \GuzzleHttp\Psr7\Request('GET', $cachedUrl), [])->wait();
    $assert(
      'a cached GET is answered from the cache with a real body',
      $cachedResponse->getStatusCode() === 200 && strlen((string) $cachedResponse->getBody()) > 0,
      $cachedResponse->getStatusCode() . ' ' . strlen((string) $cachedResponse->getBody()) . ' bytes'
    );
    $GLOBALS['__cfw_deferred_url'] = $deferUrl;
  } else {
    $assert('GuzzleHttp is available for the deferred handler', false, 'class absent');
  }
  // #endregion

  // #region the image toolkit
  $assert(
    'CfwImageToolkit class loads against real Drupal',
    class_exists('\Drupal\drupflare\ImageToolkit\CfwImageToolkit')
  );
  $imageUrl = \Drupal\drupflare\Host::call('cfwImageUrl', ['url' => '/sites/default/files/a.png', 'width' => 300]);
  $assert(
    'cfwImageUrl returns a delivery-time resizing URL',
    ($imageUrl['ok'] ?? false) === true && str_contains((string) ($imageUrl['url'] ?? ''), 'width=300'),
    $imageUrl['url'] ?? null
  );
  // #endregion
}
catch (\Throwable $e) {
  $assert('no exception escaped the capability check', false, get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
}

$passed = count(array_filter($checks, fn ($c) => $c['ok']));
echo json_encode([
  'passed' => $passed,
  'failed' => count($checks) - $passed,
  'markers' => $GLOBALS['__cfw_markers'] ?? null,
  'bodyLen' => $GLOBALS['__cfw_body_len'] ?? null,
  'mailResult' => $GLOBALS['__cfw_mail_result'] ?? null,
  'deferredUrl' => $GLOBALS['__cfw_deferred_url'] ?? null,
  'checks' => $checks,
]);
`;

/**
 * Where exactly does a form submission stop?
 *
 * The method now reaches Drupal, and a submission still does not take effect. "The form does not
 * submit" is not actionable; this reports which of four walls rejects it, with the value Drupal
 * actually saw at each stage.
 *
 * It builds the request the SAME WAY `cfw_serve()` does rather than calling it, because the whole
 * point is to hold the Request object and interrogate it -- `cfw_serve()` returns only a Response,
 * so the two questions that matter first (did Drupal see POST, did it see the values) are
 * unanswerable through it. The construction is duplicated deliberately and must be kept in step; if
 * they ever disagree, this probe is measuring something the serve path does not do.
 */
export function submissionProbe(options: {
	path?: string;
	method?: string;
	body?: string;
	contentType?: string;
}): string {
	const safe = JSON.stringify(
		JSON.stringify({
			path: options.path ?? '/node/add/page',
			method: (options.method ?? 'POST').toUpperCase(),
			body: options.body ?? '',
			contentType: options.contentType ?? 'application/x-www-form-urlencoded'
		})
	);
	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
${PW_SERVE_INLINE}
chdir('/drupal');

$opt = json_decode(${safe}, true);
$out = ['ok' => false, 'wall' => 'unknown'];

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = $opt['path'];
$_SERVER['REQUEST_METHOD'] = $opt['method'];
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];

  if (!isset($GLOBALS['__pw_kernel'])) {
    $boot = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($boot);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
    $out['bootedKernel'] = 1;
  }
  $kernel = $GLOBALS['__pw_kernel'];

  // #region wall 1: does Drupal see the POST and its values
  $parameters = [];
  $isForm = stripos($opt['contentType'], 'application/x-www-form-urlencoded') !== false;
  if ($opt['method'] !== 'GET' && $opt['body'] !== '' && $isForm) {
    parse_str($opt['body'], $parameters);
  }
  $server = [];
  if ($opt['contentType'] !== '') { $server['CONTENT_TYPE'] = $opt['contentType']; }
  if ($opt['body'] !== '') { $server['CONTENT_LENGTH'] = (string) strlen($opt['body']); }

  $request = \Symfony\Component\HttpFoundation\Request::create(
    $opt['path'], $opt['method'], $parameters, [], [], $server, $opt['body']
  );

  $out['methodSeen'] = $request->getMethod();
  $out['requestKeys'] = array_keys($request->request->all());
  $out['parsedKeys'] = array_keys($parameters);
  $out['contentLength'] = strlen($request->getContent());
  $out['isMethodPost'] = $request->isMethod('POST');
  // #endregion

  // #region wall 4: is there a session, and is the request treated as cacheable
  try {
    $out['hasSession'] = $request->hasSession() ? 1 : 0;
    $out['hasPreviousSession'] = $request->hasPreviousSession() ? 1 : 0;
  } catch (\Throwable $e) { $out['sessionError'] = $e->getMessage(); }
  try {
    $policy = \Drupal::service('page_cache_request_policy');
    $verdict = $policy->check($request);
    // ALLOW means Drupal considers this cacheable, which is only correct for an anonymous GET
    $out['pageCachePolicy'] = is_string($verdict) ? $verdict : json_encode($verdict);
  } catch (\Throwable $e) { $out['policyError'] = $e->getMessage(); }
  try {
    $out['currentUserId'] = (int) \Drupal::currentUser()->id();
    $out['isAuthenticated'] = \Drupal::currentUser()->isAuthenticated() ? 1 : 0;
  } catch (\Throwable $e) { $out['userError'] = $e->getMessage(); }
  // #endregion

  // #region walls 2 and 3: build id and token, read off what the handler answers
  try {
    $rp = new \ReflectionProperty(\Drupal\Core\DrupalKernel::class, 'prepared');
    $rp->setValue($kernel, false);
  } catch (\Throwable $e) {}
  try {
    $stack = \Drupal::service('request_stack');
    while ($stack->getCurrentRequest() !== null) { $stack->pop(); }
  } catch (\Throwable $e) {}
  if (function_exists('drupal_static_reset')) { drupal_static_reset(); }

  try {
    $response = $kernel->handle($request);
    $status = $response->getStatusCode();
    $content = (string) $response->getContent();
    $out['status'] = $status;
    $out['bytes'] = strlen($content);
    $out['location'] = $response->headers->get('location');

    // the phrases Drupal uses, each of which names a DIFFERENT wall
    $out['saysOutdated'] = stripos($content, 'form has become outdated') !== false ? 1 : 0;
    $out['saysTokenInvalid'] = stripos($content, 'security token') !== false ? 1 : 0;
    $out['saysAccessDenied'] = ($status === 403 || stripos($content, 'Access denied') !== false) ? 1 : 0;
    $out['saysNotFound'] = $status === 404 ? 1 : 0;
    $out['hasFormBuildId'] = stripos($content, 'form_build_id') !== false ? 1 : 0;
    $out['hasFormToken'] = stripos($content, 'form_token') !== false ? 1 : 0;

    if ($out['saysNotFound']) { $out['wall'] = 'route-not-found'; }
    elseif ($out['saysAccessDenied']) { $out['wall'] = 'access-denied'; }
    elseif ($out['saysOutdated']) { $out['wall'] = 'form-build-id'; }
    elseif ($out['saysTokenInvalid']) { $out['wall'] = 'csrf-token'; }
    elseif ($status >= 300 && $status < 400) { $out['wall'] = 'none-redirected'; }
    else { $out['wall'] = 'handled-no-effect'; }
    $out['ok'] = true;
  } catch (\Throwable $e) {
    $out['wall'] = 'exception';
    $out['error'] = get_class($e) . ': ' . $e->getMessage();
    $out['at'] = $e->getFile() . ':' . $e->getLine();
  }
  // #endregion
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['at'] = $e->getFile() . ':' . $e->getLine();
}

echo json_encode($out);
`;
}

/**
 * Everything that must not survive a request boundary, read WITHOUT running a request.
 *
 * The instrument for the static-state family: `Html::$seenIds`, `PathMatcher::isFrontPage`,
 * `PageCache::$cid`, `drupal_static()`, the uid-1 cache poisoning and `FormState::$anyErrors` were
 * every one of them found by accident, because nothing enumerated the class of defect. This does.
 *
 * Two halves. The NAMED half reports the specific carriers a leak has already been found in, plus
 * the ones a reading of core says are next. The BLIND half fingerprints every static property of
 * every declared class, so a carrier nobody has thought of shows up as a diff rather than as
 * nothing at all.
 *
 * Read-only by construction: `Messenger::all()` peeks rather than takes, `getValue()` does not
 * initialise, and no service is instantiated that the request did not already instantiate --
 * asking a container for a service it never built would create the state this is looking for.
 * The one exception is the output buffer, which is CLEARED because an unclosed one from the
 * previous request would swallow this report and read as a dead interpreter.
 */
export const BOUNDARY_STATE = String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
chdir('/drupal');

$obFound = ob_get_level();
while (ob_get_level() > 0) { @ob_end_clean(); }

$out = ['obLevel' => $obFound];
$out['headers'] = function_exists('headers_list') ? count(headers_list()) : -1;
$out['sessionStatus'] = function_exists('session_status') ? session_status() : -1;
$out['sessionId'] = function_exists('session_id') ? (string) @session_id() : '';
$out['sessionKeys'] = isset($_SESSION) && is_array($_SESSION) ? array_keys($_SESSION) : [];
$out['booted'] = isset($GLOBALS['__pw_kernel']) ? 1 : 0;
$out['post'] = isset($_POST) && is_array($_POST) ? array_keys($_POST) : [];
$out['cookies'] = isset($_COOKIE) && is_array($_COOKIE) ? array_keys($_COOKIE) : [];

$ask = function (callable $fn) {
  try { return $fn(); } catch (\Throwable $e) { return 'ERR: ' . substr($e->getMessage(), 0, 120); }
};

// #region the named carriers
$out['uid'] = $ask(function () { return (int) \Drupal::currentUser()->id(); });

// memoised by ThemeManager::getActiveTheme() and cleared only by resetActiveTheme(), which on a
// normal request nothing calls -- so the FIRST route to negotiate decides the theme for the object
$out['theme'] = $ask(function () {
  $container = \Drupal::getContainer();
  if ($container === null || !$container->initialized('theme.manager')) { return null; }
  $manager = $container->get('theme.manager');
  return $manager->hasActiveTheme() ? $manager->getActiveTheme()->getName() : null;
});

$out['formErrors'] = $ask(function () {
  return \Drupal\Core\Form\FormState::hasAnyErrors() ? 1 : 0;
});

$out['seenIds'] = $ask(function () {
  $property = new \ReflectionProperty(\Drupal\Component\Utility\Html::class, 'seenIds');
  $value = $property->getValue();
  return is_array($value) ? count($value) : -1;
});

// keyed by the Request OBJECT in a static SplObjectStorage, so every request ever served stays
// referenced; correct per request and unbounded across them
$out['renderContexts'] = $ask(function () {
  $property = new \ReflectionProperty(\Drupal\Core\Render\Renderer::class, 'contextCollection');
  $value = $property->getValue();
  return $value instanceof \SplObjectStorage ? $value->count() : -1;
});

$out['requestStack'] = $ask(function () {
  $container = \Drupal::getContainer();
  if ($container === null || !$container->initialized('request_stack')) { return null; }
  $stack = $container->get('request_stack');
  $property = new \ReflectionProperty($stack, 'requests');
  $value = $property->getValue($stack);
  return is_array($value) ? count($value) : -1;
});

// the flash bag lives on a session service that outlives the request, so a message queued for one
// visitor and never rendered is rendered to the next
$out['messages'] = $ask(function () {
  $container = \Drupal::getContainer();
  if ($container === null || !$container->initialized('messenger')) { return null; }
  $counts = [];
  foreach ($container->get('messenger')->all() as $type => $list) { $counts[$type] = count($list); }
  return $counts;
});

// LocaleLookup::getCid() folds the CURRENT USER'S ROLE IDS into the key and memoises it, so the
// first request to translate anything decides the key every later one reads; null unless locale is on
$out['localeCids'] = $ask(function () {
  $container = \Drupal::getContainer();
  $id = 'string_translator.locale.lookup';
  if ($container === null || !$container->has($id) || !$container->initialized($id)) { return null; }
  $service = $container->get($id);
  $held = new \ReflectionProperty($service, 'translations');
  $memo = new \ReflectionProperty(\Drupal\Core\Cache\CacheCollector::class, 'cid');
  $cids = [];
  foreach ((array) $held->getValue($service) as $langcode => $contexts) {
    foreach ((array) $contexts as $context => $lookup) {
      $cids[$langcode . '|' . $context] = is_object($lookup) ? $memo->getValue($lookup) : null;
    }
  }
  return $cids;
});

$out['db'] = $ask(function () {
  $connection = \Drupal\Core\Database\Database::getConnection();
  return [
    'buffering' => method_exists($connection, 'isBuffering') ? (int) $connection->isBuffering() : -1,
    'inTransaction' => (int) $connection->inTransaction(),
    'hostTransactions' => method_exists($connection, 'transactionCount') ? $connection->transactionCount() : -1,
  ];
});

// which of the seeded ids the resetter can actually reset; method_exists() is the gate it applies,
// so an id with no reset() is skipped in silence
$out['resetAudit'] = $ask(function () {
  $container = \Drupal::getContainer();
  if ($container === null || !$container->has('drupflare.request_resetter')) { return null; }
  $resetter = $container->get('drupflare.request_resetter');
  $property = new \ReflectionProperty($resetter, 'resettable');
  $audit = [];
  foreach ((array) $property->getValue($resetter) as $id) {
    if (!$container->has($id)) { $audit[$id] = 'absent'; continue; }
    if (!$container->initialized($id)) { $audit[$id] = 'uninitialized'; continue; }
    $service = $container->get($id);
    $audit[$id] = is_object($service) && method_exists($service, 'reset') ? 'reset' : 'no-reset';
  }
  return $audit;
});
// #endregion

// #region the blind half
$fingerprint = function ($value, $depth = 0) use (&$fingerprint) {
  if ($depth > 2) { return 'deep'; }
  if ($value === null) { return 'null'; }
  if (is_bool($value)) { return $value ? 'true' : 'false'; }
  if (is_int($value) || is_float($value)) { return 'n' . $value; }
  if (is_string($value)) { return 's' . strlen($value) . ':' . substr(md5($value), 0, 6); }
  if (is_array($value)) {
    $parts = [];
    foreach ($value as $key => $item) { $parts[] = $key . '=' . $fingerprint($item, $depth + 1); }
    return 'a' . count($value) . ':' . substr(md5(implode('|', $parts)), 0, 6);
  }
  if ($value instanceof \Closure) { return 'fn'; }
  if ($value instanceof \Countable) { return 'C' . get_class($value) . ':' . count($value); }
  if (is_object($value)) { return 'o:' . get_class($value); }
  return 'x';
};

$statics = [];
$skipped = 0;
foreach (get_declared_classes() as $class) {
  try {
    $reflection = new \ReflectionClass($class);
    foreach ($reflection->getProperties(\ReflectionProperty::IS_STATIC) as $property) {
      if ($property->getDeclaringClass()->getName() !== $class) { continue; }
      try {
        $name = $class . '::' . $property->getName();
        $statics[$name] = $property->isInitialized() ? $fingerprint($property->getValue()) : 'uninit';
      } catch (\Throwable $e) { $skipped++; }
    }
  } catch (\Throwable $e) { $skipped++; }
}
ksort($statics);
$out['statics'] = $statics;
$out['staticCount'] = count($statics);
$out['staticSkipped'] = $skipped;
$out['classCount'] = count(get_declared_classes());
// #endregion

echo json_encode($out);
`;

/**
 * Leaves output buffers open the way a handler that forgot its `ob_end_clean()` would.
 *
 * The question is whether PHP's buffer stack is per-script or per-interpreter here. On a real SAPI
 * request shutdown flushes and pops every level, so a forgotten `ob_start()` costs one response. If
 * the stack survives a `_run()` boundary it costs every response after it, because the next
 * script's output goes into a buffer nobody will ever close and the host reads nothing at all.
 *
 * The report is echoed BEFORE the buffers open, so this fragment can answer even while it is
 * creating the condition that would silence it.
 *
 * @param {number} depth how many levels to leave open
 */
export function leakOutputBuffer(depth = 2): string {
	const levels = Math.max(1, Math.min(8, Math.trunc(depth)));
	return String.raw`<?php
$out = ['ok' => true, 'before' => ob_get_level(), 'opening' => ${levels}];
echo json_encode($out);
for ($i = 0; $i < ${levels}; $i++) { ob_start(); }
`;
}

/**
 * Leaves the session manager open the way a request that never reached `save()` would.
 *
 * `Drupal\Core\StackMiddleware\Session::handle()` calls `$request->getSession()->save()` after the
 * kernel, and skips it for a `ResponseKeepSessionOpenInterface` -- which `BigPipeResponse` is,
 * because BigPipe closes the session itself inside `sendContent()`. A `sendContent()` that throws,
 * or a caller that reads `getContent()` instead, therefore ends the request with `started` TRUE and
 * `closed` FALSE.
 *
 * That state is what makes the next request's `SessionManager::start()` return at its first line
 * (`($started || $startedLazy) && !$closed`), so `loadSession()` never runs -- and `loadSession()`
 * is the ONLY thing in core that re-binds the session bags to the current `$_SESSION`. Without it
 * the flash bag still references the previous visitor's array, message and all.
 *
 * Manufactured rather than provoked, and measured rather than assumed: an anonymous GET, a login
 * POST, an authenticated GET, a node-save POST and a `drupalRequest()` render all leave `started`
 * FALSE on this runtime, so no ordinary request reaches the state and a probe is the only way to
 * exercise the reset that clears it. Same reason `leakOutputBuffer()` exists.
 *
 * @returns the flags it set and the flash bag it left behind, so a vacuous run is visible
 */
export const LEAK_OPEN_SESSION = String.raw`<?php
$out = ['ok' => false];
try {
  $container = \Drupal::getContainer();
  if ($container === null || !$container->initialized('session_manager')) {
    $out['error'] = 'session_manager was never initialised';
  } else {
    $manager = $container->get('session_manager');
    $reflection = new \ReflectionObject($manager);
    $reflection->getProperty('started')->setValue($manager, true);
    $reflection->getProperty('closed')->setValue($manager, false);
    $out['started'] = (bool) $reflection->getProperty('started')->getValue($manager);
    $out['closed'] = (bool) $reflection->getProperty('closed')->getValue($manager);
    $out['flashes'] = isset($_SESSION['_symfony_flashes'])
      ? array_map('count', (array) $_SESSION['_symfony_flashes'])
      : [];
    $out['ok'] = true;
  }
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}
echo json_encode($out);
`;

/**
 * Leaves a Drupal transaction open the way a halted request would, so the next one can be asked.
 *
 * `cfw_do_sqlite` withholds every write while a transaction is open and replays it on commit, and
 * the buffer lives on the Connection -- which `Database::$connections` holds for the life of the
 * interpreter. So the question is not whether a rollback works but whether a request that never
 * reaches its commit leaves the NEXT request buffering into a transaction nobody owns.
 *
 * Two abandonments, because they fail differently. `scope` drops the last reference at the end of
 * the script, which is where a real SAPI would run the destructor and roll back. `global` parks the
 * object where nothing will collect it, which is what an unwind interrupted by a host-level throw
 * leaves behind -- a JavaScript exception is not a `Throwable` and no PHP handler sees it.
 *
 * @param {'scope'|'global'} mode which reference the abandoned transaction keeps
 */
export function abandonTransaction(mode: 'scope' | 'global' = 'scope'): string {
	const safeMode = mode === 'global' ? 'global' : 'scope';
	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
chdir('/drupal');

$mode = json_decode(${JSON.stringify(JSON.stringify(safeMode))});
$out = ['ok' => false, 'mode' => $mode];

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];
  if (!isset($GLOBALS['__pw_kernel'])) {
    $boot = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($boot);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
    $out['bootedKernel'] = 1;
  }

  $connection = \Drupal\Core\Database\Database::getConnection();
  $transaction = $connection->startTransaction();
  \Drupal::state()->set('cfw_orphan_probe', $mode);
  $out['buffering'] = method_exists($connection, 'isBuffering') ? (int) $connection->isBuffering() : -1;

  if ($mode === 'global') {
    $GLOBALS['__cfw_orphan_txn'] = $transaction;
  }
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}

echo json_encode($out);
`;
}

/**
 * Turns on `locale.settings.translate_english`, which is what makes `locale` translate at all here.
 *
 * `LocaleTranslation::getStringTranslation()` returns FALSE for langcode `en` unless this is set, so
 * on the packed English site enabling `locale` builds no `LocaleLookup` and the per-user cid this
 * exists to exercise never comes into being. A multilingual site reaches the same state by
 * negotiating a non-English language; this is the one-boolean way to reach it from an English one.
 *
 * `loadAll()` FIRST, and it is not optional: `LocaleConfigSubscriber` runs on the config save and
 * calls `locale_is_translatable()`, a plain function in `locale.module`. A bare kernel boot has
 * loaded no `.module` file, so the save writes the value and then dies with
 * "Call to undefined function Drupal\locale\locale_is_translatable()" -- which reads as a failed
 * setup while having already changed the setting.
 */
export const TRANSLATE_ENGLISH = String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
chdir('/drupal');

$out = ['ok' => false];

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];
  if (!isset($GLOBALS['__pw_kernel'])) {
    $boot = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($boot);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
  }

  \Drupal::moduleHandler()->loadAll();
  \Drupal::configFactory()->getEditable('locale.settings')->set('translate_english', true)->save();
  $out['translateEnglish'] = (bool) \Drupal::config('locale.settings')->get('translate_english');
  $out['localeEnabled'] = \Drupal::moduleHandler()->moduleExists('locale');
  $out['ok'] = $out['translateEnglish'] && $out['localeEnabled'];
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
}

echo json_encode($out);
`;

/**
 * Creates one authenticated user with a known password, so a sequence can change identity.
 *
 * The packed site ships exactly one account, and one account cannot show a cross-USER leak -- only
 * a cross-REQUEST one. Two ordinary users plus uid 1 plus anonymous is the smallest set where
 * "whose state is this" has a wrong answer that is visible.
 *
 * Through the entity API rather than by inserting rows, so the password hasher, the presave hooks
 * and the role reference all run; a hand-built row authenticates against nothing.
 *
 * @param {{name: string, pass: string, roles?: string[]}} options
 */
export function createUser(options: { name: string; pass: string; roles?: string[] }): string {
	const payload = JSON.stringify({
		name: String(options.name),
		pass: String(options.pass),
		roles: (Array.isArray(options.roles) ? options.roles : []).filter((r) =>
			/^[a-z0-9_]+$/.test(r)
		)
	});
	return String.raw`<?php
${FIBER_SHIM}
${HOST_HELPERS}
chdir('/drupal');

$opt = json_decode(${JSON.stringify(payload)}, true);
$out = ['ok' => false, 'name' => $opt['name']];

$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PORT'] = '80';
$_SERVER['REQUEST_URI'] = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '/drupal/index.php';
$_SERVER['PHP_SELF'] = '/index.php';
$_SERVER['DOCUMENT_ROOT'] = '/drupal';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SERVER_SOFTWARE'] = 'workerd';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';

try {
  if (!isset($GLOBALS['__pw_autoloader'])) {
    $GLOBALS['__pw_autoloader'] = require_once '/drupal/autoload.php';
  }
  $autoloader = $GLOBALS['__pw_autoloader'];
  if (!isset($GLOBALS['__pw_kernel'])) {
    $boot = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
    $kernel = new \Drupal\Core\DrupalKernel('prod', $autoloader);
    \Drupal\Core\DrupalKernel::bootEnvironment();
    $sitePath = \Drupal\Core\DrupalKernel::findSitePath($boot);
    $kernel->setSitePath($sitePath);
    \Drupal\Core\Site\Settings::initialize('/drupal', $sitePath, $autoloader);
    $kernel->boot();
    $GLOBALS['__pw_kernel'] = $kernel;
    $out['bootedKernel'] = 1;
  }

  if (!defined('SAVED_NEW')) {
    require_once '/drupal/core/includes/common.inc';
    $out['loadedCommonInc'] = true;
  }

${SCHEMA_REPAIR}

  $existing = \Drupal::entityTypeManager()->getStorage('user')
    ->loadByProperties(['name' => $opt['name']]);
  $account = $existing ? reset($existing) : \Drupal\user\Entity\User::create(['name' => $opt['name']]);
  $account->setEmail($opt['name'] . '@example.invalid');
  $account->setPassword($opt['pass']);
  $account->activate();
  foreach ($opt['roles'] as $role) { $account->addRole($role); }
  $account->save();

  $out['uid'] = (int) $account->id();
  $out['roles'] = array_values($account->getRoles());
  $out['ok'] = true;
} catch (\Throwable $e) {
  $out['error'] = get_class($e) . ': ' . $e->getMessage();
  $out['trace'] = substr($e->getTraceAsString(), 0, 600);
}

echo json_encode($out);
`;
}
