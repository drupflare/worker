/**
 * The CMS a build packs, selected by the `CMS` var in `wrangler.jsonc`.
 *
 * One value today. The selection exists so the packer is keyed on it before a second CMS is, and an
 * unknown value fails the build rather than packing Drupal under another name.
 */
export const CMS_VALUES = ['drupal'] as const;

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
