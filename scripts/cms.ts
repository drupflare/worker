/**
 * The CMS a build packs, selected by the `CMS` var in `wrangler.jsonc`.
 *
 * A name is accepted before its module set exists; the packer refuses one with no module set, so a
 * build never packs Drupal under another name. An unknown value fails the build the same way.
 */
export const CMS_VALUES = ['drupal', 'wordpress', 'joomla'] as const;

export type Cms = (typeof CMS_VALUES)[number];

/** refuses anything this build cannot pack, including a missing value */
export function cmsSelection(raw: unknown): Cms {
	if (typeof raw === 'string' && (CMS_VALUES as readonly string[]).includes(raw)) {
		return raw as Cms;
	}
	throw new Error(
		`CMS=${JSON.stringify(raw ?? null)} is not a CMS this build can pack; set "CMS" in ` +
			`wrangler.jsonc vars to one of: ${CMS_VALUES.join(', ')}`
	);
}
