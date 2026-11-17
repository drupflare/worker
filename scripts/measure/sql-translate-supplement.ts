/** one authored statement: it must match MySQL, differ in a stated way, or be refused by name */
export interface SupplementCase {
	sql: string;
	/** the connection; a new name is a new session at MySQL's default strict mode */
	thread?: string;
	/** a class-table row whose documented difference this statement is expected to show */
	known?: string;
	/** a class-table row that must refuse the statement */
	refused?: string;
}

const RELAXED =
	"SET SESSION sql_mode='NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";
const hex = (c: string) => c.repeat(32);

/** statements for what the captured log never exercises, run after it on the same data */
export const SUPPLEMENT: SupplementCase[] = [
	{ sql: 'SET NAMES utf8mb4' },
	{ sql: RELAXED },
	// insert-odku: affected rows are 1 per insert, 2 per changed update, 0 per unchanged
	{
		sql: "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('zz_new', 'a', 'yes') ON DUPLICATE KEY UPDATE option_name = VALUES(option_name), option_value = VALUES(option_value), autoload = VALUES(autoload)"
	},
	{
		sql: "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('zz_new', 'a', 'yes') ON DUPLICATE KEY UPDATE option_name = VALUES(option_name), option_value = VALUES(option_value), autoload = VALUES(autoload)"
	},
	{
		sql: "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('zz_new', 'b', 'yes') ON DUPLICATE KEY UPDATE option_name = VALUES(option_name), option_value = VALUES(option_value), autoload = VALUES(autoload)"
	},
	{
		sql: "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('zz_two', '1', 'no'), ('zz_new', 'c', 'yes') ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)"
	},
	{
		sql: "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('ZZ_NEW', 'c', 'yes') ON DUPLICATE KEY UPDATE option_name = VALUES(option_name), option_value = VALUES(option_value)"
	},
	{
		sql: "SELECT option_name, option_value FROM wp_options WHERE option_name LIKE 'zz\\_%' ORDER BY option_name"
	},
	// update: rows changed, not rows matched
	{ sql: "UPDATE wp_options SET option_value = 'c' WHERE option_name = 'zz_new'" },
	{ sql: "UPDATE wp_options SET option_value = 'C' WHERE option_name = 'zz_new'" },
	{ sql: "UPDATE wp_options SET autoload = 'yes' WHERE autoload = 'yes'" },
	{
		sql: "UPDATE wp_options SET autoload = 'no' WHERE option_name LIKE 'zz%' ORDER BY option_id LIMIT 1"
	},
	{ sql: 'UPDATE wp_term_taxonomy SET count = count + 1 WHERE term_taxonomy_id = 1' },
	{ sql: "UPDATE wp_term_taxonomy SET count = '7' WHERE term_taxonomy_id = 1" },
	{ sql: "UPDATE wp_term_taxonomy SET count = '' WHERE term_taxonomy_id = 1" },
	{
		sql: "UPDATE wp_options SET option_value = 'x', autoload = 'x' WHERE option_name = 'nonexistent'"
	},
	{
		sql: 'UPDATE wp_term_taxonomy SET count = 1, parent = count WHERE term_taxonomy_id = 1',
		refused: 'update-sequential-assign'
	},
	// insert ids, ignore, implicit defaults, coercion (relaxed mode)
	{ sql: "INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (1, 'zz_a', 'x')" },
	{
		sql: "INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (1, 'zz_b', 'x'), (1, 'zz_c', 'y'), (1, 'zz_d', 'z')"
	},
	{ sql: "INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES ('', 'zz_e', 'x')" },
	{
		sql: "INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES ('12abc', 'zz_f', 'x')"
	},
	{
		sql: "SELECT post_id, meta_key FROM wp_postmeta WHERE meta_key LIKE 'zz\\_%' ORDER BY meta_id"
	},
	{ sql: "INSERT INTO wp_posts (post_title) VALUES ('zz relaxed')" },
	{
		sql: "SELECT post_title, post_content, post_excerpt, post_date, post_author, comment_count FROM wp_posts WHERE post_title = 'zz relaxed'"
	},
	{
		sql: "INSERT INTO wp_posts (post_title, post_date_gmt) VALUES ('zz zero', '0000-00-00 00:00:00')"
	},
	{ sql: "INSERT IGNORE INTO wp_options (option_name, option_value) VALUES ('zz_new', 'dup')" },
	{ sql: "INSERT IGNORE INTO wp_options (option_name, option_value) VALUES ('zz_ign', 'v')" },
	{ sql: "INSERT INTO wp_options (option_name, option_value) VALUES ('zz_new', 'dup')" },
	{
		sql: "INSERT INTO wp_options (option_name, option_value, autoload) VALUES (NULL, 'v', 'no')"
	},
	{ sql: 'INSERT INTO wp_postmeta (nope) VALUES (1)' },
	{
		sql: "REPLACE INTO wp_options (option_name, option_value) VALUES ('zz_new', 'replaced')",
		known: 'replace-into'
	},
	// strict mode, on a session that kept MySQL's default
	{ sql: "INSERT INTO wp_posts (post_title) VALUES ('zz strict')", thread: 'strict' },
	{
		sql: "INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES ('', 'zz_s', 'x')",
		thread: 'strict'
	},
	{
		sql: "INSERT INTO wp_posts (post_title, post_content, post_excerpt, post_content_filtered, to_ping, pinged, post_date_gmt) VALUES ('zz', '', '', '', '', '', '0000-00-00 00:00:00')",
		thread: 'strict'
	},
	// delete forms
	{
		sql: "INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('_transient_zz1', 'v', 'no'), ('_transient_timeout_zz1', '1000000005', 'no'), ('_transient_zz2', 'v', 'no'), ('_transient_timeout_zz2', '9999999999', 'no'), ('_transient_zz3', 'v', 'no')",
		known: 'auto-increment-gaps'
	},
	{
		sql: "DELETE a, b FROM wp_options a, wp_options b WHERE a.option_name LIKE '\\_transient\\_%' AND a.option_name NOT LIKE '\\_transient\\_timeout\\_%' AND b.option_name = CONCAT( '_transient_timeout_', SUBSTRING( a.option_name, 12 ) ) AND b.option_value < 5000000000"
	},
	{
		sql: "SELECT option_name FROM wp_options WHERE option_name LIKE '\\_transient\\_%' ORDER BY option_name"
	},
	{
		sql: `INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('rss_${hex('a')}', '1', 'no'), ('rss_${hex('A')}', '1', 'no'), ('rss_${hex('b')}_ts', '1', 'no'), ('rss_${hex('g')}', '1', 'no'), ('rss_${hex('c').slice(0, 31)}', '1', 'no'), ('xrss_${hex('d')}', '1', 'no')`
	},
	{ sql: "DELETE FROM wp_options WHERE option_name REGEXP '^rss_[0-9a-f]{32}(_ts)?$'" },
	{
		sql: "SELECT option_name FROM wp_options WHERE option_name LIKE '%rss%' ORDER BY option_name"
	},
	{
		sql: "SELECT option_name FROM wp_options WHERE option_name NOT REGEXP '^zz_' AND option_name LIKE 'zz%'",
		refused: 'regexp-other'
	},
	{ sql: "DELETE FROM wp_options WHERE option_name LIKE 'zz\\_%' ORDER BY option_id LIMIT 2" },
	{ sql: "DELETE FROM wp_options WHERE option_name LIKE 'zz\\_%'" },
	{
		sql: 'DELETE a, b FROM wp_options a, wp_postmeta b WHERE a.option_id = b.meta_id',
		refused: 'delete-multi-table-distinct'
	},
	// found rows
	{ sql: 'SELECT SQL_CALC_FOUND_ROWS ID FROM wp_posts ORDER BY ID LIMIT 0, 2' },
	{ sql: 'SELECT FOUND_ROWS()' },
	{ sql: 'SELECT FOUND_ROWS()' },
	{ sql: 'SELECT ID FROM wp_posts ORDER BY ID LIMIT 1, 2' },
	{ sql: 'SELECT FOUND_ROWS()' },
	{ sql: 'SELECT SQL_CALC_FOUND_ROWS post_type FROM wp_posts GROUP BY post_type LIMIT 1' },
	{ sql: 'SELECT FOUND_ROWS()' },
	{ sql: 'SELECT ID FROM wp_posts ORDER BY ID LIMIT 5, 10' },
	{ sql: 'SELECT FOUND_ROWS()' },
	{ sql: 'SELECT ID FROM wp_posts ORDER BY ID LIMIT 10, 2' },
	{ sql: 'SELECT FOUND_ROWS()' },
	{ sql: 'SELECT ID FROM wp_posts ORDER BY ID LIMIT 2 OFFSET 3' },
	{ sql: 'SELECT FOUND_ROWS()' },
	{ sql: 'SELECT ID FROM wp_posts WHERE ID > 1000 LIMIT 0, 5' },
	{ sql: 'SELECT FOUND_ROWS()' },
	{ sql: 'SELECT SQL_CALC_FOUND_ROWS ID FROM wp_posts ORDER BY ID' },
	{ sql: 'SELECT FOUND_ROWS()' },
	// like, collation, functions
	{ sql: "SELECT option_name FROM wp_options WHERE option_name LIKE '%SITEURL%'" },
	{
		sql: "SELECT option_name FROM wp_options WHERE option_name LIKE 'blog_%' ORDER BY option_name"
	},
	{
		sql: "SELECT option_name FROM wp_options WHERE option_name LIKE 'blog\\_%' ORDER BY option_name"
	},
	{
		sql: "SELECT option_name FROM wp_options WHERE option_name LIKE '%wp_user_roles%' ORDER BY option_name"
	},
	{
		sql: `INSERT INTO wp_options (option_name, option_value) VALUES ('zzlongname${'x'.repeat(60)}', 'v')`,
		known: 'auto-increment-gaps'
	},
	{
		sql: `SELECT option_name FROM wp_options WHERE option_name LIKE '%${'ZZLONGNAME'}${'x'.repeat(60)}%'`
	},
	{ sql: `SELECT option_name FROM wp_options WHERE option_name LIKE '%${'x'.repeat(60)}'` },
	{
		sql: `SELECT option_name FROM wp_options WHERE option_name LIKE 'zzlongname${'x'.repeat(40)}%'`
	},
	{
		sql: `SELECT option_name FROM wp_options WHERE option_name LIKE 'zzlongname${'x'.repeat(60)}'`
	},
	{
		sql: `SELECT option_name FROM wp_options WHERE option_name NOT LIKE '%${'x'.repeat(60)}' AND option_name LIKE 'zz%' ORDER BY option_name`
	},
	{
		sql: "SELECT option_value < 1000000000 FROM wp_options WHERE option_name = 'siteurl'",
		known: 'compare-text-number'
	},
	{
		sql: `SELECT option_name FROM wp_options WHERE option_name LIKE '${'siteurl'.padEnd(55, 'x')}%'`
	},
	{
		sql: `SELECT option_name FROM wp_options WHERE option_name NOT LIKE '%${'zz'.repeat(30)}%' AND option_name = 'siteurl'`
	},
	{
		sql: `SELECT option_name FROM wp_options WHERE option_name LIKE '%${'a'.repeat(30)}_${'b'.repeat(30)}%'`,
		refused: 'like-pattern-too-long'
	},
	{ sql: "SELECT 'a' LIKE 'A', 'É' LIKE 'é', 'e' LIKE 'É'", known: 'like' },
	{ sql: "SELECT option_name FROM wp_options WHERE option_name = 'SITEURL'" },
	{ sql: "SELECT option_name FROM wp_options WHERE option_name COLLATE utf8mb4_bin = 'SITEURL'" },
	{
		sql: "SELECT CONCAT('a', NULL), CONCAT('a', 1, 'b'), CONCAT(option_name, '-x') FROM wp_options WHERE option_name = 'siteurl'"
	},
	{ sql: "SELECT SUBSTRING('abcdef', 3), SUBSTRING('abcdef', -2), SUBSTRING('abcdef', 2, 3)" },
	{
		sql: "SELECT YEAR('2026-11-17 10:00:00'), MONTH('2026-11-17 10:00:00'), DAYOFMONTH('2026-11-17 10:00:00'), MONTH('0000-00-00 00:00:00'), YEAR(NULL)"
	},
	{
		sql: "SELECT DATE_SUB('2026-11-17 10:00:00', INTERVAL 7 DAY), DATE_ADD('2026-11-17 10:00:00', INTERVAL 2 HOUR), DATE_SUB('2026-11-17 10:00:00', INTERVAL 1 YEAR)"
	},
	{ sql: "SELECT DATE_ADD('2026-01-31 00:00:00', INTERVAL 1 MONTH)", known: 'fn-date-add' },
	{ sql: "SELECT DATE_ADD('2026-01-31', INTERVAL 1 DAY)", known: 'fn-date-add' },
	{
		sql: 'SELECT COUNT(*), MIN(autoload), MAX(autoload), SUM(1), COALESCE(NULL, 3), IFNULL(NULL, 4) FROM wp_options'
	},
	{ sql: 'SELECT 1 || 0, 0 && 1, NULL <=> NULL' },
	{ sql: 'SELECT 5 / 2', known: 'division' },
	{
		sql: "SELECT \"abc\" AS x, 'it\\'s', 'a''b', 'tab\\there', 'back\\\\slash', '\\%', '\\_' /* c */ # trailing"
	},
	{ sql: 'SELECT LOWER(option_name) FROM wp_options', refused: 'function-unknown' },
	{ sql: "SELECT GET_LOCK('x', 1)", refused: 'get-lock' },
	{ sql: 'SELECT a FROM t FOR UPDATE SKIP LOCKED', refused: 'locking-read-nowait' },
	{ sql: "SELECT option_name FROM wp_options WHERE option_name = 'siteurl' FOR UPDATE" },
	{ sql: 'SELECT option_name FROM wp_options LOCK IN SHARE MODE' },
	{ sql: "SELECT SQL_NO_CACHE option_name FROM wp_options WHERE option_name = 'siteurl'" },
	{
		sql: "SELECT a.option_name FROM wp_options a STRAIGHT_JOIN wp_options b ON a.option_id = b.option_id WHERE a.option_name = 'siteurl'"
	},
	{
		sql: "SELECT option_name FROM wp_options WHERE option_name = 'siteurl' UNION SELECT option_name FROM wp_options WHERE option_name = 'home' ORDER BY option_name"
	},
	{
		sql: 'SELECT autoload, COUNT(*) AS n FROM wp_options GROUP BY autoload HAVING n > 1 ORDER BY autoload'
	},
	{
		sql: 'SELECT option_name FROM wp_options WHERE option_id IN (SELECT MIN(option_id) FROM wp_options)'
	},
	{ sql: 'SELECT SQL_CALC_FOUND_ROWS 1 FROM wp_options a, wp_options b LIMIT 3' },
	{
		sql: 'SELECT a.* FROM wp_options a' + ' USE INDEX (autoload) LIMIT 1',
		refused: 'index-hint'
	},
	{ sql: "SELECT MATCH(post_title) AGAINST ('x') FROM wp_posts", refused: 'match-against' },
	{ sql: "SELECT X'41'", refused: 'hex-literal' },
	{ sql: 'SELECT @a := 1', refused: 'variable-in-expression' },
	{ sql: 'SELECT 1; SELECT 2', refused: 'syntax-error' },
	// host-answered session statements
	{ sql: 'SELECT @@SESSION.sql_mode' },
	{ sql: 'SELECT @@sql_mode, @@version_comment', known: 'select-system-variable' },
	{ sql: 'SELECT VERSION()', known: 'select-version' },
	{ sql: "SET SESSION sql_mode = 'NOT_A_MODE'" },
	{ sql: "SET SESSION sql_mode = 'ANSI_QUOTES'", refused: 'sql-mode-unsupported' },
	{ sql: 'SET autocommit = 0', refused: 'set-variable' },
	{ sql: 'START TRANSACTION', refused: 'transaction' },
	{ sql: 'COMMIT', refused: 'transaction' },
	{ sql: 'SAVEPOINT a', refused: 'savepoint' },
	{ sql: 'LOCK TABLES wp_options WRITE', refused: 'lock-tables' },
	{ sql: 'OPTIMIZE TABLE wp_options', refused: 'maintenance-statement' },
	{ sql: 'TRUNCATE TABLE wp_options', refused: 'truncate' },
	{ sql: 'ALTER TABLE wp_options ADD COLUMN zz int', refused: 'alter-table' },
	{ sql: "SELECT 1 INTO OUTFILE '/tmp/zz'", refused: 'select-into' },
	// show, describe, ddl
	{ sql: 'SHOW TABLES' },
	{ sql: "SHOW TABLES LIKE 'wp\\_po%'" },
	{ sql: 'SHOW COLUMNS FROM wp_posts' },
	{ sql: 'SHOW FULL COLUMNS FROM wp_term_taxonomy' },
	{ sql: 'SHOW INDEX FROM wp_term_taxonomy', known: 'show-index' },
	{ sql: 'SHOW CREATE TABLE wp_options', known: 'show-create-table' },
	{ sql: 'SHOW TABLE STATUS', refused: 'show-other' },
	{ sql: 'DESCRIBE zz_missing' },
	{ sql: 'CREATE TABLE wp_options (a int)' },
	{ sql: 'CREATE TABLE IF NOT EXISTS wp_options (a int)' },
	{
		sql: "CREATE TABLE zz_t (id bigint(20) unsigned NOT NULL auto_increment, name varchar(40) NOT NULL default '', n int(11) NOT NULL default '0', price decimal(10,2) default NULL, created datetime NOT NULL default '0000-00-00 00:00:00', body longtext, tiny tinyint(1) NOT NULL default 0, PRIMARY KEY  (id), UNIQUE KEY name (name), KEY n_created (n, created), KEY body_k (name(10))) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_520_ci",
		known: 'index-prefix'
	},
	{ sql: 'DESCRIBE zz_t' },
	{ sql: 'SHOW FULL COLUMNS FROM zz_t' },
	{ sql: "INSERT INTO zz_t (name, n, price) VALUES ('a', 1, 2.50), ('b', 2, NULL)" },
	{ sql: "INSERT INTO zz_t (name, n) VALUES ('A', 3)" },
	{ sql: "INSERT INTO zz_t (id, name) VALUES (50, 'z')" },
	{ sql: "INSERT INTO zz_t (name) VALUES ('after50')" },
	{ sql: 'DELETE FROM zz_t WHERE id = 51' },
	{ sql: "INSERT INTO zz_t (name) VALUES ('after-delete')" },
	{ sql: 'SELECT id, name, n, price FROM zz_t ORDER BY id', known: 'ddl-decimal' },
	{ sql: 'DROP TABLE zz_t' },
	{ sql: 'DROP TABLE zz_t' },
	{ sql: 'DROP TABLE IF EXISTS zz_t' },
	{ sql: "CREATE TABLE zz_e (a enum('x','y'))", refused: 'ddl-type-unsupported' },
	{
		sql: 'CREATE TABLE zz_f (a int, FOREIGN KEY (a) REFERENCES wp_posts (ID))',
		refused: 'ddl-foreign-key'
	},
	// errors
	{ sql: 'SELECT nope FROM wp_options' },
	{ sql: 'SELECT * FROM zz_missing' },
	{ sql: 'SELECT NOPE_FN(1)', refused: 'function-unknown' },
	{ sql: 'SELEC 1' },
	{ sql: "INSERT INTO wp_options (option_id, option_name) VALUES (1, 'dup')" }
];
