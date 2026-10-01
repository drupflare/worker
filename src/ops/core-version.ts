/**
 * Invalidates the cache rows that embed the Drupal core version, when that version changes.
 *
 * `library_info:<theme>` (`cache_discovery`) and `fonts:<theme>:<hash>` (`cache_data`) carry the
 * version as the `?v=` buster on every asset URL and are permanent, so an upgraded site would serve
 * new JavaScript at a URL advertising the old version. They are deleted (Drupal rebuilds the
 * serialized value), not shipped empty, which would cost every site 89 KB of discovery on first
 * render.
 * @module
 */

/**
 * The cache rows that embed the core version, matched by cid prefix (cids carry a theme name and a
 * hash). The render and page bins are already invalidated by the generation bump.
 */
export const VERSION_PINNED_CACHES: readonly { table: string; prefix: string }[] = [
	{ table: 'cache_discovery', prefix: 'library_info' },
	{ table: 'cache_data', prefix: 'fonts:' }
];

/** the `cfw_meta` key holding the core version this database was built for */
export const CORE_VERSION_KEY = 'core_version';

/** the slice of the Durable Object SQL handle this module uses */
export type SqlLike = {
	exec(text: string, ...bindings: unknown[]): { toArray(): unknown[] };
};

/**
 * Whether the stored version differs from the one now shipping.
 *
 * A missing stored version is not an upgrade (older databases have no key); the first read
 * records the shipped version and invalidates nothing.
 */
export function needsInvalidation(stored: string | null, shipped: string): boolean {
	if (stored === null || stored === '') return false;
	return stored !== shipped;
}

/** what an invalidation pass did */
export type InvalidationResult = {
	/** rows deleted, per table */
	deleted: number;
	/** what the stored version was, for the log line */
	from: string | null;
	to: string;
};

/**
 * Deletes the version-pinned rows and records the new version (the unchanged path costs one meta
 * read).
 */
export function invalidateVersionPinnedCaches(
	sql: SqlLike,
	stored: string | null,
	shipped: string,
	setVersion: (version: string) => void
): InvalidationResult {
	if (!needsInvalidation(stored, shipped)) {
		// record it so the next upgrade has a baseline
		if (stored !== shipped) setVersion(shipped);
		return { deleted: 0, from: stored, to: shipped };
	}

	let deleted = 0;
	for (const { table, prefix } of VERSION_PINNED_CACHES) {
		try {
			// the `LIKE` pattern stays under the 50-byte platform ceiling
			const rows = sql
				.exec(`SELECT cid FROM ${table} WHERE cid LIKE ?`, `${prefix}%`)
				.toArray();
			if (rows.length === 0) continue;
			sql.exec(`DELETE FROM ${table} WHERE cid LIKE ?`, `${prefix}%`);
			deleted += rows.length;
		} catch {
			// a bin Drupal has not created yet is not an error
		}
	}
	setVersion(shipped);
	return { deleted, from: stored, to: shipped };
}
