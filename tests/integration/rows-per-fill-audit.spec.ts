import { describe, expect, it } from 'vitest';
import { ROWS_PER_FILL } from '../../scripts/measure/free-envelope';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The four `ROWS_PER_FILL` classes, re-measured against the tree that ships.
 *
 * Those constants set the regeneration ceiling, which is one of the product's two headline numbers,
 * and nothing re-measures them. A first-ever fill of `/user/login` read 157 charged rows against a
 * documented `firstEverForPath` of 62, so at least one of them is describing a build that no longer
 * exists.
 *
 * Every arm is driven on ONE object and consecutively, because objects differ in marginal render
 * cost by 2.8x and an unpaired comparison here has already read 2.7x high once.
 *
 * All four fell when the pack's cache bins became `WITHOUT ROWID`: 156 -> 103, 24 -> 14, 12 -> 9,
 * and `warmReassemble` alone unchanged at 2, because it writes only `cfw_page` and that table was
 * already stored as its own key.
 */

const TIMEOUT = 900_000;

type Arm = {
	rows: number;
	index: number;
	statements: number;
	perTable: { table: string; chargedRows: number; indexRows: number; chargePerRow: number }[];
};

/**
 * WHAT A CONTENT SAVE COSTS ON THE ROW METER, attributed per table.
 *
 * Measured deployed 2026-09-11: a node save costs ~208-233 charged rows, consistently across 4, 12
 * and 30 saves per minute. Against the free plan's ~100,000 rows/day that is roughly 480 saves a
 * day, and it is the product's binding write limit -- it arrives an order of magnitude before any
 * latency problem, and nothing was designed against it because every earlier measurement was in
 * milliseconds. This attributes the rows so a lever has somewhere to aim.
 *
 * Same harness as the fill arms above and the same meter; the operation is the difference.
 */
describe('rows per content save, which is the write ceiling', () => {
	it(
		'attributes a node save per table',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Audit-9912-pass',
							siteName: 'Audit'
						})
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);
				// a page warm first, so the save's own invalidation has something to purge and
				// re-queue -- a save on a site with nothing cached under-reports by construction
				await site.fillOne('/');

				const save = async (title: string): Promise<Arm> => {
					await site.fetch(new Request('https://do.local/__writes?op=off'));
					await site.fetch(new Request('https://do.local/__writes?op=on'));
					const res = await site.fetch(
						new Request(
							`https://do.local/__savenode?title=${encodeURIComponent(title)}`
						)
					);
					expect(res.status, await res.clone().text()).toBe(200);
					const t = (await (
						await site.fetch(new Request('https://do.local/__writes'))
					).json()) as {
						rowsWritten: number;
						statements: number;
						indexSplit: {
							indexRows: number;
							rows: {
								table: string;
								chargedRows: number;
								indexRows: number;
								chargePerRow: number;
							}[];
						};
					};
					return {
						rows: t.rowsWritten,
						index: t.indexSplit.indexRows,
						statements: t.statements,
						perTable: t.indexSplit.rows
							.filter((r) => r.chargedRows > 0)
							.sort((a, b) => b.chargedRows - a.chargedRows)
					};
				};

				// two consecutive saves: the first carries any one-off warming, the second is the
				// marginal cost an editor actually repeats
				const firstSave = await save('audit one');
				// `cfw_meta` is the largest NON-CONTENT charge and it is entirely ours, so the keys
				// behind it are counted rather than left as a total. Wrapping the setter is the only
				// way to attribute them: the write tally sees a table, not a key
				const metaKeys: Record<string, number> = {};
				const realMetaSet = site.metaSet.bind(site);
				site.metaSet = (k: string, v: unknown) => {
					metaKeys[k] = (metaKeys[k] ?? 0) + 1;
					return realMetaSet(k, v);
				};
				const secondSave = await save('audit two');
				site.metaSet = realMetaSet;
				return { firstSave, secondSave, metaKeys };
			});

			const share = (arm: Arm) =>
				arm.perTable.map((r) => ({
					table: r.table,
					rows: r.chargedRows,
					pct: Math.round((r.chargedRows / arm.rows) * 100)
				}));
			console.log(
				`[rows-per-save] ${JSON.stringify({
					firstSaveRows: out.firstSave.rows,
					secondSaveRows: out.secondSave.rows,
					firstSave: share(out.firstSave),
					secondSave: share(out.secondSave),
					metaKeys: Object.entries(out.metaKeys).sort((a, b) => b[1] - a[1])
				})}`
			);

			// a save that writes nothing prices nothing, and a save is the operation the write
			// ceiling is computed from
			expect(out.firstSave.rows).toBeGreaterThan(0);
			expect(out.secondSave.rows).toBeGreaterThan(0);
			expect(out.secondSave.perTable.length).toBeGreaterThan(0);

			// ONE `commit_seq` row per save, not one per authoritative statement. It was 28 -- 15% of
			// a 188-row save and the largest non-content charge on it -- and batching took the save
			// to 161. A regression here is invisible in latency and shows up only as a site that
			// runs out of daily rows sooner, which is the failure mode nobody was watching
			expect(out.metaKeys.commit_seq ?? 0).toBe(1);
			// and the fence still has to MOVE, or the saving came from breaking replication
			expect(out.metaKeys.commit_seq).toBeGreaterThan(0);
		},
		TIMEOUT
	);
});

describe('rows per fill, against the constants the ceiling is computed from', () => {
	it(
		'measures each warmth class and reports it beside the constant',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				const first = await site.fetch(
					new Request('https://do.local/__firstrun', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							adminPass: 'cfw-Audit-9912-pass',
							siteName: 'Audit'
						})
					})
				);
				expect(first.status, await first.clone().text()).toBe(200);

				const arm = async (path: string, bins?: string[]): Promise<Arm> => {
					await site.fetch(new Request('https://do.local/__writes?op=off'));
					await site.fetch(new Request('https://do.local/__writes?op=on'));
					site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
					await site.fillOne(path, bins);
					const t = (await (
						await site.fetch(new Request('https://do.local/__writes'))
					).json()) as {
						rowsWritten: number;
						statements: number;
						indexSplit: {
							indexRows: number;
							rows: {
								table: string;
								chargedRows: number;
								indexRows: number;
								chargePerRow: number;
							}[];
						};
					};
					return {
						rows: t.rowsWritten,
						index: t.indexSplit.indexRows,
						statements: t.statements,
						// EVERY table that charged, not just the ones carrying an index charge. The
						// narrow list answered "where does the index cost live" and could not answer
						// "why did the total move": a drift of 8 landed entirely in single-charge
						// tables, so the report named `cache_data` and `key_value` at exactly their
						// documented values while the total disagreed
						perTable: t.indexSplit.rows
							.filter((r) => r.chargedRows > 0)
							.sort((a, b) => b.chargedRows - a.chargedRows)
					};
				};

				// the front page first, so `/user/login` below is a never-routed path on
				// an object whose shared bins are already populated
				const firstEver = await arm('/user/login');
				const anotherNewPath = await arm('/user/password');
				// BOTH bins, which is what `realRender` means. `fillOne()` defaults to
				// `FILL_BINS = ['page']`, so an arm that omits the argument is a REASSEMBLE -- a
				// first pass measured that and read `realRender` at 5 against a documented 13
				const realRender = await arm('/user/login', ['page', 'dynamic_page_cache']);
				// page bin only: dynamic_page_cache stays warm, so this is a reassemble
				const warmReassemble = await arm('/user/login', ['page']);
				return { firstEver, anotherNewPath, realRender, warmReassemble };
			});

			const table = {
				firstEverForPath: {
					measured: out.firstEver.rows,
					constant: ROWS_PER_FILL.firstEverForPath
				},
				secondNewPath: { measured: out.anotherNewPath.rows, constant: null },
				realRender: { measured: out.realRender.rows, constant: ROWS_PER_FILL.realRender },
				warmReassemble: {
					measured: out.warmReassemble.rows,
					constant: ROWS_PER_FILL.warmReassemble
				}
			};
			console.log(`[rows-per-fill] ${JSON.stringify({ table, detail: out })}`);

			// every arm has to have written something, or a zero reads as a saving
			for (const [name, arm] of Object.entries(out)) {
				expect(arm.rows, `${name} wrote nothing, so it prices nothing`).toBeGreaterThan(0);
			}
			// PINNED, not ranged: three consecutive runs read identical counts in every class, so
			// these are exact charges rather than noisy measurements and a drift is a real change
			expect(out.realRender.rows).toBe(ROWS_PER_FILL.realRender);
			expect(out.warmReassemble.rows).toBe(ROWS_PER_FILL.warmReassemble);
			expect(out.anotherNewPath.rows).toBe(ROWS_PER_FILL.firstEverForPath);
			expect(out.firstEver.rows).toBe(ROWS_PER_FILL.firstFillOnFreshObject);
			// and the ordering, which is what the model's warmth classes mean
			expect(out.firstEver.rows).toBeGreaterThan(out.anotherNewPath.rows);
			expect(out.anotherNewPath.rows).toBeGreaterThan(out.realRender.rows);
			expect(out.realRender.rows).toBeGreaterThan(out.warmReassemble.rows);
		},
		TIMEOUT
	);
});
