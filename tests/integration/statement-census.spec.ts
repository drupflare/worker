import { describe, expect, it } from 'vitest';
import {
	census,
	CENSUS_CATEGORIES,
	type Census,
	type CensusCall,
	type CensusCategory
} from '../../src/ops/statement-census';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

/**
 * WHICH statements a warm render sends, not how many. Three arms, two paths; the table each run
 * reproduces is in the report, and each case asserts a shape rather than a value that moves.
 */

/** both halves: the census sees only Drupal's statements, the host writes through `this.sql` */
type FillWrites = { statements: number; rowsWritten: number; byTable: Record<string, number> };

type Reading = {
	crossings: number;
	log: CensusCall[];
	census: Census;
	writes: FillWrites;
	/**
	 * whether the fill STORED the page, which decides whether the arm is a regeneration at all.
	 *
	 * `fillOne()` refuses to store a render that set a cookie, answered for a uid, or asked not to
	 * be cached, so a form path writes no `cfw_page` row. Scoring the regeneration ceiling off an
	 * arm that stored nothing would price the meter on a workload that never reaches it.
	 */
	stored: boolean;
	/** Drupal's own `X-Drupal-Dynamic-Cache`, which says whether the bin answered for this render */
	dynamicCache: string | null;
};

const REQUEST_TIMEOUT = 900_000;

/**
 * One object, boot-filled once, then the same path rendered three times.
 *
 * `/__migrate` not `provisionedSite()`, which stamps the cursor without replaying; `/__fill` not
 * `/__serve`, which refuses to boot inline. The third arm is the control on the second.
 */
async function warmRender(
	path = '/user/login',
	bootPath = '/'
): Promise<{ first: Reading; repeat: Reading; steady: Reading }> {
	const raw = await inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		queuePath(site, bootPath, { arm: false });
		await site.fetch(new Request('https://do.local/__fill'));
		const tally = site.crossings;
		if (!tally) throw new Error('no crossing tally: the interpreter never booted');
		// armed AFTER the boot fill, so the kernel build is not charged to the census
		const one = async () => {
			const before = tally.total;
			tally.calls = [];
			queuePath(site, path, { arm: false });
			// armed AFTER the queue insert, so the tally covers the fill and not the invalidation
			// that queued it; `?op=on` resets, so each arm reads its own fill rather than a running sum
			await site.fetch(new Request('https://do.local/__writes?op=on'));
			// `page` rather than `filled`, and `filled` is a probe that cannot fail: `fillOne()`
			// returns the path whether or not it stored anything, and attaches `page` exactly when
			// it REFUSED to store. A `stored` read off `filled` is true for every arm
			const outcome = (await (
				await site.fetch(new Request('https://do.local/__fill'))
			).json()) as { page?: unknown; dynamicCache?: string | null };
			const writes = (await (
				await site.fetch(new Request('https://do.local/__writes'))
			).json()) as {
				statements: number;
				rowsWritten: number;
				ranked?: Array<{ table: string; rows: number }>;
			};
			const log = tally.calls ?? [];
			// disarmed between arms, so nothing between the two renders lands in either log
			tally.calls = undefined;
			return {
				crossings: tally.total - before,
				log,
				stored: outcome.page === undefined,
				dynamicCache: outcome.dynamicCache ?? null,
				writes: {
					statements: writes.statements,
					rowsWritten: writes.rowsWritten,
					byTable: Object.fromEntries(
						(writes.ranked ?? []).map((r) => [r.table, r.rows] as const)
					)
				}
			};
		};
		const first = await one();
		const repeat = await one();
		return { first, repeat, steady: await one() };
	});
	const read = (r: (typeof raw)['first']): Reading => ({ ...r, census: census(r.log) });
	return { first: read(raw.first), repeat: read(raw.repeat), steady: read(raw.steady) };
}

const sumCategories = (c: Census) =>
	CENSUS_CATEGORIES.reduce((n, key: CensusCategory) => n + c.byCategory[key], 0);

/** the heaviest single fingerprint by what it sent back across the bridge */
const widest = (c: Census) => [...c.rows].sort((a, b) => b.resultBytes - a.resultBytes)[0] ?? null;

describe('the statement census of one warm render', () => {
	it(
		'decomposes every crossing, with nothing unparsed and nothing double-counted',
		async () => {
			const { first, repeat, steady } = await warmRender();
			// TWO WORKLOADS, because `/user/login` is a form and `fillOne()` stores no `cfw_page` row
			// for it -- so it is a render and never a REGENERATION, and the ceiling is about the
			// second thing. RULE 0c's "under which workload?" asked of this instrument
			const front = await warmRender('/', '/user/login');
			// the record `scripts/measure/render-census.ts` reads; emitted from THIS case alone so a
			// full-file run does not print the same table five times
			for (const [path, arms] of [
				['/user/login', { first, repeat, steady }],
				['/', front]
			] as const) {
				for (const [arm, reading] of Object.entries(arms)) {
					console.log(
						`[render-census] ${JSON.stringify({
							path,
							arm,
							crossings: reading.crossings,
							stored: reading.stored,
							dynamicCache: reading.dynamicCache,
							fill: reading.writes,
							...reading.census
						})}`
					);
				}
			}
			for (const arm of [first, repeat, steady, front.first, front.repeat, front.steady]) {
				// a GET render opens no transaction, so one crossing is one statement. If this ever
				// diverges the render buffered a write, and the two counts stop being the same
				// question rather than the census being wrong
				expect(arm.census.statements).toBe(arm.crossings);
				// THE INSTRUMENT CHECK. A payload that failed to parse is recorded with a null
				// fingerprint and lands in `bridge`; every crossing here is `cfwSqlExec`, so a
				// non-zero `bridge` means the decoder is broken rather than that the render did
				// something new
				expect(arm.census.byCategory.bridge).toBe(0);
				expect(arm.census.rows.every((r) => r.fingerprint.length > 0)).toBe(true);
				// the five categories are a partition, so they sum to the total exactly
				expect(sumCategories(arm.census)).toBe(arm.census.statements);
				// a render that sent nothing is a broken fixture reported as a cheap workload
				expect(arm.census.statements).toBeGreaterThan(0);
			}
			// the FIRST render of a path pays every per-path bin as a miss, so it is the one arm
			// with a meaningful floor; a steady render answers from the bins and is single digits
			expect(first.census.statements).toBeGreaterThan(10);
			expect(front.first.census.statements).toBeGreaterThan(10);
		},
		REQUEST_TIMEOUT
	);

	it(
		'shows a REPEAT render of the same path is a different workload from the first',
		async () => {
			const { first, repeat } = await warmRender();
			// measured 18 against 48. The 48 that P36 opened is the first render of a path on an
			// object whose interpreter is warm, so it pays every per-path bin as a miss. A
			// regeneration re-renders a page that already existed, which is the workload the
			// ceiling is computed from -- pricing it at the warm-up overstates it
			expect(repeat.census.statements).toBeLessThan(first.census.statements / 2);
			// rows written binds the regeneration ceiling (RULE 0b), and it separates harder than
			// the statement count does: measured 8 against 46
			expect(repeat.census.totals.rowsWritten).toBeLessThan(
				first.census.totals.rowsWritten / 2
			);
		},
		REQUEST_TIMEOUT
	);

	it(
		'attributes the first render mostly to REPEATS of a query it already ran',
		async () => {
			const { first } = await warmRender();
			const c = first.census;
			// measured 25 of 48 statements, 23 distinct fingerprints. A duplicate is a repeat of a
			// fingerprint the same render already sent -- the floor a perfect deduplication would
			// reach is `distinct`, which is what makes this the count worth quoting
			expect(c.distinct).toBeLessThan(c.statements);
			expect(c.byCategory.duplicate / c.statements).toBeGreaterThan(0.4);
			// the other two reducible buckets are non-zero, which is what proves the classifier
			// discriminates rather than dumping everything into the largest one
			expect(c.byCategory['cache-miss']).toBeGreaterThan(0);
			expect(c.byCategory['repeated-table']).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'finds the bridge payload concentrated in ONE row, which no statement count would show',
		async () => {
			const { repeat } = await warmRender();
			const top = widest(repeat.census);
			expect(top).not.toBeNull();
			// measured: a single `cache_discovery` read returns 97,749 of 128,773 bytes. It is one
			// statement of eighteen and three quarters of everything that crosses, so the render's
			// dominant bridge cost is a RESULT SIZE and the statement count cannot see it. Asserted
			// as a majority rather than at 75.9%, which moves with the pack
			expect(top!.count).toBeLessThanOrEqual(2);
			expect(top!.resultBytes / repeat.census.totals.resultBytes).toBeGreaterThan(0.5);
		},
		REQUEST_TIMEOUT
	);

	it(
		'writes NO rows to dynamic_page_cache on a steady fill, which is the lever',
		async () => {
			const { repeat } = await warmRender();
			const dpc = repeat.census.byTable['cache_dynamic_page_cache'];
			// this bin used to carry 6 of the 7 rows a fill charged, entirely because the fill
			// emptied it on itself; `FILL_BINS` no longer does, and the A/B below prices it
			expect(dpc?.rowsWritten ?? 0).toBe(0);
			expect(repeat.dynamicCache).toBe('HIT');
		},
		REQUEST_TIMEOUT
	);

	it(
		'measures what a fill that does NOT empty the bin costs, and what still invalidates it',
		async () => {
			// an A/B rather than a subtraction, whose subtrahend would be an assumption; then the
			// correctness half, since a HIT after `invalidateTags()` would mean tags miss the bin
			const reading = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
				queuePath(site, '/', { arm: false });
				await site.fetch(new Request('https://do.local/__fill'));
				// narrowed on the way out, because `/__assemble` echoes the whole refused page and a
				// 17 KB marker line is a log entry rather than a measurement
				const assemble = async (bins: string) => {
					const out = (await (
						await site.fetch(
							new Request(`https://do.local/__assemble?path=/&bins=${bins}`)
						)
					).json()) as {
						dynamicCache: string | null;
						hostStatements: number;
						rowsWritten: number;
						bytes?: number;
					};
					return {
						dynamicCache: out.dynamicCache,
						hostStatements: out.hostStatements,
						rowsWritten: out.rowsWritten,
						bytes: out.bytes ?? 0
					};
				};
				// both bins first, so the warm entry the next arm reads was written by a render
				// rather than by the pack
				const rendered = await assemble('page,dynamic_page_cache');
				const reassembled = await assemble('page');
				// what bounds the bin's LIFETIME once nothing empties it. An `expire` of -1 is
				// CACHE_PERMANENT, and nothing in `EXPIRED_ROW_RULES` or `gcCacheData()` touches
				// this bin, so a permanent row's only bound today is the deleteAll() being removed
				const rows = site.sql
					.exec(
						'SELECT expire, COUNT(*) AS c FROM cache_dynamic_page_cache GROUP BY expire'
					)
					.toArray()
					.map((r) => ({ expire: Number(r.expire), count: Number(r.c) }));
				await site.fetch(new Request('https://do.local/__invalidate?tags=rendered'));
				const afterInvalidation = await assemble('page');
				return { rendered, reassembled, afterInvalidation, expiries: rows };
			});
			console.log(`[render-census-dpc] ${JSON.stringify(reading)}`);

			// leaving the bin warm is a HIT, which is the whole saving
			expect(reading.reassembled.dynamicCache).toBe('HIT');
			expect(reading.rendered.dynamicCache).toBe('MISS');
			// and it costs strictly less on both columns; rows written is the one that binds
			expect(reading.reassembled.rowsWritten).toBeLessThan(reading.rendered.rowsWritten);
			expect(reading.reassembled.hostStatements).toBeLessThan(
				reading.rendered.hostStatements
			);
			// THE CORRECTNESS HALF. A tag invalidation must reach an entry the fill no longer
			// deletes, or "do not empty the bin" trades rows for a page that cannot be refreshed
			expect(reading.afterInvalidation.dynamicCache).toBe('MISS');
		},
		REQUEST_TIMEOUT
	);
});
