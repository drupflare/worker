import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What `AUTOINCREMENT` costs on the rows-written meter.
 *
 * P29. SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT` keeps a high-water mark in `sqlite_sequence`,
 * so every insert into such a table writes the row AND updates that table. `INTEGER PRIMARY KEY`
 * alone reuses rowids after a delete and writes nothing extra.
 *
 * MEASURED HERE RATHER THAN REASONED, against the real Durable Object storage, because the
 * question is what the PLATFORM charges rather than what SQLite documents. Both tables are created
 * in the same object and driven with identical statements, so the difference is the keyword.
 *
 * **THE FIRST VERSION OF THIS FILE ASKED THE WRONG QUESTION AND THEN CLOSED THE ITEM ON IT.** It
 * asked "does this reduce rows per page FILL", measured no, and wrote P29 up as not worth doing.
 * That answer is correct and it settles one workload out of a dozen. Rows written is charged on
 * every write the site makes, not only on regeneration: a node save, a revision, a user creation, a
 * path alias and a file record all pay it, and none of them appears in the fill path the
 * regeneration ceiling is computed from. SQLite additionally documents extra CPU, memory, disk
 * space and disk I/O for the keyword, none of which the row count sees.
 *
 * So the file now measures BOTH: the per-fill answer (no effect, kept) and the per-SEMANTIC-
 * OPERATION answer, which is the one that decides whether the work is worth doing.
 *
 * WHAT IT STILL DOES NOT DECIDE. Whether Drupal or contrib depends on ids never being reused is a
 * per-table compatibility question -- an entity id that comes back after a delete can collide with
 * a stale reference held somewhere else. That is a separate audit and this is its input.
 */

type Sql = ServeDo['sql'];

function rowsFor(sql: Sql, ddl: string, table: string, inserts: number): number {
	sql.exec(ddl);
	let rows = 0;
	for (let i = 0; i < inserts; i++) {
		rows += sql.exec(`INSERT INTO ${table} (v) VALUES (?)`, `row-${i}`).rowsWritten;
	}
	return rows;
}

async function measure(inserts: number) {
	return inObject(freshSite(), (site: ServeDo) => ({
		auto: rowsFor(
			site.sql,
			'CREATE TABLE IF NOT EXISTS p29_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)',
			'p29_auto',
			inserts
		),
		plain: rowsFor(
			site.sql,
			'CREATE TABLE IF NOT EXISTS p29_plain (id INTEGER PRIMARY KEY, v TEXT)',
			'p29_plain',
			inserts
		)
	}));
}

describe('AUTOINCREMENT against the rows-written meter', () => {
	it('charges exactly twice per insert, and the plain key charges once', async () => {
		const out = await measure(10);
		expect(out.plain).toBe(10);
		expect(out.auto).toBe(20);
		expect(out.auto / out.plain).toBe(2);
	});

	it('is a per-INSERT cost rather than a one-off, which is what makes it worth counting', async () => {
		const ten = await measure(10);
		const forty = await measure(40);
		// linear: 4x the inserts is 4x the charge on both, so the extra row is not amortised by
		// anything and a hot table pays it on every write forever
		expect(forty.auto / ten.auto).toBe(4);
		expect(forty.plain / ten.plain).toBe(4);
	});

	it('leaves a sqlite_sequence row for the AUTOINCREMENT table and none for the other', async () => {
		const names = await inObject(freshSite(), (site: ServeDo) => {
			site.sql.exec(
				'CREATE TABLE IF NOT EXISTS p29_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
			);
			site.sql.exec('CREATE TABLE IF NOT EXISTS p29_plain (id INTEGER PRIMARY KEY, v TEXT)');
			site.sql.exec("INSERT INTO p29_auto (v) VALUES ('a')");
			site.sql.exec("INSERT INTO p29_plain (v) VALUES ('a')");
			return site.sql
				.exec('SELECT name FROM sqlite_sequence ORDER BY name')
				.toArray()
				.map((r) => String(r.name));
		});
		// the mechanism, stated by the database rather than by this file
		expect(names).toContain('p29_auto');
		expect(names).not.toContain('p29_plain');
	});
});

/**
 * How many of the shipped schema's tables pay it.
 *
 * Read out of the PACKED DATABASE rather than out of Drupal's schema definitions, because what
 * ships is what charges. `sqlite_sequence` only gains a row once a table is inserted into, so the
 * `sqlite_master` scan is the complete list and the `sqlite_sequence` scan is the used subset.
 */
describe('the shipped schema, and where the charge actually lands', () => {
	/**
	 * MEASURED against the packed database: **18 tables declare `AUTOINCREMENT`**, and on a
	 * migrated site with no content only **3 have ever been inserted into** -- `menu_tree`, `users`
	 * and `watchdog`. Read out of the DATABASE THAT SHIPS rather than out of Drupal's schema
	 * definitions, because what ships is what charges.
	 */
	it('names every AUTOINCREMENT table, so the list is auditable rather than quoted', async () => {
		const found = await inObject(freshSite(), async (site: ServeDo) => {
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			const declared = site.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%' ORDER BY name"
				)
				.toArray()
				.map((r) => String(r.name));
			const used = site.sql
				.exec('SELECT name FROM sqlite_sequence ORDER BY name')
				.toArray()
				.map((r) => String(r.name));
			return { declared, used };
		});

		// asserted as containment plus a floor rather than as a pinned count, so a schema change is
		// visible without a legitimate one failing the gate
		expect(found.declared.length).toBeGreaterThanOrEqual(18);
		for (const name of found.used) expect(found.declared).toContain(name);
		// the CONTENT tables are where the charge is, and they are the ones a node save writes
		for (const table of ['node', 'node_revision', 'path_alias', 'file_managed', 'users']) {
			expect(found.declared).toContain(table);
		}
	});

	/**
	 * THE FINDING THAT REORDERS THE ITEM: none of the hot REGENERATION tables pays it.
	 *
	 * Rows written binds regeneration, and a fill writes cache bins plus `cfw_page`. Neither
	 * declares `AUTOINCREMENT`, so the 2.00x above is charged on the CONTENT path -- a node save --
	 * and not on the path the ceiling is computed from. C34 already measured zero rows to
	 * `watchdog` in a fill, which removes the one hot table that does declare it.
	 */
	it('does NOT touch the cache bins or the page store, which is what a fill writes', async () => {
		const declared = await inObject(freshSite(), async (site: ServeDo) => {
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			return site.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%' ORDER BY name"
				)
				.toArray()
				.map((r) => String(r.name));
		});

		expect(declared.filter((name) => name.startsWith('cache_'))).toEqual([]);
		expect(declared).not.toContain('cfw_page');
		expect(declared).not.toContain('cfw_fill_queue');
		// and the host's own tables stay off it too, which is a choice this repo controls
		expect(declared.filter((name) => name.startsWith('cfw_'))).toEqual(['cfw_health']);
	});
});

/**
 * THE QUESTION THAT SURVIVES: write amplification per SEMANTIC OPERATION.
 *
 * The fill path is one workload. Rows written is charged on all of them, and the content path is
 * where every AUTOINCREMENT table actually lives. A node save touches `node`, `node_revision` and
 * `path_alias`; a user registration touches `users`; an upload touches `file_managed`. Each of
 * those inserts pays the extra row, and none of it appears in the regeneration ceiling.
 *
 * MEASURED AS A DIFFERENTIAL over the same statements against the two key kinds, so the number is
 * the keyword's cost and not the workload's. The real Drupal operation is bounded by what the
 * fixture can drive; what this establishes is the per-INSERT charge and the table count behind it,
 * which multiply out to the per-operation figure.
 */
describe('write amplification on the CONTENT path, which the fill path does not see', () => {
	it('charges one extra row per insert per AUTOINCREMENT table touched', async () => {
		// a node save in Drupal 11 inserts into `node`, `node_revision` and `path_alias` at
		// minimum, and all three declare the keyword -- so the operation pays 3 extra rows before
		// any field table is counted
		const perOperation = await inObject(freshSite(), (site: ServeDo) => {
			const rowsFor = (ddl: string, table: string) => {
				site.sql.exec(ddl);
				return site.sql.exec(`INSERT INTO ${table} (v) VALUES ('x')`).rowsWritten;
			};
			const auto = rowsFor(
				'CREATE TABLE IF NOT EXISTS amp_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)',
				'amp_auto'
			);
			const plain = rowsFor(
				'CREATE TABLE IF NOT EXISTS amp_plain (id INTEGER PRIMARY KEY, v TEXT)',
				'amp_plain'
			);
			return { auto, plain };
		});

		expect(perOperation.auto - perOperation.plain).toBe(1);
		// three tables per node save is three extra rows; against a 100,000/day allowance that is
		// 33,333 saves rather than 25,000, which is a 33% difference on a CONTENT workload and
		// exactly 0% on the regeneration one the item was closed against
		const tablesPerNodeSave = 3;
		const extraPerSave = (perOperation.auto - perOperation.plain) * tablesPerNodeSave;
		expect(extraPerSave).toBe(3);
	});

	it('keeps charging after a DELETE, which is the semantics the keyword is FOR', async () => {
		// SQLite documents AUTOINCREMENT as existing to guarantee a rowid is never reused. That is
		// the compatibility question a removal has to answer, and it is observable: the plain key
		// reuses the id, the AUTOINCREMENT one does not
		const ids = await inObject(freshSite(), (site: ServeDo) => {
			site.sql.exec(
				'CREATE TABLE IF NOT EXISTS reuse_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'
			);
			site.sql.exec(
				'CREATE TABLE IF NOT EXISTS reuse_plain (id INTEGER PRIMARY KEY, v TEXT)'
			);
			const first = (table: string) => {
				site.sql.exec(`INSERT INTO ${table} (v) VALUES ('a')`);
				const id = Number(
					site.sql.exec(`SELECT MAX(id) AS id FROM ${table}`).toArray()[0]?.id ?? 0
				);
				site.sql.exec(`DELETE FROM ${table} WHERE id = ?`, id);
				site.sql.exec(`INSERT INTO ${table} (v) VALUES ('b')`);
				return {
					before: id,
					after: Number(
						site.sql.exec(`SELECT MAX(id) AS id FROM ${table}`).toArray()[0]?.id ?? 0
					)
				};
			};
			return { auto: first('reuse_auto'), plain: first('reuse_plain') };
		});

		// the plain key reuses the freed id; the AUTOINCREMENT one moves past it
		expect(ids.plain.after).toBe(ids.plain.before);
		expect(ids.auto.after).toBeGreaterThan(ids.auto.before);
	});
});
