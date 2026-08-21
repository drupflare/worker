/**
 * Invalidates the cache rows that embed the Drupal core version, when that version changes.
 *
 * Two rows in the shipped database hard-code the core version as the `?v=` cache-buster on every
 * asset URL, and both are permanent (`expire = -1`), so nothing evicts them:
 *
 * | table             | cid                    | version occurrences |
 * | ----------------- | ---------------------- | ------------------- |
 * | `cache_discovery` | `library_info:<theme>` | 298                 |
 * | `cache_data`      | `fonts:<theme>:<hash>` | 4                   |
 *
 * Measured 2026-08-21 while rehearsing an 11.4.4 -> 11.4.5 upgrade. `core/misc/ajax.js` and
 * `core/misc/details.js` both changed in that diff, so an upgraded site serves new JavaScript at a
 * URL still advertising the old version -- and a browser holding the old copy has no reason to
 * refetch.
 *
 * ## Why this is not solved by shipping the rows empty
 *
 * Deleting them from the pack would make EVERY site rebuild 89 KB of library discovery on its first
 * render: a permanent cost on every deployment, to fix something that only occurs on an upgrade.
 * Comparing versions costs one `cfw_meta` read once per object lifetime and pays the rebuild
 * exactly when it is needed.
 *
 * ## Why the row is deleted rather than rewritten
 *
 * The stored value is a serialized PHP structure with the version threaded through hundreds of
 * asset paths. Rewriting it means parsing and re-emitting Drupal's own serialization from
 * JavaScript, which would be a second implementation of a format only Drupal owns. A delete makes
 * Drupal rebuild it correctly on the next request, which is what its cache API is for.
 */

/**
 * The cache rows whose contents embed the core version.
 *
 * Matched by PREFIX rather than by exact cid, because both carry a theme name and the fonts row
 * carries a content hash as well -- a site on a different theme has the same problem under a
 * different key. `cache_discovery` and `cache_data` are the only two bins involved; the render and
 * page bins are already invalidated by the generation bump.
 */
export const VERSION_PINNED_CACHES: readonly { table: string; prefix: string }[] = [
	{ table: 'cache_discovery', prefix: 'library_info' },
	{ table: 'cache_data', prefix: 'fonts:' }
];

/** the `cfw_meta` key holding the core version this database was built for */
export const CORE_VERSION_KEY = 'core_version';

export type SqlLike = {
	exec(text: string, ...bindings: unknown[]): { toArray(): unknown[] };
};

/**
 * Whether the stored version differs from the one now shipping.
 *
 * A MISSING stored version is NOT an upgrade. Every database built before this existed has no key,
 * and treating that as a change would make every site on earth rebuild its library cache once on
 * the deploy that introduced this. The first read records the shipped version and invalidates
 * nothing.
 */
export function needsInvalidation(stored: string | null, shipped: string): boolean {
	if (stored === null || stored === '') return false;
	return stored !== shipped;
}

export type InvalidationResult = {
	/** rows deleted, per table */
	deleted: number;
	/** what the stored version was, for the log line */
	from: string | null;
	to: string;
};

/**
 * Deletes the version-pinned rows and records the new version.
 *
 * Returns 0 deletions when nothing changed, which is the normal path and costs one meta read.
 */
export function invalidateVersionPinnedCaches(
	sql: SqlLike,
	stored: string | null,
	shipped: string,
	setVersion: (version: string) => void
): InvalidationResult {
	if (!needsInvalidation(stored, shipped)) {
		// still record it, so the NEXT upgrade has a baseline to compare against
		if (stored !== shipped) setVersion(shipped);
		return { deleted: 0, from: stored, to: shipped };
	}

	let deleted = 0;
	for (const { table, prefix } of VERSION_PINNED_CACHES) {
		try {
			// a LIKE pattern here is 12 bytes, well inside the 50-byte platform ceiling
			const rows = sql
				.exec(`SELECT cid FROM ${table} WHERE cid LIKE ?`, `${prefix}%`)
				.toArray();
			if (rows.length === 0) continue;
			sql.exec(`DELETE FROM ${table} WHERE cid LIKE ?`, `${prefix}%`);
			deleted += rows.length;
		} catch {
			// a bin that does not exist on this site is not an error: the cache tables are created
			// by Drupal on first use, and a site that never rendered has none of them
		}
	}
	setVersion(shipped);
	return { deleted, from: stored, to: shipped };
}
