import { describe, expect, it } from 'vitest';
import { emptyTally } from '../../src/db/write-tally';
import { inObject, markProvisioned, provisionedSite, type ServeDo } from '../helpers/serve-do';

/**
 * One read spent to avoid one charged row, and why the trade is not close.
 *
 * The free plan allows 5,000,000 rows READ a day against 100,000 written, so a read is 1/50th of a
 * write, and rows written is the meter that binds regeneration. A statement that
 * stores the value a column already holds is charged in full.
 *
 * Two callers were already doing this by hand -- `noteStorable()` compares against the held list,
 * `clearPendingTags()` checks before clearing -- which says the shape is common and says nothing
 * about how common. The counter is what answers that on a real workload.
 */

const REQUEST_TIMEOUT = 300_000;

describe('a write that would not change the row', () => {
	it(
		'is not made, and is counted instead',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				site.ensureServeTables();

				site.writeTally = emptyTally();
				site.metaSet('conditional_probe', 'first');
				const firstWrite = site.writeTally?.rowsWritten ?? -1;

				const before = site.elidedWrites ?? 0;
				site.writeTally = emptyTally();
				for (let i = 0; i < 5; i++) site.metaSet('conditional_probe', 'first');
				const repeats = site.writeTally?.rowsWritten ?? -1;
				const elided = (site.elidedWrites ?? 0) - before;

				site.writeTally = emptyTally();
				site.metaSet('conditional_probe', 'second');
				const changed = site.writeTally?.rowsWritten ?? -1;
				site.writeTally = undefined;

				return {
					firstWrite,
					repeats,
					elided,
					changed,
					value: site.metaGet('conditional_probe'),
					reported: Number(
						(
							site as unknown as { serveStatsSync(): Record<string, unknown> }
						).serveStatsSync()['elidedWrites'] ?? -1
					)
				};
			});

			// THE CONTROL: the first write is charged, so what follows is an elision rather than a
			// meter that stopped counting
			expect(seen.firstWrite).toBe(1);
			expect(seen.repeats).toBe(0);
			expect(seen.elided).toBe(5);
			// a real change is still written, which is the half that makes the elision safe
			expect(seen.changed).toBe(1);
			expect(seen.value).toBe('second');
			// and the saving is observable rather than asserted
			expect(seen.reported).toBeGreaterThanOrEqual(5);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * REFUTED FOR `cfw_page`, and the reason is the row's own freshness column.
	 *
	 * A stored page carries `rendered_at`, which the AGED tier reads to decide whether to re-queue
	 * it. Eliding an upsert whose HTML is byte-identical would leave that timestamp at the original
	 * render, so the page would age out again immediately and the object would re-render it on
	 * every alarm -- one row saved per render against an unbounded number of renders. The mechanism
	 * is closed for any row whose timestamp is what the row is for; the objective, spending fewer
	 * rows on regeneration that changes nothing, is not.
	 */
	it(
		'still writes a page whose body did not change, because the clock did',
		async () => {
			const seen = await inObject(await provisionedSite(), async (site: ServeDo) => {
				markProvisioned(site);
				site.ensureServeTables();
				const at = site.nowMs();
				site.sql.exec(
					`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)
           VALUES ('/same', 200, 'text/html', '<p>same</p>', ?, 1)
           ON CONFLICT(path) DO UPDATE SET rendered_at = excluded.rendered_at`,
					at - 60_000
				);
				const stale = Number(
					site.sql
						.exec('SELECT rendered_at FROM cfw_page WHERE path = ?', '/same')
						.toArray()[0]?.['rendered_at'] ?? 0
				);
				site.sql.exec(
					`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms)
           VALUES ('/same', 200, 'text/html', '<p>same</p>', ?, 1)
           ON CONFLICT(path) DO UPDATE SET
             html = excluded.html,
             rendered_at = excluded.rendered_at`,
					at
				);
				const fresh = Number(
					site.sql
						.exec('SELECT rendered_at FROM cfw_page WHERE path = ?', '/same')
						.toArray()[0]?.['rendered_at'] ?? 0
				);
				return { stale, fresh };
			});

			// identical bytes, a moved clock: the row genuinely changed, so there was no write to save
			expect(seen.fresh).toBeGreaterThan(seen.stale);
		},
		REQUEST_TIMEOUT
	);
});
