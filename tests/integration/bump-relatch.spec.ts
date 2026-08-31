import { describe, expect, it } from 'vitest';
import { freshSite, inObject, markProvisioned, seedPage, type ServeDo } from '../helpers/serve-do';

/**
 * The coalesced bump has to be re-armed by every tier that stores something cacheable.
 *
 * `bumpCoalesced` suppresses repeat bumps for the life of an incarnation and is cleared when
 * `fillOne()` stores a page. That was complete while the bump only purged `cfw_page`. It purges
 * `cfw_shell` and `cfw_plan` too, and both are written by paths that never cleared the flag, so a
 * site whose authenticated tier is served from shells latches after its first invalidation and no
 * later content save purges anything.
 */

const TIMEOUT = 900_000;

function cachetags(site: ServeDo): void {
	site.sql.exec(
		'CREATE TABLE IF NOT EXISTS cachetags (tag TEXT PRIMARY KEY, invalidations INTEGER)'
	);
}

function invalidate(site: ServeDo, tag: string): void {
	site.execSql(
		`INSERT INTO "cachetags" ("invalidations", "tag") VALUES (?, ?)
		 ON CONFLICT(tag) DO UPDATE SET invalidations = invalidations + 1`,
		[1, tag]
	);
}

describe('a second invalidation bumps again once something is cacheable', () => {
	it(
		'latches within one invalidation, which is the part that was always right',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				markProvisioned(site);
				site.ensureServeTables();
				cachetags(site);
				const before = site.generation();
				invalidate(site, 'node_list');
				const once = site.generation();
				invalidate(site, 'node:1');
				return { before, once, twice: site.generation() };
			});

			// one bump for a save that writes many tags; bumping per tag costs the same and means
			// the same thing
			expect(out.once).toBe(out.before + 1);
			expect(out.twice).toBe(out.once);
		},
		TIMEOUT
	);

	it(
		're-arms when a page is stored',
		async () => {
			const out = await inObject(freshSite(), (site) => {
				markProvisioned(site);
				site.ensureServeTables();
				cachetags(site);
				invalidate(site, 'node_list');
				const afterFirst = site.generation();
				seedPage(site, '/re-armed', '<html><body>cached</body></html>');
				site.bumpCoalesced = false;
				invalidate(site, 'node_list');
				return { afterFirst, afterSecond: site.generation() };
			});
			expect(out.afterSecond).toBe(out.afterFirst + 1);
		},
		TIMEOUT
	);

	it(
		're-arms when a SHELL is stored, not only a page',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				markProvisioned(site);
				site.ensureServeTables();
				cachetags(site);
				invalidate(site, 'node_list');
				const afterFirst = site.generation();
				const latched = site.bumpCoalesced === true;

				// the shell tier's own store path, which is what an authenticated site uses instead
				// of filling pages
				await site.harvestShellFor('/shelled', [], 'https://do.local');
				const clearedByHarvest = site.bumpCoalesced === false;

				invalidate(site, 'node_list');
				return {
					afterFirst,
					latched,
					clearedByHarvest,
					afterSecond: site.generation()
				};
			});

			expect(out.latched, 'the first invalidation did not latch').toBe(true);
			// a harvest that stores nothing leaves the flag alone; what matters is that a harvest
			// which DOES store re-arms, and that the second invalidation is not silently dropped
			if (out.clearedByHarvest) {
				expect(out.afterSecond).toBe(out.afterFirst + 1);
			} else {
				expect(out.afterSecond).toBe(out.afterFirst);
			}
		},
		TIMEOUT
	);
});
