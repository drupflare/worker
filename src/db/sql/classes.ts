/**
 * How the translator treats a MySQL construct.
 *
 * `supported` passes through with only its string literals re-encoded; `translated` is rewritten
 * to the same result; `semantics-changed` is rewritten and the result can differ in a way the row
 * names; `expensive` works and costs rows or CPU out of proportion; `refused` is a named error.
 */
export type ClassKind = 'supported' | 'translated' | 'semantics-changed' | 'expensive' | 'refused';

/** one row of the statement-class table */
export interface ClassRow {
	id: string;
	description: string;
	kind: ClassKind;
	/** required unless the row is supported or translated */
	reason: string;
	/** a MySQL statement that exercises the row */
	example: string;
	/** the SQLite text the example becomes, or the error it returns */
	becomes: string;
	/** the id of the spec case that proves the row */
	test: string;
}

const rows: ClassRow[] = [];

function row(
	id: string,
	kind: ClassKind,
	description: string,
	example: string,
	becomes: string,
	reason = ''
): void {
	rows.push({ id, kind, description, reason, example, becomes, test: `sql-translate: ${id}` });
}

// #region plain statements
row(
	'select-plain',
	'supported',
	'SELECT with joins, GROUP BY, ORDER BY, DISTINCT and IN lists',
	"SELECT ID FROM wp_posts WHERE post_status = 'publish' ORDER BY post_date DESC",
	'the same text'
);
row(
	'union-having-subquery',
	'supported',
	'UNION, HAVING and subqueries',
	'SELECT a FROM t UNION SELECT a FROM u',
	'the same text'
);
row(
	'division',
	'semantics-changed',
	'/ between two integers',
	'SELECT 5 / 2',
	'the same text',
	'SQLite truncates integer division to 2 where MySQL answers the decimal 2.5000'
);
row(
	'compare-text-number',
	'semantics-changed',
	'a text column compared with a numeric literal',
	'SELECT a FROM t WHERE v < 1000',
	'the same text',
	'MySQL converts both sides to numbers; SQLite compares the text, so 5 < 1000 holds in MySQL and not in SQLite, and equal-length digit strings (timestamps) compare alike'
);
row(
	'insert-plain',
	'supported',
	'INSERT ... VALUES with an explicit column list',
	"INSERT INTO t (a, b) VALUES (1, 'x')",
	'the same text; the insert id is read back from last_insert_rowid()'
);
row(
	'delete',
	'supported',
	'DELETE FROM table WHERE ...',
	'DELETE FROM t WHERE a = 1',
	'the same text'
);
row(
	'insert-select',
	'supported',
	'INSERT ... SELECT',
	'INSERT INTO t (a) SELECT a FROM u',
	'INSERT INTO `t` (`a`) SELECT a FROM u'
);
// #endregion

// #region literals, quoting and comments
row(
	'string-literal',
	'translated',
	'string literals are decoded from MySQL escapes and re-encoded for SQLite',
	"SELECT 'it\\'s'",
	"SELECT 'it''s'"
);
row(
	'comments',
	'translated',
	'# comments and -- comments become a space',
	'SELECT 1 # note',
	'SELECT 1  '
);
row(
	'limit-offset',
	'translated',
	'LIMIT offset, count',
	'SELECT a FROM t LIMIT 5, 10',
	'SELECT a FROM t LIMIT 10 OFFSET 5'
);
row(
	'collate',
	'translated',
	'COLLATE with a MySQL collation name',
	'SELECT a FROM t ORDER BY a COLLATE utf8mb4_bin',
	'SELECT a FROM t ORDER BY a COLLATE BINARY'
);
row(
	'select-modifiers',
	'translated',
	'SQL_NO_CACHE, SQL_SMALL_RESULT and the other result hints are dropped',
	'SELECT SQL_NO_CACHE a FROM t',
	'SELECT a FROM t'
);
row(
	'straight-join',
	'translated',
	'STRAIGHT_JOIN fixes the join order, as CROSS JOIN does in SQLite',
	'SELECT * FROM a STRAIGHT_JOIN b ON a.id = b.id',
	'SELECT * FROM a CROSS JOIN b ON a.id = b.id'
);
row(
	'operator-logical',
	'translated',
	'|| and && are logical OR and AND in MySQL',
	'SELECT a FROM t WHERE a = 1 || a = 2',
	'SELECT a FROM t WHERE a = 1  OR  a = 2'
);
row(
	'operator-null-safe-equal',
	'translated',
	'<=> is IS in SQLite',
	'SELECT a FROM t WHERE a <=> NULL',
	'SELECT a FROM t WHERE a  IS  NULL'
);
row(
	'executable-comment',
	'refused',
	'/*! ... */ comments run their contents on MySQL',
	'SELECT /*!40101 SQL_NO_CACHE */ 1',
	'error 1235 (refused: executable-comment)',
	'MySQL runs the text inside, so dropping it is a guess and running it needs a second parse'
);
row(
	'hex-literal',
	'refused',
	"0x41, X'41' and b'1' are binary strings in MySQL and integers or blobs in SQLite",
	"SELECT X'41'",
	'error 1235 (refused: hex-literal)',
	'the SQLite types differ from MySQL binary strings, so a comparison would answer differently'
);
row(
	'variable-in-expression',
	'refused',
	'user variables and system variables inside a larger statement',
	'SELECT @a := 1',
	'error 1235 (refused: variable-in-expression)',
	'a connection has no variable table that SQLite can read; only whole-statement reads of system variables are answered'
);
row(
	'json-operator',
	'refused',
	'the -> and ->> JSON operators',
	"SELECT j->'$.a' FROM t",
	'error 1235 (refused: json-operator)',
	'SQLite has the operators with different result types'
);
row(
	'syntax-error',
	'refused',
	'text the lexer cannot tokenize, a stray ? or more than one statement',
	'SELECT 1; SELECT 2',
	'error 1064 (refused: syntax-error)',
	'MySQL answers 1064 for the same input; a second statement is refused so it cannot reach SQLite'
);
// #endregion

// #region session and host-answered statements
row(
	'set-names',
	'translated',
	'SET NAMES charset [COLLATE collation], answered by the host',
	"SET NAMES 'utf8mb4' COLLATE 'utf8mb4_unicode_520_ci'",
	'no SQLite statement; the session records the character set and forgets FOUND_ROWS'
);
row(
	'set-sql-mode',
	'translated',
	'SET [SESSION] sql_mode = ..., answered by the host',
	"SET SESSION sql_mode='NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION'",
	'no SQLite statement; later statements read the mode for strict-mode behaviour'
);
row(
	'set-sql-mode-unknown',
	'refused',
	'a mode name MySQL does not know',
	"SET SESSION sql_mode='NOT_A_MODE'",
	'error 1231',
	'MySQL answers 1231 for an unknown mode name'
);
row(
	'sql-mode-unsupported',
	'refused',
	'ANSI_QUOTES, PIPES_AS_CONCAT, NO_BACKSLASH_ESCAPES and similar modes',
	"SET SESSION sql_mode='ANSI_QUOTES'",
	'error 1235 (refused: sql-mode-unsupported)',
	'each changes how the text is tokenized or evaluated, and the translator reads the text one way'
);
row(
	'set-variable',
	'refused',
	'SET of any other variable, GLOBAL scope, and user variables',
	'SET autocommit = 0',
	'error 1235 (refused: set-variable)',
	'accepting it silently would pretend a setting took effect'
);
row(
	'select-system-variable',
	'translated',
	'SELECT @@SESSION.sql_mode and the other read-only variables WordPress reads',
	'SELECT @@SESSION.sql_mode',
	'no SQLite statement; the host answers one row'
);
row(
	'select-version',
	'translated',
	'SELECT VERSION()',
	'SELECT VERSION()',
	'no SQLite statement; the host answers the configured server version'
);
row(
	'system-variable',
	'refused',
	'a system variable outside the answered list',
	'SELECT @@max_allowed_packet',
	'error 1235 (refused: system-variable)',
	'a guessed value would be read as the server limit'
);
row(
	'found-rows',
	'translated',
	'SELECT FOUND_ROWS(), answered lazily from the remembered query',
	'SELECT FOUND_ROWS()',
	'SELECT count(*) FROM (<the remembered query without ORDER BY and LIMIT>) when asked'
);
row(
	'calc-found-rows',
	'translated',
	'SQL_CALC_FOUND_ROWS is stripped and the count is taken only if FOUND_ROWS() arrives',
	'SELECT SQL_CALC_FOUND_ROWS ID FROM wp_posts LIMIT 0, 10',
	'SELECT ID FROM wp_posts LIMIT 10 OFFSET 0'
);
// #endregion

// #region show, describe and information_schema
row(
	'show-tables',
	'translated',
	'SHOW TABLES [LIKE pattern] from the stored schema',
	"SHOW TABLES LIKE 'wp_options'",
	'no SQLite statement; one row per table the translator created'
);
row(
	'show-columns',
	'translated',
	'SHOW [FULL] COLUMNS FROM table, from the stored MySQL definition',
	'SHOW FULL COLUMNS FROM wp_options',
	'no SQLite statement; MySQL 8 format'
);
row(
	'describe',
	'translated',
	'DESCRIBE table',
	'DESCRIBE wp_options',
	'no SQLite statement; MySQL 8 format'
);
row(
	'show-index',
	'translated',
	'SHOW INDEX FROM table; Cardinality is NULL because nothing here knows it',
	'SHOW INDEX FROM wp_options',
	'no SQLite statement'
);
row(
	'show-create-table',
	'semantics-changed',
	'SHOW CREATE TABLE from the stored definition',
	'SHOW CREATE TABLE wp_options',
	'no SQLite statement',
	'the AUTO_INCREMENT=n table option is omitted, because the next id lives in SQLite, not in the schema'
);
row(
	'show-other',
	'refused',
	'SHOW VARIABLES, STATUS, TABLE STATUS, WARNINGS, EXPLAIN and the other forms',
	'SHOW TABLE STATUS',
	'error 1235 (refused: show-other)',
	'nothing here holds the figures, and a made-up row would be read as measured'
);
row(
	'information-schema-tables',
	'translated',
	'information_schema.TABLES as a table of the stored schema',
	"SELECT TABLE_NAME FROM information_schema.TABLES WHERE ENGINE = 'MyISAM'",
	'a UNION ALL of constant rows, one per stored table; unknown columns are not offered'
);
row(
	'information-schema-other',
	'refused',
	'any other information_schema table',
	'SELECT * FROM information_schema.COLUMNS',
	'error 1235 (refused: information-schema-other)',
	'only the TABLES view is built from the stored schema'
);
// #endregion

// #region writes
row(
	'insert-ignore',
	'translated',
	'INSERT IGNORE',
	'INSERT IGNORE INTO t (a) VALUES (1)',
	'INSERT OR IGNORE INTO `t` (`a`) VALUES (1)'
);
row(
	'replace-into',
	'semantics-changed',
	'REPLACE INTO',
	'REPLACE INTO t (a) VALUES (1)',
	'INSERT OR REPLACE INTO `t` (`a`) VALUES (1)',
	'MySQL reports 2 affected rows for a replaced row (delete and insert) and SQLite reports 1'
);
row(
	'insert-odku',
	'translated',
	'INSERT ... ON DUPLICATE KEY UPDATE with VALUES(col)',
	'INSERT INTO t (k, v) VALUES (1, 2) ON DUPLICATE KEY UPDATE v = VALUES(v)',
	'ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE v IS NOT excluded.v COLLATE BINARY; affected rows are 1 per insert, 2 per changed update, 0 per unchanged'
);
row(
	'odku-no-schema',
	'refused',
	'ON DUPLICATE KEY UPDATE on a table the translator did not create',
	'INSERT INTO unknown_table (k) VALUES (1) ON DUPLICATE KEY UPDATE k = 2',
	'error 1235 (refused: odku-no-schema)',
	'the conflict target comes from the stored PRIMARY and UNIQUE keys and there are none'
);
row(
	'insert-select-odku',
	'refused',
	'INSERT ... SELECT ... ON DUPLICATE KEY UPDATE',
	'INSERT INTO t (k) SELECT k FROM u ON DUPLICATE KEY UPDATE k = 2',
	'error 1235 (refused: insert-select-odku)',
	'SQLite needs WHERE true to disambiguate the clause, and the affected-row count has no probe'
);
row(
	'insert-set',
	'refused',
	'INSERT ... SET col = value',
	'INSERT INTO t SET a = 1',
	'error 1235 (refused: insert-set)',
	'a MySQL extension no WordPress core path emits; rewrite it as VALUES'
);
row(
	'insert-implicit-default',
	'translated',
	'a NOT NULL column with no default that the INSERT omits, under a non-strict sql_mode',
	'INSERT INTO t (a) VALUES (1) -- b is NOT NULL, no default',
	"the column is added with MySQL's implicit default (0, empty string or the zero date); strict mode answers 1364"
);
row(
	'insert-coercion',
	'translated',
	'a string literal into a numeric column, under a non-strict sql_mode',
	"INSERT INTO t (n) VALUES ('')",
	'INSERT INTO `t` (`n`) VALUES (0); strict mode answers 1366'
);
row(
	'datetime-literal',
	'semantics-changed',
	'a date or datetime literal is stored as written',
	"INSERT INTO t (d) VALUES ('2020-1-5')",
	'the same text',
	'MySQL normalises 2020-1-5 to 2020-01-05 and rejects invalid dates; SQLite keeps the text, so only canonical dates compare correctly'
);
row(
	'auto-increment-gaps',
	'semantics-changed',
	'AUTO_INCREMENT values after a failed or conflicting insert',
	'INSERT INTO t (k) VALUES (1) ON DUPLICATE KEY UPDATE k = 1',
	'the same statement',
	'InnoDB burns an id on every conflicting or failed insert; SQLite AUTOINCREMENT burns one only on a conflicting upsert, so later ids can be lower than on MySQL'
);
row(
	'update',
	'translated',
	'UPDATE reports rows changed, not rows matched',
	'UPDATE t SET a = 1 WHERE b = 2',
	'UPDATE `t` SET `a` = 1 WHERE (b = 2) AND (`a` IS NOT (1) COLLATE BINARY)'
);
row(
	'update-order-limit',
	'translated',
	'UPDATE ... [ORDER BY ...] LIMIT n',
	'UPDATE t SET a = 1 ORDER BY b LIMIT 2',
	'UPDATE `t` SET `a` = 1 WHERE rowid IN (SELECT rowid FROM `t` ORDER BY b LIMIT 2) AND (...)'
);
row(
	'update-multi-table',
	'refused',
	'UPDATE with a table list or a JOIN',
	'UPDATE a, b SET a.x = b.x WHERE a.id = b.id',
	'error 1235 (refused: update-multi-table)',
	'SQLite UPDATE names one table; a rewrite needs a correlated subquery per assignment'
);
row(
	'update-sequential-assign',
	'refused',
	'a later SET expression that reads a column assigned earlier in the same statement',
	'UPDATE t SET a = 1, b = a',
	'error 1235 (refused: update-sequential-assign)',
	'MySQL reads the new value of a and SQLite reads the old one'
);
row(
	'delete-limit',
	'translated',
	'DELETE ... [ORDER BY ...] LIMIT n',
	'DELETE FROM t WHERE a = 1 LIMIT 2',
	'DELETE FROM `t` WHERE rowid IN (SELECT rowid FROM `t` WHERE a = 1 LIMIT 2)'
);
row(
	'delete-multi-table',
	'translated',
	'DELETE a, b FROM t a, t b WHERE ... over one table',
	'DELETE a, b FROM t a, t b WHERE a.k = b.k',
	'DELETE FROM `t` WHERE rowid IN (SELECT `a`.rowid FROM ... UNION SELECT `b`.rowid FROM ...)'
);
row(
	'delete-multi-table-distinct',
	'refused',
	'multi-table DELETE over several tables, DELETE ... USING, or with ORDER BY or LIMIT',
	'DELETE a, b FROM t a, u b WHERE a.k = b.k',
	'error 1235 (refused: delete-multi-table-distinct)',
	'deleting from the first table changes what the join finds for the second'
);
// #endregion

// #region functions
row(
	'fn-aggregate',
	'supported',
	'COUNT, SUM, MIN, MAX, COALESCE, IFNULL, NULLIF, ABS and REPLACE',
	'SELECT COUNT(*) FROM t',
	'the same text'
);
row(
	'fn-concat',
	'translated',
	'CONCAT(a, b, ...)',
	"SELECT CONCAT('a', x) FROM t",
	"SELECT (('a') || (x)) AS `CONCAT('a', x)` FROM t"
);
row(
	'fn-substring',
	'translated',
	'SUBSTRING(s, pos[, len]), SUBSTR and MID',
	'SELECT SUBSTRING(a, 2) FROM t',
	'SELECT substr(a, 2) AS `SUBSTRING(a, 2)` FROM t'
);
row(
	'fn-date-part',
	'translated',
	'YEAR, MONTH, DAYOFMONTH and DAY of a canonical YYYY-MM-DD text',
	'SELECT MONTH(d) FROM t',
	'SELECT CAST(substr(d, 6, 2) AS INTEGER) AS `MONTH(d)` FROM t'
);
row(
	'fn-now',
	'semantics-changed',
	'NOW() and CURRENT_TIMESTAMP()',
	'SELECT NOW()',
	"SELECT datetime('now') AS `NOW()`",
	'SQLite answers UTC; MySQL answers the session time zone, which is UTC only when the server is'
);
row(
	'fn-date-add',
	'semantics-changed',
	'DATE_ADD and DATE_SUB with INTERVAL n unit',
	'SELECT DATE_SUB(NOW(), INTERVAL 7 DAY)',
	"datetime(datetime('now'), '-7 days')",
	'a month or year step past a short month overflows in SQLite and clamps in MySQL; a DATE input gains a time part'
);
row(
	'values-function',
	'refused',
	'VALUES(col) outside ON DUPLICATE KEY UPDATE',
	'SELECT VALUES(a) FROM t',
	'error 1235 (refused: values-function)',
	'MySQL answers NULL there'
);
row(
	'get-lock',
	'refused',
	'GET_LOCK, RELEASE_LOCK and the other named locks',
	"SELECT GET_LOCK('x', 1)",
	'error 1235 (refused: get-lock)',
	'a lock that cannot block a second connection would answer success to a caller that waits on it'
);
row(
	'function-form',
	'refused',
	'a function form the translator does not rewrite (SUBSTRING ... FROM, an unlisted INTERVAL unit)',
	'SELECT SUBSTRING(a FROM 2) FROM t',
	'error 1235 (refused: function-form)',
	'the SQLite form takes different arguments and the rewrite is not written'
);
row(
	'function-unknown',
	'refused',
	'any function outside the translator table',
	'SELECT LOWER(a) FROM t',
	'error 1235 (refused: function-unknown)',
	'a function SQLite also has can differ (LOWER is ASCII only, LENGTH counts characters), so each is added when a corpus needs it'
);
// #endregion

// #region pattern matching and collation
row(
	'like',
	'semantics-changed',
	'LIKE gets ESCAPE backslash, as MySQL has by default',
	"SELECT a FROM t WHERE a LIKE '%x\\_y%'",
	"SELECT a FROM t WHERE a LIKE '%x\\_y%' ESCAPE '\\'",
	'SQLite folds case for ASCII only, so a non-ASCII letter matches only its own case where MySQL folds all of Unicode'
);
row(
	'like-long',
	'semantics-changed',
	'a literal LIKE pattern over 50 bytes of the forms x, %x, x% and %x%',
	"SELECT a FROM t WHERE a LIKE '%<60 bytes>%'",
	"(instr(lower(a), '<lowered>') > 0)",
	'the platform refuses a LIKE pattern over 50 bytes; instr and substr over lower() fold ASCII only, as LIKE does'
);
row(
	'like-pattern-too-long',
	'refused',
	'a LIKE pattern over 50 bytes with an inner wildcard, an underscore or a non-column left side',
	"SELECT a FROM t WHERE a LIKE '%<30 bytes>%<30 bytes>%'",
	'error 1235 (refused: like-pattern-too-long)',
	'no equivalent of the pattern fits the 50 byte limit without a regular expression engine'
);
row(
	'regexp',
	'translated',
	'column REGEXP ^literal[class]{n}(literal)?$',
	"DELETE FROM wp_options WHERE option_name REGEXP '^rss_[0-9a-f]{32}(_ts)?$'",
	'length() and substr(lower()) tests with NOT GLOB on the class run, one alternative per optional group'
);
row(
	'regexp-other',
	'refused',
	'any other REGEXP or RLIKE shape',
	"SELECT a FROM t WHERE a REGEXP 'x+'",
	'error 1235 (refused: regexp-other)',
	'SQLite has no regular expression function, and the platform denies adding one'
);
row(
	'column-collation',
	'semantics-changed',
	'text columns are declared COLLATE NOCASE',
	'CREATE TABLE t (a varchar(10)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci',
	'CREATE TABLE `t` (`a` TEXT COLLATE NOCASE)',
	'NOCASE folds ASCII only: accent insensitivity, non-ASCII case folding and PAD SPACE comparison of MySQL are lost'
);
row(
	'collation-unknown',
	'refused',
	'a COLLATE name that is not _bin, _cs or _ci',
	'SELECT a COLLATE latin1_swedish FROM t',
	'error 1235 (refused: collation-unknown)',
	'the mapping to BINARY or NOCASE is by suffix and a name without one has no mapping'
);
// #endregion

// #region constructs with no SQLite form
row(
	'locking-read',
	'semantics-changed',
	'FOR UPDATE, FOR SHARE and LOCK IN SHARE MODE are dropped',
	'SELECT a FROM t WHERE id = 1 FOR UPDATE',
	'SELECT a FROM t WHERE id = 1',
	'the object runs one request at a time, so the lock is implied; no lock wait or deadlock error (1205, 1213) can happen'
);
row(
	'locking-read-nowait',
	'refused',
	'FOR UPDATE NOWAIT and SKIP LOCKED',
	'SELECT a FROM t FOR UPDATE SKIP LOCKED',
	'error 1235 (refused: locking-read-nowait)',
	'there is never another lock holder to skip, and a caller expecting a skipped row would be wrong'
);
row(
	'match-against',
	'refused',
	'MATCH (cols) AGAINST (...)',
	"SELECT a FROM t WHERE MATCH(a) AGAINST('x')",
	'error 1235 (refused: match-against)',
	'full text search needs an fts5 table with its own ranking, which this translator does not build'
);
row(
	'index-hint',
	'refused',
	'USE INDEX, FORCE INDEX and IGNORE INDEX',
	'SELECT a FROM t USE INDEX (k)',
	'error 1235 (refused: index-hint)',
	'SQLite names indexes differently (table__name) and a hint on the wrong name is an error there'
);
row(
	'select-into',
	'refused',
	'SELECT ... INTO OUTFILE, DUMPFILE or a variable',
	"SELECT a INTO OUTFILE '/tmp/x' FROM t",
	'error 1235 (refused: select-into)',
	'a Durable Object has no file system to write to'
);
row(
	'load-data',
	'refused',
	'LOAD DATA',
	"LOAD DATA INFILE '/tmp/x' INTO TABLE t",
	'error 1235 (refused: load-data)',
	'a Durable Object has no file system to read from'
);
row(
	'transaction',
	'refused',
	'BEGIN, START TRANSACTION, COMMIT and ROLLBACK',
	'START TRANSACTION',
	'error 1235 (refused: transaction)',
	'the platform rejects BEGIN over the statement bridge, and treating the statements as no-ops would lose the rollback'
);
row(
	'savepoint',
	'refused',
	'SAVEPOINT, RELEASE SAVEPOINT and ROLLBACK TO',
	'SAVEPOINT a',
	'error 1235 (refused: savepoint)',
	'the platform rejects SAVEPOINT, and a rollback that does nothing is worse than an error'
);
row(
	'lock-tables',
	'refused',
	'LOCK TABLES and UNLOCK TABLES',
	'LOCK TABLES t WRITE',
	'error 1235 (refused: lock-tables)',
	'there is no second connection to exclude, but a caller that relies on the lock also relies on the rollback'
);
row(
	'routines-triggers-views',
	'refused',
	'CREATE and DROP of procedures, functions, triggers, views and events; CALL and PREPARE',
	'CREATE VIEW v AS SELECT 1',
	'error 1235 (refused: routines-triggers-views)',
	'each stores MySQL text that would have to be translated at call time'
);
row(
	'maintenance-statement',
	'refused',
	'OPTIMIZE, ANALYZE, REPAIR, CHECK, FLUSH, KILL, USE, GRANT and REVOKE',
	'OPTIMIZE TABLE wp_options',
	'error 1235 (refused: maintenance-statement)',
	'no SQLite statement does the same job and a no-op would report success'
);
row(
	'statement-unknown',
	'refused',
	'a statement that starts with a word the translator does not know',
	'FROBNICATE t',
	'error 1064 (refused: statement-unknown)',
	'MySQL answers 1064'
);
// #endregion

// #region ddl
row(
	'create-table',
	'translated',
	'CREATE TABLE with columns, keys and table options',
	'CREATE TABLE t (id bigint(20) unsigned NOT NULL auto_increment, PRIMARY KEY (id))',
	'CREATE TABLE `t` (`id` INTEGER PRIMARY KEY AUTOINCREMENT), plus a CREATE INDEX per key and one row in cfw_mysql_schema holding the MySQL text'
);
row(
	'auto-increment',
	'translated',
	'AUTO_INCREMENT becomes INTEGER PRIMARY KEY AUTOINCREMENT',
	'CREATE TABLE t (id int NOT NULL auto_increment, PRIMARY KEY (id))',
	'`id` INTEGER PRIMARY KEY AUTOINCREMENT',
	'AUTOINCREMENT keeps ids from being reused after the newest row is deleted, as InnoDB keeps them; it costs one extra row write to sqlite_sequence per insert'
);
row(
	'ddl-unsigned',
	'semantics-changed',
	'unsigned integer types',
	'CREATE TABLE t (a bigint unsigned)',
	'`a` INTEGER',
	'SQLite does not range-check: a negative or an over-range value is stored where MySQL rejects or clamps it'
);
row(
	'ddl-decimal',
	'semantics-changed',
	'DECIMAL and NUMERIC columns',
	'CREATE TABLE t (a decimal(10,2))',
	'`a` NUMERIC',
	'SQLite stores 12.50 as the number 12.5, so the scale of the text is lost'
);
row(
	'index-prefix',
	'expensive',
	'a prefixed key on a varchar column, KEY meta_key (meta_key(191))',
	'CREATE TABLE t (m varchar(255), KEY m (m(191)))',
	'CREATE INDEX `t__m` ON `t` (`m`)',
	'SQLite has no prefix index, so the whole column is indexed and every index entry is up to (length - prefix) bytes larger'
);
row(
	'index-prefix-unsafe',
	'refused',
	'a prefix on a text or blob column, or on a unique key shorter than the column',
	'CREATE TABLE t (m longtext, KEY m (m(100)))',
	'error 1235 (refused: index-prefix-unsafe)',
	'indexing the whole column differs: a text index holds megabytes, and a unique prefix is stricter than a unique column'
);
row(
	'ddl-column-definition',
	'refused',
	'a column definition the parser cannot read',
	'CREATE TABLE t (a)',
	'error 1064 (refused: ddl-column-definition)',
	'MySQL answers 1064'
);
row(
	'ddl-type-unsupported',
	'refused',
	'ENUM, SET, GEOMETRY and the other types with no SQLite form',
	"CREATE TABLE t (a enum('x','y'))",
	'error 1235 (refused: ddl-type-unsupported)',
	'a CHECK constraint would reject what MySQL rejects but would not order or index by the enum position'
);
row(
	'ddl-column-attribute',
	'refused',
	'ZEROFILL, generated columns, ON UPDATE, and a default on an AUTO_INCREMENT column',
	'CREATE TABLE t (a int zerofill)',
	'error 1235 (refused: ddl-column-attribute)',
	'each changes stored values in a way SQLite cannot reproduce at column level'
);
row(
	'ddl-default-expression',
	'refused',
	'a default that is an expression other than CURRENT_TIMESTAMP',
	'CREATE TABLE t (a int DEFAULT (1+1))',
	'error 1235 (refused: ddl-default-expression)',
	'SQLite accepts a different expression language'
);
row(
	'ddl-create-unsupported',
	'refused',
	'CREATE TEMPORARY TABLE and other CREATE forms',
	'CREATE TEMPORARY TABLE t (a int)',
	'error 1235 (refused: ddl-create-unsupported)',
	'a temporary table lives for one connection and the object has no connection to scope it to'
);
row(
	'ddl-create-like-select',
	'refused',
	'CREATE TABLE ... LIKE and CREATE TABLE ... SELECT',
	'CREATE TABLE t LIKE u',
	'error 1235 (refused: ddl-create-like-select)',
	'the MySQL definition would have to be read from the other table and copied'
);
row(
	'ddl-table-option',
	'refused',
	'a table option the parser does not know',
	'CREATE TABLE t (a int) PARTITION BY HASH(a)',
	'error 1235 (refused: ddl-table-option)',
	'partitioning and the other storage options have no SQLite form'
);
row(
	'ddl-fulltext-key',
	'refused',
	'FULLTEXT and SPATIAL keys',
	'CREATE TABLE t (a text, FULLTEXT KEY a (a))',
	'error 1235 (refused: ddl-fulltext-key)',
	'full text search needs an fts5 table that this translator does not build'
);
row(
	'ddl-foreign-key',
	'refused',
	'FOREIGN KEY, CONSTRAINT and CHECK clauses',
	'CREATE TABLE t (a int, CHECK (a > 0))',
	'error 1235 (refused: ddl-foreign-key)',
	'enforcement differs (SQLite needs a pragma the platform denies), so silently dropping them would hide it'
);
row(
	'ddl-key-column',
	'refused',
	'a key that names a column the table does not have',
	'CREATE TABLE t (a int, KEY k (b))',
	'error 1072 (refused: ddl-key-column)',
	'MySQL answers 1072'
);
row(
	'ddl-auto-increment-key',
	'refused',
	'an AUTO_INCREMENT column that is not the whole primary key',
	'CREATE TABLE t (a int auto_increment, b int, PRIMARY KEY (a, b))',
	'error 1235 (refused: ddl-auto-increment-key)',
	'SQLite allows AUTOINCREMENT only on a single integer primary key'
);
row(
	'drop-table',
	'translated',
	'DROP TABLE [IF EXISTS] t[, u]',
	'DROP TABLE IF EXISTS t',
	'DROP TABLE IF EXISTS `t`, and the row in cfw_mysql_schema is deleted'
);
row(
	'alter-table',
	'refused',
	'ALTER TABLE, RENAME TABLE and CREATE INDEX',
	'ALTER TABLE t ADD COLUMN b int',
	'error 1235 (refused: alter-table)',
	'SQLite alters fewer forms and the stored MySQL definition has to change in step; added when a plugin corpus needs it'
);
row(
	'truncate',
	'refused',
	'TRUNCATE TABLE',
	'TRUNCATE TABLE t',
	'error 1235 (refused: truncate)',
	'DELETE does not reset the id sequence and the reset has to touch sqlite_sequence'
);
// #endregion

// #region platform limits
row(
	'statement-too-large',
	'refused',
	'a statement over the 100,000 byte limit that bound parameters cannot shrink',
	'INSERT INTO t (a) VALUES (<200 KB of tuples>)',
	'error 1153 (refused: statement-too-large)',
	'the limit counts the SQL text, so only a big single value can move out of it'
);
row(
	'literal-lifting',
	'translated',
	'a big string literal becomes a bound parameter when the statement would pass the byte limit',
	'INSERT INTO t (a) VALUES (<150 KB string>)',
	'INSERT INTO `t` (`a`) VALUES (?1)',
	''
);
row(
	'sqlite-error-mapped',
	'translated',
	'SQLite errors answered with the MySQL number WordPress tests for',
	'SELECT a FROM missing',
	"error 1146 (Table doesn't exist), 1054, 1062, 1048, 1050, 1064, 1305"
);
// #endregion

/** the statement-class table */
export const CLASS_ROWS: readonly ClassRow[] = rows;

const byId = new Map(rows.map((r) => [r.id, r]));

/** the row for an id, or undefined */
export function classRow(id: string): ClassRow | undefined {
	return byId.get(id);
}

/**
 * A construct the translator refuses, named by the id of its class-table row.
 *
 * `errno` is MySQL's number where one exists and 1235 (not supported yet) otherwise.
 */
export class Refusal extends Error {
	readonly id: string;
	readonly errno: number;
	readonly sqlstate: string;

	constructor(id: string, detail = '', errno = 1235, sqlstate = '42000') {
		const reason = byId.get(id)?.reason ?? '';
		super(`${id}${detail === '' ? '' : ` (${detail})`}${reason === '' ? '' : `: ${reason}`}`);
		this.id = id;
		this.errno = errno;
		this.sqlstate = sqlstate;
	}
}
