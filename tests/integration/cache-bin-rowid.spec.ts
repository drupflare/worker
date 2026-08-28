import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The shipped cache bins are stored as their primary-key B-tree, and a render is charged for it.
 *
 * A rowid table gives a `TEXT PRIMARY KEY` its own unique index, so one stored row is charged twice
 * on the meter that binds regeneration. Every bin `DatabaseBackend` creates keys on a TEXT `cid`,
 * and `scripts/measure/index-audit.ts` reports 13 of the 14 with NO secondary index -- so that
 * autoindex WAS their entire index cost. `scripts/pack-sql.ts` emits them `WITHOUT ROWID`.
 *
 * **MEASURED AS A CONVERSION BEFORE IT SHIPPED**, on one object and paired: a steady-state render
 * went **8 charged rows -> 6** and the bins' index charge **3 -> 0**, n=3 with zero spread. That A/B
 * cannot be re-run now that the pack ships converted -- the control arm no longer exists -- so this
 * asserts the END STATE instead: the bins carry no autoindex and a render pays no index row for them.
 *
 * The first version of that A/B read **11 -> 6 and was wrong**. A single warming render leaves
 * `cache_menu` and `cache_discovery` cold, so they are written in the control arm and not in the
 * treatment arm; 3 of those 5 rows were warmth rather than the conversion. Both arms need the same
 * warmth before the comparison means anything.
 */

const TIMEOUT = 900_000;

const CACHE_BIN = /^cache_/;

describe('the cache bins ship WITHOUT ROWID, and a render is not charged an autoindex', () => {
	it(
		'stores every bin as its key and charges one row per stored row',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Rowid-4417-pass',
							siteName: 'Rowid'
						})
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);

				// filtered in JS, NOT with `LIKE 'cache_%'`: `_` is a single-character wildcard in
				// SQL LIKE, so that pattern also matches `cachetags`, which is the tag-checksum
				// table rather than a bin and is not what the packer converts
				const bins = (
					site.sql
						.exec("SELECT name, sql FROM sqlite_master WHERE type='table'")
						.toArray() as { name: string; sql: string }[]
				)
					.filter((b) => b.name.startsWith('cache_'))
					.map((b) => ({
						name: b.name,
						withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(b.sql)
					}));

				// TWICE, so the measured arm is a steady-state render. One warming render leaves the
				// shared bins cold and the charge reads high for a reason that is not the schema
				await site.fillOne('/user/login', ['page', 'dynamic_page_cache']);
				site.sql.exec('DELETE FROM cfw_page WHERE path = ?', '/user/login');
				await site.fillOne('/user/login', ['page', 'dynamic_page_cache']);

				await site.fetch(new Request('https://do.local/__writes?op=off'));
				await site.fetch(new Request('https://do.local/__writes?op=on'));
				site.sql.exec('DELETE FROM cfw_page WHERE path = ?', '/user/login');
				await site.fillOne('/user/login', ['page', 'dynamic_page_cache']);

				const tally = (await (
					await site.fetch(new Request('https://do.local/__writes'))
				).json()) as {
					rowsWritten: number;
					indexSplit: {
						indexRows: number;
						rows: { table: string; indexRows: number; chargePerRow: number }[];
					};
				};
				return { bins, tally };
			});

			const binIndexRows = out.tally.indexSplit.rows
				.filter((r) => CACHE_BIN.test(r.table))
				.reduce((n, r) => n + r.indexRows, 0);

			console.log(
				`[cache-bin-rowid] ${JSON.stringify({
					bins: out.bins.length,
					rowid: out.bins.filter((b) => !b.withoutRowid).map((b) => b.name),
					rowsWritten: out.tally.rowsWritten,
					binIndexRows,
					detail: out.tally.indexSplit.rows
				})}`
			);

			expect(
				out.bins.length,
				'no cache bin exists, so this measures nothing'
			).toBeGreaterThan(0);
			// the shipped DDL: a bin left as a rowid table is charged twice per stored row
			expect(
				out.bins.filter((b) => !b.withoutRowid).map((b) => b.name),
				'a cache bin still ships as a rowid table'
			).toEqual([]);
			// and the consequence on the meter, which is the reason the DDL is that way
			expect(binIndexRows, 'a bin was charged an autoindex row').toBe(0);
			for (const r of out.tally.indexSplit.rows) {
				expect(r.chargePerRow, `${r.table} charges more than one row per stored row`).toBe(
					1
				);
			}
			expect(out.tally.rowsWritten).toBe(6);
		},
		TIMEOUT
	);
});
