import { describe, expect, it } from 'vitest';
import { ROWS_PER_FILL, ROWS_PER_FILL_MEMORY_BINS } from '../../scripts/measure/free-envelope';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

// injected by `vitest.config.ts`; workerd has no `process.env`, so reading it here would be false
// on every run and the gate would never fire
declare const __DRUPFLARE_PACK_FROM_SOURCE__: boolean;
const FROM_SOURCE =
	typeof __DRUPFLARE_PACK_FROM_SOURCE__ === 'boolean' ? __DRUPFLARE_PACK_FROM_SOURCE__ : false;

// `/user/login` reassembles in the upsert alone; `warmReassemble` is priced on `/`, the dearer path
const LOGIN_REASSEMBLE_ROWS = 1;

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

// PINNED AGAINST THE SHIPPED PACK. A from-source build is a superset, so a real render touches a
// different file set and the counts move -- 86 against 94 on the first fill of a fresh object
describe.skipIf(FROM_SOURCE)(
	'rows per fill, against the constants the ceiling is computed from',
	() => {
		it(
			'measures each warmth class and reports it beside the constant',
			async () => {
				const out = await inObject(freshSite(), async (site: ServeDo) => {
					// THE CONSTANTS DESCRIBE `MEMORY_CACHE_BINS=none` AND THE DEFAULT IS NOT THAT.
					// Driving the default here would compare a measurement of one configuration
					// against a constant describing another, which is the drift this file exists to
					// catch rather than to commit. The default's own figures are the arm below
					site.env = { ...site.env, MEMORY_CACHE_BINS: 'none' };
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
						// THE RESET GOES AFTER THE HARNESS'S OWN SETUP. A DELETE is a charged write,
						// and this one landed inside the tracked window, so every class whose page
						// row already existed read one row too high -- `realRender` and
						// `warmReassemble`, which carry 95% of the steady-state mix between them. A
						// fill UPSERTS (`ON CONFLICT(path) DO UPDATE`), so production never pays it
						site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
						await site.fetch(new Request('https://do.local/__writes?op=off'));
						await site.fetch(new Request('https://do.local/__writes?op=on'));
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
					// the front page reassembles dearer than login, so the class is priced on it.
					// Appended AFTER the four, because the classes above are sequence-sensitive
					await arm('/');
					const frontReassemble = await arm('/', ['page']);
					return {
						firstEver,
						anotherNewPath,
						realRender,
						warmReassemble,
						frontReassemble
					};
				});

				const table = {
					firstEverForPath: {
						measured: out.firstEver.rows,
						constant: ROWS_PER_FILL.firstEverForPath
					},
					secondNewPath: { measured: out.anotherNewPath.rows, constant: null },
					realRender: {
						measured: out.realRender.rows,
						constant: ROWS_PER_FILL.realRender
					},
					warmReassemble: {
						measured: out.warmReassemble.rows,
						constant: ROWS_PER_FILL.warmReassemble
					}
				};
				console.log(`[rows-per-fill] ${JSON.stringify({ table, detail: out })}`);

				// every arm has to have written something, or a zero reads as a saving
				for (const [name, arm] of Object.entries(out)) {
					expect(arm.rows, `${name} wrote nothing, so it prices nothing`).toBeGreaterThan(
						0
					);
				}
				// PINNED, not ranged: three consecutive runs read identical counts in every class, so
				// these are exact charges rather than noisy measurements and a drift is a real change
				expect(out.realRender.rows).toBe(ROWS_PER_FILL.realRender);
				// the ONE class not pinned by equality: this arm reassembles `/user/login`, which is
				// one row and the cheaper path, while the class is priced on `/` at two. Pin the
				// login figure exactly so a drift still fails, and assert the class is not undercut
				expect(out.warmReassemble.rows).toBe(LOGIN_REASSEMBLE_ROWS);
				expect(out.warmReassemble.rows).toBeLessThanOrEqual(ROWS_PER_FILL.warmReassemble);
				expect(out.anotherNewPath.rows).toBe(ROWS_PER_FILL.firstEverForPath);
				expect(out.firstEver.rows).toBe(ROWS_PER_FILL.firstFillOnFreshObject);
				// and the ordering, which is what the model's warmth classes mean
				expect(out.firstEver.rows).toBeGreaterThan(out.anotherNewPath.rows);
				expect(out.anotherNewPath.rows).toBeGreaterThan(out.realRender.rows);
				expect(out.realRender.rows).toBeGreaterThan(out.warmReassemble.rows);
			},
			TIMEOUT
		);

		/**
		 * And the same classes at the SHIPPING DEFAULT, which is a different configuration.
		 *
		 * `dynamic_page_cache` is an in-memory bin by default, so the rows above describe a site
		 * that turned that off. The gap is not a regression and not a saving to quote yet: taking
		 * `realRender` from 9 to 3 moves the published ceiling 9,685 -> 27,845/day, and it inverts
		 * the safety property the headline rests on -- a realistic warmth mix prices 3.20 against
		 * this class's 3.00, where it used to sit below, so quoting the class would make the ceiling
		 * optimistic. Re-deriving the model against the default is its own measurement pass. This
		 * arm exists so the gap is a number somebody can act on rather than a surprise.
		 */
		it(
			'measures the same classes at the default, and prints the gap',
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
						// THE RESET GOES AFTER THE HARNESS'S OWN SETUP. A DELETE is a charged write,
						// and this one landed inside the tracked window, so every class whose page
						// row already existed read one row too high -- `realRender` and
						// `warmReassemble`, which carry 95% of the steady-state mix between them. A
						// fill UPSERTS (`ON CONFLICT(path) DO UPDATE`), so production never pays it
						site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
						await site.fetch(new Request('https://do.local/__writes?op=off'));
						await site.fetch(new Request('https://do.local/__writes?op=on'));
						await site.fillOne(path, bins);
						const t = (await (
							await site.fetch(new Request('https://do.local/__writes'))
						).json()) as {
							rowsWritten: number;
							statements: number;
							indexSplit: { rows: { table: string; chargedRows: number }[] };
						};
						return {
							rows: t.rowsWritten,
							index: 0,
							statements: t.statements,
							perTable: t.indexSplit.rows.filter((r) => r.chargedRows > 0)
						} as Arm;
					};
					// the same four classes in the same order as the SQL arm above, so the two
					// tables are comparable class by class rather than only on `realRender`
					const firstEver = await arm('/user/login');
					const anotherNewPath = await arm('/user/password');
					const realRender = await arm('/user/login', ['page', 'dynamic_page_cache']);
					const warmReassemble = await arm('/user/login', ['page']);
					// the front page reassembles dearer than login, so the class is priced on it.
					// Appended AFTER the four, because the classes above are sequence-sensitive
					await arm('/');
					const frontReassemble = await arm('/', ['page']);
					return {
						firstEver,
						anotherNewPath,
						realRender,
						warmReassemble,
						frontReassemble
					};
				});

				console.log(
					`[rows-per-fill-default] ${JSON.stringify({
						firstFillOnFreshObject: {
							measured: out.firstEver.rows,
							sqlConstant: ROWS_PER_FILL.firstFillOnFreshObject
						},
						firstEverForPath: {
							measured: out.anotherNewPath.rows,
							sqlConstant: ROWS_PER_FILL.firstEverForPath
						},
						realRender: {
							measured: out.realRender.rows,
							sqlConstant: ROWS_PER_FILL.realRender
						},
						warmReassemble: {
							measured: out.warmReassemble.rows,
							sqlConstant: ROWS_PER_FILL.warmReassemble
						},
						detail: out
					})}`
				);

				// the class ORDERING has to survive the configuration change, or the warmth mix
				// is describing a different shape of day than the one it was written for
				expect(out.firstEver.rows).toBeGreaterThan(out.anotherNewPath.rows);
				expect(out.anotherNewPath.rows).toBeGreaterThan(out.realRender.rows);
				// NOT STRICT AT THIS DEFAULT: with `dynamic_page_cache` and `menu` both in memory a
				// re-render of `/user/login` writes the `cfw_page` upsert and nothing else, which is
				// all a reassemble writes, so on the warm path the two classes converge on one row
				expect(out.realRender.rows).toBeGreaterThanOrEqual(out.warmReassemble.rows);

				// the default is CHEAPER on the meter that binds regeneration, which is the whole
				// reason it is the default
				expect(out.realRender.rows).toBeLessThan(ROWS_PER_FILL.realRender);
				// and the bin is genuinely absent rather than merely smaller
				expect(
					out.realRender.perTable.some((r) => r.table === 'cache_dynamic_page_cache')
				).toBe(false);
				// a reassemble does not move between configurations: it never wrote that bin
				expect(out.warmReassemble.rows).toBe(LOGIN_REASSEMBLE_ROWS);
				// and every class is PINNED against the table the shipping headline is priced on,
				// the same way the SQL arm above pins its own -- reassemble as a bound, for the
				// front-page reason given there
				expect(out.realRender.rows).toBe(ROWS_PER_FILL_MEMORY_BINS.realRender);
				// priced on the DEARER path, which is the front page
				expect(Math.max(out.warmReassemble.rows, out.frontReassemble.rows)).toBe(
					ROWS_PER_FILL_MEMORY_BINS.warmReassemble
				);
				expect(out.anotherNewPath.rows).toBe(ROWS_PER_FILL_MEMORY_BINS.firstEverForPath);
				expect(out.firstEver.rows).toBe(ROWS_PER_FILL_MEMORY_BINS.firstFillOnFreshObject);
			},
			TIMEOUT
		);
	}
);
