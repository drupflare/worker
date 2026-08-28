import { describe, expect, it } from 'vitest';
import { ROWS_PER_FILL } from '../../scripts/measure/free-envelope';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * What `FILL_BINS` saves, on a site whose page table actually fills.
 *
 * THE FIRST MEASUREMENT WAS TAKEN AGAINST A SITE THAT STORED NOTHING, reporting `bins=page` at ZERO
 * charged rows: `cache.page.max_age` shipped at 0, so every render came back `no-store` and the
 * `cfw_page` upsert -- the largest write in a fill -- was declined. This asserts the store is
 * non-empty before believing either arm. Paired on ONE object and consecutive, since objects differ
 * in marginal render cost by 2.8x.
 */

const REQUEST_TIMEOUT = 240_000;

const call = (site: ServeDo, path: string, init?: RequestInit) =>
	site.fetch(new Request(`https://do.local${path}`, init));

type Arm = { bins: string[]; rows: number; bytes: number; pageRows: number };

async function arm(site: ServeDo, bins: string[], path: string): Promise<Arm> {
	// the page row is deleted so the fill actually renders rather than answering from storage
	site.sql.exec('DELETE FROM cfw_page WHERE path = ?', path);
	site.sql.exec('DELETE FROM cfw_fill_queue');
	site.sql.exec('INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, 0)', path);
	const before = site.dailyRows();
	const bytesBefore = Number(site.sql.databaseSize);
	const outcome = await site.fillOne(path, bins);
	return {
		bins,
		rows: site.dailyRows() - before,
		bytes: Number(site.sql.databaseSize) - bytesBefore,
		pageRows: Number(
			site.sql.exec('SELECT COUNT(*) AS c FROM cfw_page').toArray()[0]?.['c'] ?? 0
		)
	};
}

let cached: Promise<{ narrow: Arm; wide: Arm }> | null = null;

async function measure(): Promise<{ narrow: Arm; wide: Arm }> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await call(site, '/__migrate?all=1&prefill=0');
		// NO `/__firstrun`. It is not needed for an anonymous page fill, and the render it leaves
		// behind sets a cookie -- which `cacheable` refuses, so the page would never be stored and
		// both arms would measure a fill that stored nothing. That is the defect this file exists
		// to avoid repeating
		// warm once, so neither arm pays for the boot or for a cold render cache
		await arm(site, ['page'], '/');
		const narrow = await arm(site, ['page'], '/');
		const wide = await arm(site, ['page', 'dynamic_page_cache'], '/');
		return { narrow, wide };
	});
}

const measured = () => (cached ??= measure());

describe('the bins a fill empties on itself', () => {
	it(
		'stores a page at all, which is the precondition the first measurement lacked',
		async () => {
			const { narrow, wide } = await measured();
			// a zero here means `cacheable` was false and BOTH arms measured a fill that stored
			// nothing -- the exact defect that produced the original figure
			expect(narrow.pageRows).toBeGreaterThan(0);
			expect(wide.pageRows).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'charges fewer rows when dynamic_page_cache is left warm',
		async () => {
			const { narrow, wide } = await measured();
			console.log(
				JSON.stringify(
					{ narrow, wide, ratio: narrow.rows > 0 ? wide.rows / narrow.rows : null },
					null,
					1
				)
			);
			expect(narrow.rows).toBeGreaterThan(0);
			expect(wide.rows).toBeGreaterThan(narrow.rows);
			// 1.4x, and the figure this replaces was 2.37x. That one was taken when the narrow arm
			// charged ZERO rows, which is not reachable on a site that stores anything
			expect(wide.rows / narrow.rows).toBeLessThan(2);
		},
		REQUEST_TIMEOUT
	);

	// the two queue rows are the harness's own -- one DELETE of the row it just queued, one INSERT.
	// The wide arm is NOT `realRender`, which also empties the `render` bin
	it(
		'charges ONE row for the fill itself, at or under the warmReassemble class',
		async () => {
			const { narrow } = await measured();
			const HARNESS_QUEUE_ROWS = 2;
			const fill = narrow.rows - HARNESS_QUEUE_ROWS;
			// this asserted equality with `warmReassemble` and held until the cache bins became
			// WITHOUT ROWID. The two are measured on DIFFERENT PATHS -- that constant is
			// `/user/login`, this is `/` -- and the conversion took a bin row off the front page and
			// not off the login form, so the paths now differ by one and the equality was never the
			// property being tested
			expect(fill).toBe(1);
			expect(fill).toBeLessThanOrEqual(ROWS_PER_FILL.warmReassemble);
		},
		REQUEST_TIMEOUT
	);

	// the shipped list is the narrow one; a change to it should fail here rather than silently cost
	it(
		'is what FILL_BINS ships as',
		async () => {
			const { narrow } = await measured();
			expect(narrow.bins).toEqual(['page']);
		},
		REQUEST_TIMEOUT
	);
});
