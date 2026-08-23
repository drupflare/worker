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
 * WHICH statements a warm render sends, not how many of them there are.
 *
 * P36's surviving half. `crossings.spec.ts` counted a warm render at 48 crossings, all `cfwSqlExec`,
 * and closed the BATCHING mechanism -- correctly, because Drupal's read path is read-decide-read.
 * RULE 0c: that closes a mechanism and not the resource, and the resource is the 48 statements. This
 * file decomposes them, so the next person arguing about render SQL argues from a list.
 *
 * TWO ARMS, and the second is the one that reframes the question. The 48 is the FIRST render of a
 * path on an object whose interpreter is already warm -- so it pays every per-path cache bin as a
 * miss. A REPEAT render of the same path is what the regeneration ceiling is actually about
 * (RULE 0b: a fill is a re-render of a page that already existed), and it is a different measurement.
 * Reporting only the first would price regeneration at the warm-up.
 *
 * MEASURED 2026-08-23, one object, `/` filled first to boot, then `/user/login` twice. n=2 whole
 * runs: every COUNT below reproduced exactly, and the byte totals moved by 2 (the payload carries
 * `created` timestamps), so the counts are stated flat and the bytes as approximate.
 *
 * | reading                      | first render | repeat render |
 * | ---------------------------- | -----------: | ------------: |
 * | crossings = statements       |       **48** |        **18** |
 * | distinct fingerprints        |           23 |            10 |
 * | duplicate                    |           25 |             8 |
 * | cache-miss                   |            4 |             2 |
 * | repeated-table               |            4 |             0 |
 * | necessary                    |           15 |             8 |
 * | rows read                    |           53 |            33 |
 * | rows written (charged)       |           46 |             8 |
 * | bytes returned to PHP        |      240,036 |       128,773 |
 *
 * The largest single item in a repeat render is not a statement count: **one** `cache_discovery`
 * read returns 97,749 bytes, 75.9% of everything the bridge carries.
 *
 * WHAT IS DELIBERATELY NOT HERE: milliseconds, and the same reason `workload-matrix.spec.ts` gives.
 * RULE 0 -- an absolute CPU figure comes only from `cpuTime` on a deployed worker, and every
 * in-isolate clock is frozen out there. Every column above is a COUNT or a BYTE COUNT, and both are
 * the same number locally and on the edge.
 *
 * Each case asserts a SHAPE -- a partition that sums, a ratio with a bound -- rather than the values
 * above, which move with the pack. The table is the record a later run compares against.
 */

type Reading = { crossings: number; log: CensusCall[]; census: Census };

const REQUEST_TIMEOUT = 900_000;

/**
 * One object, boot-filled once, then the same path rendered twice.
 *
 * `freshSite()` and `/__migrate`, NOT `provisionedSite()`: the latter stamps the migration cursor
 * `done` without replaying anything, so the render aborts with "the site is not installed yet" and
 * the census is of a render that never happened.
 *
 * `/__fill` rather than `/__serve`, and the difference is the measurement: an anonymous GET on a cold
 * object refuses to boot inline, so `/__serve` would return a MISS having never entered PHP.
 */
async function warmRender(path = '/user/login'): Promise<{ first: Reading; repeat: Reading }> {
	const raw = await inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		queuePath(site, '/', { arm: false });
		await site.fetch(new Request('https://do.local/__fill'));
		const tally = site.crossings;
		if (!tally) throw new Error('no crossing tally: the interpreter never booted');
		// armed AFTER the boot fill, so the kernel build is not charged to the census
		const one = async () => {
			const before = tally.total;
			tally.calls = [];
			queuePath(site, path, { arm: false });
			await site.fetch(new Request('https://do.local/__fill'));
			const log = tally.calls ?? [];
			// disarmed between arms, so nothing between the two renders lands in either log
			tally.calls = undefined;
			return { crossings: tally.total - before, log };
		};
		return { first: await one(), repeat: await one() };
	});
	return {
		first: { ...raw.first, census: census(raw.first.log) },
		repeat: { ...raw.repeat, census: census(raw.repeat.log) }
	};
}

const sumCategories = (c: Census) =>
	CENSUS_CATEGORIES.reduce((n, key: CensusCategory) => n + c.byCategory[key], 0);

/** the heaviest single fingerprint by what it sent back across the bridge */
const widest = (c: Census) => [...c.rows].sort((a, b) => b.resultBytes - a.resultBytes)[0] ?? null;

describe('the statement census of one warm render', () => {
	it(
		'decomposes every crossing, with nothing unparsed and nothing double-counted',
		async () => {
			const { first, repeat } = await warmRender();
			for (const arm of [first, repeat]) {
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
				expect(arm.census.statements).toBeGreaterThan(10);
			}
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
		"prices the fill's OWN dynamic_page_cache empty, which is a host decision rather than Drupal",
		async () => {
			const { repeat } = await warmRender();
			const dpc = repeat.census.byTable['cache_dynamic_page_cache'];
			// `fillOne()` empties `page` and `dynamic_page_cache`, so the DELETE, the MISS it
			// guarantees and the re-population are all the fill's own doing. Measured 4 of 18
			// statements and 6 of 8 charged rows -- which makes it the largest single lever on the
			// meter that binds regeneration, and it is owned HERE rather than by Drupal.
			//
			// NOT scored as a free win: `/__assemble` already fills with `bins=['page']`, and what
			// that trades away is whether a regenerated page may carry a stale dynamic fragment.
			// The census supplies the count; the trade is a product decision
			expect(dpc).toBeDefined();
			expect(dpc!.statements).toBeGreaterThan(0);
			expect(dpc!.rowsWritten / repeat.census.totals.rowsWritten).toBeGreaterThan(0.5);
		},
		REQUEST_TIMEOUT
	);
});
