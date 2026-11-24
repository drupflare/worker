/** every CMS the build can pack and the shared tables key on */
export const CMS_VALUES = ['drupal', 'wordpress', 'joomla'] as const;

/** one of {@link CMS_VALUES} */
export type Cms = (typeof CMS_VALUES)[number];

/** the CMS an environment selects: the `CMS` var, or Drupal when it is absent or empty */
export function cmsOf(env: unknown): string {
	const value = (env as { CMS?: unknown } | undefined)?.CMS;
	return typeof value === 'string' && value !== '' ? value : 'drupal';
}
