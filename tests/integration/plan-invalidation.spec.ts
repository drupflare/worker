import { describe, expect, it } from 'vitest';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * Tag-scoped plan invalidation, and the flag that makes incomplete information safe.
 *
 * The tag set is only complete at the END of an invocation and a plan must not be served in the
 * meantime, so the two halves run at different times: a wholesale flag at the write, a scoped delete
 * at the flush. An invocation that dies in between leaves everything flagged, which is the direction
 * that has to fail.
 */

const TIMEOUT = 900_000;

function invalidate(site: ServeDo, tag: string): void {
	site.execSql(
		`INSERT INTO "cachetags" ("invalidations", "tag") VALUES (?, ?)
		 ON CONFLICT(tag) DO UPDATE SET invalidations = invalidations + 1`,
		[1, tag]
	);
}

function seedPlan(site: ServeDo, path: string, tags: string[]): void {
	site.sql.exec(
		`INSERT INTO cfw_plan (path, plan, uid, tags, stale, compiled_at) VALUES (?, ?, 0, ?, 0, ?)
		 ON CONFLICT(path) DO UPDATE SET tags = excluded.tags, stale = 0`,
		path,
		JSON.stringify({ path, ops: [['t', 'x']], slots: {}, sample: {}, sampleB: {} }),
		JSON.stringify(tags),
		Date.now()
	);
}

const paths = (site: ServeDo): string[] =>
	site.sql
		.exec('SELECT path FROM cfw_plan ORDER BY path')
		.toArray()
		.map((r) => String(r.path));

const staleCount = (site: ServeDo): number =>
	Number(
		site.sql.exec('SELECT COUNT(*) AS c FROM cfw_plan WHERE stale = 1').toArray()[0]?.c ?? 0
	);

function ready(site: ServeDo): void {
	markProvisioned(site);
	site.ensureServeTables();
	site.sql.exec(
		'CREATE TABLE IF NOT EXISTS cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)'
	);
}

describe('a compiled plan dies by its own tags and not by another plan tags', () => {
	it(
		'keeps the plan a save does not touch and deletes the one it does',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				ready(site);
				seedPlan(site, '/admin/config/system/site-information', [
					'config:system.site',
					'rendered'
				]);
				seedPlan(site, '/admin/content', ['node_list', 'rendered']);
				invalidate(site, 'node:1:revisions');
				invalidate(site, 'node_list');
				const flaggedDuring = staleCount(site);
				const settled = site.settlePlans(site.flushTagPurge());
				return { flaggedDuring, settled, left: paths(site), stillStale: staleCount(site) };
			});

			// both were flagged at the write, when the tag set could not decide anything
			expect(out.flaggedDuring).toBe(2);
			expect(out.left).toEqual(['/admin/config/system/site-information']);
			expect(out.settled.purged).toBe(1);
			expect(out.stillStale).toBe(0);
		},
		TIMEOUT
	);

	it(
		'refuses to serve a plan flagged but not yet settled',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				ready(site);
				seedPlan(site, '/plan-stale', ['config:system.site']);
				invalidate(site, 'node_list');
				// the invocation dies here: no settle, so the flag stands
				const res = await site.fetch(
					new Request('https://do.local/__plan?action=run&path=%2Fplan-stale')
				);
				return { status: res.status, body: await res.text() };
			});

			expect(out.status).toBe(409);
			expect(out.body).toContain('stale');
		},
		TIMEOUT
	);

	it(
		'flags a plan compiled after the generation bump has already coalesced',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				ready(site);
				// the first invalidation latches `bumpCoalesced` for the life of the incarnation
				invalidate(site, 'node_list');
				site.settlePlans(site.flushTagPurge());
				seedPlan(site, '/late', ['node_list']);
				const latched = (site as unknown as { bumpCoalesced?: boolean }).bumpCoalesced;
				invalidate(site, 'node_list');
				const flagged = staleCount(site);
				site.settlePlans(site.flushTagPurge());
				return { flagged, latched, left: paths(site) };
			});

			// without this the case passes for the wrong reason: an unlatched flag means the bump
			// itself would have purged the plan and nothing was tested
			expect(out.latched).toBe(true);
			// a plan compiled after the latch used to be invisible to every later save
			expect(out.flagged).toBe(1);
			expect(out.left).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'deletes everything when the invalidation named no usable tag',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				ready(site);
				seedPlan(site, '/a', ['config:system.site']);
				// a `cachetags` write whose parameters carry no tag name; the flag is all there is
				site.execSql('DELETE FROM "cachetags" WHERE 1 = 0', []);
				const flagged = staleCount(site);
				const settled = site.settlePlans(site.flushTagPurge());
				return { flagged, settled, left: paths(site) };
			});

			expect(out.flagged).toBe(1);
			expect(out.left).toEqual([]);
			expect(out.settled.purged).toBe(1);
		},
		TIMEOUT
	);

	it(
		'does nothing on an invocation that invalidated nothing',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				ready(site);
				seedPlan(site, '/quiet', ['node_list']);
				const settled = site.settlePlans(site.flushTagPurge());
				return { settled, left: paths(site) };
			});

			// a settle that fires on every request must not be a purge on every request
			expect(out.settled).toEqual({ purged: 0, cleared: false });
			expect(out.left).toEqual(['/quiet']);
		},
		TIMEOUT
	);
});
