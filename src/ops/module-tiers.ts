import { type ModuleCapability } from './catalog.js';

/**
 * Capability classification for the stress-chosen module list.
 *
 * A SEPARATE FILE from `catalog.ts` so the table can grow without touching the classifier, and
 * because this is measurement output rather than mechanism. `KNOWN_MODULE_CAPABILITIES` there stays
 * the authority for what ships; this is the working set, merged into it by `allKnownCapabilities()`.
 *
 * **THESE ARE ENGINEERING POSITIONS, NOT VERDICTS.** A module is `refused` only where the platform
 * genuinely cannot host it after asking what a rewrite would take. Every non-empty entry carries
 * what it would take to move up a tier, because "blocked" without a route out is just a shrug.
 *
 * **An absent entry is `unknown`, never `works-today`.** `tierFor()` enforces that; this file must
 * never gain an entry that has not actually been looked at.
 */

/** what a classification cost to reach, so a later reader can retest it rather than trust it */
export interface TierNote {
	needs: readonly ModuleCapability[];
	/** the mechanism, not the module: why this capability and not another */
	why: string;
	/** what would move it up a tier, and roughly how big that is */
	lift?: string;
}

export const MODULE_TIER_NOTES: Readonly<Record<string, TierNote>> = {
	// #region works today: no outbound, no cron
	'drupal/pathauto': { needs: [], why: 'token replacement over local entity data on save' },
	'drupal/token': { needs: [], why: 'a token vocabulary; no I/O of its own' },
	'drupal/ctools': { needs: [], why: 'plugin and form helpers' },
	'drupal/redirect': { needs: [], why: 'a route subscriber over its own table' },
	'drupal/metatag': { needs: [], why: 'renders meta tags from entity data' },
	'drupal/admin_toolbar': { needs: [], why: 'menu rendering only' },
	'drupal/field_group': { needs: [], why: 'display configuration; no runtime I/O' },
	'drupal/linkit': { needs: [], why: 'autocomplete over local entities' },
	'drupal/honeypot': {
		needs: [],
		why: 'a hidden field and a submission timer, entirely local. Still the recommended default over any captcha here: zero outbound beats two round trips on every submit'
	},
	'drupal/twig_tweak': { needs: [], why: 'Twig functions over local services' },
	'drupal/paragraphs': { needs: [], why: 'entity composition, all local' },
	'drupal/entity_reference_revisions': { needs: [], why: 'a field type' },
	'drupal/webform': {
		needs: [],
		why: 'form building and submission storage are local. Handlers that POST to a remote endpoint are the deferrable case and are per-handler, not per-module'
	},
	'drupal/filefield_sources': {
		needs: [],
		why: 'the local sources (upload, reference, clipboard) need nothing. Only the "remote URL" source calls out, and it is one source among several'
	},
	'drupal/devel': {
		needs: [],
		why: 'local introspection. Worth a warning rather than a capability: it dumps debug output INTO the page, and this runtime stores anonymous output in `cfw_page` and serves it to everyone'
	},
	// #endregion

	// #region cron: the driver exists and nothing calls it
	'drupal/scheduler': {
		needs: ['cron'],
		why: 'publishes and unpublishes on cron; the work is a bounded query per run',
		lift: 'wire `driveCron()` into `alarm()`. The driver, the cursor and the budget already exist in `src/ops/cron-drive.ts`; nothing imports it. Small: the patch is about a dozen lines. Note the cadence: cron is interval-gated at 15 minutes (`cronDue()`), so work lands within a quarter hour rather than immediately'
	},
	'drupal/simple_sitemap': {
		needs: ['cron'],
		why: 'generation is a queue drained by cron, plus a filesystem write per chunk',
		lift: 'the same cron wiring, plus confirming a sitemap chunk fits under the 2,199,995-byte record ceiling. Medium: the queue is already sliced, the size question is unmeasured. Note the cadence: cron is interval-gated at 15 minutes (`cronDue()`), so work lands within a quarter hour rather than immediately'
	},
	'drupal/search_api': {
		needs: ['cron'],
		why: 'indexing runs on cron. The DATABASE backend needs nothing else and is the supported shape here',
		lift: 'cron wiring alone for the database backend. A remote backend is a different module and a different tier. Note the cadence: cron is interval-gated at 15 minutes (`cronDue()`), so work lands within a quarter hour rather than immediately'
	},
	'drupal/queue_ui': {
		needs: ['cron'],
		why: 'a UI over Drupal queues; the queues themselves only move when cron runs them',
		lift: 'cron wiring. It also becomes the natural operator view of `cronStep()` queue units, which today have no surface at all. Note the cadence: cron is interval-gated at 15 minutes (`cronDue()`), so work lands within a quarter hour rather than immediately'
	},
	'drupal/image_optimize': {
		needs: ['cron'],
		why: 'batch optimisation over managed files. The BINARY pipelines shell out and cannot work; the pure-PHP and remote-service pipelines are the ones in scope',
		lift: 'cron wiring for the batch, and a pipeline that is neither a subprocess nor a blocking call. Large: most shipped pipelines are subprocess-based, so this needs a pipeline written for the platform. Note the cadence: cron is interval-gated at 15 minutes (`cronDue()`), so work lands within a quarter hour rather than immediately'
	},
	'drupal/migrate_plus': {
		needs: ['cron'],
		why: 'migrations run as batches. A local source (JSON on disk, another table) needs only the batch driver; a remote source is deferrable outbound on top',
		lift: 'cron wiring covers the local-source case. Remote sources additionally need the deferred tier and a fetcher written against it. Note the cadence: cron is interval-gated at 15 minutes (`cronDue()`), so work lands within a quarter hour rather than immediately'
	},
	// #endregion

	// #region deferred outbound: possible with the POST tier
	'drupal/captcha': {
		needs: ['deferrable-outbound'],
		why: 'the base module is local; it is the reCAPTCHA-style providers under it that verify against a remote endpoint inside form validation',
		lift: '`src/ops/deferred-post.ts` plus a provider shim that queues on the first submit and reads the cached result on the automatic re-submit'
	},
	'drupal/recaptcha': {
		needs: ['deferrable-outbound'],
		why: 'siteverify is a POST to Google inside form validation. It does NOT have to happen inside the render, which is what makes it deferrable rather than impossible',
		lift: 'the POST tier plus the re-submit shim. The token must be re-posted unchanged or the second attempt misses the cache forever'
	},
	'drupal/stage_file_proxy': {
		needs: ['deferrable-outbound'],
		why: 'fetches a missing file from an upstream site on the request that missed it. A cache fill, so a placeholder or a 202 on the first miss is honest',
		lift: 'the existing GET tier already covers it; what is missing is the Drupal-side shim that tolerates a miss instead of blocking'
	},
	'drupal/purge': {
		needs: ['deferrable-outbound', 'cron'],
		why: 'invalidation is a queue drained by cron, and each purger POSTs or PURGEs to a CDN. Both halves are deferrable; neither has to answer inside a render',
		lift: 'cron wiring plus the POST tier. Worth noting this runtime already invalidates its OWN edge by bumping the generation, so purge is only needed for a CDN in front of it'
	},
	// #endregion

	// #region refused: needs an answer inside one synchronous run
	'drupal/facets': {
		needs: [],
		why: 'facets themselves are local: they read from whatever Search API backend is configured. With the DATABASE backend this needs nothing, which is why it is not refused',
		lift: 'none required with the database backend; it inherits the backend tier'
	},
	'drupal/search_api_solr': {
		needs: ['blocking-outbound'],
		why: 'a query per keystroke against a remote index has to answer inside the render that asked. Deferring it changes what the user sees rather than when they see it',
		lift: 'JSPI or an Asyncify build, which is the whole-binary change this project has priced and deferred. Use the Search API database backend instead'
	}
	// #endregion
};

/**
 * The classification set, this table merged over the shipped one.
 *
 * `catalog.ts` keeps its own list because it ships with the artifact; this one is the working set
 * from the compatibility pass. Merging rather than replacing means a module classified in both
 * places takes the value here, which is the more recently measured of the two.
 */
export function allKnownCapabilities(
	shipped: Readonly<Record<string, readonly ModuleCapability[]>>
): Record<string, readonly ModuleCapability[]> {
	const merged: Record<string, readonly ModuleCapability[]> = { ...shipped };
	for (const [name, note] of Object.entries(MODULE_TIER_NOTES)) merged[name] = note.needs;
	return merged;
}

/** the composer names this pass covered, for a report that can say what it did not cover */
export const CLASSIFIED_MODULES = Object.keys(MODULE_TIER_NOTES);
