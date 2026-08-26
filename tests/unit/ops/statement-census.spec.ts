import { describe, expect, it } from 'vitest';
import {
	census,
	CENSUS_CATEGORIES,
	fingerprint,
	isWriteStatement,
	recordCrossing,
	subsystemOf,
	SUBSYSTEMS,
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
	key: null,
	...over
});

const sql = (text: string, over: Partial<CensusCall> = {}): CensusCall =>
	call({ fingerprint: fingerprint(text), table: targetTable(text), ...over });

/**
 * cids taken verbatim from a census run against the shipped pack, one per attribution rule.
 *
 * Verbatim rather than invented, because the rules exist to name what THIS site's renders ask for.
 * A fixture written from Drupal's source would test the rules against a different site.
 */
const MEASURED_CIDS: Array<[string, string, string]> = [
	['cache_render', 'entity_view:block:olivero_site_branding:[theme]=olivero', 'render'],
	[
		'cache_dynamic_page_cache',
		'response:[request_format]=html:[route]=view.frontpage',
		'page-assembly'
	],
	['cache_data', 'route:[language]=en:[query_parameters]=:/user/login', 'routing'],
	['cache_data', 'css:olivero:olivero:enX9BF0eudLpqW4W9l94pPclSOxB5A9b', 'assets'],
	['cache_data', 'js:olivero:en:yITln3qjyTh8JQCgqudyThlefzIg66zUcxV8D9It4fM:0', 'assets'],
	['cache_discovery', 'library_info:olivero', 'assets'],
	['cache_discovery', 'local_task_plugins:en:user.login', 'menu'],
	['cache_discovery', 'user.field_storage_definitions.installed', 'entity'],
	['cache_menu', 'active-trail:route:user.login:route_parameters:a:0:{}', 'menu'],
	['cache_bootstrap', 'theme.active_theme.olivero', 'theme'],
	['cache_default', 'twig:6a788299bc238_breadcrumb.html.twig_SJyn2Qe6a73zSgC2HnhU4sfSf', 'theme'],
	['cache_config', 'user.settings', 'config'],
	['key_value', 'config.entity.key_store.block', 'config']
];

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

	it('counts distinct cids uncapped, which is what separates a repeat from a batch', () => {
		const one = 'SELECT "cid" FROM "cache_render" WHERE "cid" IN (:a)';
		const c = census([
			sql(one, { rows: 1, key: 'entity_view:block:a' }),
			sql(one, { rows: 1, key: 'entity_view:block:b' }),
			// the same cid a second time: this one is genuinely redundant
			sql(one, { rows: 1, key: 'entity_view:block:b' })
		]);
		expect(c.rows[0]!.count).toBe(3);
		expect(c.rows[0]!.distinctKeys).toBe(2);
		// the capped sample and the uncapped count agree while under the cap; the point of the
		// second field is that they stop agreeing above it
		expect(c.rows[0]!.keys).toHaveLength(2);
	});

	it('answers an empty census for an empty log rather than throwing', () => {
		const c = census([]);
		expect(c.statements).toBe(0);
		expect(c.distinct).toBe(0);
		expect(c.rows).toEqual([]);
		expect(CENSUS_CATEGORIES.every((k) => c.byCategory[k] === 0)).toBe(true);
		expect(SUBSYSTEMS.every((s) => c.bySubsystem[s].statements === 0)).toBe(true);
	});
});

describe('the subsystem a statement belongs to', () => {
	it('names every cid a real census run produced', () => {
		for (const [table, cid, expected] of MEASURED_CIDS) {
			expect(`${cid} -> ${subsystemOf(table, cid)}`).toBe(`${cid} -> ${expected}`);
		}
	});

	it('lets the cid override the table, which is the whole reason it takes one', () => {
		// three of these live in the SAME bin; attributing by table alone would put a route
		// lookup, a CSS aggregate and a JS aggregate all on `cache_data` and hide the callers
		expect(subsystemOf('cache_data', 'route:[language]=en:/')).toBe('routing');
		expect(subsystemOf('cache_data', 'css:olivero:olivero:abc')).toBe('assets');
		// and the widest single reply in a steady render is an ASSET library rather than
		// "discovery", which is a bin name and not a subsystem
		expect(subsystemOf('cache_discovery', 'library_info:olivero')).toBe('assets');
	});

	it('falls back to the table when there is no cid to be more specific with', () => {
		expect(subsystemOf('cache_dynamic_page_cache', null)).toBe('page-assembly');
		expect(subsystemOf('router', null)).toBe('routing');
		expect(subsystemOf('menu_tree', null)).toBe('menu');
		expect(subsystemOf('cachetags', null)).toBe('cache-tags');
		expect(subsystemOf('cfw_page', null)).toBe('host');
	});

	it('answers `other` rather than guessing an owner for a shared bin', () => {
		// `cache_discovery`, `cache_data` and `cache_default` are deliberately absent from the
		// table rules: without a cid there is nothing to attribute them by, and a plausible
		// owner is worse than a visible gap
		expect(subsystemOf('cache_discovery', null)).toBe('other');
		expect(subsystemOf('cache_data', null)).toBe('other');
		expect(subsystemOf('cache_default', null)).toBe('other');
		expect(subsystemOf(null, null)).toBe('other');
	});

	it('is total: every answer is a member of the declared set', () => {
		const answers = [
			...MEASURED_CIDS.map(([t, k]) => subsystemOf(t, k)),
			subsystemOf('some_table_nobody_mapped', 'a-cid-nobody-mapped')
		];
		expect(answers.every((a) => SUBSYSTEMS.includes(a))).toBe(true);
	});
});
