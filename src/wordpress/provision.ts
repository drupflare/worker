import type { SitePhpDurableObject } from '../site-do';

/** the `cfw_meta` key holding the origin the options rows were last set to */
export const ORIGIN_KEY = 'wp_origin';

/** the `cfw_meta` key holding the digest of the drop-in pack this site last booted with */
export const DIGEST_KEY = 'wp_driver_digest';

/** the rows that hold the site's own address, which the pack bakes with a placeholder */
export const ORIGIN_OPTIONS = ['siteurl', 'home'] as const;

/**
 * Points `siteurl` and `home` at the site's origin, once per origin.
 *
 * The pack's rows name a placeholder. `WP_HOME` and `WP_SITEURL` already win at read time, so this
 * keeps the rows true for anything that reads them raw (an export, the admin screens). Both are
 * plain strings, so no serialization is involved. Other rows that embed the origin (post GUIDs, the
 * privacy page text, the administrator's `user_url`) are left as baked.
 *
 * @returns whether rows were written
 */
export function setOriginOptions(
	site: SitePhpDurableObject,
	origin: string,
	prefix = 'wp_'
): boolean {
	if (site.metaGet(ORIGIN_KEY) === origin) return false;
	site.sql.exec(
		`UPDATE ${prefix}options SET option_value = ? WHERE option_name IN (${ORIGIN_OPTIONS.map(() => '?').join(', ')})`,
		origin,
		...ORIGIN_OPTIONS
	);
	site.metaSet(ORIGIN_KEY, origin);
	return true;
}
