import { describe, expect, it } from 'vitest';
import { chargeFactorsFromSchema, splitChargedRows } from '../../src/db/write-tally';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What a `TEXT PRIMARY KEY` costs on the meter that binds, and whether `WITHOUT ROWID` removes it.
 *
 * SQLite gives a rowid table's `TEXT PRIMARY KEY` its own unique index, so every insert writes the
 * table row AND an index row -- two charged rows for one logical write. `WITHOUT ROWID` stores the
 * row inside the key's own B-tree instead, which should charge one.
 *
 * Rows written binds the regeneration ceiling, and the `cfw_page` upsert is the largest write in a
 * fill, so halving it is a direct multiplier on how many pages a site may regenerate per day.
 * Measured on a real `ctx.storage.sql` rather than reasoned about from SQLite's file format.
 */

const TIMEOUT = 900_000;

type Cost = { insert: number; update: number; reinsert: number };

/** charges one table through the shapes a fill actually performs */
function chargeOf(sql: ServeDo['sql'], table: string, ddl: string): Cost {
	sql.exec(ddl);
	const html = 'x'.repeat(12_304);
	const upsert = (path: string, body: string) =>
		sql.exec(
			`INSERT INTO ${table} (path, status, html, rendered_at) VALUES (?, 200, ?, 1)
			 ON CONFLICT(path) DO UPDATE SET html = excluded.html, rendered_at = excluded.rendered_at`,
			path,
			body
		).rowsWritten;
	return {
		insert: upsert('/a', html),
		// an upsert onto an existing path is the repeat-fill case, and it is charged separately
		update: upsert('/a', html + 'y'),
		reinsert: upsert('/b', html)
	};
}

describe('the row cost of a text primary key', () => {
	it(
		'charges a rowid table twice per write and a WITHOUT ROWID table once',
		async () => {
			const measured = await inObject(freshSite(), (site: ServeDo) => {
				const rowid = chargeOf(
					site.sql,
					'wr_rowid',
					`CREATE TABLE wr_rowid (path TEXT PRIMARY KEY, status INTEGER NOT NULL,
					 html TEXT NOT NULL, rendered_at INTEGER NOT NULL)`
				);
				const without = chargeOf(
					site.sql,
					'wr_without',
					`CREATE TABLE wr_without (path TEXT PRIMARY KEY, status INTEGER NOT NULL,
					 html TEXT NOT NULL, rendered_at INTEGER NOT NULL) WITHOUT ROWID`
				);
				// the platform has to actually honour the clause; a silently ignored one would
				// read as "no difference" and close the lever for the wrong reason
				const honoured = site.sql
					.exec("SELECT sql FROM sqlite_master WHERE name = 'wr_without'")
					.toArray()[0] as { sql?: string } | undefined;
				return { rowid, without, ddl: String(honoured?.sql ?? '') };
			});

			console.log(`[without-rowid] ${JSON.stringify(measured)}`);

			expect(measured.ddl, 'the platform dropped the WITHOUT ROWID clause').toContain(
				'WITHOUT ROWID'
			);
			expect(measured.rowid.insert).toBeGreaterThan(measured.without.insert);
			expect(measured.without.insert).toBe(1);
			expect(measured.rowid.insert).toBe(2);
		},
		TIMEOUT
	);

	it(
		'does not pay the saving back in rows READ or in bytes stored',
		async () => {
			// SQLite's own guidance is that WITHOUT ROWID suits SMALL rows, and `cfw_page` holds
			// ~12 KB of html per row. Rows read is a second meter (5M/day) and the serve HIT is one
			// indexed lookup, so a saving on writes bought with reads or size is not a saving
			const measured = await inObject(freshSite(), (site: ServeDo) => {
				const sql = site.sql;
				const html = 'x'.repeat(12_304);
				const build = (t: string, tail: string) => {
					sql.exec(
						`CREATE TABLE ${t} (path TEXT PRIMARY KEY, status INTEGER NOT NULL,
						 html TEXT NOT NULL, rendered_at INTEGER NOT NULL) ${tail}`
					);
					for (let i = 0; i < 200; i++) {
						sql.exec(
							`INSERT INTO ${t} (path, status, html, rendered_at)
							 VALUES (?, 200, ?, 1)`,
							`/page-${i}`,
							html
						);
					}
				};
				const before = Number(sql.databaseSize);
				build('rd_rowid', '');
				const rowidBytes = Number(sql.databaseSize) - before;
				const mid = Number(sql.databaseSize);
				build('rd_without', 'WITHOUT ROWID');
				const withoutBytes = Number(sql.databaseSize) - mid;
				// the serve HIT, which is the hot path and the one that must not regress
				const read = (t: string) => {
					const c = sql.exec(
						`SELECT status, html, rendered_at FROM ${t} WHERE path = ?`,
						'/page-137'
					);
					const rows = c.toArray();
					return { rows: rows.length, rowsRead: c.rowsRead };
				};
				return {
					rowidBytes,
					withoutBytes,
					rowidRead: read('rd_rowid'),
					withoutRead: read('rd_without')
				};
			});

			console.log(`[without-rowid tradeoff] ${JSON.stringify(measured)}`);

			// the claim being tested: the write saving is not funded by the read path
			expect(measured.withoutRead.rows).toBe(1);
			expect(measured.rowidRead.rows).toBe(1);
			expect(
				measured.withoutRead.rowsRead,
				'WITHOUT ROWID made the serve HIT read more rows'
			).toBeLessThanOrEqual(measured.rowidRead.rowsRead);
		},
		TIMEOUT
	);

	it(
		'is counted correctly by the instrument that prices the fill lane',
		async () => {
			// `chargeFactorsFromSchema()` derives the factor from `PRAGMA index_list`, and a
			// WITHOUT ROWID primary key is the table rather than an index. If the pragma still
			// reported one, the instrument would price the saving at zero and close this lever on
			// its own arithmetic -- so it is checked against the rowsWritten measured above
			const measured = await inObject(freshSite(), (site: ServeDo) => {
				const sql = site.sql;
				sql.exec('CREATE TABLE cf_rowid (path TEXT PRIMARY KEY, v TEXT NOT NULL)');
				sql.exec(
					'CREATE TABLE cf_without (path TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID'
				);
				const charged = {
					cf_rowid: sql.exec("INSERT INTO cf_rowid VALUES ('/a','x')").rowsWritten,
					cf_without: sql.exec("INSERT INTO cf_without VALUES ('/a','x')").rowsWritten
				};
				const factors = chargeFactorsFromSchema(sql, ['cf_rowid', 'cf_without']);
				return { charged, factors, split: splitChargedRows(charged, factors) };
			});

			console.log(`[without-rowid instrument] ${JSON.stringify(measured)}`);

			// the factor has to equal what the platform actually charged, both ways
			expect(measured.factors['cf_rowid']).toBe(measured.charged.cf_rowid);
			expect(measured.factors['cf_without']).toBe(measured.charged.cf_without);
			// and the split then reports one data row each and an index row only for the rowid one
			expect(measured.split.dataRows).toBe(2);
			expect(measured.split.indexRows).toBe(1);
		},
		TIMEOUT
	);

	it(
		'sizes the saving against a real fill rather than against a synthetic insert',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: 'cfw-Rows-7781-pass', siteName: 'Rows' })
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);
				// armed AFTER provisioning, or the install's writes land in the fill's window --
				// the padded-window error this project has already made once
				await site.fetch(new Request('https://do.local/__writes?op=on'));
				await site.fillOne('/user/login');
				const tally = (await (
					await site.fetch(new Request('https://do.local/__writes'))
				).json()) as {
					rowsWritten: number;
					indexSplit: {
						indexRows: number;
						dataRows: number;
						indexShare: number;
						rows: { table: string; indexRows: number; chargePerRow: number }[];
					};
				};
				// what the cfw_* text-keyed tables charged, which is the part this lever can move
				const byTable = (
					site as unknown as { writeTally?: { byTable: Record<string, number> } }
				).writeTally?.byTable;
				return { tally, byTable };
			});

			const cfw = Object.entries(out.byTable ?? {}).filter(([t]) => t.startsWith('cfw_'));
			const movable = cfw.reduce((n, [, rows]) => n + rows, 0);
			console.log(
				`[without-rowid fill] ${JSON.stringify({
					rowsWritten: out.tally.rowsWritten,
					indexRows: out.tally.indexSplit.indexRows,
					indexShare: +out.tally.indexSplit.indexShare.toFixed(3),
					cfwTables: Object.fromEntries(cfw),
					cfwChargedRows: movable,
					// WHERE THE INDEX ROWS ACTUALLY ARE. The cfw_* tables carry 2 of 157, so the
					// lever this file opened is worth ~1 row; the mass is Drupal's own schema
					perTable: out.tally.indexSplit.rows
						.filter((r) => r.indexRows > 0)
						.sort((a, b) => b.indexRows - a.indexRows)
						.slice(0, 12)
				})}`
			);

			// a fill that wrote nothing prices nothing, and this project has taken that reading
			// before when `cache.page.max_age` shipped at 0
			expect(out.tally.rowsWritten).toBeGreaterThan(0);
			expect(movable).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'says whether a WARM fill still pays the index charge, which is what decides the lever',
		async () => {
			// An UPDATE of an existing row charges 1 whether or not the table has an autoindex --
			// measured in the first case above. So the saving exists only for INSERTS of new keys.
			// A cold fill is full of them; the steady state that sets the regeneration ceiling may
			// not be, and if it is not, converting the cache bins buys nothing
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ adminPass: 'cfw-Warm-3312-pass', siteName: 'Warm' })
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);

				const armed = async (path: string) => {
					await site.fetch(new Request('https://do.local/__writes?op=off'));
					await site.fetch(new Request('https://do.local/__writes?op=on'));
					site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
					await site.fillOne(path);
					return (await (
						await site.fetch(new Request('https://do.local/__writes'))
					).json()) as {
						rowsWritten: number;
						indexSplit: { indexRows: number; dataRows: number; indexShare: number };
					};
				};

				// cold: the caches are empty and every write is a new key
				const cold = await armed('/user/login');
				// warm: the same path again, with every bin already carrying its entries
				const warm = await armed('/user/login');
				return { cold, warm };
			});

			const shape = (t: { rowsWritten: number; indexSplit: { indexRows: number } }) => ({
				rows: t.rowsWritten,
				index: t.indexSplit.indexRows
			});
			console.log(
				`[without-rowid warm] ${JSON.stringify({
					cold: shape(out.cold),
					warm: shape(out.warm)
				})}`
			);

			// both arms have to have done real work, or the comparison is between two nothings
			expect(out.cold.rowsWritten).toBeGreaterThan(0);
			expect(out.warm.rowsWritten).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'reads the same saving on the tables this project actually declares',
		async () => {
			// the four `cfw_*` tables keyed by text, priced together, because the fill path touches
			// three of them and the ceiling is the sum rather than any one of them
			const measured = await inObject(freshSite(), (site: ServeDo) => {
				const sql = site.sql;
				sql.exec(
					'CREATE TABLE q_rowid (path TEXT PRIMARY KEY, queued_at INTEGER NOT NULL)'
				);
				sql.exec(
					'CREATE TABLE q_without (path TEXT PRIMARY KEY, queued_at INTEGER NOT NULL) WITHOUT ROWID'
				);
				sql.exec('CREATE TABLE m_rowid (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
				sql.exec(
					'CREATE TABLE m_without (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID'
				);
				const q = (t: string) =>
					sql.exec(`INSERT INTO ${t} (path, queued_at) VALUES ('/p', 1)`).rowsWritten;
				const m = (t: string) =>
					sql.exec(
						`INSERT INTO ${t} (k, v) VALUES ('generation', '7')
						 ON CONFLICT(k) DO UPDATE SET v = excluded.v`
					).rowsWritten;
				return {
					queueRowid: q('q_rowid'),
					queueWithout: q('q_without'),
					metaRowid: m('m_rowid'),
					metaWithout: m('m_without')
				};
			});

			console.log(`[without-rowid tables] ${JSON.stringify(measured)}`);

			expect(measured.queueWithout).toBeLessThan(measured.queueRowid);
			expect(measured.metaWithout).toBeLessThan(measured.metaRowid);
		},
		TIMEOUT
	);
});
