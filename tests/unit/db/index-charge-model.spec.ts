import { describe, expect, it } from 'vitest';
import {
	auditSchema,
	chargePerInsertedRow,
	parseCreateIndex,
	parseCreateTable,
	splitFill,
	type PackStatement
} from '../../../scripts/measure/index-audit';
import { chargeFactorsFromSchema, splitChargedRows } from '../../../src/db/write-tally';
import type { Sql } from '../../helpers/serve-do';
import { freshSite, inObject } from '../../helpers/serve-do';
import { CFW_PAGE_DDL, SHIPPED } from '../../helpers/shipped-ddl';

/**
 * Whether the charge model `scripts/measure/index-audit.ts` applies is the one the engine bills.
 *
 * The audit reads the shipped schema and says a stored row costs `1 + implicit + explicit` charged
 * rows. Every conclusion drawn from it -- 75% of a fill is index maintenance, `router_alias` is
 * charged on 402 rows that store nothing -- is that arithmetic applied to a measured total, so if
 * the model and the engine disagree the arithmetic is decoration.
 *
 * So the model is not asserted here, it is COMPARED against `rowsWritten` from real Durable Object
 * SQL, on the real DDL, for every primary-key form the pack contains. `router` is already measured
 * this way in `router-rebuild-cost.spec.ts`; what this adds is the rowid case, the AUTOINCREMENT
 * case, the UNIQUE index, and the write shapes an INSERT model cannot price.
 */

type Cursor = { rowsWritten: number };

/** creates the table and its indexes, then returns the charged rows for `rows` fresh inserts */
function measureInsert(
	sql: Sql,
	ddl: string[],
	insert: string,
	values: (n: number) => unknown[],
	rows: number
): number {
	for (const statement of ddl) sql.exec(statement);
	let charged = 0;
	for (let n = 0; n < rows; n++) {
		charged += (sql.exec(insert, ...values(n)) as Cursor).rowsWritten;
	}
	return charged;
}

/** what the audit predicts one stored row costs, from the same DDL strings */
function predict(ddl: string[]): number {
	const table = parseCreateTable(ddl[0] as string);
	if (!table) throw new Error(`not a CREATE TABLE: ${ddl[0]}`);
	const indexes = ddl
		.slice(1)
		.map((d) => parseCreateIndex(d))
		.filter((i) => i !== null);
	return chargePerInsertedRow(table, indexes);
}

const CACHE_INSERT =
	'INSERT INTO cache_dynamic_page_cache (cid, data, expire, created, serialized, tags, checksum)' +
	' VALUES (?, ?, ?, ?, ?, ?, ?)';

/** a rendered response is the point of the bin, so the payload is sized like one rather than like 'x' */
function cacheRow(n: number): unknown[] {
	return [`route:/node/${n}`, 'y'.repeat(4096), -1, 1786258127.5 + n, 0, 'rendered', '0'];
}

describe('the charge model against the engine, one case per primary-key form', () => {
	it('charges a text primary key for its implicit index: cache bins cost 2 per row', async () => {
		const ddl = SHIPPED.cacheDynamicPageCache!.ddl;
		const charged = await inObject(freshSite(), (site) =>
			measureInsert(site.sql, ddl, CACHE_INSERT, cacheRow, 10)
		);
		// 1 table row + 1 primary-key index. The `_created` and `_expire` indexes are gone:
		// CfwCacheBackend drops them on every bin except cache_data, which is the only one the
		// host garbage-collects, so this went from 4 to 2
		expect(charged / 10).toBe(2);
		expect(predict(ddl)).toBe(2);
	});

	it('charges NOTHING for a rowid primary key, because there is no index to keep', async () => {
		const ddl = [
			'CREATE TABLE rowid_pk (id INTEGER PRIMARY KEY, a TEXT, b TEXT)',
			'CREATE INDEX rowid_pk_a ON rowid_pk (a)'
		];
		const charged = await inObject(freshSite(), (site) =>
			measureInsert(
				site.sql,
				ddl,
				'INSERT INTO rowid_pk (a, b) VALUES (?, ?)',
				(n) => [`a${n}`, `b${n}`],
				10
			)
		);
		expect(charged / 10).toBe(2);
		expect(predict(ddl)).toBe(2);
	});

	it('charges AUTOINCREMENT one MORE row than the same key without it', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const plain = measureInsert(
				site.sql,
				['CREATE TABLE plain_pk (id INTEGER PRIMARY KEY, a TEXT)'],
				'INSERT INTO plain_pk (a) VALUES (?)',
				(n) => [`a${n}`],
				10
			);
			const auto = measureInsert(
				site.sql,
				['CREATE TABLE auto_pk (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)'],
				'INSERT INTO auto_pk (a) VALUES (?)',
				(n) => [`a${n}`],
				10
			);
			return { plain, auto };
		});
		// THE MODEL WAS WRONG HERE AND THE ENGINE CORRECTED IT. The first draft predicted 4 for
		// `watchdog` on the reasoning that a rowid key stores no index; the meter said 5. The extra
		// row is `sqlite_sequence`, which AUTOINCREMENT updates on every insert -- a hidden write
		// multiplier on every table Drupal declares with a serial key.
		expect(cost.plain / 10).toBe(1);
		expect(cost.auto / 10).toBe(2);
	});

	it('charges the shipped watchdog 5, which is 3 indexes plus the sequence row', async () => {
		const ddl = SHIPPED.watchdog!.ddl;
		const charged = await inObject(freshSite(), (site) =>
			measureInsert(
				site.sql,
				ddl,
				'INSERT INTO watchdog (uid, type, message, variables, severity, location, hostname, timestamp)' +
					' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				() => [0, 'php', 'm', '', 6, '/', '127.0.0.1', 1786258127],
				10
			)
		);
		expect(charged / 10).toBe(5);
		expect(predict(ddl)).toBe(5);
	});

	it('charges a composite primary key once, not once per column', async () => {
		const ddl = SHIPPED.keyValue!.ddl;
		const charged = await inObject(freshSite(), (site) =>
			measureInsert(
				site.sql,
				ddl,
				'INSERT INTO key_value (collection, name, value) VALUES (?, ?, ?)',
				(n) => ['state', `k${n}`, 'v'],
				10
			)
		);
		expect(charged / 10).toBe(2);
		expect(predict(ddl)).toBe(2);
	});

	it('charges a UNIQUE index exactly like an ordinary one', async () => {
		const ddl = SHIPPED.usersFieldData!.ddl;
		const charged = await inObject(freshSite(), (site) =>
			measureInsert(
				site.sql,
				ddl,
				'INSERT INTO users_field_data (uid, langcode, name, created, access, default_langcode)' +
					' VALUES (?, ?, ?, ?, ?, ?)',
				(n) => [n + 1, 'en', `u${n}`, 1786258127, 0, 1],
				10
			)
		);
		// 1 row + composite key index + 5 CREATE INDEX, one of which is UNIQUE
		expect(charged / 10).toBe(7);
		expect(predict(ddl)).toBe(7);
	});

	it('charges a bare table with one text key 2, which is the floor for a keyed table', async () => {
		const ddl = SHIPPED.cachetags!.ddl;
		const charged = await inObject(freshSite(), (site) =>
			measureInsert(
				site.sql,
				ddl,
				'INSERT INTO cachetags (tag, invalidations) VALUES (?, ?)',
				(n) => [`node:${n}`, 0],
				10
			)
		);
		expect(charged / 10).toBe(2);
		expect(predict(ddl)).toBe(2);
	});

	it('charges the host serve table 2, so storing the page is not where the cost is', async () => {
		const charged = await inObject(freshSite(), (site) =>
			measureInsert(
				site.sql,
				[CFW_PAGE_DDL],
				'INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)' +
					' VALUES (?, ?, ?, ?, ?, ?)',
				(n) => [`/node/${n}`, 200, 'text/html', 'z'.repeat(12_304), 1786258127, 40],
				10
			)
		);
		// 12,304 bytes of HTML -- the measured front page -- still costs 2 charged rows, because
		// the meter counts rows and index entries rather than bytes
		expect(charged / 10).toBe(2);
		expect(predict([CFW_PAGE_DDL])).toBe(2);
	});
});

describe('write shapes an insert-only model cannot price', () => {
	it('charges a re-store of the same cid the full 2 again, so a re-fill is not cheaper', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const first = measureInsert(
				site.sql,
				SHIPPED.cacheDynamicPageCache!.ddl,
				CACHE_INSERT,
				cacheRow,
				1
			);
			const again = (
				site.sql.exec(
					CACHE_INSERT.replace('INSERT INTO', 'INSERT OR REPLACE INTO'),
					...cacheRow(0)
				) as Cursor
			).rowsWritten;
			return { first, again };
		});
		expect(cost.first).toBe(2);
		// THE SHAPE THAT MATTERS FOR A FILL. Drupal's cache backend merges, and a merge over an
		// existing cid rewrites the row and re-keys its primary index, so it costs the same 2 it
		// did when it was new. There is no warm discount to find here -- dropping the secondary
		// indexes halved the figure without changing that.
		expect(cost.again).toBe(2);
	});

	it('charges an UPDATE only for the indexes whose columns actually moved', async () => {
		// DRIVEN OVER cache_data, not a bin whose indexes were dropped. The point is the
		// DIFFERENCE between touching an indexed and an unindexed column, and on a bin with no
		// secondary index there is no difference left to show -- the test would pass while
		// demonstrating nothing
		const ddl = [
			SHIPPED.cacheDynamicPageCache!.ddl[0]!.replace(
				/cache_dynamic_page_cache/g,
				'cache_data'
			),
			'CREATE INDEX "cache_data_created" ON "cache_data" ("created")',
			'CREATE INDEX "cache_data_expire" ON "cache_data" ("expire")'
		];
		const insert = CACHE_INSERT.replace('cache_dynamic_page_cache', 'cache_data');
		const cost = await inObject(freshSite(), (site) => {
			measureInsert(site.sql, ddl, insert, cacheRow, 1);
			const dataOnly = (
				site.sql.exec(
					'UPDATE cache_data SET data = ? WHERE cid = ?',
					'w'.repeat(4096),
					'route:/node/0'
				) as Cursor
			).rowsWritten;
			const indexed = (
				site.sql.exec(
					'UPDATE cache_data SET expire = ? WHERE cid = ?',
					99,
					'route:/node/0'
				) as Cursor
			).rowsWritten;
			return { dataOnly, indexed };
		});
		// an unindexed column is 1 charged row; touching `expire` adds its index entry
		expect(cost.dataOnly).toBe(1);
		expect(cost.indexed).toBe(2);
	});

	it('charges a DELETE once per row and nothing for tearing the index entries down', async () => {
		const cost = await inObject(freshSite(), (site) => {
			const inserted = measureInsert(
				site.sql,
				SHIPPED.cacheDynamicPageCache!.ddl,
				CACHE_INSERT,
				cacheRow,
				10
			);
			const deleted = (site.sql.exec('DELETE FROM cache_dynamic_page_cache') as Cursor)
				.rowsWritten;
			return { inserted, deleted };
		});
		expect(cost.inserted).toBe(20);
		// the same asymmetry `router-rebuild-cost.spec.ts` found: index maintenance is billed on
		// the way in and free on the way out, so every lever is on the insert side
		expect(cost.deleted).toBe(10);
	});
});

describe('what dropping the two cache indexes actually bought', () => {
	it('halved a cache row from 4 charged rows to 2, measured rather than modelled', async () => {
		// the INDEXED form is built here rather than read from SHIPPED, because SHIPPED is now the
		// dropped form -- reading it for both sides would compare 2 against 2 and report a 1.00x
		// "win" while passing
		const indexed = [
			SHIPPED.cacheDynamicPageCache!.ddl[0] as string,
			'CREATE INDEX "cache_dynamic_page_cache_created" ON "cache_dynamic_page_cache" ("created")',
			'CREATE INDEX "cache_dynamic_page_cache_expire" ON "cache_dynamic_page_cache" ("expire")'
		];
		const cost = await inObject(freshSite(), (site) => {
			const full = measureInsert(site.sql, indexed, CACHE_INSERT, cacheRow, 10);
			site.sql.exec('DROP TABLE cache_dynamic_page_cache');
			const bare = measureInsert(
				site.sql,
				SHIPPED.cacheDynamicPageCache!.ddl,
				CACHE_INSERT,
				cacheRow,
				10
			);
			return { full, bare };
		});
		expect(cost.full).toBe(40);
		expect(cost.bare).toBe(20);
		// so the recorded 12-row fill is now 6, a 2.00x move on the meter that binds regeneration --
		// and unlike nulling the bin it costs no render
		expect(cost.full / cost.bare).toBe(2);
	});

	it('leaves the primary key index in place, because that one is not optional', async () => {
		const charged = await inObject(freshSite(), (site) =>
			measureInsert(
				site.sql,
				[SHIPPED.cacheDynamicPageCache!.ddl[0] as string],
				CACHE_INSERT,
				cacheRow,
				10
			)
		);
		// 2, not 1: `cid` is the lookup the bin exists for, so the floor for any cache bin is 2
		expect(charged / 10).toBe(2);
	});
});

describe('the decomposition the audit reports', () => {
	/** the two cache bins as a miniature pack, which is all `splitFill` needs */
	const statements: PackStatement[] = [
		...SHIPPED.cacheDynamicPageCache!.ddl,
		...SHIPPED.cachePage!.ddl
	].map((s) => ({ s, p: [] }));

	it('splits the recorded fill into 3 data rows and 9 index entries, AS MEASURED', () => {
		// against the 4x schema the 12-row fill was recorded on, not the 2x schema that ships now.
		// `splitFill` divides by the CURRENT factor, so passing today's audit would re-decompose a
		// historical total as 6 data rows -- a fill that really stored 3. The measurement did not
		// change; the divisor did
		const asMeasured = auditSchema([
			...statements,
			{
				s: 'CREATE INDEX "cache_dynamic_page_cache_created" ON "cache_dynamic_page_cache" ("created")',
				p: []
			},
			{
				s: 'CREATE INDEX "cache_dynamic_page_cache_expire" ON "cache_dynamic_page_cache" ("expire")',
				p: []
			},
			{ s: 'CREATE INDEX "cache_page_created" ON "cache_page" ("created")', p: [] },
			{ s: 'CREATE INDEX "cache_page_expire" ON "cache_page" ("expire")', p: [] }
		]);
		const split = splitFill({ cache_dynamic_page_cache: 8, cache_page: 4 }, asMeasured);
		expect(split.dataRows).toBe(3);
		expect(split.indexRows).toBe(9);
		expect(split.indexShare).toBe(0.75);
		// every table divided cleanly, so the fill really was fresh single-row inserts
		expect(split.rows.every((r) => r.exact)).toBe(true);
	});

	it('and the same fill on the SHIPPED schema is 3 data rows and 3 index entries', () => {
		const split = splitFill(
			{ cache_dynamic_page_cache: 4, cache_page: 2 },
			auditSchema(statements)
		);
		expect(split.dataRows).toBe(3);
		expect(split.indexRows).toBe(3);
		expect(split.rows.every((r) => r.exact)).toBe(true);
	});

	it('refuses to round when the charged total is not a whole multiple of the factor', () => {
		const split = splitFill({ cache_dynamic_page_cache: 7 }, auditSchema(statements));
		// 7 / 2 is not a fill shape; reporting "3.5 data rows" or silently rounding would
		// turn a wrong assumption about the statements into a confident number
		expect(split.rows[0]?.exact).toBe(false);
	});

	it('reports zero rather than guessing for a table the schema does not contain', () => {
		const split = splitFill({ watchdog: 9 }, auditSchema(statements));
		expect(split.rows[0]?.chargePerRow).toBe(0);
		expect(split.rows[0]?.exact).toBe(false);
	});
});

/**
 * The same charge model read off a LIVE database instead of off the pack.
 *
 * `chargePerInsertedRow()` parses shipped DDL, which is the right instrument for an artifact and the
 * wrong one for a running object: a module enable creates tables no pack contains, and
 * `write-amplification.spec.ts` decomposes a workload measured inside a Durable Object. So the two
 * have to agree wherever both can answer, and that agreement is what makes either one quotable.
 */
describe('chargeFactorsFromSchema, the same model against the engine', () => {
	it('agrees with the pack parser on every primary-key form the schema contains', async () => {
		const cases = [
			SHIPPED.cacheDynamicPageCache!.ddl,
			SHIPPED.watchdog!.ddl,
			SHIPPED.keyValue!.ddl,
			SHIPPED.usersFieldData!.ddl,
			SHIPPED.cachetags!.ddl,
			[CFW_PAGE_DDL]
		];
		const live = await inObject(freshSite(), (site) => {
			for (const ddl of cases) for (const statement of ddl) site.sql.exec(statement);
			const names = cases.map((ddl) => parseCreateTable(ddl[0] as string)!.name);
			return chargeFactorsFromSchema(site.sql, names);
		});
		for (const ddl of cases) {
			const name = parseCreateTable(ddl[0] as string)!.name;
			expect(live[name], name).toBe(predict(ddl));
		}
	});

	it('excludes a PARTIAL index, on the engine flag rather than on a regex', async () => {
		const live = await inObject(freshSite(), (site) => {
			site.sql.exec('CREATE TABLE partial_t (id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
			site.sql.exec('CREATE INDEX partial_t_a ON partial_t (a)');
			site.sql.exec('CREATE INDEX partial_t_b ON partial_t (b) WHERE b IS NOT NULL');
			return chargeFactorsFromSchema(site.sql, ['partial_t']);
		});
		// a partial index stores an entry only for the rows its WHERE admits, which is the whole
		// reason it is worth proposing -- counting it would price the fix as if it changed nothing
		expect(live['partial_t']).toBe(2);
	});

	it('reads AUTOINCREMENT off the DDL, because no pragma reports it', async () => {
		const live = await inObject(freshSite(), (site) => {
			site.sql.exec('CREATE TABLE auto_live (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)');
			site.sql.exec('CREATE TABLE plain_live (id INTEGER PRIMARY KEY, a TEXT)');
			return chargeFactorsFromSchema(site.sql, ['auto_live', 'plain_live']);
		});
		expect(live['plain_live']).toBe(1);
		expect(live['auto_live']).toBe(2);
	});

	it('omits a table it cannot find rather than pricing it as pure data', async () => {
		const live = await inObject(freshSite(), (site) =>
			// the second name would be interpolated into a PRAGMA, so it is refused before the read
			chargeFactorsFromSchema(site.sql, ['no_such_table', 'bad"; DROP TABLE x; --'])
		);
		expect(live).toStrictEqual({});
		// omitted, not zero: `splitChargedRows()` reports an absent factor as inexact, where a 0
		// would silently attribute every charged row to index maintenance
		expect(splitChargedRows({ no_such_table: 9 }, live).rows[0]?.exact).toBe(false);
	});
});
