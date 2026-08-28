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
 */

const TIMEOUT = 900_000;

type Arm = {
	rows: number;
	index: number;
	statements: number;
	perTable: { table: string; indexRows: number; chargePerRow: number }[];
};

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
							rows: { table: string; indexRows: number; chargePerRow: number }[];
						};
					};
					return {
						rows: t.rowsWritten,
						index: t.indexSplit.indexRows,
						statements: t.statements,
						// which tables carry the index charge, so a lever aimed at it knows where
						// to aim rather than assuming the cfw_* tables matter
						perTable: t.indexSplit.rows
							.filter((r) => r.indexRows > 0)
							.sort((a, b) => b.indexRows - a.indexRows)
					};
				};

				// the front page first, so `/user/login` below is genuinely a never-routed path on
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
