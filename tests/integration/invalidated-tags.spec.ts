import { describe, expect, it } from 'vitest';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * The whole invocation's invalidated tags, not the first one.
 *
 * The generation bump is coalesced: a save writes many `cachetags` rows, any one of them proves
 * content changed, and bumping fifty times means the same thing as bumping once. The TAG SET is not
 * like that. Collecting only the tag that happened to trigger the bump is what made a tag-scoped
 * plan purge fail open, because a node save writes `node:3:revisions` before it writes `node_list`
 * and a stale plan depended on the second.
 */

const TIMEOUT = 900_000;

/**
 * The shape `Connection::merge('cachetags')` emits, with the tag BOUND rather than inlined.
 *
 * Binding is what makes the tag reachable at all: it arrives in `execSql(sql, params)`, which is the
 * same call site that already tests the statement for a cachetags write. The conflict clause is why
 * invalidating one tag twice is a real sequence rather than a constraint violation.
 */
function invalidate(site: ServeDo, tag: string): void {
	site.execSql(
		`INSERT INTO "cachetags" ("invalidations", "tag") VALUES (?, ?)
		 ON CONFLICT(tag) DO UPDATE SET invalidations = invalidations + 1`,
		[1, tag]
	);
}

describe('every tag an invocation invalidates is collected', () => {
	it(
		'keeps all of them, not only the one that triggered the bump',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				markProvisioned(site);
				site.ensureServeTables();
				site.sql.exec(
					'CREATE TABLE IF NOT EXISTS cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)'
				);
				invalidate(site, 'node:3:revisions');
				invalidate(site, 'node_list');
				invalidate(site, 'config:system.site');
				return site.flushTagPurge();
			});

			// the first is what the bump saw; the second is what a plan for `/` actually depends on
			expect(out).toContain('node:3:revisions');
			expect(out).toContain('node_list');
			expect(out).toContain('config:system.site');
		},
		TIMEOUT
	);

	it(
		'still bumps the generation once',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				markProvisioned(site);
				site.ensureServeTables();
				site.sql.exec(
					'CREATE TABLE IF NOT EXISTS cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)'
				);
				const before = site.generation();
				for (const tag of ['a', 'b', 'c', 'd']) invalidate(site, tag);
				return { before, after: site.generation(), tags: site.flushTagPurge().length };
			});

			// four invalidations, four tags collected, one bump: the coalescing is the part that was
			// right and it is kept
			expect(out.tags).toBe(4);
			expect(out.after).toBe(out.before + 1);
		},
		TIMEOUT
	);

	it(
		'deduplicates, because a save writes the same tag more than once',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				markProvisioned(site);
				site.ensureServeTables();
				site.sql.exec(
					'CREATE TABLE IF NOT EXISTS cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)'
				);
				invalidate(site, 'node_list');
				invalidate(site, 'node_list');
				return site.flushTagPurge();
			});
			expect(out).toEqual(['node_list']);
		},
		TIMEOUT
	);

	it(
		'survives being observed from a later request',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				site.ensureServeTables();
				site.sql.exec(
					'CREATE TABLE IF NOT EXISTS cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)'
				);
				invalidate(site, 'node_list');
				// the invocation that did the invalidating ends here
				const first = site.flushTagPurge();
				site.lastInvalidatedTags = first.length > 0 ? first : site.lastInvalidatedTags;
				// a LATER request looks at it, and its own flush returns nothing
				const second = site.flushTagPurge();
				site.lastInvalidatedTags = second.length > 0 ? second : site.lastInvalidatedTags;
				return site.lastInvalidatedTags;
			});

			// an unconditional assignment made the reader the thing that erased it, so the field
			// could never be observed across invocations and an unfired probe read as "nothing was
			// invalidated"
			expect(out).toEqual(['node_list']);
		},
		TIMEOUT
	);

	it(
		'empties on read, so one invocation cannot inherit the last one',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				markProvisioned(site);
				site.ensureServeTables();
				site.sql.exec(
					'CREATE TABLE IF NOT EXISTS cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)'
				);
				invalidate(site, 'node_list');
				return { first: site.flushTagPurge(), second: site.flushTagPurge() };
			});

			// a leaked set would purge a plan on an invalidation that belonged to another request
			expect(out.first).toEqual(['node_list']);
			expect(out.second).toEqual([]);
		},
		TIMEOUT
	);
});
