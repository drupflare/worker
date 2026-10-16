/**
 * Whether the packed container row can be left alone, decided from what the database RECORDS.
 *
 * The check used to compare `PACKED_CONTAINER_DIGEST` with `DRIVER_DIGEST`, and the bake writes the
 * first from the second. Both are constants in the tree, so a database put back to an older bake
 * (a restore from a backup, a checkout of the tracked file) read as current while its
 * `cfw_packed_container` row still carried the older driver. The specs that boot from the pack then
 * failed on a digest mismatch with nothing naming the stale row. Measured 2026-10-16: the constant
 * said f0c14ac6a3daa87d, the row said e73dca6077b26dd8, and the bake answered "already keyed".
 * @module
 */

/**
 * Whether a cid came from the RUNTIME rather than from a native bake.
 *
 * THE HASH ALONE IS NOT ENOUGH, and checking only the hash shipped a broken row. `install-site-db.php`
 * bakes on the build machine, so the database it produces already carries a `cache_container` row
 * with the right `VERSIONS_HASH` and the wrong everything else -- `Darwin` and an absolute
 * `sites/build/services.yml`. The early exit read the hash, matched, and left it in place.
 *
 * `getContainerCacheKey()` folds the OS and the services.yml paths in beside the hash, so both are
 * readable from the cid and neither needs the row opened.
 */
export function runtimeShaped(cid: string): boolean {
	return cid.includes(':Linux:') && cid.includes('/drupal/sites/default/services.yml');
}

export interface BakeState {
	/** the cid of the `cache_container` row, or null when there is none */
	cid: string | null;
	/** the versions hash the pack carries */
	wanted: string;
	/** `PACKED_CONTAINER_DIGEST` */
	constant: string;
	/** `DRIVER_DIGEST` */
	driver: string;
	/** the `driver` column of every `cfw_packed_container` row; empty when the table has none */
	recorded: readonly string[];
}

/**
 * True when the row is keyed to the pack, came from the runtime, and every driver the database
 * records equals the shipping one. An empty `recorded` falls back to the constants, because a pack
 * with no extra variants writes no rows to read.
 */
export function bakeIsCurrent(state: BakeState): boolean {
	if (state.cid === null || !runtimeShaped(state.cid) || !state.cid.includes(state.wanted)) {
		return false;
	}
	if (state.constant !== state.driver) return false;
	return state.recorded.every((driver) => driver === state.driver);
}
