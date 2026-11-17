import { isMissingTable } from '../util/errors';
import { firstRow } from '../util/sql';
import type { PurgeHost } from './host';
import type { Row } from './types';

/**
 * Deletes the plans that depend on any of `tags`, or every plan when none are known.
 *
 * `LIKE` rather than a join table: a page bubbles 10-40 tags and a row each would spend the
 * meter that binds regeneration, so the tags live in one JSON column on the plan row.
 */
export function purgePlansFor(host: PurgeHost, tags?: string[]): number {
	const before = Number(
		firstRow(host.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_plan'))?.c ?? 0
	);
	if (!tags || tags.length === 0) {
		host.sql.exec('DELETE FROM cfw_plan');
		return before;
	}
	for (const tag of tags) {
		// the pattern stays inside the 50-byte `LIKE` limit (`cacheTagsIn` caps the name at 40)
		host.sql.exec('DELETE FROM cfw_plan WHERE tags LIKE ?', `%"${tag}"%`);
	}
	const after = Number(
		firstRow(host.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_plan'))?.c ?? 0
	);
	return before - after;
}

/**
 * Flags every plan the moment content changes, before the tag set is known.
 *
 * One wholesale `UPDATE` at the write, so an invocation that dies before
 * {@link settlePlans} leaves everything flagged. Not coalesced on `bumpCoalesced`, which only
 * `fillOne()` clears (a node save left plans in place on a site serving plans).
 */
export function stalePlans(host: PurgeHost): void {
	if (host.purge.plansStaled) return;
	host.purge.plansStaled = true;
	// runs inside `execSql()`, so a missing table would fail the triggering write
	host.ensureServeTables();
	host.sql.exec('UPDATE cfw_plan SET stale = 1 WHERE stale = 0');
}

/**
 * Deletes the plans this invocation's tags invalidate and un-flags the rest; runs at the end,
 * when the tag set is complete.
 */
export function settlePlans(
	host: PurgeHost,
	tags: readonly string[]
): { purged: number; cleared: boolean } {
	if (!host.purge.plansStaled) return { purged: 0, cleared: false };
	host.purge.plansStaled = false;
	host.ensureServeTables();
	// no tags with a stale flag set means the write that flagged them named nothing usable, so
	// the conservative reading stands and every plan goes
	const purged = purgePlansFor(host, tags.length === 0 ? undefined : [...tags]);
	host.sql.exec('UPDATE cfw_plan SET stale = 0 WHERE stale = 1');
	return { purged, cleared: true };
}

/**
 * Empties Drupal's dynamic page cache, tolerating a site that has never created the table.
 *
 * @returns rows removed, or -1 when the bin does not exist yet.
 */
export function purgeDynamicPageCache(host: PurgeHost): number {
	try {
		const before = Number(
			firstRow(
				host.sql.exec<Row<{ c: number }>>(
					'SELECT COUNT(*) AS c FROM cache_dynamic_page_cache'
				)
			)?.c ?? 0
		);
		host.sql.exec('DELETE FROM cache_dynamic_page_cache');
		return before;
	} catch (e) {
		if (!isMissingTable(e)) host.noteError('purgeDynamicPageCache', e);
		return -1;
	}
}

/**
 * Drops the derived caches a lane holds once the primary's log has moved it past a generation.
 *
 * Only the primary runs `bumpGeneration()`; replayed SQL leaves a lane's path-keyed `cfw_page`
 * stale. Wholesale, since the log carries statements, not tags.
 *
 * @returns what each store gave up, for the pull loop to report
 */
export function purgeAfterApply(host: PurgeHost): {
	pages: number;
	shells: number;
	plans: number;
	dynamic: number;
} {
	const count = (table: string): number =>
		Number(
			firstRow(host.sql.exec<Row<{ c: number }>>(`SELECT COUNT(*) AS c FROM ${table}`))?.c ??
				0
		);
	const pages = count('cfw_page');
	if (pages > 0) host.sql.exec('DELETE FROM cfw_page');
	const shells = count('cfw_shell');
	if (shells > 0) {
		host.sql.exec('DELETE FROM cfw_shell');
		host.sql.exec('DELETE FROM cfw_shell_verified');
	}
	const plans = purgePlansFor(host);
	const dynamic = purgeDynamicPageCache(host);
	return { pages, shells, plans, dynamic };
}
