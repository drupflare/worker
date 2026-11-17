/** the CMSs the shared tables know; `scripts/cms.ts` `CMS_VALUES` is the build-side list */
export type Cms = 'drupal' | 'wordpress' | 'joomla';

/** the CMS an environment selects: the `CMS` var, or Drupal when it is absent or empty */
export function cmsOf(env: unknown): string {
	const value = (env as { CMS?: unknown } | undefined)?.CMS;
	return typeof value === 'string' && value !== '' ? value : 'drupal';
}
