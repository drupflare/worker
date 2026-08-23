import { describe, expect, it } from 'vitest';
import {
	census,
	CENSUS_CATEGORIES,
	fingerprint,
	isWriteStatement,
	recordCrossing,
	targetTable,
	type CensusCall
} from '../../../src/ops/statement-census';

/**
 * The deterministic half of the census, driven without an interpreter.
 *
 * `tests/integration/statement-census.spec.ts` produces the real reading and needs the pack, so it is
 * excluded on a clean checkout and every line of the classifier would go uncovered with it. These
 * cases are the gate lane's copy: same functions, fabricated logs, no PHP.
 *
 * The cases are not arbitrary. Each one is a shape the real measurement produced and got WRONG on a
 * first run -- Drupal spelling a one-element `IN` as `( :a )` and a two-element one as `( :a, :b )`,
 * a qualified `"main"."cache_default"` against a bare one, and a batched `VALUES (?), (?)` against a
 * single-row upsert. All three split one repeated operation into two "distinct" ones.
 */

const call = (over: Partial<CensusCall> = {}): CensusCall => ({
	name: 'cfwSqlExec',
	fingerprint: null,
	table: null,
	rowsRead: 0,
	rowsWritten: 0,
	rows: 0,
	resultBytes: 0,
	viaTxn: false,
	...over
});

const sql = (text: string, over: Partial<CensusCall> = {}): CensusCall =>
	call({ fingerprint: fingerprint(text), table: targetTable(text), ...over });

describe('the statement fingerprint', () => {
	it('collapses a placeholder list to one shape whatever its arity', () => {
		const one =
			'SELECT "cid" FROM "cache_render" WHERE "cid" IN ( :db_condition_placeholder_0 )';
		const many =
			'SELECT "cid" FROM "cache_render" WHERE "cid" IN (:db_condition_placeholder_0, :db_condition_placeholder_1)';
		expect(fingerprint(one)).toBe(fingerprint(many));
		expect(fingerprint(one)).toContain('IN (?)');
	});

	it('collapses a multi-row VALUES into the single-row shape', () => {
		expect(fingerprint('INSERT INTO "router" ("name") VALUES (:a), (:b), (:c)')).toBe(
			fingerprint('INSERT INTO "router" ("name") VALUES (:a)')
		);
	});

	it('normalises string and numeric literals but leaves the statement readable', () => {
		expect(fingerprint("SELECT * FROM t WHERE a = 'x' AND b = 42 LIMIT 10")).toBe(
			'SELECT * FROM t WHERE a = ? AND b = ? LIMIT ?'
		);
	});

	it('does not eat a digit inside an identifier, which would merge two tables', () => {
		expect(fingerprint('SELECT p1 FROM menu_tree ORDER BY p1, p2')).toBe(
			'SELECT p1 FROM menu_tree ORDER BY p1, p2'
		);
	});
});

describe('the statement target table', () => {
	it('reads the same table through every spelling Drupal emits', () => {
		expect(targetTable('SELECT * FROM "main"."cache_default"')).toBe('cache_default');
		expect(targetTable('SELECT * FROM cache_default')).toBe('cache_default');
		expect(targetTable('INSERT INTO "cache_default" ("cid") VALUES (?)')).toBe('cache_default');
		expect(targetTable('DELETE FROM "cache_default"')).toBe('cache_default');
	});

	it('answers null for a statement naming no table', () => {
		expect(targetTable('PRAGMA index_list(x)')).toBeNull();
		expect(targetTable('')).toBeNull();
	});

	it('calls a write a write from its text rather than from what it changed', () => {
		expect(isWriteStatement('INSERT INTO "cache_menu" ("cid") VALUES (?)')).toBe(true);
		expect(isWriteStatement('DELETE FROM "cache_menu"')).toBe(true);
		expect(isWriteStatement('SELECT "cid" FROM "cache_menu"')).toBe(false);
		expect(isWriteStatement(null)).toBe(false);
	});
});

describe('recording one crossing', () => {
	it('decodes a cfwSqlExec into one statement with its counters', () => {
		const log: CensusCall[] = [];
		const reply = JSON.stringify({
			ok: true,
			rows: [{ cid: 'a' }],
			rowsRead: 3,
			rowsWritten: 0
		});
		recordCrossing(log, 'cfwSqlExec', JSON.stringify({ sql: 'SELECT * FROM router' }), reply);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({
			name: 'cfwSqlExec',
			table: 'router',
			rowsRead: 3,
			rows: 1,
			viaTxn: false,
			resultBytes: reply.length
		});
	});

	it('expands a cfwSqlTxn into one record per statement, so the two counts can diverge', () => {
		const log: CensusCall[] = [];
		recordCrossing(
			log,
			'cfwSqlTxn',
			JSON.stringify({
				statements: [
					{ sql: 'INSERT INTO "sessions" ("sid") VALUES (?)' },
					{ sql: 'UPDATE "users_field_data" SET "access" = ?' }
				]
			}),
			JSON.stringify({
				ok: true,
				results: [
					{ rows: [], rowsRead: 0, rowsWritten: 2 },
					{ rows: [], rowsRead: 1, rowsWritten: 1 }
				]
			})
		);
		expect(log).toHaveLength(2);
		expect(log.map((c) => c.table)).toEqual(['sessions', 'users_field_data']);
		expect(log.every((c) => c.viaTxn)).toBe(true);
		expect(log[1]!.rowsWritten).toBe(1);
	});

	it('records a crossing carrying no SQL rather than dropping it', () => {
		const log: CensusCall[] = [];
		recordCrossing(log, 'cfwStats', '{}', '{"queryCount":4}');
		expect(log).toHaveLength(1);
		expect(log[0]!.fingerprint).toBeNull();
		expect(census(log).byCategory.bridge).toBe(1);
	});

	it('records an unparseable payload as unattributed instead of hiding it', () => {
		const log: CensusCall[] = [];
		recordCrossing(log, 'cfwSqlExec', 'not json', 'not json either');
		expect(log).toHaveLength(1);
		expect(log[0]!.fingerprint).toBeNull();
	});
});

describe('the census classification', () => {
	it('is a partition: every statement lands in exactly one category', () => {
		const log = [
			sql('SELECT "cid" FROM "cache_render" WHERE "cid" IN (:a)', { rows: 1 }),
			sql('SELECT "cid" FROM "cache_render" WHERE "cid" IN (:a, :b)', { rows: 2 }),
			sql('SELECT "cid" FROM "cache_menu" WHERE "cid" IN (:a)'),
			sql('INSERT INTO "cache_menu" ("cid") VALUES (:a)', { rowsWritten: 2 }),
			sql('SELECT "name" FROM "router" WHERE "name" IN (:a)', { rows: 1 }),
			sql('SELECT "name", "fit" FROM "router" WHERE "pattern_outline" IN (:a)', { rows: 1 }),
			call({ name: 'cfwStats' })
		];
		const c = census(log);
		expect(c.statements).toBe(7);
		expect(CENSUS_CATEGORIES.reduce((n, k) => n + c.byCategory[k], 0)).toBe(7);
	});

	it('names the second run of one fingerprint a duplicate, and only the second', () => {
		const c = census([
			sql('SELECT "cid" FROM "cache_render" WHERE "cid" IN (:a)', { rows: 1 }),
			sql('SELECT "cid" FROM "cache_render" WHERE "cid" IN (:a, :b)', { rows: 2 })
		]);
		expect(c.distinct).toBe(1);
		expect(c.byCategory.duplicate).toBe(1);
		expect(c.rows[0]!.count).toBe(2);
		expect(c.rows[0]!.rows).toBe(3);
	});

	it('calls a cache read that came back empty a MISS, and a populated one necessary', () => {
		const miss = census([sql('SELECT "cid" FROM "cache_data" WHERE "cid" IN (:a)')]);
		expect(miss.byCategory['cache-miss']).toBe(1);
		const hit = census([
			sql('SELECT "cid" FROM "cache_data" WHERE "cid" IN (:a)', { rows: 1 })
		]);
		expect(hit.byCategory['cache-miss']).toBe(0);
		expect(hit.byCategory.necessary).toBe(1);
		// an empty read of a NON-cache table is not a miss; there was nothing there to hit
		const plain = census([sql('SELECT "id" FROM "path_alias" WHERE "path" = :a')]);
		expect(plain.byCategory['cache-miss']).toBe(0);
	});

	it('calls two DIFFERENT reads of one table repeated-table, and a lone read necessary', () => {
		const two = census([
			sql('SELECT "name" FROM "router" WHERE "name" IN (:a)', { rows: 1 }),
			sql('SELECT "fit" FROM "router" WHERE "pattern_outline" IN (:a)', { rows: 1 })
		]);
		expect(two.byCategory['repeated-table']).toBe(2);
		const one = census([sql('SELECT "name" FROM "router" WHERE "name" IN (:a)', { rows: 1 })]);
		expect(one.byCategory['repeated-table']).toBe(0);
		expect(one.byCategory.necessary).toBe(1);
	});

	it('never calls a write repeated-table, however many reads share its table', () => {
		const c = census([
			sql('SELECT "cid" FROM "cache_menu" WHERE "cid" IN (:a)', { rows: 1 }),
			sql('SELECT "data" FROM "cache_menu" WHERE "expire" > :a', { rows: 1 }),
			sql('INSERT INTO "cache_menu" ("cid") VALUES (:a)', { rowsWritten: 2 })
		]);
		expect(c.byCategory['repeated-table']).toBe(2);
		expect(c.byCategory.necessary).toBe(1);
	});

	it('totals rows and bytes per table, which is what a size lever is read from', () => {
		const c = census([
			sql('SELECT "cid" FROM "cache_discovery" WHERE "cid" IN (:a)', {
				rows: 1,
				rowsRead: 1,
				resultBytes: 97_749
			}),
			sql('INSERT INTO "cache_discovery" ("cid") VALUES (:a)', { rowsWritten: 2 })
		]);
		expect(c.byTable['cache_discovery']).toEqual({
			statements: 2,
			rowsRead: 1,
			rowsWritten: 2
		});
		expect(c.totals).toEqual({ rowsRead: 1, rowsWritten: 2, resultBytes: 97_749 });
	});

	it('answers an empty census for an empty log rather than throwing', () => {
		const c = census([]);
		expect(c.statements).toBe(0);
		expect(c.distinct).toBe(0);
		expect(c.rows).toEqual([]);
		expect(CENSUS_CATEGORIES.every((k) => c.byCategory[k] === 0)).toBe(true);
	});
});
