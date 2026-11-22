import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { memoryDatabase } from '../../scripts/measure/sql-translate-run';
import { frontPageReplies, type WpCapture } from '../../scripts/measure/wp-capture-golden';
import {
	bakedDatabase,
	compareShapes,
	plansOf,
	shapeOf,
	translatedDatabase,
	type DdlFixture
} from '../../scripts/wp/oracle-ddl';
import { loadFixture, replayFixture } from '../../scripts/wp/oracles';
import { CLASS_ROWS, classRow } from '../../src/db/sql/classes';
import {
	CACHE_MAX_ENTRIES,
	CACHE_MAX_SQL,
	executeMysql,
	translationOf,
	type MysqlReply
} from '../../src/db/sql/exec';
import {
	DEFAULT_SQL_MODE,
	createDatabaseState,
	createState,
	translate,
	type MysqlState,
	type Plan
} from '../../src/db/sql/translate';
import answers from '../fixtures/mysql-schema-answers.json';

/**
 * The statement-class table, row by row, over `node:sqlite` (the vitest `node` project).
 *
 * `CASES` has one entry per class row; the registry tests fail when a row has no case, a case has
 * no row, or a row that is not supported or translated has no reason. The MySQL answers in
 * `mysql-schema-answers.json` were read from a running MySQL for the DDL in the same file.
 */

const RELAXED =
	"SET SESSION sql_mode='NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";
const SRC = resolve(import.meta.dirname, '../../src/db/sql');

interface Rig {
	state: MysqlState;
	q: (sql: string) => MysqlReply;
	rows: (sql: string) => unknown[][];
	ok: (sql: string) => MysqlReply & { ok: true };
	run: ReturnType<typeof memoryDatabase>['run'];
	atomic: ReturnType<typeof memoryDatabase>['atomic'];
	raw: ReturnType<typeof memoryDatabase>['db'];
}

const TABLES = Object.values(answers) as { ddl: string }[];

function rig(
	options: { relaxed?: boolean; tables?: boolean; state?: Partial<MysqlState> } = {}
): Rig {
	const { db, run, atomic } = memoryDatabase();
	const state = createState({ database: 'wp', ...options.state });
	const q = (sql: string) => executeMysql(sql, run, state, { atomic });
	const ok = (sql: string) => {
		const r = q(sql);
		if (!r.ok) throw new Error(`${sql}\n=> ${JSON.stringify(r)}`);
		return r;
	};
	if (options.tables !== false) for (const t of TABLES) ok(t.ddl);
	if (options.relaxed !== false) ok(RELAXED);
	const rows = (sql: string) => {
		const r = ok(sql);
		if (r.kind !== 'rows') throw new Error('not a read');
		return r.rows;
	};
	return { state, q, rows, ok, run, atomic, raw: db };
}

function joinRig(): Rig {
	const r = rig({ tables: false });
	r.ok(
		"CREATE TABLE t_owner (id bigint(20) unsigned NOT NULL auto_increment, name varchar(20) NOT NULL default '', n int NOT NULL default 0, PRIMARY KEY (id))"
	);
	r.ok(
		"CREATE TABLE t_item (id bigint(20) unsigned NOT NULL auto_increment, owner_id bigint(20) unsigned NOT NULL default 0, label varchar(20) NOT NULL default '', flag tinyint NOT NULL default 0, PRIMARY KEY (id), KEY owner_id (owner_id))"
	);
	r.ok("INSERT INTO t_owner (name) VALUES ('ann'), ('bob'), ('cy')");
	r.ok('INSERT INTO t_item (owner_id) VALUES (1), (1), (2), (2), (4)');
	return r;
}

const plan = (sql: string, state: MysqlState = createState({ database: 'wp' })): Plan =>
	translate(sql, state).plan;

const mainSql = (sql: string, state?: MysqlState): string => {
	const p = plan(sql, state);
	if (p.kind === 'read') return p.step.sql;
	if (p.kind === 'write') return (p.steps[p.steps.length - 1] as { sql: string }).sql;
	throw new Error(`no statement: ${JSON.stringify(p)}`);
};

const refusedBy = (sql: string, state?: MysqlState): string | undefined => {
	const p = plan(sql, state);
	return p.kind === 'error' ? p.refused : undefined;
};

const refused = (id: string, sql: string) => () => expect(refusedBy(sql)).toBe(id);

const errno = (r: MysqlReply) => (r.ok ? 0 : r.errno);

const long = (n: number, c = 'x') => c.repeat(n);

const CASES: Record<string, () => void> = {
	'select-plain': () => {
		const sql = "SELECT ID FROM wp_posts WHERE post_status = 'publish' ORDER BY post_date DESC";
		expect(mainSql(sql)).toBe(sql);
	},
	'order-ties': () => {
		const r = rig();
		const ordered = 'SELECT option_id FROM t_options ORDER BY autoload DESC';
		expect(translationOf(ordered, r.state).classes).toContain('order-ties');
		expect(translationOf('SELECT option_id FROM t_options', r.state).classes).not.toContain(
			'order-ties'
		);
		expect(
			translationOf(
				'SELECT a FROM (SELECT option_id AS a FROM t_options ORDER BY a) x',
				r.state
			).classes
		).not.toContain('order-ties');
		r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('a', '1'), ('b', '2'), ('c', '3')"
		);
		expect(r.rows('SELECT option_id FROM t_options ORDER BY autoload DESC, option_id')).toEqual(
			[[1], [2], [3]]
		);
	},
	'union-having-subquery': () => {
		const r = rig();
		r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('a', '1'), ('b', '2'), ('c', '3')"
		);
		expect(r.rows('SELECT 1 AS a UNION SELECT 2 ORDER BY a')).toEqual([[1], [2]]);
		expect(
			r.rows('SELECT autoload, COUNT(*) AS n FROM t_options GROUP BY autoload HAVING n > 2')
		).toEqual([['yes', 3]]);
		expect(
			r.rows(
				'SELECT option_name FROM t_options WHERE option_id IN (SELECT MIN(option_id) FROM t_options)'
			)
		).toEqual([['a']]);
	},
	division: () => {
		expect(mainSql('SELECT 5 / 2')).toBe('SELECT 5 / 2');
		expect(rig({ tables: false }).rows('SELECT 5 / 2')).toEqual([[2]]);
	},
	'compare-text-number': () => {
		const sql = 'SELECT option_name FROM t_options WHERE option_value < 1000';
		expect(mainSql(sql)).toBe(sql);
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('five', '5')");
		expect(r.rows(sql)).toEqual([]);
	},
	'insert-plain': () => {
		const r = rig();
		const w = r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x')");
		expect(w).toMatchObject({ kind: 'write', affected: 1, insertId: 1 });
		const m = r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('b', 'x'), ('c', 'x'), ('d', 'x')"
		);
		expect(m).toMatchObject({ affected: 3, insertId: 2 });
		expect(w).toMatchObject({ rowsWritten: expect.any(Number) });
	},
	delete: () => {
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x'), ('b', 'x')");
		expect(r.ok("DELETE FROM t_options WHERE option_name = 'a'")).toMatchObject({
			affected: 1
		});
		expect(r.ok('DELETE FROM t_options')).toMatchObject({ affected: 1 });
	},
	'insert-select': () => {
		const r = rig();
		r.ok("INSERT INTO t_notes (author, body) VALUES ('a', 'b')");
		expect(mainSql('INSERT INTO t_links (object_id) SELECT note_id FROM t_notes')).toBe(
			'INSERT INTO `t_links` (`object_id`) SELECT note_id FROM t_notes'
		);
		expect(r.ok('INSERT INTO t_links (object_id) SELECT note_id FROM t_notes')).toMatchObject({
			affected: 1
		});
		// the id of the generated key is reported, as the plugins that read insert_id expect
		r.ok("INSERT INTO t_notes (author, body) VALUES ('a', 'b'), ('c', 'd')");
		expect(
			r.ok(
				"INSERT INTO t_notes (author, body) SELECT author, body FROM t_notes WHERE author = 'c'"
			)
		).toMatchObject({ affected: 1, insertId: 4 });
		expect(
			r.ok(
				"INSERT INTO t_notes (author, body) SELECT author, body FROM t_notes WHERE author = 'none'"
			)
		).toMatchObject({ affected: 0, insertId: 0 });
	},
	'from-dual': () => {
		expect(mainSql('SELECT 1 FROM DUAL WHERE 1 = 1').replace(/\s+/g, ' ')).toBe(
			'SELECT 1 WHERE 1 = 1'
		);
		const r = rig();
		expect(r.rows('SELECT 1 FROM DUAL WHERE ( SELECT NULL FROM dual ) IS NULL')).toEqual([[1]]);
		expect(r.rows('SELECT 5 FROM DUAL')).toEqual([[5]]);
		expect(r.rows('SELECT 5 FROM DUAL WHERE 1 = 2')).toEqual([]);
		expect(
			r.ok(
				"INSERT INTO t_options (option_name, option_value) SELECT 'a', 'b' FROM DUAL WHERE ( SELECT NULL FROM DUAL ) IS NULL"
			)
		).toMatchObject({ affected: 1, insertId: 1 });
		expect(r.q('SELECT a FROM `dual`')).toMatchObject({ errno: 1146 });
	},
	'string-literal': () => {
		expect(mainSql("SELECT 'it\\'s'")).toBe("SELECT 'it''s' AS `it's`");
		const r = rig({ tables: false });
		expect(r.rows("SELECT 'a''b', 'tab\\there', 'back\\\\slash', '\\%', \"dq\"")).toEqual([
			["a'b", 'tab\there', 'back\\slash', '\\%', 'dq']
		]);
		expect(mainSql("SELECT 'a\\0b'")).toContain("CAST(x'610062' AS TEXT)");
		const nul = rig();
		nul.ok("INSERT INTO t_options (option_name, option_value) VALUES ('nul', 'a\\0b')");
		expect(nul.rows("SELECT option_value FROM t_options WHERE option_name = 'nul'")).toEqual([
			['a\0b']
		]);
	},
	comments: () => {
		const r = rig({ tables: false });
		expect(r.rows('SELECT 1 # note')).toEqual([[1]]);
		expect(r.rows('SELECT 2 /* inline */ + 3')).toEqual([[5]]);
		expect(r.rows('SELECT 4 -- tail')).toEqual([[4]]);
	},
	'limit-offset': () => {
		expect(mainSql('SELECT a FROM t LIMIT 5, 10')).toBe('SELECT a FROM t LIMIT 10 OFFSET 5');
		expect(mainSql('SELECT a FROM t LIMIT 3')).toBe('SELECT a FROM t LIMIT 3');
	},
	collate: () => {
		expect(mainSql('SELECT a FROM t ORDER BY a COLLATE utf8mb4_bin')).toBe(
			'SELECT a FROM t ORDER BY a COLLATE BINARY'
		);
		expect(mainSql('SELECT a FROM t WHERE a = b COLLATE utf8mb4_unicode_520_ci')).toContain(
			'COLLATE NOCASE'
		);
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('Abc', '1')");
		expect(
			r.rows(
				"SELECT option_name FROM t_options WHERE option_name COLLATE utf8mb4_bin = 'abc'"
			)
		).toEqual([]);
	},
	'select-modifiers': () => {
		expect(mainSql('SELECT SQL_NO_CACHE a FROM t')).toBe('SELECT  a FROM t');
		expect(mainSql('SELECT SQL_SMALL_RESULT DISTINCT a FROM t')).toBe(
			'SELECT  DISTINCT a FROM t'
		);
	},
	'straight-join': () => {
		expect(mainSql('SELECT * FROM a STRAIGHT_JOIN b ON a.id = b.id')).toBe(
			'SELECT * FROM a CROSS JOIN b ON a.id = b.id'
		);
	},
	'operator-logical': () => {
		const r = rig({ tables: false });
		expect(r.rows('SELECT 1 || 0, 0 && 1, 1 && 1')).toEqual([[1, 0, 1]]);
		expect(mainSql('SELECT 1 || 0')).toContain(' OR ');
	},
	'operator-null-safe-equal': () => {
		const r = rig({ tables: false });
		expect(r.rows('SELECT NULL <=> NULL, 1 <=> NULL, 2 <=> 2')).toEqual([[1, 0, 1]]);
	},
	'executable-comment': refused('executable-comment', 'SELECT /*!40101 SQL_NO_CACHE */ 1'),
	'hex-literal': refused('hex-literal', "SELECT X'41'"),
	'variable-in-expression': refused('variable-in-expression', 'SELECT @a := 1'),
	'json-operator': refused('json-operator', "SELECT j->'$.a' FROM t"),
	'syntax-error': () => {
		expect(refusedBy('SELECT 1; SELECT 2')).toBe('syntax-error');
		expect(refusedBy("SELECT 'unterminated")).toBe('syntax-error');
		expect(refusedBy('SELECT ?')).toBe('syntax-error');
		expect(errno(rig().q('SELECT 1; DROP TABLE t_options'))).toBe(1064);
		expect(rig().rows('SELECT count(*) FROM t_options')).toEqual([[0]]);
	},
	'set-names': () => {
		const r = rig();
		expect(r.ok("SET NAMES 'utf8mb4' COLLATE 'utf8mb4_unicode_520_ci'")).toEqual({
			ok: true,
			kind: 'none'
		});
		expect(r.state.collation).toBe('utf8mb4_unicode_520_ci');
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x')");
		r.ok('SELECT SQL_CALC_FOUND_ROWS option_id FROM t_options LIMIT 0, 1');
		r.ok('SET NAMES utf8mb4');
		expect(r.rows('SELECT FOUND_ROWS()')).toEqual([[0]]);
	},
	'set-sql-mode': () => {
		const r = rig();
		r.ok("SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION,NO_ZERO_IN_DATE'");
		expect(r.rows('SELECT @@SESSION.sql_mode')).toEqual([
			['NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION']
		]);
		r.ok("SET sql_mode = ''");
		expect(r.rows('SELECT @@sql_mode')).toEqual([['']]);
	},
	'set-sql-mode-unknown': () => {
		const r = rig();
		expect(errno(r.q("SET SESSION sql_mode='NOT_A_MODE'"))).toBe(1231);
		expect(r.rows('SELECT @@sql_mode')[0]?.[0]).not.toBe('NOT_A_MODE');
	},
	'sql-mode-unsupported': refused('sql-mode-unsupported', "SET SESSION sql_mode='ANSI_QUOTES'"),
	'set-variable': () => {
		expect(refusedBy('SET autocommit = 0')).toBe('set-variable');
		expect(refusedBy("SET GLOBAL sql_mode = ''")).toBe('set-variable');
		expect(refusedBy('SET @x = 1')).toBe('set-variable');
	},
	'select-system-variable': () => {
		const r = createState();
		expect(translate('SELECT @@SESSION.sql_mode', r).plan).toEqual({
			kind: 'local',
			result: { columns: ['@@SESSION.sql_mode'], rows: [[DEFAULT_SQL_MODE]] }
		});
		expect(rig().rows('SELECT @@sql_mode, @@collation_connection')[0]).toHaveLength(2);
	},
	'select-version': () => {
		const r = rig({ state: { serverVersion: '8.0.99-test' } });
		expect(r.q('SELECT VERSION()')).toMatchObject({
			columns: ['VERSION()'],
			rows: [['8.0.99-test']]
		});
	},
	'system-variable': refused('system-variable', 'SELECT @@max_allowed_packet'),
	'found-rows': () => {
		const r = rig();
		for (let i = 0; i < 5; i++)
			r.ok(`INSERT INTO t_options (option_name, option_value) VALUES ('o${i}', 'v')`);
		r.ok('SELECT option_id FROM t_options ORDER BY option_id LIMIT 1, 2');
		expect(r.rows('SELECT FOUND_ROWS()')).toEqual([[3]]);
		expect(r.rows('SELECT FOUND_ROWS()')).toEqual([[1]]);
		r.ok('SELECT option_id FROM t_options ORDER BY option_id LIMIT 10, 2');
		expect(r.rows('SELECT FOUND_ROWS()')).toEqual([[5]]);
		r.ok('SELECT option_id FROM t_options LIMIT 2 OFFSET 3');
		expect(r.rows('SELECT FOUND_ROWS()')).toEqual([[5]]);
		expect(rig().rows('SELECT FOUND_ROWS()')).toEqual([[0]]);
	},
	'calc-found-rows': () => {
		const r = rig();
		for (let i = 0; i < 7; i++)
			r.ok(`INSERT INTO t_options (option_name, option_value) VALUES ('o${i}', 'v')`);
		const read = r.ok(
			'SELECT SQL_CALC_FOUND_ROWS option_name FROM t_options ORDER BY option_id LIMIT 0, 3'
		);
		expect(read).toMatchObject({ rows: [['o0'], ['o1'], ['o2']] });
		expect(r.rows('SELECT FOUND_ROWS()')).toEqual([[7]]);
		// no LIMIT: the count is the row count, with no second query
		r.ok('SELECT SQL_CALC_FOUND_ROWS option_name FROM t_options');
		expect(r.rows('SELECT FOUND_ROWS()')).toEqual([[7]]);
		// lazy: nothing is counted until FOUND_ROWS() arrives
		const p = plan(
			'SELECT SQL_CALC_FOUND_ROWS option_name FROM t_options ORDER BY option_id LIMIT 0, 3'
		);
		expect(p.kind === 'read' && p.step.sql).not.toContain('SQL_CALC_FOUND_ROWS');
		expect(p.kind === 'read' && p.calc && 'countStep' in p.calc && p.calc.countStep.sql).toBe(
			'SELECT count(*) FROM (SELECT  option_name FROM t_options )'
		);
		// per connection
		const other = createState({ database: 'wp', db: r.state.db });
		expect(executeMysql('SELECT FOUND_ROWS()', r.run, other)).toMatchObject({ rows: [[0]] });
	},
	'show-tables': () => {
		const r = rig();
		expect(r.rows('SHOW TABLES')).toEqual([
			['t_links'],
			['t_notes'],
			['t_options'],
			['t_terms']
		]);
		expect(r.q("SHOW TABLES LIKE 't\\_o%'")).toMatchObject({
			columns: ['Tables_in_wp (t\\_o%)'],
			rows: [['t_options']]
		});
		expect(r.rows("SHOW TABLES LIKE 'tXoptions'")).toEqual([]);
	},
	'show-columns': () => {
		const r = rig();
		for (const [name, a] of Object.entries(answers)) {
			const full = r.q(`SHOW FULL COLUMNS FROM ${name}`);
			expect(full).toMatchObject({ columns: a.full.columns, rows: a.full.rows });
			expect(r.q(`SHOW COLUMNS FROM \`${name}\``)).toMatchObject({ rows: a.describe.rows });
		}
		expect(errno(r.q('SHOW COLUMNS FROM missing'))).toBe(1146);
	},
	describe: () => {
		const r = rig();
		for (const [name, a] of Object.entries(answers)) {
			expect(r.q(`DESCRIBE ${name}`)).toMatchObject({
				columns: a.describe.columns,
				rows: a.describe.rows
			});
			expect(r.q(`DESC ${name}`)).toMatchObject({ rows: a.describe.rows });
		}
		expect(errno(r.q('DESCRIBE missing'))).toBe(1146);
	},
	'show-index': () => {
		const r = rig();
		for (const [name, a] of Object.entries(answers)) {
			const got = r.q(`SHOW INDEX FROM ${name}`);
			expect(got.ok && got.kind === 'rows' && got.columns).toEqual(a.index.columns);
			// Cardinality (column 6) is an estimate MySQL keeps and this does not
			const strip = (rows: unknown[][]) =>
				rows.map((x) =>
					x.filter((_, i) => i !== 6).map((v) => (v === null ? null : String(v)))
				);
			expect(strip(got.ok && got.kind === 'rows' ? got.rows : [])).toEqual(
				strip(a.index.rows)
			);
		}
	},
	'show-create-table': () => {
		const r = rig();
		for (const [name, a] of Object.entries(answers)) {
			expect(r.q(`SHOW CREATE TABLE ${name}`)).toMatchObject({ rows: [[name, a.create]] });
		}
		expect(errno(r.q('SHOW CREATE TABLE missing'))).toBe(1146);
	},
	'show-other': () => {
		expect(refusedBy('SHOW TABLE STATUS')).toBe('show-other');
		expect(refusedBy('SHOW VARIABLES')).toBe('show-other');
		expect(refusedBy('EXPLAIN SELECT 1')).toBe('show-other');
	},
	'information-schema-tables': () => {
		const r = rig();
		const sql =
			"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'wp' AND TABLE_NAME IN ('t_options','t_notes','nope') AND ENGINE = 'InnoDB' ORDER BY TABLE_NAME";
		expect(r.rows(sql)).toEqual([['t_notes'], ['t_options']]);
		expect(
			r.rows(
				"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_NAME = 't_options' AND ENGINE = 'MyISAM'"
			)
		).toEqual([]);
		expect(rig({ tables: false }).rows(sql)).toEqual([]);
	},
	'information-schema-other': refused(
		'information-schema-other',
		'SELECT * FROM information_schema.COLUMNS'
	),
	'insert-ignore': () => {
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x')");
		expect(mainSql("INSERT IGNORE INTO t_options (option_name) VALUES ('a')")).toContain(
			'INSERT OR IGNORE'
		);
		expect(
			r.ok("INSERT IGNORE INTO t_options (option_name, option_value) VALUES ('a', 'y')")
		).toMatchObject({
			affected: 0,
			insertId: 0
		});
		expect(
			r.ok("INSERT IGNORE INTO t_options (option_name, option_value) VALUES ('b', 'y')")
		).toMatchObject({
			affected: 1
		});
	},
	'replace-into': () => {
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x')");
		expect(
			mainSql("REPLACE INTO t_options (option_name, option_value) VALUES ('a', 'y')")
		).toContain('INSERT OR REPLACE');
		expect(
			r.ok("REPLACE INTO t_options (option_name, option_value) VALUES ('a', 'y')")
		).toMatchObject({
			affected: 1
		});
		expect(r.rows('SELECT option_value FROM t_options')).toEqual([['y']]);
	},
	'insert-odku': () => {
		const r = rig();
		const upsert = (name: string, value: string) =>
			r.ok(
				`INSERT INTO \`t_options\` (\`option_name\`, \`option_value\`, \`autoload\`) VALUES ('${name}', '${value}', 'yes') ON DUPLICATE KEY UPDATE \`option_name\` = VALUES(\`option_name\`), \`option_value\` = VALUES(\`option_value\`), \`autoload\` = VALUES(\`autoload\`)`
			);
		expect(upsert('a', '1')).toMatchObject({ affected: 1, insertId: 1 });
		expect(upsert('a', '1')).toMatchObject({ affected: 0, insertId: 0 });
		expect(upsert('a', '2')).toMatchObject({ affected: 2, insertId: 1 });
		expect(upsert('A', '2')).toMatchObject({ affected: 2 });
		expect(
			r.ok(
				"INSERT INTO t_options (option_name, option_value) VALUES ('n', '1'), ('A', '3') ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)"
			)
		).toMatchObject({ affected: 3 });
		expect(
			r.rows('SELECT option_name, option_value FROM t_options ORDER BY option_id')
		).toEqual([
			['A', '3'],
			['n', '1']
		]);
		const text = mainSql(
			"INSERT INTO t_options (option_name, option_value) VALUES ('a', 'b') ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)",
			r.state
		);
		expect(text).toContain(
			'ON CONFLICT (`option_name`) DO UPDATE SET `option_value` = excluded.option_value'
		);
		expect(text).toContain('IS NOT (excluded.option_value) COLLATE BINARY');
		// a composite key and an expression that reads the existing row
		r.ok('INSERT INTO t_links (object_id, term_taxonomy_id) VALUES (1, 2)');
		expect(
			r.ok(
				'INSERT INTO t_links (object_id, term_taxonomy_id, term_order) VALUES (1, 2, 5) ON DUPLICATE KEY UPDATE term_order = term_order + VALUES(term_order)'
			)
		).toMatchObject({ affected: 2 });
		expect(r.rows('SELECT term_order FROM t_links')).toEqual([[5]]);
	},
	'odku-no-schema': refused(
		'odku-no-schema',
		'INSERT INTO unknown_table (k) VALUES (1) ON DUPLICATE KEY UPDATE k = 2'
	),
	'insert-select-odku': () => {
		const r = rig();
		expect(
			refusedBy(
				'INSERT INTO t_links (object_id) SELECT 1 ON DUPLICATE KEY UPDATE object_id = 2',
				r.state
			)
		).toBe('insert-select-odku');
		const refuse = (sql: string) =>
			expect(refusedBy(sql, r.state), sql).toBe('insert-select-odku');
		refuse(
			"INSERT INTO t_options (option_name, option_value) SELECT 'a', 'b' FROM DUAL ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)"
		);
		refuse(
			"INSERT INTO t_options (option_name, option_value) SELECT option_name, 'b' FROM t_options ON DUPLICATE KEY UPDATE option_name = VALUES(option_name)"
		);
		refuse(
			"INSERT INTO t_options (option_name, option_value) SELECT 'a', 'b' FROM DUAL ON DUPLICATE KEY UPDATE option_name = 'z'"
		);
		refuse(
			'INSERT INTO unknown_table (k) SELECT 1 FROM DUAL ON DUPLICATE KEY UPDATE k = VALUES(k)'
		);
	},
	'insert-select-odku-noop': () => {
		const r = rig();
		const sql =
			"INSERT INTO t_options (option_name, option_value) SELECT 'a', 'b' FROM DUAL WHERE ( SELECT NULL FROM DUAL ) IS NULL ON DUPLICATE KEY UPDATE option_name = VALUES(option_name)";
		expect(mainSql(sql, r.state)).toMatch(/ ON CONFLICT DO NOTHING$/);
		expect(translationOf(sql, r.state).classes).toContain('insert-select-odku-noop');
		expect(r.ok(sql)).toMatchObject({ affected: 1, insertId: 1 });
		expect(r.ok(sql)).toMatchObject({ affected: 0, insertId: 0 });
		expect(r.rows('SELECT option_name, option_value FROM t_options')).toEqual([['a', 'b']]);
		// a column outside the key would change on MySQL, so it stays refused
		expect(
			refusedBy(
				sql.replace(
					'option_name = VALUES(option_name)',
					'option_value = VALUES(option_value)'
				),
				r.state
			)
		).toBe('insert-select-odku');
	},
	'insert-set': refused('insert-set', 'INSERT INTO t SET a = 1'),
	'insert-implicit-default': () => {
		const r = rig();
		r.ok("INSERT INTO t_notes (author) VALUES ('a')");
		expect(r.rows('SELECT body, created, author_email FROM t_notes')).toEqual([
			['', '0000-00-00 00:00:00', '']
		]);
		const strict = rig({ relaxed: false });
		const e = strict.q("INSERT INTO t_notes (author) VALUES ('a')");
		expect(e).toMatchObject({ ok: false, errno: 1364 });
		expect(strict.rows('SELECT count(*) FROM t_notes')).toEqual([[0]]);
	},
	'insert-coercion': () => {
		const r = rig();
		r.ok(
			"INSERT INTO t_terms (term_id, taxonomy, description) VALUES ('', 'a', ''), ('12abc', 'b', '')"
		);
		expect(r.rows('SELECT term_id FROM t_terms ORDER BY term_taxonomy_id')).toEqual([
			[0],
			[12]
		]);
		r.ok("UPDATE t_terms SET count = '' WHERE taxonomy = 'a'");
		r.ok("UPDATE t_terms SET count = '7x' WHERE taxonomy = 'b'");
		expect(r.rows('SELECT count FROM t_terms ORDER BY term_taxonomy_id')).toEqual([[0], [7]]);
		const strict = rig({ relaxed: false });
		expect(
			strict.q("INSERT INTO t_terms (term_id, taxonomy, description) VALUES ('', 'a', '')")
		).toMatchObject({
			ok: false,
			errno: 1366
		});
		expect(
			strict.q(
				"INSERT INTO t_notes (author, body, created) VALUES ('a', 'b', '0000-00-00 00:00:00')"
			)
		).toMatchObject({ ok: false, errno: 1292 });
	},
	'datetime-literal': () => {
		const r = rig();
		r.ok("INSERT INTO t_notes (author, body, created) VALUES ('a', 'b', '2020-1-5')");
		expect(r.rows('SELECT created FROM t_notes')).toEqual([['2020-1-5']]);
	},
	'auto-increment-gaps': () => {
		const r = rig();
		const odku =
			"INSERT INTO t_options (option_name, option_value) VALUES ('a', '1') ON DUPLICATE KEY UPDATE option_value = VALUES(option_value)";
		r.ok(odku);
		r.ok(odku);
		// SQLite also burns one id per conflicting upsert; MySQL burns one per failed insert too
		expect(
			r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('b', '1')")
		).toMatchObject({
			insertId: 3
		});
		expect(
			errno(r.q("INSERT INTO t_options (option_name, option_value) VALUES ('b', '1')"))
		).toBe(1062);
		expect(
			r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('c', '1')")
		).toMatchObject({
			insertId: 4
		});
	},
	update: () => {
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x'), ('b', 'x')");
		expect(
			r.ok("UPDATE t_options SET option_value = 'x' WHERE option_name = 'a'")
		).toMatchObject({ affected: 0 });
		expect(
			r.ok("UPDATE t_options SET option_value = 'y' WHERE option_name = 'a'")
		).toMatchObject({ affected: 1 });
		expect(
			r.ok("UPDATE t_options SET option_value = 'Y' WHERE option_name = 'a'")
		).toMatchObject({ affected: 1 });
		expect(r.ok("UPDATE t_options SET option_value = 'z'")).toMatchObject({ affected: 2 });
		expect(
			r.ok("UPDATE `t_options` SET `option_value` = 'q' WHERE `option_name` = 'nope'")
		).toMatchObject({
			affected: 0
		});
		expect(mainSql("UPDATE t_options SET option_value = 'q' WHERE option_name = 'a'")).toBe(
			"UPDATE `t_options` SET `option_value` = 'q' WHERE (option_name = 'a') AND (`option_value` IS NOT ('q') COLLATE BINARY)"
		);
		r.ok('UPDATE t_terms SET count = count + 1');
		expect(r.rows("SELECT option_value FROM t_options WHERE option_name = 'a'")).toEqual([
			['z']
		]);
	},
	'update-order-limit': () => {
		const r = rig();
		r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x'), ('b', 'x'), ('c', 'x')"
		);
		expect(
			r.ok("UPDATE t_options SET option_value = 'y' ORDER BY option_id DESC LIMIT 2")
		).toMatchObject({
			affected: 2
		});
		expect(r.rows('SELECT option_value FROM t_options ORDER BY option_id')).toEqual([
			['x'],
			['y'],
			['y']
		]);
		expect(r.ok("UPDATE t_options SET option_value = 'y' LIMIT 2")).toMatchObject({
			affected: 1
		});
	},
	'update-join': () => {
		const r = joinRig();
		const claim =
			"UPDATE t_item t1 JOIN ( SELECT id FROM t_item WHERE flag = 0 ORDER BY id LIMIT 2 FOR UPDATE ) t2 ON t1.id = t2.id SET flag = 7, label = 'held'";
		expect(mainSql(claim, r.state)).toBe(
			"UPDATE `t_item` AS `t1` SET `flag` = 7, `label` = 'held' FROM ( SELECT id FROM t_item WHERE flag = 0 ORDER BY id LIMIT 2  ) AS `t2` WHERE (t1.id = t2.id) AND (`t1`.`flag` IS NOT (7) COLLATE BINARY OR `t1`.`label` IS NOT ('held') COLLATE BINARY)"
		);
		expect(translationOf(claim, r.state).classes).toEqual(
			expect.arrayContaining(['update-join', 'locking-read', 'order-ties'])
		);
		expect(r.ok(claim)).toMatchObject({ affected: 2 });
		expect(r.rows('SELECT id FROM t_item WHERE flag = 7 ORDER BY id')).toEqual([[1], [2]]);
		expect(r.ok(claim)).toMatchObject({ affected: 2 });
		expect(r.rows('SELECT id FROM t_item WHERE flag = 7 ORDER BY id')).toEqual([
			[1],
			[2],
			[3],
			[4]
		]);
		expect(r.ok(claim)).toMatchObject({ affected: 1 });
		expect(r.ok(claim)).toMatchObject({ affected: 0 });
		// a row already holding the values is matched and not counted
		expect(
			r.ok(
				"UPDATE t_item i INNER JOIN t_owner o ON o.id = i.owner_id SET i.flag = 7 WHERE o.name = 'ann'"
			)
		).toMatchObject({ affected: 0 });
		expect(
			r.ok(
				"UPDATE t_item i, t_owner o SET i.label = 'x' WHERE i.owner_id = o.id AND o.name = 'bob'"
			)
		).toMatchObject({ affected: 2 });
		expect(r.rows("SELECT id FROM t_item WHERE label = 'x' ORDER BY id")).toEqual([[3], [4]]);
		// a self join needs the alias on both sides
		expect(
			r.ok(
				'UPDATE t_item a JOIN t_item b ON a.owner_id = b.owner_id AND b.id < a.id SET a.flag = 2'
			)
		).toMatchObject({ affected: 2 });
		expect(
			r.ok(
				"UPDATE t_item i JOIN t_owner o ON o.id = i.owner_id SET label = 'q' WHERE o.name = 'none'"
			)
		).toMatchObject({ affected: 0 });
		expect(
			refusedBy(
				'UPDATE t_item i JOIN t_owner o ON o.id = i.owner_id SET flag = 1',
				createState()
			)
		).toBe('update-multi-table');
	},
	'update-join-correlated': () => {
		const r = joinRig();
		const sql =
			'UPDATE t_owner o JOIN (SELECT owner_id, COUNT(*) AS c FROM t_item GROUP BY owner_id) x ON x.owner_id = o.id SET o.n = x.c';
		expect(translationOf(sql, r.state).classes).toEqual(
			expect.arrayContaining(['update-join', 'update-join-correlated'])
		);
		expect(r.ok(sql)).toMatchObject({ affected: 2 });
		expect(r.rows('SELECT id, n FROM t_owner ORDER BY id')).toEqual([
			[1, 2],
			[2, 2],
			[3, 0]
		]);
		expect(
			translationOf(
				'UPDATE t_item i JOIN t_owner o ON o.id = i.owner_id SET i.flag = 1',
				r.state
			).classes
		).not.toContain('update-join-correlated');
		// one target row with two joined rows keeps one of them; which one is not defined
		r.ok('UPDATE t_owner o JOIN t_item i ON i.owner_id = o.id SET o.n = i.id');
		expect([1, 2]).toContain(r.rows('SELECT n FROM t_owner WHERE id = 1')[0]?.[0]);
	},
	'update-multi-table': () => {
		const r = joinRig();
		const refuse = (sql: string) =>
			expect(refusedBy(sql, r.state), sql).toBe('update-multi-table');
		refuse('UPDATE t_item i JOIN t_owner o ON o.id = i.owner_id SET o.n = i.flag');
		refuse('UPDATE t_item i JOIN t_owner o ON o.id = i.owner_id SET i.flag = 1, o.n = 1');
		refuse('UPDATE t_item i LEFT JOIN t_owner o ON o.id = i.owner_id SET i.flag = 1');
		refuse('UPDATE t_item i NATURAL JOIN t_owner o SET i.flag = 1');
		refuse('UPDATE t_item i JOIN t_owner o USING (id) SET i.flag = 1');
		refuse('UPDATE t_item i JOIN t_owner o ON o.id = i.owner_id SET i.flag = 1 LIMIT 1');
		refuse('UPDATE t_item i JOIN t_owner o ON o.id = i.owner_id SET i.nope = 1');
		expect(r.q('UPDATE t_item i JOIN (SELECT 1) ON 1 SET i.flag = 1')).toMatchObject({
			errno: 1248
		});
	},
	'update-sequential-assign': () => {
		expect(refusedBy('UPDATE t SET a = 1, b = a')).toBe('update-sequential-assign');
		expect(refusedBy('UPDATE t SET a = 1, b = c')).toBeUndefined();
	},
	'delete-limit': () => {
		const r = rig();
		r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x'), ('b', 'x'), ('c', 'x')"
		);
		expect(r.ok('DELETE FROM t_options ORDER BY option_id DESC LIMIT 2')).toMatchObject({
			affected: 2
		});
		expect(r.rows('SELECT option_name FROM t_options')).toEqual([['a']]);
	},
	'delete-multi-table': () => {
		const r = rig();
		r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('_transient_a', 'v'), ('_transient_timeout_a', '1000000005'), ('_transient_b', 'v'), ('_transient_timeout_b', '9999999999'), ('keep', 'v')"
		);
		const w = r.ok(
			"DELETE a, b FROM t_options a, t_options b WHERE a.option_name LIKE '\\_transient\\_%' AND a.option_name NOT LIKE '\\_transient\\_timeout\\_%' AND b.option_name = CONCAT( '_transient_timeout_', SUBSTRING( a.option_name, 12 ) ) AND b.option_value < 5000000000"
		);
		expect(w).toMatchObject({ affected: 2 });
		expect(r.rows('SELECT option_name FROM t_options ORDER BY option_id')).toEqual([
			['_transient_b'],
			['_transient_timeout_b'],
			['keep']
		]);
	},
	'delete-multi-table-distinct': () => {
		expect(refusedBy('DELETE a, b FROM t a, u b WHERE a.k = b.k')).toBe(
			'delete-multi-table-distinct'
		);
		expect(refusedBy('DELETE FROM a USING a, b WHERE a.k = b.k')).toBe(
			'delete-multi-table-distinct'
		);
	},
	'fn-aggregate': () => {
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x'), ('b', 'y')");
		expect(
			r.rows(
				'SELECT COUNT(*), MIN(option_id), MAX(option_id), SUM(option_id), COALESCE(NULL, 3), IFNULL(NULL, 4) FROM t_options'
			)
		).toEqual([[2, 1, 2, 3, 3, 4]]);
		expect(r.q('SELECT COUNT(*) FROM t_options')).toMatchObject({ columns: ['COUNT(*)'] });
	},
	'fn-concat': () => {
		const r = rig();
		expect(r.rows("SELECT CONCAT('a', NULL), CONCAT('a', 1, 'b'), CONCAT('x')")).toEqual([
			[null, 'a1b', 'x']
		]);
		expect(r.q("SELECT CONCAT('a', 'b')")).toMatchObject({ columns: ["CONCAT('a', 'b')"] });
	},
	'fn-substring': () => {
		const r = rig();
		expect(
			r.rows(
				"SELECT SUBSTRING('abcdef', 3), SUBSTRING('abcdef', -2), SUBSTRING('abcdef', 2, 3)"
			)
		).toEqual([['cdef', 'ef', 'bcd']]);
		expect(r.q('SELECT SUBSTRING(a, 2) FROM (SELECT 1 AS a)')).toMatchObject({
			columns: ['SUBSTRING(a, 2)']
		});
	},
	'fn-date-part': () => {
		const r = rig();
		expect(
			r.rows(
				"SELECT YEAR('2026-11-17 10:00:00'), MONTH( '2026-11-17 10:00:00' ), DAYOFMONTH('2026-11-17 10:00:00'), DAY('2026-11-07'), MONTH('0000-00-00 00:00:00'), YEAR(NULL)"
			)
		).toEqual([[2026, 11, 17, 7, 0, null]]);
	},
	'fn-now': () => {
		const r = rig();
		expect(String(r.rows('SELECT NOW(), CURRENT_TIMESTAMP()')[0]?.[0])).toMatch(
			/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/
		);
		expect(r.q('SELECT NOW()')).toMatchObject({ columns: ['NOW()'] });
	},
	'fn-date-add': () => {
		const r = rig();
		expect(
			r.rows(
				"SELECT DATE_SUB('2026-11-17 10:00:00', INTERVAL 7 DAY), DATE_ADD('2026-11-17 10:00:00', INTERVAL 2 HOUR), DATE_SUB('2026-11-17 10:00:00', INTERVAL 1 WEEK), DATE_SUB('2026-11-17 10:00:00', INTERVAL (1 + 2) DAY)"
			)
		).toEqual([
			[
				'2026-11-10 10:00:00',
				'2026-11-17 12:00:00',
				'2026-11-10 10:00:00',
				'2026-11-14 10:00:00'
			]
		]);
		// the documented difference: a month step past a short month overflows
		expect(r.rows("SELECT DATE_ADD('2026-01-31 00:00:00', INTERVAL 1 MONTH)")).toEqual([
			['2026-03-03 00:00:00']
		]);
	},
	'fn-field': () => {
		const r = rig();
		r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x'), ('b', 'y'), ('c', 'z')"
		);
		expect(
			r.rows('SELECT option_id FROM t_options ORDER BY FIELD(option_id, 3, 1, 2)')
		).toEqual([[3], [1], [2]]);
		expect(
			r.rows(
				'SELECT option_id FROM t_options ORDER BY FIELD(option_id, 2, 3) DESC, option_id'
			)
		).toEqual([[3], [2], [1]]);
		expect(r.rows("SELECT FIELD(NULL, 1, 2), FIELD(7, 1, 2), FIELD('b', 'a', 'b')")).toEqual([
			[0, 0, 2]
		]);
		expect(
			r.rows("SELECT option_id FROM t_options ORDER BY FIELD(option_name, 'C', 'a', 'B')")
		).toEqual([[3], [1], [2]]);
		expect(r.q('SELECT FIELD(1, 1)')).toMatchObject({ columns: ['FIELD(1, 1)'] });
		expect(refusedBy('SELECT FIELD(1)')).toBe('function-form');
		// the documented difference: two strings with no column collation compare byte for byte
		expect(r.rows("SELECT FIELD('A', 'a', 'b')")).toEqual([[0]]);
	},
	'fn-length': () => {
		const r = rig();
		expect(
			r.rows("SELECT LENGTH('abc'), LENGTH('café'), LENGTH(123), LENGTH(''), LENGTH(NULL)")
		).toEqual([[3, 5, 3, 0, null]]);
		expect(r.q("SELECT LENGTH('a')")).toMatchObject({ columns: ["LENGTH('a')"] });
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'xé'), ('b', 'yy')");
		expect(r.rows('SELECT SUM(LENGTH(option_value)) FROM t_options')).toEqual([[5]]);
		expect(refusedBy('SELECT LENGTH(a, b) FROM t')).toBe('function-form');
	},
	'values-function': refused('values-function', 'SELECT VALUES(a) FROM t'),
	'get-lock': () => {
		expect(refusedBy("SELECT GET_LOCK('x', 1)")).toBe('get-lock');
		expect(refusedBy("SELECT RELEASE_LOCK('x')")).toBe('get-lock');
	},
	'function-form': () => {
		expect(refusedBy('SELECT SUBSTRING(a FROM 2) FROM t')).toBe('function-form');
		expect(refusedBy('SELECT DATE_ADD(a, INTERVAL 1 MICROSECOND) FROM t')).toBe(
			'function-form'
		);
	},
	'function-unknown': () => {
		expect(refusedBy('SELECT LOWER(a) FROM t')).toBe('function-unknown');
		expect(refusedBy('SELECT RAND()')).toBe('function-unknown');
	},
	like: () => {
		const r = rig();
		r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('a_c', 'x'), ('abc', 'x'), ('ABD', 'x')"
		);
		expect(r.rows("SELECT option_name FROM t_options WHERE option_name LIKE 'a\\_c'")).toEqual([
			['a_c']
		]);
		expect(
			r.rows(
				"SELECT option_name FROM t_options WHERE option_name LIKE 'ab%' ORDER BY option_id"
			)
		).toEqual([['abc'], ['ABD']]);
		expect(mainSql("SELECT a FROM t WHERE a LIKE 'x'")).toBe(
			"SELECT a FROM t WHERE a LIKE 'x' ESCAPE '\\'"
		);
		expect(mainSql("SELECT a FROM t WHERE a LIKE 'x' ESCAPE '!'")).not.toContain("ESCAPE '\\'");
		// documented: ASCII case folding only
		expect(r.rows("SELECT 'É' LIKE 'é'")).toEqual([[0]]);
	},
	'like-long': () => {
		const r = rig();
		const name = `zz${long(60)}`;
		r.ok(
			`INSERT INTO t_options (option_name, option_value) VALUES ('${name}', 'v'), ('other', 'v')`
		);
		const has = (pattern: string, not = '') =>
			r.rows(`SELECT option_name FROM t_options WHERE option_name ${not}LIKE '${pattern}'`)
				.length;
		expect(has(`%${long(60)}%`)).toBe(1);
		expect(has(`%${long(60)}`)).toBe(1);
		expect(has(`ZZ${long(60)}%`)).toBe(1);
		expect(has(name)).toBe(1);
		expect(has(`%${long(60)}`, 'NOT ')).toBe(1);
		expect(has(`%${long(59)}y%`)).toBe(0);
		expect(mainSql(`SELECT a FROM t WHERE a.b LIKE '%${long(60)}%'`)).toContain(
			'instr(lower(a.b)'
		);
	},
	'like-pattern-too-long': () => {
		expect(refusedBy(`SELECT a FROM t WHERE a LIKE '%${long(30)}_${long(30)}%'`)).toBe(
			'like-pattern-too-long'
		);
		expect(refusedBy(`SELECT a FROM t WHERE a LIKE '%${long(30)}%${long(30)}%'`)).toBe(
			'like-pattern-too-long'
		);
		expect(refusedBy(`SELECT a FROM t WHERE LOWER(a) LIKE '%${long(60)}%'`)).toBe(
			'function-unknown'
		);
		expect(refusedBy(`SELECT a FROM t WHERE CONCAT(a, 'x') LIKE '%${long(60)}%'`)).toBe(
			'like-pattern-too-long'
		);
	},
	regexp: () => {
		const r = rig();
		const hex = (c: string) => c.repeat(32);
		r.ok(
			`INSERT INTO t_options (option_name, option_value) VALUES ('rss_${hex('a')}', '1'), ('rss_${'Ab'.repeat(16)}', '1'), ('rss_${hex('b')}_ts', '1'), ('rss_${hex('g')}', '1'), ('rss_${long(31, 'c')}', '1'), ('xrss_${hex('d')}', '1'), ('keep', '1')`
		);
		const w = r.ok("DELETE FROM t_options WHERE option_name REGEXP '^rss_[0-9a-f]{32}(_ts)?$'");
		expect(w).toMatchObject({ affected: 3 });
		expect(
			r
				.rows('SELECT option_name FROM t_options ORDER BY option_id')
				.map((x) => String(x[0]).slice(0, 6))
		).toEqual(['rss_gg', 'rss_cc', 'xrss_d', 'keep']);
		expect(
			r.rows("SELECT count(*) FROM t_options WHERE option_name NOT REGEXP '^kee.$'")
		).toEqual([[3]]);
		expect(
			r.rows("SELECT count(*) FROM t_options WHERE t_options.option_name REGEXP '^k[e]{2}p$'")
		).toEqual([[1]]);
		expect(mainSql("SELECT a FROM t WHERE a REGEXP '^x$'")).toContain(
			"substr(lower(a), 1, 1) = 'x'"
		);
	},
	'regexp-other': () => {
		for (const re of ['x+', '^x+$', '^[^a]$', '^(a|b)$', '^\\\\d$', '^a$|^b$', '^(a)?(b)?$']) {
			expect(refusedBy(`SELECT a FROM t WHERE a REGEXP '${re}'`)).toBe('regexp-other');
		}
		expect(refusedBy("SELECT a FROM t WHERE LOWER(a) REGEXP '^a$'")).toBe('function-unknown');
		expect(refusedBy('SELECT a FROM t WHERE a REGEXP b')).toBe('regexp-other');
	},
	'column-collation': () => {
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('Abc', 'x')");
		expect(r.rows("SELECT option_name FROM t_options WHERE option_name = 'aBC'")).toEqual([
			['Abc']
		]);
		expect(
			errno(r.q("INSERT INTO t_options (option_name, option_value) VALUES ('ABC', 'x')"))
		).toBe(1062);
		// documented: accents are not folded
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('é', 'x')");
		expect(r.rows("SELECT count(*) FROM t_options WHERE option_name = 'e'")).toEqual([[0]]);
		const create = plan(
			'CREATE TABLE t (a varchar(10), b varchar(10) COLLATE utf8mb4_bin, c int)'
		);
		expect(create.kind === 'ddl' && create.steps[0]?.sql).toBe(
			'CREATE TABLE `t` (`a` TEXT COLLATE NOCASE, `b` TEXT, `c` INTEGER)'
		);
	},
	'collation-unknown': refused('collation-unknown', 'SELECT a COLLATE latin1_swedish FROM t'),
	'locking-read': () => {
		expect(mainSql('SELECT a FROM t WHERE id = 1 FOR UPDATE')).not.toContain('FOR UPDATE');
		expect(mainSql('SELECT a FROM t LOCK IN SHARE MODE')).not.toContain('SHARE');
		expect(mainSql('SELECT a FROM t FOR SHARE')).not.toContain('SHARE');
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x')");
		expect(
			r.rows("SELECT option_name FROM t_options WHERE option_name = 'a' FOR UPDATE")
		).toEqual([['a']]);
		// inside a derived table of a joined UPDATE, the form Action Scheduler claims with
		expect(
			mainSql(
				"UPDATE t_options o JOIN (SELECT option_id FROM t_options LIMIT 1 FOR UPDATE) x ON x.option_id = o.option_id SET autoload = 'no'",
				r.state
			)
		).not.toContain('FOR UPDATE');
	},
	'locking-read-nowait': () => {
		expect(mainSql('SELECT a FROM t FOR UPDATE SKIP LOCKED').trim()).toBe('SELECT a FROM t');
		expect(mainSql('SELECT a FROM t FOR SHARE NOWAIT').trim()).toBe('SELECT a FROM t');
		expect(
			translationOf('SELECT a FROM t FOR UPDATE SKIP LOCKED', createState()).classes
		).toEqual(expect.arrayContaining(['locking-read', 'locking-read-nowait']));
		expect(refusedBy('SELECT a FROM t FOR UPDATE SKIP')).toBe('syntax-error');
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x')");
		expect(
			r.rows('SELECT option_name FROM t_options ORDER BY option_id FOR UPDATE SKIP LOCKED')
		).toEqual([['a']]);
	},
	'match-against': refused('match-against', "SELECT a FROM t WHERE MATCH(a) AGAINST('x')"),
	'index-hint': () => {
		expect(refusedBy('SELECT a FROM t USE INDEX (k)')).toBe('index-hint');
		expect(refusedBy('SELECT a FROM t FORCE KEY (k)')).toBe('index-hint');
	},
	'select-into': () => {
		expect(refusedBy("SELECT a INTO OUTFILE '/tmp/x' FROM t")).toBe('select-into');
		expect(refusedBy('SELECT a INTO @v FROM t')).toBe('select-into');
	},
	'load-data': refused('load-data', "LOAD DATA INFILE '/tmp/x' INTO TABLE t"),
	transaction: () => {
		for (const s of ['START TRANSACTION', 'BEGIN', 'COMMIT', 'ROLLBACK'])
			expect(refusedBy(s)).toBe('transaction');
	},
	savepoint: () => {
		expect(refusedBy('SAVEPOINT a')).toBe('savepoint');
		expect(refusedBy('RELEASE SAVEPOINT a')).toBe('savepoint');
	},
	'lock-tables': () => {
		expect(refusedBy('LOCK TABLES t WRITE')).toBe('lock-tables');
		expect(refusedBy('UNLOCK TABLES')).toBe('lock-tables');
	},
	'routines-triggers-views': () => {
		expect(refusedBy('CREATE VIEW v AS SELECT 1')).toBe('routines-triggers-views');
		expect(refusedBy('CREATE TRIGGER x BEFORE INSERT ON t FOR EACH ROW SET @a = 1')).toBe(
			'routines-triggers-views'
		);
		expect(refusedBy('CALL p()')).toBe('routines-triggers-views');
		expect(refusedBy('DROP VIEW v')).toBe('routines-triggers-views');
	},
	'maintenance-statement': () => {
		for (const s of [
			'OPTIMIZE TABLE t',
			'ANALYZE TABLE t',
			'REPAIR TABLE t',
			'FLUSH TABLES',
			'KILL 1',
			'USE x'
		]) {
			expect(refusedBy(s)).toBe('maintenance-statement');
		}
	},
	'statement-unknown': () => {
		const r = rig();
		expect(r.q('FROBNICATE t')).toMatchObject({
			ok: false,
			errno: 1064,
			refused: 'statement-unknown'
		});
		expect(r.q('   ')).toMatchObject({ ok: false, errno: 1065 });
	},
	'create-table': () => {
		const r = rig({ tables: false });
		const sql = answers.t_options.ddl;
		expect(r.q(sql)).toMatchObject({ ok: true, kind: 'none' });
		expect(
			r.rows(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 't_options__%' ORDER BY name"
			)
		).toEqual([['t_options__autoload'], ['t_options__option_name']]);
		// the stored MySQL text outlives the isolate: a fresh database state reads it back
		const next = createState({ database: 'wp', db: createDatabaseState() });
		expect(executeMysql('DESCRIBE t_options', r.run, next)).toMatchObject({
			rows: answers.t_options.describe.rows
		});
		expect(errno(r.q(sql))).toBe(1050);
		expect(r.q(sql.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'))).toMatchObject({
			ok: true
		});
		// IF NOT EXISTS leaves the first definition in place
		expect(r.q('CREATE TABLE IF NOT EXISTS t_options (zz int)')).toMatchObject({ ok: true });
		expect(r.rows('DESCRIBE t_options')).toHaveLength(4);
		// the steps run in one unit when the host offers one
		let units = 0;
		const withAtomic = rig({ tables: false });
		executeMysql(sql.replace('t_options', 't_other'), withAtomic.run, withAtomic.state, {
			atomic: (fn) => {
				units++;
				return withAtomic.atomic(fn);
			}
		});
		expect(units).toBe(1);
	},
	'auto-increment': () => {
		const p = plan('CREATE TABLE t (id int NOT NULL auto_increment, PRIMARY KEY (id))');
		expect(p.kind === 'ddl' && p.steps[0]?.sql).toBe(
			'CREATE TABLE `t` (`id` INTEGER PRIMARY KEY AUTOINCREMENT)'
		);
		const r = rig();
		r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x'), ('b', 'x')");
		r.ok("DELETE FROM t_options WHERE option_name = 'b'");
		expect(
			r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('c', 'x')")
		).toMatchObject({
			insertId: 3
		});
		expect(
			r.ok(
				"INSERT INTO t_options (option_id, option_name, option_value) VALUES (50, 'd', 'x')"
			)
		).toMatchObject({
			insertId: 50
		});
		expect(
			r.ok("INSERT INTO t_options (option_name, option_value) VALUES ('e', 'x')")
		).toMatchObject({
			insertId: 51
		});
	},
	'ddl-unsigned': () => {
		const p = plan('CREATE TABLE t (a bigint unsigned NOT NULL)');
		expect(p.kind === 'ddl' && p.steps[0]?.sql).toBe('CREATE TABLE `t` (`a` INTEGER NOT NULL)');
		const r = rig({ tables: false });
		r.ok('CREATE TABLE t (a bigint unsigned NOT NULL)');
		r.ok('INSERT INTO t (a) VALUES (-1)');
		expect(r.rows('SELECT a FROM t')).toEqual([[-1]]);
		expect(r.rows('DESCRIBE t')[0]?.[1]).toBe('bigint unsigned');
	},
	'ddl-decimal': () => {
		const r = rig();
		r.ok("INSERT INTO t_notes (author, body, price) VALUES ('a', 'b', 2.50)");
		expect(r.rows('SELECT price FROM t_notes')).toEqual([[2.5]]);
		expect(r.rows('DESCRIBE t_notes')[6]?.[1]).toBe('decimal(10,2)');
	},
	'index-prefix': () => {
		const r = rig();
		const sql = r.raw
			.prepare("SELECT sql FROM sqlite_master WHERE name = 't_notes__author_email'")
			.get() as {
			sql: string;
		};
		expect(sql.sql).toBe('CREATE INDEX `t_notes__author_email` ON `t_notes` (`author_email`)');
		expect(r.rows('SHOW INDEX FROM t_notes').find((x) => x[2] === 'author_email')?.[7]).toBe(
			10
		);
	},
	'index-prefix-unsafe': () => {
		expect(refusedBy('CREATE TABLE t (m longtext, KEY m (m(100)))')).toBe(
			'index-prefix-unsafe'
		);
		expect(refusedBy('CREATE TABLE t (m varchar(50), UNIQUE KEY m (m(10)))')).toBe(
			'index-prefix-unsafe'
		);
		expect(refusedBy('CREATE TABLE t (m varchar(50), UNIQUE KEY m (m(50)))')).toBeUndefined();
	},
	'ddl-column-definition': () => {
		expect(refusedBy('CREATE TABLE t (a)')).toBe('ddl-column-definition');
		expect(errno(rig({ tables: false }).q('CREATE TABLE t (a)'))).toBe(1064);
	},
	'ddl-type-unsupported': () => {
		expect(refusedBy("CREATE TABLE t (a enum('x','y'))")).toBe('ddl-type-unsupported');
		expect(refusedBy('CREATE TABLE t (a geometry)')).toBe('ddl-type-unsupported');
	},
	'ddl-column-attribute': () => {
		expect(refusedBy('CREATE TABLE t (a int zerofill)')).toBe('ddl-column-attribute');
		expect(refusedBy('CREATE TABLE t (a int GENERATED ALWAYS AS (1))')).toBe(
			'ddl-column-attribute'
		);
	},
	'ddl-default-expression': refused(
		'ddl-default-expression',
		'CREATE TABLE t (a int DEFAULT (1+1))'
	),
	'ddl-create-unsupported': () => {
		expect(refusedBy('CREATE TEMPORARY TABLE t (a int)')).toBe('ddl-create-unsupported');
	},
	'ddl-create-like-select': () => {
		expect(refusedBy('CREATE TABLE t LIKE u')).toBe('ddl-create-like-select');
		expect(refusedBy('CREATE TABLE t AS SELECT 1')).toBe('ddl-create-like-select');
	},
	'ddl-table-option': refused('ddl-table-option', 'CREATE TABLE t (a int) PARTITION BY HASH(a)'),
	'ddl-fulltext-key': refused('ddl-fulltext-key', 'CREATE TABLE t (a text, FULLTEXT KEY a (a))'),
	'ddl-foreign-key': () => {
		expect(refusedBy('CREATE TABLE t (a int, CHECK (a > 0))')).toBe('ddl-foreign-key');
		expect(refusedBy('CREATE TABLE t (a int, FOREIGN KEY (a) REFERENCES u (id))')).toBe(
			'ddl-foreign-key'
		);
	},
	'ddl-key-column': () => {
		expect(rig({ tables: false }).q('CREATE TABLE t (a int, KEY k (b))')).toMatchObject({
			ok: false,
			errno: 1072,
			refused: 'ddl-key-column'
		});
	},
	'ddl-auto-increment-key': refused(
		'ddl-auto-increment-key',
		'CREATE TABLE t (a int auto_increment, b int, PRIMARY KEY (a, b))'
	),
	'drop-table': () => {
		const r = rig();
		expect(r.ok('DROP TABLE t_links')).toMatchObject({ kind: 'none' });
		expect(r.rows('SHOW TABLES')).not.toContainEqual(['t_links']);
		expect(errno(r.q('DROP TABLE t_links'))).toBe(1051);
		expect(r.q('DROP TABLE IF EXISTS t_links')).toMatchObject({ ok: true });
		expect(r.q('DROP TABLE t_notes, t_terms')).toMatchObject({ ok: true });
		expect(r.rows('SHOW TABLES')).toEqual([['t_options']]);
		expect(errno(r.q('DESCRIBE t_notes'))).toBe(1146);
		// the stored definition went with it
		const next = createState({ database: 'wp', db: createDatabaseState() });
		expect(executeMysql('SHOW TABLES', r.run, next)).toMatchObject({ rows: [['t_options']] });
	},
	'alter-table': () => {
		expect(refusedBy('ALTER TABLE t ADD COLUMN b int')).toBe('alter-table');
		expect(refusedBy('RENAME TABLE a TO b')).toBe('alter-table');
		expect(refusedBy('CREATE INDEX i ON t (a)')).toBe('alter-table');
	},
	truncate: refused('truncate', 'TRUNCATE TABLE t'),
	'statement-too-large': () => {
		const state = createState({ database: 'wp', maxStatementBytes: 300, maxParams: 3 });
		const tuples = Array.from({ length: 40 }, (_, i) => `('k${i}', 'v')`).join(', ');
		const p = translate(
			`INSERT INTO t_options (option_name, option_value) VALUES ${tuples}`,
			state
		).plan;
		expect(p).toMatchObject({ kind: 'error', errno: 1153, refused: 'statement-too-large' });
		const many = Array.from({ length: 8 }, (_, i) => `('${long(100, String(i))}', 'v')`).join(
			', '
		);
		expect(
			refusedBy(`INSERT INTO t_options (option_name, option_value) VALUES ${many}`, state)
		).toBe('statement-too-large');
	},
	'literal-lifting': () => {
		const r = rig({ state: { maxStatementBytes: 2000 } });
		const big = `${long(5000, 'q')}'"\\`;
		const text = `INSERT INTO t_options (option_name, option_value) VALUES ('big', '${big.replaceAll("'", "''").replaceAll('\\', '\\\\')}')`;
		const p = plan(text, r.state);
		expect(p.kind === 'write' && p.steps[0]?.params).toEqual([big]);
		expect(p.kind === 'write' && p.steps[0]?.sql).toContain('?1');
		expect(r.ok(text)).toMatchObject({ affected: 1 });
		expect(r.rows("SELECT option_value FROM t_options WHERE option_name = 'big'")).toEqual([
			[big]
		]);
		// the same literal in SET and in the change test binds once
		const bigger = `${long(5000, 'z')}`;
		const u = plan(
			`UPDATE t_options SET option_value = '${bigger}' WHERE option_name = 'big'`,
			r.state
		);
		expect(u.kind === 'write' && u.steps[0]?.params).toEqual([bigger]);
		expect(
			r.ok(`UPDATE t_options SET option_value = '${bigger}' WHERE option_name = 'big'`)
		).toMatchObject({
			affected: 1
		});
		expect(
			r.ok(`UPDATE t_options SET option_value = '${bigger}' WHERE option_name = 'big'`)
		).toMatchObject({
			affected: 0
		});
		// 101 literals stay inline, so no bound parameter limit applies
		const list = Array.from({ length: 101 }, (_, i) => `'o${i}'`).join(', ');
		const s = plan(`SELECT option_name FROM t_options WHERE option_name IN (${list})`, r.state);
		expect(s.kind === 'read' && s.step.params).toEqual([]);
	},
	'sqlite-error-mapped': () => {
		const r = rig();
		expect(r.q('SELECT a FROM missing')).toMatchObject({ errno: 1146, sqlstate: '42S02' });
		expect(r.q('SELECT nope FROM t_options')).toMatchObject({ errno: 1054 });
		expect(r.q("INSERT INTO t_options (nope) VALUES ('x')")).toMatchObject({ errno: 1054 });
		r.ok("INSERT INTO t_options (option_id, option_name) VALUES (1, 'a')");
		expect(r.q("INSERT INTO t_options (option_id, option_name) VALUES (1, 'b')")).toMatchObject(
			{ errno: 1062 }
		);
		expect(
			r.q("INSERT INTO t_options (option_name, option_value) VALUES (NULL, 'b')")
		).toMatchObject({
			errno: 1048
		});
		expect(r.q('SELEC 1')).toMatchObject({ errno: 1064 });
		expect(
			r.q('SELECT a.option_id FROM t_options a, t_options b WHERE option_id = 1')
		).toMatchObject({
			errno: 1052
		});
		expect(r.q('INSERT INTO t_links (object_id) VALUES (1, 2)')).toMatchObject({ errno: 1136 });
	}
};

describe('class table registry', () => {
	it('has a case for every row and a row for every case', () => {
		expect(Object.keys(CASES).sort()).toEqual(CLASS_ROWS.map((r) => r.id).sort());
	});

	it('gives every row a unique id, a test id and an example', () => {
		const ids = new Set<string>();
		for (const row of CLASS_ROWS) {
			expect(ids.has(row.id), `duplicate ${row.id}`).toBe(false);
			ids.add(row.id);
			expect(row.test).toBe(`sql-translate: ${row.id}`);
			expect(row.example.length, row.id).toBeGreaterThan(0);
			expect(row.becomes.length, row.id).toBeGreaterThan(0);
			expect(row.description.length, row.id).toBeGreaterThan(0);
		}
	});

	it('gives every row that is not supported or translated a reason', () => {
		for (const row of CLASS_ROWS) {
			if (row.kind === 'supported' || row.kind === 'translated') continue;
			expect(row.reason.length, `${row.id} has no reason`).toBeGreaterThan(0);
		}
	});

	it('names only rows that exist at every place the source names one', () => {
		const used = new Set<string>();
		for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
			const text = readFileSync(resolve(SRC, file), 'utf8');
			for (const m of text.matchAll(
				/(?:new Refusal|this\.note|r\.note|\.note)\(\s*'([a-z0-9-]+)'/g
			)) {
				used.add(m[1] as string);
			}
		}
		for (const id of used) expect(classRow(id), `unknown class id ${id}`).toBeDefined();
	});

	it('renders the table in one of the five classes', () => {
		const kinds = new Set(CLASS_ROWS.map((r) => r.kind));
		for (const k of kinds) {
			expect([
				'supported',
				'translated',
				'semantics-changed',
				'expensive',
				'refused'
			]).toContain(k);
		}
		expect(kinds.size).toBe(5);
	});
});

describe('statement classes', () => {
	for (const row of CLASS_ROWS) {
		it(row.test, CASES[row.id] ?? (() => expect.fail(`no case for ${row.id}`)));
	}
});

describe('statement terminator', () => {
	it('takes one closing semicolon, as dbDelta sends on DESCRIBE', () => {
		const r = rig();
		expect(r.q('DESCRIBE wp_options;')).toEqual(r.q('DESCRIBE wp_options'));
		expect(r.q('SELECT 1 ;  ')).toEqual(r.q('SELECT 1'));
		expect(r.q('SHOW TABLES;').ok).toBe(true);
	});

	it('still refuses a second statement and a lone semicolon', () => {
		const r = rig();
		expect(errno(r.q('SELECT 1;;'))).toBe(1064);
		expect(errno(r.q('SELECT 1; SELECT 2'))).toBe(1064);
		expect(errno(r.q('SELECT 1; SELECT 2;'))).toBe(1064);
		expect(errno(r.q(';'))).toBe(1064);
	});
});

describe('translation cache', () => {
	it('answers a repeated statement from the cache and counts it', () => {
		const r = rig();
		const sql = "SELECT option_name FROM t_options WHERE option_name = 'a'";
		const before = r.state.db.stats.hits;
		r.ok(sql);
		r.ok(sql);
		r.ok(sql);
		expect(r.state.db.stats.hits - before).toBe(2);
	});

	it('does not cache a long statement or a host-answered one', () => {
		const r = rig();
		const long = `SELECT '${'x'.repeat(CACHE_MAX_SQL)}'`;
		r.ok(long);
		r.ok(long);
		expect(r.state.db.cache.has(long)).toBe(false);
		r.ok('SELECT @@sql_mode');
		expect(r.state.db.cache.has('SELECT @@sql_mode')).toBe(false);
	});

	it('is bounded and drops the oldest entry first', () => {
		const r = rig({ tables: false });
		for (let i = 0; i < CACHE_MAX_ENTRIES + 20; i++) r.ok(`SELECT ${i}`);
		expect(r.state.db.cache.size).toBe(CACHE_MAX_ENTRIES);
		expect(r.state.db.cache.has('SELECT 0')).toBe(false);
		expect(r.state.db.cache.has(`SELECT ${CACHE_MAX_ENTRIES + 19}`)).toBe(true);
	});

	it('retires a translation when the schema or the sql mode changes under it', () => {
		const r = rig({ tables: false });
		const sql = "INSERT INTO t_notes (author) VALUES ('a')";
		r.ok('CREATE TABLE t_notes (author tinytext NOT NULL, body text NOT NULL)');
		expect(r.q(sql)).toMatchObject({ ok: true });
		r.ok('SET SESSION sql_mode = STRICT_TRANS_TABLES');
		expect(translationOf(sql, r.state).plan).toMatchObject({ kind: 'error', errno: 1364 });
		r.ok('DROP TABLE t_notes');
		expect(r.q(sql)).toMatchObject({ ok: false, errno: 1146 });
	});

	it('shares nothing between two database states', () => {
		const a = createState({ database: 'wp' });
		const b = createState({ database: 'wp' });
		expect(a.db).not.toBe(b.db);
		expect(a.db.cache).not.toBe(b.db.cache);
	});
});

describe('bridge reply shape', () => {
	it('answers rows, write, none and error in the contract shapes', () => {
		const r = rig();
		expect(r.q('SELECT 1 AS a, 2 AS a')).toMatchObject({
			ok: true,
			kind: 'rows',
			columns: ['a', 'a'],
			rows: [[1, 2]]
		});
		expect(
			r.q("INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x')")
		).toMatchObject({
			ok: true,
			kind: 'write',
			affected: 1,
			insertId: 1
		});
		expect(r.q('SET NAMES utf8mb4')).toEqual({ ok: true, kind: 'none' });
		expect(r.q('SELECT a FROM missing')).toMatchObject({
			ok: false,
			errno: 1146,
			sqlstate: '42S02',
			error: expect.stringContaining('missing')
		});
		expect(r.q('START TRANSACTION')).toMatchObject({ ok: false, refused: 'transaction' });
	});

	it('reports rows written and read, which are the host meters', () => {
		const r = rig();
		const w = r.ok(
			"INSERT INTO t_options (option_name, option_value) VALUES ('a', 'x'), ('b', 'x')"
		);
		expect(w).toMatchObject({ rowsWritten: 2 });
		const read = r.ok('SELECT option_name FROM t_options');
		expect(read).toMatchObject({ rowsRead: 2 });
	});

	it('keeps both columns of a join that repeats a column name', () => {
		const r = rig();
		r.ok("INSERT INTO t_terms (term_id, taxonomy, description) VALUES (7, 'a', '')");
		r.ok('INSERT INTO t_links (object_id, term_taxonomy_id) VALUES (7, 1)');
		const got = r.ok(
			'SELECT t.*, l.* FROM t_terms AS t INNER JOIN t_links AS l ON t.term_taxonomy_id = l.term_taxonomy_id'
		);
		expect(
			got.kind === 'rows' && got.columns.filter((c) => c === 'term_taxonomy_id')
		).toHaveLength(2);
		expect(got.kind === 'rows' && got.rows[0]).toHaveLength(7 + 3);
	});

	it('names unaliased expressions as MySQL does', () => {
		const r = rig();
		expect(
			r.q(
				"SELECT YEAR( '2020-01-01' ), CONCAT('a','b'), 'lit', 5 / 2, COUNT(*) FROM t_options"
			)
		).toMatchObject({
			columns: ["YEAR( '2020-01-01' )", "CONCAT('a','b')", 'lit', '5 / 2', 'COUNT(*)']
		});
		expect(r.q('SELECT /* x */ 1 AS one, 2 two FROM t_options')).toMatchObject({
			columns: ['one', 'two']
		});
	});
});

describe('the captured front page', () => {
	it('matches the golden replies the bridge specs compare against', () => {
		const capture = JSON.parse(
			readFileSync(resolve(import.meta.dirname, '../fixtures/wp-capture.json'), 'utf8')
		) as WpCapture;
		const golden = JSON.parse(
			readFileSync(
				resolve(import.meta.dirname, '../fixtures/wp-front-page-golden.json'),
				'utf8'
			)
		);
		expect(capture.frontPageCold).toHaveLength(24);
		expect(frontPageReplies(capture)).toEqual(golden);
	});
});

describe('the outside oracles', () => {
	const dir = resolve(import.meta.dirname, '../fixtures/oracles');
	const recorded = existsSync(resolve(dir, 'record.json.gz'));
	const baked = existsSync(
		resolve(import.meta.dirname, '../../assets/wordpress/sql/manifest.json')
	);

	it.skipIf(!recorded)('explains every disagreement with MySQL and the upstream plugin', () => {
		const fixture = loadFixture(resolve(dir, 'record.json.gz'));
		const { classified } = replayFixture(fixture);
		expect(classified.filter((c) => c.owner === 'unexplained')).toEqual([]);
		const count = (pair: string, owner: string) =>
			classified.filter((c) => c.pair === pair && c.owner === owner).length;
		expect(count('native/ours', 'documented')).toBe(23);
		expect(count('native/upstream', 'documented')).toBe(15);
		expect(count('native/upstream', 'upstream')).toBe(139);
		expect(
			classified.filter((c) => c.pair === 'native/ours' && c.owner !== 'documented')
		).toEqual([]);
	});

	it.skipIf(!recorded)('answers the Action Scheduler statements exactly as MySQL does', () => {
		const fixture = loadFixture(resolve(dir, 'record.json.gz'));
		const inScenario = fixture.statements.filter((s) => s.scenario === 'action-scheduler');
		const claims = inScenario.filter((s) => /^UPDATE \S+ t1 JOIN/.test(s.sql));
		expect(claims.length).toBeGreaterThanOrEqual(8);
		expect(inScenario.filter((s) => s.refused !== undefined)).toHaveLength(4);
		const { classified } = replayFixture(fixture);
		expect(
			classified.filter((c) => c.scenario === 'action-scheduler' && c.pair === 'native/ours')
		).toEqual([]);
	});

	it.skipIf(!recorded)('leaves the same table contents as MySQL after every scenario', () => {
		const { dumps } = replayFixture(loadFixture(resolve(dir, 'record.json.gz')));
		for (const d of dumps) {
			expect(d.upstream, d.scenario).toBe(true);
			expect(d.native, d.scenario).toBe(d.scenario !== 'supplement');
		}
	});

	it.skipIf(!recorded || !baked)(
		'builds the same index set, keys and types as drangler and the upstream plugin',
		() => {
			const ddl = JSON.parse(readFileSync(resolve(dir, 'ddl.json'), 'utf8')) as DdlFixture;
			const creates = loadFixture(resolve(dir, 'record.json.gz'))
				.statements.filter(
					(s) =>
						s.scenario !== 'supplement' &&
						s.scenario !== 'action-scheduler' &&
						/^\s*CREATE TABLE/i.test(s.sql)
				)
				.map((s) => s.sql);
			const baked = shapeOf(bakedDatabase());
			expect(Object.keys(baked)).toHaveLength(12);
			expect(compareShapes(baked, shapeOf(translatedDatabase(creates)), baked)).toEqual([]);
			const facets = compareShapes(baked, ddl.converted, ddl.upstream).map((d) => d.facet);
			expect(facets.filter((f) => !f.endsWith('.collation'))).toEqual([]);
			const converted = compareShapes(baked, ddl.converted, baked);
			expect(
				converted.every((d) => d.facet.endsWith('.collation') && d.converted === '"BINARY"')
			).toBe(true);
			expect(converted.length).toBeGreaterThan(40);
			expect(ddl.refusals.every((r) => r.startsWith('refused:'))).toBe(true);
		}
	);

	it.skipIf(!baked)(
		'keeps the index the single-post lookup by slug needs when the statuses are listed',
		() => {
			const db = bakedDatabase();
			const plan = plansOf(db, [
				"SELECT wp_posts.* FROM wp_posts WHERE post_name = 'x' AND post_type = 'post' AND (post_status = 'publish' OR post_status = 'private') ORDER BY post_date DESC"
			]);
			expect(plan[0]?.[0]).toContain('wp_posts__post_name');
		}
	);
});
