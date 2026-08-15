import { describe, expect, it } from 'vitest';
import {
	amplification,
	countingSql,
	emptyTally,
	overheadShare,
	rankTally,
	routerRebuildPasses,
	splitChargedRows,
	tallyWrite,
	writeTargetTable
} from '../../../src/db/write-tally';

/**
 * The instrument for the one figure the roadmap now rests on.
 *
 * Rows written binds the regeneration ceiling, and the work order says rows work is worth 2.15x against
 * ~1% for boot work. All of that depends on "~17-18 rows per fill, ~9 of them `dblog`" -- an attribution
 * that has never been measured. So this parser has to be right, and where it is not sure it has to SAY so
 * rather than guess: a wrong guess moves rows onto the wrong table and corrupts the number silently.
 */

describe('the write target, for the forms Drupal actually emits', () => {
	it('reads INSERT, INSERT OR REPLACE and INSERT OR IGNORE', () => {
		expect(writeTargetTable('INSERT INTO watchdog (wid) VALUES (1)')).toBe('watchdog');
		expect(writeTargetTable('INSERT OR REPLACE INTO cache_render (cid) VALUES (?)')).toBe(
			'cache_render'
		);
		expect(writeTargetTable('INSERT OR IGNORE INTO semaphore (name) VALUES (?)')).toBe(
			'semaphore'
		);
	});

	it('reads UPDATE and DELETE', () => {
		expect(writeTargetTable('UPDATE key_value SET value = ? WHERE name = ?')).toBe('key_value');
		expect(writeTargetTable('DELETE FROM cache_page WHERE cid = ?')).toBe('cache_page');
	});

	it('reads REPLACE INTO and DDL, because a migration is mostly DDL', () => {
		expect(writeTargetTable('REPLACE INTO config (name) VALUES (?)')).toBe('config');
		expect(writeTargetTable('CREATE TABLE IF NOT EXISTS cfw_page (path TEXT)')).toBe(
			'cfw_page'
		);
		expect(writeTargetTable('CREATE INDEX idx_foo ON bar (baz)')).toBe('idx_foo');
	});

	it('survives quoted identifiers, which Drupal emits for reserved words', () => {
		expect(writeTargetTable('INSERT INTO "users" (uid) VALUES (1)')).toBe('users');
		expect(writeTargetTable('UPDATE `node` SET nid = 1')).toBe('node');
	});

	it('is case- and whitespace-insensitive', () => {
		expect(writeTargetTable('  insert   into   watchdog (a) values (1)')).toBe('watchdog');
	});

	it('returns null for a READ rather than attributing it somewhere', () => {
		for (const sql of [
			'SELECT * FROM watchdog',
			'PRAGMA journal_mode',
			'BEGIN',
			'COMMIT',
			''
		]) {
			expect(writeTargetTable(sql), sql).toBeNull();
		}
	});
});

describe('the tally counts rows, not statements', () => {
	it('attributes rows to the table the statement targets', () => {
		let t = emptyTally();
		t = tallyWrite(t, 'INSERT INTO watchdog (a) VALUES (1)', 1);
		t = tallyWrite(t, 'INSERT INTO watchdog (a) VALUES (2)', 1);
		t = tallyWrite(t, 'INSERT OR REPLACE INTO cache_render (cid) VALUES (?)', 1);
		expect(t.byTable).toEqual({ watchdog: 2, cache_render: 1 });
		expect(t.rowsWritten).toBe(3);
		expect(t.statements).toBe(3);
	});

	it('counts a zero-row write as a statement but not as a row', () => {
		// the question is where the ROWS go, and a no-op write is not where they go
		let t = emptyTally();
		t = tallyWrite(t, 'UPDATE key_value SET value = ? WHERE 0', 0);
		expect(t.statements).toBe(1);
		expect(t.rowsWritten).toBe(0);
		expect(t.byTable).toEqual({});
	});

	it('parks an unparseable write under ?unattributed rather than dropping it', () => {
		// a meaningful share here means the parser is missing a form, so the breakdown is not
		// trustworthy -- which is visible, where a silent drop would not be
		let t = emptyTally();
		t = tallyWrite(t, 'WITH x AS (SELECT 1) INSERT INTO y SELECT * FROM x', 4);
		expect(t.byTable['?unattributed']).toBe(4);
	});

	it('ignores a negative or non-finite row count instead of subtracting', () => {
		let t = emptyTally();
		t = tallyWrite(t, 'INSERT INTO a (b) VALUES (1)', -5);
		t = tallyWrite(t, 'INSERT INTO a (b) VALUES (1)', Number.NaN);
		expect(t.rowsWritten).toBe(0);
	});
});

describe('ranking, because only the heaviest tables matter', () => {
	it('sorts heaviest first with a share of the total', () => {
		let t = emptyTally();
		t = tallyWrite(t, 'INSERT INTO watchdog (a) VALUES (1)', 9);
		t = tallyWrite(t, 'INSERT INTO cache_render (a) VALUES (1)', 1);
		const ranked = rankTally(t);
		expect(ranked[0]!.table).toBe('watchdog');
		expect(ranked[0]!.rows).toBe(9);
		expect(ranked[0]!.share).toBeCloseTo(0.9, 5);
		expect(ranked[1]!.table).toBe('cache_render');
	});

	it('does not divide by zero on an empty tally', () => {
		expect(rankTally(emptyTally())).toEqual([]);
	});

	it('keeps a table that ran statements but wrote NOTHING', () => {
		let t = emptyTally();
		t = tallyWrite(t, 'DELETE FROM cache_render WHERE cid = ?', 0);
		const ranked = rankTally(t);
		// a write path that ran and did nothing is a finding, not a blank; ranking off
		// byTable alone would drop it entirely
		expect(ranked).toHaveLength(1);
		expect(ranked[0]!.table).toBe('cache_render');
		expect(ranked[0]!.rows).toBe(0);
		expect(ranked[0]!.statements).toBe(1);
	});

	it('reports statements alongside rows', () => {
		let t = emptyTally();
		t = tallyWrite(t, 'INSERT INTO router (a) VALUES (1)', 64);
		t = tallyWrite(t, 'INSERT INTO router (a) VALUES (1)', 64);
		expect(rankTally(t)[0]).toMatchObject({ table: 'router', rows: 128, statements: 2 });
	});
});

describe('reading router rebuilds out of the statement shape', () => {
	/** one rebuild: a single DELETE plus ceil(routes / 16) parameter-budgeted INSERTs */
	function rebuild(t: ReturnType<typeof emptyTally>, routes: number) {
		t = tallyWrite(t, 'DELETE FROM router', routes);
		for (let n = 0; n < Math.ceil(routes / 16); n++) {
			t = tallyWrite(t, 'INSERT INTO router (name) VALUES (?)', 64);
		}
		return t;
	}

	it('counts one rebuild of the real 419-route table', () => {
		expect(routerRebuildPasses(rebuild(emptyTally(), 419), 419)).toBe(1);
	});

	it('counts the eight the module enable actually paid for', () => {
		let t = emptyTally();
		for (let i = 0; i < 8; i++) t = rebuild(t, 419);
		expect(routerRebuildPasses(t, 419)).toBe(8);
	});

	it('returns null rather than rounding when the shape does not divide', () => {
		let t = rebuild(emptyTally(), 419);
		t = tallyWrite(t, 'INSERT INTO router (name) VALUES (?)', 64);
		// 2.4 rebuilds reported as 2 would launder a wrong chunk-size assumption into a fact
		expect(routerRebuildPasses(t, 419)).toBeNull();
	});

	it('returns null when the router was never written', () => {
		expect(routerRebuildPasses(emptyTally(), 419)).toBeNull();
	});

	it('returns null on a zero route count rather than dividing by it', () => {
		expect(routerRebuildPasses(rebuild(emptyTally(), 419), 0)).toBeNull();
	});

	it('honours a different chunk size, since the ceiling is a platform number', () => {
		let t = tallyWrite(emptyTally(), 'DELETE FROM router', 100);
		for (let n = 0; n < 2; n++) t = tallyWrite(t, 'INSERT INTO router (n) VALUES (?)', 4);
		expect(routerRebuildPasses(t, 100, 50)).toBe(1);
	});
});

describe('countingSql, which is what made the instrument complete', () => {
	/**
	 * A stand-in for `ctx.storage.sql`. `rowsWritten` is per-statement, and `databaseSize` exists
	 * so the delegation case has a real non-function member to prove it forwards.
	 */
	function fakeSql(perStatement: Record<string, number> = {}) {
		const seen: string[] = [];
		return {
			databaseSize: 4096,
			calls: seen,
			exec(text: string, ...bindings: unknown[]) {
				seen.push(text);
				return {
					rowsWritten: perStatement[text] ?? 0,
					bindings,
					toArray: () => [{ n: 1 }]
				};
			}
		};
	}

	it('counts a write the HOST makes directly, which execSql could never see', () => {
		// the regression. `cfw_page` is written by `this.sql.exec()` inside fillOne(), not through
		// the PHP driver, so the old execSql-based tally reported 0 for the statement that stores
		// the entire product of a fill.
		const insert = 'INSERT INTO cfw_page (path, html) VALUES (?, ?)';
		const raw = fakeSql({ [insert]: 5 });
		let tally = emptyTally();
		const sql = countingSql(raw, () => tally);
		sql.exec(insert, '/', '<html>');
		expect(tally.rowsWritten).toBe(5);
		expect(tally.byTable['cfw_page']).toBe(5);
	});

	it('counts Drupal and host writes into ONE tally, each exactly once', () => {
		const drupal = 'INSERT INTO cache_dynamic_page_cache (cid) VALUES (?)';
		const host = 'INSERT INTO cfw_page (path) VALUES (?)';
		const raw = fakeSql({ [drupal]: 8, [host]: 3 });
		let tally = emptyTally();
		const sql = countingSql(raw, () => tally);
		sql.exec(drupal, 'x');
		sql.exec(host, '/');
		expect(tally.rowsWritten).toBe(11);
		expect(tally.statements).toBe(2);
	});

	it('does not touch a read cursor, because rowsWritten mid-iteration is not settled', () => {
		const select = 'SELECT status, html FROM cfw_page WHERE path = ?';
		const raw = fakeSql({ [select]: 0 });
		let tally = emptyTally();
		const sql = countingSql(raw, () => tally);
		const cursor = sql.exec(select, '/');
		// the caller still gets the real cursor with its rows intact
		expect(cursor.toArray()).toEqual([{ n: 1 }]);
		expect(tally.statements).toBe(0);
	});

	it('counts nothing at all when disarmed', () => {
		// the hit path runs through this wrapper, so a disarmed tally must cost one predicate
		const insert = 'INSERT INTO cfw_page (path) VALUES (?)';
		const raw = fakeSql({ [insert]: 3 });
		const sql = countingSql(raw, () => undefined);
		sql.exec(insert, '/');
		expect(raw.calls).toEqual([insert]);
	});

	it('forwards members other than exec, so rowid and size lookups still work', () => {
		// `rowidOf()`/`changesOf()` and `databaseSize` all reach through this handle; replacing the
		// object instead of proxying it would break them silently
		const raw = fakeSql();
		const sql = countingSql(raw, () => undefined);
		expect(sql.databaseSize).toBe(4096);
	});

	it('passes bindings through untouched', () => {
		const insert = 'INSERT INTO cfw_meta (k, v) VALUES (?, ?)';
		const raw = fakeSql({ [insert]: 1 });
		let tally = emptyTally();
		const sql = countingSql(raw, () => tally);
		const cursor = sql.exec(insert, 'generation', 'abc');
		expect(cursor.bindings).toEqual(['generation', 'abc']);
	});
});

describe('the always-on write meter, separate from the diagnostic tally', () => {
	function fakeSql(perStatement: Record<string, number> = {}) {
		return {
			exec(text: string) {
				return { rowsWritten: perStatement[text] ?? 0, databaseSize: 1 };
			}
		};
	}

	it('counts writes with NO tally armed, which is the whole point', () => {
		// the daily meter is a product reading; gating it behind the diagnostic tally is what
		// left the Limits page showing "nothing measures this yet" for the binding meter
		let seen = 0;
		const sql = countingSql(
			fakeSql({ 'INSERT INTO cfw_page (a) VALUES (1)': 7 }),
			() => undefined,
			(rows) => {
				seen += rows;
			}
		);
		sql.exec('INSERT INTO cfw_page (a) VALUES (1)');
		expect(seen).toBe(7);
	});

	it('does NOT fire on a read, so a SELECT cursor is never consumed', () => {
		let calls = 0;
		const sql = countingSql(
			fakeSql(),
			() => undefined,
			() => {
				calls += 1;
			}
		);
		sql.exec('SELECT * FROM cfw_page');
		expect(calls).toBe(0);
	});

	it('fires once per write statement, not once per row', () => {
		let calls = 0;
		let rows = 0;
		const sql = countingSql(
			fakeSql({ 'INSERT INTO a (b) VALUES (1)': 4 }),
			() => undefined,
			(n) => {
				calls += 1;
				rows += n;
			}
		);
		sql.exec('INSERT INTO a (b) VALUES (1)');
		sql.exec('INSERT INTO a (b) VALUES (1)');
		expect(calls).toBe(2);
		expect(rows).toBe(8);
	});

	it('still feeds the tally when one IS armed, so the two do not compete', () => {
		let seen = 0;
		const tally = emptyTally();
		const sql = countingSql(
			fakeSql({ 'INSERT INTO watchdog (a) VALUES (1)': 3 }),
			() => tally,
			(rows) => {
				seen += rows;
			}
		);
		sql.exec('INSERT INTO watchdog (a) VALUES (1)');
		expect(seen).toBe(3);
		expect(tally.byTable['watchdog']).toBe(3);
	});

	it('works with no callback at all, which is the diagnostic-only shape', () => {
		const tally = emptyTally();
		const sql = countingSql(fakeSql({ 'INSERT INTO a (b) VALUES (1)': 2 }), () => tally);
		expect(() => sql.exec('INSERT INTO a (b) VALUES (1)')).not.toThrow();
		expect(tally.rowsWritten).toBe(2);
	});
});

describe('amplification, the index audit instrument', () => {
	const tally = (statementsByTable: Record<string, number>, byTable: Record<string, number>) => ({
		statementsByTable,
		byTable,
		statements: Object.values(statementsByTable).reduce((t, n) => t + n, 0),
		rowsWritten: Object.values(byTable).reduce((t, n) => t + n, 0)
	});

	it('reports charged rows per statement per table', () => {
		const out = amplification(tally({ router: 419 }, { router: 2095 }));
		expect(out).toHaveLength(1);
		expect(out[0]!.table).toBe('router');
		// the known case: 419 route inserts charged 2,095 rows, so 4 of every 5 are not the row
		expect(out[0]!.factor).toBeCloseTo(5, 5);
	});

	it('sorts by factor, so the worst table is first', () => {
		const out = amplification(
			tally(
				{ router: 100, cache_render: 100, cfw_page: 10 },
				{ router: 500, cache_render: 100, cfw_page: 10 }
			)
		);
		expect(out.map((r) => r.table)).toStrictEqual(['router', 'cache_render', 'cfw_page']);
	});

	it('reports a factor of 1 rather than hiding a table with nothing to win', () => {
		const out = amplification(tally({ cfw_page: 5 }, { cfw_page: 5 }));
		expect(out[0]!.factor).toBe(1);
	});

	it('keeps an all-no-op table at factor 0 instead of dropping it', () => {
		// the statements still cost CPU, so a table that charges nothing is a finding not a blank
		const out = amplification(tally({ watchdog: 7 }, {}));
		expect(out[0]).toStrictEqual({
			table: 'watchdog',
			statements: 7,
			rowsWritten: 0,
			factor: 0
		});
	});

	it('includes a table that charged rows with no counted statement', () => {
		// asymmetric input is a bug signal, not something to silently drop
		const out = amplification(tally({}, { mystery: 3 }));
		expect(out[0]!.table).toBe('mystery');
		expect(out[0]!.statements).toBe(0);
	});

	it('is empty for an empty tally', () => {
		expect(amplification(tally({}, {}))).toStrictEqual([]);
	});
});

describe('overheadShare', () => {
	it('is 0 when every statement charged exactly one row', () => {
		expect(
			overheadShare({ statementsByTable: {}, byTable: {}, statements: 13, rowsWritten: 13 })
		).toBe(0);
	});

	it('is the unexplained fraction when rows exceed statements', () => {
		// 419 statements, 2,095 rows: 1,676 of them are not one-per-statement
		const share = overheadShare({
			statementsByTable: {},
			byTable: {},
			statements: 419,
			rowsWritten: 2095
		});
		expect(share).toBeCloseTo(0.8, 5);
	});

	it('is 0 rather than negative when statements exceed rows', () => {
		// no-op writes make statements exceed rows, which is not overhead
		expect(
			overheadShare({ statementsByTable: {}, byTable: {}, statements: 50, rowsWritten: 10 })
		).toBe(0);
	});

	it('is 0 on an empty tally rather than NaN', () => {
		expect(
			overheadShare({ statementsByTable: {}, byTable: {}, statements: 0, rowsWritten: 0 })
		).toBe(0);
	});

	it('reads 0 on the recorded fill, which is 75% index maintenance', () => {
		// THE COUNTEREXAMPLE THAT RETIRED THE "upper bound on the index share" reading. 63
		// statements against 12 charged rows clamps `explained` to 12, so this returns 0 -- while
		// the schema decomposes the same 12 rows as 3 data and 9 index entries. A statement-heavy
		// write path always reads 0 here and always looks index-free.
		expect(
			overheadShare({ statementsByTable: {}, byTable: {}, statements: 63, rowsWritten: 12 })
		).toBe(0);
		const split = splitChargedRows(
			{ cache_dynamic_page_cache: 8, cache_page: 4 },
			{ cache_dynamic_page_cache: 4, cache_page: 4 }
		);
		expect(split.indexShare).toBe(0.75);
	});
});

describe('splitChargedRows', () => {
	it('divides a measured total by the schema factor rather than by a statement count', () => {
		const split = splitChargedRows(
			{ cache_dynamic_page_cache: 8, cache_page: 4 },
			{ cache_dynamic_page_cache: 4, cache_page: 4 }
		);
		expect(split.dataRows).toBe(3);
		expect(split.indexRows).toBe(9);
		expect(split.rows.every((r) => r.exact)).toBe(true);
	});

	it('marks a total that is not a whole multiple inexact instead of rounding it', () => {
		const split = splitChargedRows({ router: 10 }, { router: 4 });
		expect(split.rows[0]!.exact).toBe(false);
		// the floor is still reported, so the number is usable as a bound; the flag says it is one
		expect(split.rows[0]!.dataRows).toBe(2);
		expect(split.rows[0]!.indexRows).toBe(8);
	});

	it('reports factor 0 for a table with no known schema rather than assuming 1', () => {
		const split = splitChargedRows({ mystery: 6 }, {});
		expect(split.rows[0]!.chargePerRow).toBe(0);
		expect(split.rows[0]!.dataRows).toBe(0);
		expect(split.rows[0]!.exact).toBe(false);
		// all 6 land in indexRows, which overstates rather than hides an unattributed cost
		expect(split.indexRows).toBe(6);
	});

	it('is 0 on an empty input rather than NaN', () => {
		const split = splitChargedRows({}, {});
		expect(split.indexShare).toBe(0);
		expect(split.rows).toStrictEqual([]);
	});

	it('prices a rowid table at 1, where the row IS the whole cost', () => {
		const split = splitChargedRows({ sequences: 7 }, { sequences: 1 });
		expect(split.dataRows).toBe(7);
		expect(split.indexRows).toBe(0);
		expect(split.indexShare).toBe(0);
	});
});
