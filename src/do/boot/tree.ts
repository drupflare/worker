import { bootDrupalTree } from '../../drupal/boot';
import type { SitePhpDurableObject } from '../../site-do';
import { bootWordpressTree } from '../../wordpress/boot';
import type { SiteBinary } from '../types';

/** thrown for a CMS value the worker has no boot for, so it never falls through to Drupal */
export class CmsHasNoBootError extends Error {
	constructor(readonly cms: string) {
		super(`CMS=${cms} has no boot yet`);
		this.name = 'CmsHasNoBootError';
	}
}

/** mounts a CMS's tree on the interpreter and points its configuration at this runtime */
export type TreeBoot = (site: SitePhpDurableObject, binary: SiteBinary) => Promise<void>;

/** which of the alarm's CMS-bound phases a CMS takes, and which cron drive it has */
export type CmsPhases = {
	/** the pack reconciliation steps, which run Drupal PHP */
	reconcile: boolean;
	/** loading `prefill.json`, whose pages are Drupal's */
	prefill: boolean;
	/** the cron drive: Drupal's cron units, WordPress's `wp-cron.php`, or none */
	cron: 'drupal' | 'wordpress' | 'none';
};

const PHASES: Record<string, CmsPhases> = {
	drupal: { reconcile: true, prefill: true, cron: 'drupal' },
	wordpress: { reconcile: false, prefill: false, cron: 'wordpress' }
};

/** a CMS the table lacks takes no phase, so none of Drupal's PHP can run on its tree */
const NO_PHASES: CmsPhases = { reconcile: false, prefill: false, cron: 'none' };

/** the alarm phases for the `CMS` var, Drupal's when it is absent or empty */
export function phasesFor(cms: string | undefined): CmsPhases {
	const value = cms === undefined || cms === '' ? 'drupal' : cms;
	return PHASES[value] ?? NO_PHASES;
}

/**
 * The tree boot for the `CMS` var, Drupal when it is absent or empty.
 *
 * Called before the interpreter is built, so a CMS with no boot costs nothing.
 */
export function treeBootFor(cms: string | undefined): TreeBoot {
	const value = cms === undefined || cms === '' ? 'drupal' : cms;
	if (value === 'drupal') return bootDrupalTree;
	if (value === 'wordpress') return bootWordpressTree;
	throw new CmsHasNoBootError(value);
}
