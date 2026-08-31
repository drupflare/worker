import { describe, expect, it } from 'vitest';
import { inObject, markProvisioned, provisionedSite, seedPage } from '../helpers/serve-do';

/**
 * What counting a page view costs.
 *
 * The storage lane exists to answer without writing -- that is the whole reason a cached page is
 * cheaper than a render. It nonetheless ran an unconditional `INSERT ... ON CONFLICT DO UPDATE` on
 * `serve_requests` for every request it answered, on both serving lanes, outside the
 * `shouldFlushMeters()` gate the daily meters go through. Against free's 10,869 rows/day windowed
 * budget that bound serving at ~10,869 views/day rather than the 100,000 Worker requests/day the
 * tier is sized for.
 *
 * The comment two lines below the write said why `pageHits` is kept in memory and never a row. The
 * counter next to it was doing the thing that comment forbids.
 */

const TIMEOUT = 900_000;
const VIEWS = 20;

describe('serving a cached page does not buy a row per view', () => {
	it(
		'charges far fewer rows than it answers requests',
		async () => {
			const stub = await provisionedSite();
			const out = await inObject(stub, async (site) => {
				markProvisioned(site);
				seedPage(site, '/counted', '<html><body>counted</body></html>');
				// flushed first, so the baseline is not carrying the seed's own writes
				site.flushServeRequests();
				const before = site.dailyRows();
				for (let i = 0; i < VIEWS; i++) {
					const res = await site.fetch(
						new Request('https://do.local/__serve?path=/counted')
					);
					expect(res.status).toBe(200);
				}
				return {
					rows: site.dailyRows() - before,
					counted: site.serveRequests(),
					durable: Number(site.metaGet('serve_requests', '0'))
				};
			});

			// every view is still counted
			expect(out.counted).toBeGreaterThanOrEqual(VIEWS);
			// and NOT one row each. 20 views under the 50-view flush threshold pay for nothing yet
			expect(out.rows).toBeLessThan(VIEWS);
			expect(out.durable).toBe(0);
		},
		TIMEOUT
	);

	it(
		'folds the pending count into the durable total rather than losing it',
		async () => {
			const stub = await provisionedSite();
			const out = await inObject(stub, async (site) => {
				markProvisioned(site);
				seedPage(site, '/folded', '<html><body>folded</body></html>');
				site.flushServeRequests();
				for (let i = 0; i < 5; i++) {
					await site.fetch(new Request('https://do.local/__serve?path=/folded'));
				}
				const pendingBefore = site.serveRequests();
				const wrote = site.flushServeRequests();
				return {
					pendingBefore,
					wrote,
					durable: Number(site.metaGet('serve_requests', '0')),
					reported: site.serveRequests()
				};
			});

			expect(out.wrote).toBe(5);
			expect(out.durable).toBe(5);
			// the reported figure is the same across the flush; a caller cannot see the accumulator
			expect(out.reported).toBe(out.pendingBefore);
		},
		TIMEOUT
	);

	it(
		'writes nothing when nothing was served',
		async () => {
			const stub = await provisionedSite();
			const wrote = await inObject(stub, (site) => {
				site.flushServeRequests();
				return site.flushServeRequests();
			});
			// an idle flush that charged a row would be the counter-counts-itself shape again
			expect(wrote).toBe(0);
		},
		TIMEOUT
	);
});
