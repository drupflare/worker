import { describe, expect, it } from 'vitest';
import { executeMysql, type MysqlReply } from '../../../src/db/sql/exec';
import { createState } from '../../../src/db/sql/translate';
import { emptyTally } from '../../../src/db/write-tally';
import {
	bindingOf,
	BRIDGE_SQL_MODE,
	installMysqlBridge,
	MYSQL_SERVER_VERSION
} from '../../../src/do/mysql-bridge';
import { emptyCrossings, wrapCrossings } from '../../../src/ops/crossings';
import { enforceReadOnly } from '../../../src/ops/replica';
import { refusedStatements } from '../../helpers/refused-statements';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

/**
 * `cfwMysqlExec` on a real object: the translator over the platform's own SQLite, called the way
 * PHP calls it (a JSON string in, a JSON string out).
 */

type Binary = Record<string, unknown>;
type Call = (sql: string) => Record<string, any>;

const RELAXED =
	"SET SESSION sql_mode='NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";

const OPTIONS =
	'CREATE TABLE wp_options (option_id bigint(20) unsigned NOT NULL auto_increment, ' +
	"option_name varchar(191) NOT NULL default '', option_value longtext NOT NULL, " +
	"autoload varchar(20) NOT NULL default 'yes', PRIMARY KEY  (option_id), " +
	'UNIQUE KEY option_name (option_name)) DEFAULT CHARACTER SET utf8mb4';

/** a bridge installed on a real object, with a caller that decodes the reply */
async function withBridge<T>(
	fn: (
		call: Call,
		site: ServeDo,
		binary: Binary,
		bridge: ReturnType<typeof installMysqlBridge>
	) => T | Promise<T>
): Promise<T> {
	return inObject(freshSite(), async (site) => {
		const binary: Binary = {};
		const bridge = installMysqlBridge(site as never, binary as never);
		// read at call time, so a wrapper installed later sees every call
		const call: Call = (sql) =>
			JSON.parse((binary.cfwMysqlExec as (json: string) => string)(JSON.stringify({ sql })));
		return fn(call, site, binary, bridge);
	});
}

describe('cfwMysqlExec on a durable object', () => {
	it('answers every reply shape of the contract', async () => {
		await withBridge((call) => {
			expect(call(OPTIONS)).toMatchObject({ ok: true, kind: 'none' });
			expect(call(RELAXED)).toMatchObject({ ok: true, kind: 'none' });
			const insert = call(
				"INSERT INTO wp_options (option_name, option_value) VALUES ('a', '1')"
			);
			expect(insert).toMatchObject({ ok: true, kind: 'write', affected: 1, insertId: 1 });
			const read = call(
				"SELECT option_id, option_name, option_value FROM wp_options WHERE option_name = 'a'"
			);
			expect(read).toMatchObject({
				ok: true,
				kind: 'rows',
				columns: ['option_id', 'option_name', 'option_value'],
				rows: [[1, 'a', '1']]
			});
			expect(call('SELECT option_id FROM wp_options WHERE option_id = 99')).toMatchObject({
				ok: true,
				kind: 'rows',
				rows: []
			});
			expect(call('SELECT * FROM wp_missing')).toMatchObject({
				ok: false,
				errno: 1146,
				sqlstate: '42S02'
			});
			expect(
				call("INSERT INTO wp_options (option_name, option_value) VALUES ('a', '2')")
			).toMatchObject({
				ok: false,
				errno: 1062
			});
		});
	});

	it('keeps both columns of a join that repeats a name', async () => {
		await withBridge((call) => {
			call('CREATE TABLE t1 (id int NOT NULL, PRIMARY KEY (id))');
			call('CREATE TABLE t2 (id int NOT NULL, PRIMARY KEY (id))');
			call('INSERT INTO t1 (id) VALUES (1)');
			call('INSERT INTO t2 (id) VALUES (2)');
			const r = call('SELECT t1.id, t2.id FROM t1, t2');
			expect(r.columns).toEqual(['id', 'id']);
			expect(r.rows).toEqual([[1, 2]]);
		});
	});

	it('names the class row of a refused statement', async () => {
		await withBridge((call) => {
			expect(call("SELECT GET_LOCK('x', 1)")).toMatchObject({
				ok: false,
				errno: 1235,
				refused: 'get-lock'
			});
			expect(call('START TRANSACTION')).toMatchObject({ ok: false, refused: 'transaction' });
			expect(call('SELECT 1; SELECT 2')).toMatchObject({ ok: false, errno: 1064 });
			expect(call('FROBNICATE t')).toMatchObject({ ok: false, errno: 1064 });
			expect(call("SELECT X'41'")).toMatchObject({ ok: false, refused: 'hex-literal' });
			expect(call("SELECT a FROM t WHERE a REGEXP 'x+'")).toMatchObject({
				ok: false,
				refused: 'regexp-other'
			});
		});
	});

	it('answers a request that has no sql string, and one that is not JSON', async () => {
		await withBridge((_call, _site, binary) => {
			const fn = binary.cfwMysqlExec as (json: string) => string;
			expect(JSON.parse(fn('{}'))).toMatchObject({ ok: false, errno: 1105 });
			expect(JSON.parse(fn('{"sql": 5}'))).toMatchObject({ ok: false, errno: 1105 });
			expect(JSON.parse(fn('not json'))).toMatchObject({ ok: false, errno: 1105 });
		});
	});

	it('answers VERSION() with the configured version, at or above 8.0.17', async () => {
		await withBridge((call) => {
			expect(call('SELECT VERSION()').rows).toEqual([[MYSQL_SERVER_VERSION]]);
			expect(MYSQL_SERVER_VERSION.startsWith('8.0.17')).toBe(true);
		});
	});

	it('runs a statement over the 100,000 byte text limit through bound values', async () => {
		await withBridge((call) => {
			call(OPTIONS);
			call(RELAXED);
			const big = 'x'.repeat(150_000);
			const w = call(
				`INSERT INTO wp_options (option_name, option_value) VALUES ('big', '${big}')`
			);
			expect(w).toMatchObject({ ok: true, kind: 'write', affected: 1 });
			const r = call("SELECT option_value FROM wp_options WHERE option_name = 'big'");
			expect(r.rows).toEqual([[big]]);
		});
	});

	it('counts the rows a translated write spends on the daily meter', async () => {
		await withBridge((call, site) => {
			call(OPTIONS);
			const before = site.rowsSinceFlush ?? 0;
			call("INSERT INTO wp_options (option_name, option_value) VALUES ('m', '1')");
			const spent = (site.rowsSinceFlush ?? 0) - before;
			expect(spent).toBeGreaterThan(0);
			const reads = site.rowsSinceFlush ?? 0;
			call("SELECT option_value FROM wp_options WHERE option_name = 'm'");
			expect(site.rowsSinceFlush ?? 0).toBe(reads);
		});
	});

	it('tallies a translated write against its table when the tally is armed', async () => {
		await withBridge((call, site) => {
			call(OPTIONS);
			site.writeTally = emptyTally();
			call("INSERT INTO wp_options (option_name, option_value) VALUES ('t', '1')");
			expect(site.writeTally.statementsByTable.wp_options).toBeGreaterThan(0);
			expect(site.writeTally.byTable.wp_options).toBeGreaterThan(0);
		});
	});

	it('refuses the platform reserved tables on a read and on a write', async () => {
		await withBridge((call) => {
			const read = call('SELECT * FROM _cf_KV');
			expect(read.ok).toBe(false);
			const write = call("INSERT INTO _cf_KV (key, value) VALUES ('k', 'v')");
			expect(write.ok).toBe(false);
		});
	});
});

describe('multi statement DDL is atomic', () => {
	// the second statement of the translation (an index named like an existing table) fails
	const BLOCKED = 'CREATE TABLE t (a int NOT NULL, KEY k (a))';

	it('leaves no table, no stored definition and no catalog entry behind', async () => {
		await withBridge((call, site, _binary, bridge) => {
			expect(call('CREATE TABLE t__k (a int)').ok).toBe(true);
			const failed = call(BLOCKED);
			expect(failed.ok).toBe(false);
			const names = site.sql
				.exec("SELECT name FROM sqlite_master WHERE name IN ('t', 't__k')")
				.toArray()
				.map((r) => r.name);
			expect(names).toEqual(['t__k']);
			const stored = site.sql
				.exec("SELECT name FROM cfw_mysql_schema WHERE name = 't'")
				.toArray();
			expect(stored).toEqual([]);
			expect(bridge.session().db.catalog.has('t')).toBe(false);
			expect(call('SELECT * FROM t').errno).toBe(1146);
		});
	});

	it('control: without the atomic option the same statement leaves a partial table', async () => {
		await inObject(freshSite(), async (site) => {
			const run = (sql: string, ...p: unknown[]) => {
				const cursor = (site.sql as unknown as SqlStorage).exec(sql, ...p);
				return {
					columnNames: cursor.columnNames,
					raw: () => ({ toArray: () => Array.from(cursor.raw()) }),
					get rowsRead() {
						return cursor.rowsRead;
					},
					get rowsWritten() {
						return cursor.rowsWritten;
					}
				};
			};
			const state = createState();
			expect(executeMysql('CREATE TABLE t__k (a int)', run as never, state).ok).toBe(true);
			const failed: MysqlReply = executeMysql(BLOCKED, run as never, state);
			expect(failed.ok).toBe(false);
			const names = site.sql
				.exec("SELECT name FROM sqlite_master WHERE name = 't'")
				.toArray();
			expect(names.length).toBe(1);
		});
	});
});

describe('the session', () => {
	const CALC =
		"INSERT INTO wp_options (option_name, option_value) VALUES ('a','1'), ('b','2'), ('c','3')";

	it('does not hand the last query of one run to the next run', async () => {
		await withBridge((call, _site, _binary, bridge) => {
			call(OPTIONS);
			call(RELAXED);
			call(CALC);
			call('SELECT SQL_CALC_FOUND_ROWS option_id FROM wp_options LIMIT 0, 1');
			expect(call('SELECT FOUND_ROWS()').rows).toEqual([[3]]);
			call('SELECT SQL_CALC_FOUND_ROWS option_id FROM wp_options LIMIT 0, 1');
			bridge.beginRun();
			expect(call('SELECT FOUND_ROWS()').rows).toEqual([[0]]);
		});
	});

	it('control: without the run boundary the count leaks', async () => {
		await withBridge((call) => {
			call(OPTIONS);
			call(RELAXED);
			call(CALC);
			call('SELECT SQL_CALC_FOUND_ROWS option_id FROM wp_options LIMIT 0, 1');
			expect(call('SELECT FOUND_ROWS()').rows).toEqual([[3]]);
			call('SELECT SQL_CALC_FOUND_ROWS option_id FROM wp_options LIMIT 0, 1');
			expect(call('SELECT FOUND_ROWS()').rows).toEqual([[3]]);
		});
	});

	it('keeps the sql mode across a run, which is what the connection holds', async () => {
		await withBridge((call, _site, _binary, bridge) => {
			call(RELAXED);
			bridge.beginRun();
			expect(bridge.session().sqlMode).toBe(
				'NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'
			);
		});
	});

	it('starts in the mode wpdb sets, so a fresh host agrees with a PHP side that already sent it', async () => {
		await withBridge((call, _site, _binary, bridge) => {
			expect(bridge.session().sqlMode).toBe(BRIDGE_SQL_MODE);
			call(RELAXED);
			expect(bridge.session().sqlMode).toBe(BRIDGE_SQL_MODE);
			expect(call('SELECT @@SESSION.sql_mode').rows).toEqual([[BRIDGE_SQL_MODE]]);
		});
	});

	it('shares the stored schema and the translation cache between sessions of one bridge', async () => {
		await withBridge((call, _site, _binary, bridge) => {
			call(OPTIONS);
			const q = "SELECT option_value FROM wp_options WHERE option_name = 'a'";
			call(q);
			const { stats } = bridge.session().db;
			const hits = stats.hits;
			call(q);
			expect(stats.hits).toBe(hits + 1);
		});
	});

	it('keeps two bridges apart, so two sites share neither schema nor cache', async () => {
		await withBridge(async (call, _site, _binary, first) => {
			call(OPTIONS);
			await withBridge((other, _s, _b, second) => {
				expect(second.session().db).not.toBe(first.session().db);
				expect(other('SELECT * FROM wp_options').errno).toBe(1146);
			});
		});
	});
});

describe('bound values', () => {
	it('passes primitives and an ArrayBuffer, and maps booleans and safe bigints', () => {
		const buf = new ArrayBuffer(2);
		expect(bindingOf(null)).toBeNull();
		expect(bindingOf('s')).toBe('s');
		expect(bindingOf(4)).toBe(4);
		expect(bindingOf(true)).toBe(1);
		expect(bindingOf(false)).toBe(0);
		expect(bindingOf(7n)).toBe(7);
		expect(bindingOf(buf)).toBe(buf);
	});

	it('refuses an object, an array, undefined and a typed array', () => {
		for (const v of [{ x: 1 }, [1], undefined, new Uint8Array(1), () => 1]) {
			expect(() => bindingOf(v)).toThrow(/refused a bound/);
		}
	});

	it('refuses a bigint the platform would read back altered', () => {
		expect(() => bindingOf(2n ** 60n)).toThrow();
	});
});

describe('the capability tables', () => {
	it('is counted as a crossing under its own name', async () => {
		await withBridge((call, _site, binary) => {
			const tally = emptyCrossings();
			tally.calls = [];
			expect(wrapCrossings(binary, tally)).toEqual(['cfwMysqlExec']);
			call(OPTIONS);
			call("INSERT INTO wp_options (option_name, option_value) VALUES ('c', '1')");
			expect(tally.byName).toEqual({ cfwMysqlExec: 2 });
			const [create, insert] = tally.calls!;
			expect(create?.table).toBe('wp_options');
			expect(insert).toMatchObject({ name: 'cfwMysqlExec', table: 'wp_options' });
			expect(insert?.rowsWritten).toBeGreaterThan(0);
		});
	});

	it('is guarded per statement on a replica', async () => {
		await withBridge((call, _site, binary) => {
			call(OPTIONS);
			const refusals: string[] = [];
			const guard = enforceReadOnly(binary, (r) => refusals.push(r.detail));
			expect(guard.wrapped.cfwMysqlExec).toBe('per-call');
			const fn = binary.cfwMysqlExec as (json: string) => string;
			const send = (sql: string) => JSON.parse(fn(JSON.stringify({ sql })));
			expect(send(RELAXED).ok).toBe(true);
			expect(send('SELECT FOUND_ROWS()').ok).toBe(true);
			expect(send('SHOW TABLES').ok).toBe(true);
			expect(() =>
				send("INSERT INTO wp_options (option_name, option_value) VALUES ('r', '1')")
			).toThrow(/requires the primary/);
			expect(refusals).toHaveLength(1);
			const rows = JSON.parse(fn(JSON.stringify({ sql: 'SELECT COUNT(*) FROM wp_options' })));
			expect(rows.rows).toEqual([[0]]);
		});
	});
});

describe('every refused class reaches the caller by name', () => {
	it('answers each refused row of the class table with its id', async () => {
		await withBridge((call) => {
			const statements = refusedStatements();
			expect(statements.length).toBeGreaterThan(40);
			for (const { id, sql } of statements) {
				const reply = call(sql);
				expect(reply.ok, id).toBe(false);
				expect(reply.refused, id).toBe(id);
				expect(typeof reply.errno, id).toBe('number');
				expect(typeof reply.sqlstate, id).toBe('string');
				expect(String(reply.error).length, id).toBeGreaterThan(0);
			}
		});
	});
});
