/**
 * The 25 contrib modules this QA pass covers, and what each one is expected to need.
 *
 * SEPARATED FROM THE RUNNER so the list is data rather than a script's inner detail: a later pass
 * adds a name here and re-runs, and `tests/node/qa-modules.spec.ts` asserts on this table without
 * booting anything.
 *
 * `expected` is a PREDICTION, recorded so the pass can disagree with it. Every value here was
 * reasoned from `src/ops/catalog.ts` and `src/ops/shipped-lock.ts` before the run; where a run
 * contradicts one, the disagreement is the finding and the prediction stays put as the record of
 * what was believed.
 */

/** what a module turns out to be, once the site has actually been asked */
export type Verdict =
	| 'ships'
	| 'core'
	| 'obsolete'
	| 'works'
	| 'needs-deferred-tier'
	| 'needs-cron'
	| 'refused'
	| 'absent';

/**
 * Three tiers, not two, and the middle one is where most of the interesting cases land.
 *
 * `blocking-outbound` is the only genuine refusal: a call that must complete inside one synchronous
 * `php._run()`. `deferrable-outbound` is a call that can be split across invocations -- PHP queues
 * through `cfwQueueFetch`, `drainHttpQueue()` performs it inside `alarm()` where awaiting is legal,
 * and a later invocation reads the result synchronously from `cfw_http_cache`. That layering
 * already exists and already answers 202 with `x-cfw-deferred: queued`.
 *
 * The distinction matters because it moves modules out of "impossible" and into "needs a
 * per-module Drupal shim", which is a cost somebody can decide to pay.
 */
export type Capability = 'deferrable-outbound' | 'blocking-outbound' | 'cron';

export interface QaModule {
	/** the Drupal machine name, which is what `/enable` takes */
	machine: string;
	/** the composer name, which is what `/installable` takes */
	composer: string;
	/** runtime capabilities the module needs at REQUEST time, not install time */
	needs: readonly Capability[];
	/** the prediction, before the run */
	expected: Verdict;
	/** why the prediction, in one clause */
	why: string;
}

/**
 * The list.
 *
 * `views` and `media` are core in Drupal 11 and are here because they were named, not because they
 * are contrib. `file_entity` has no Drupal 11 release at all: it was the D7 file entity system that
 * core Media superseded, so it is obsolete rather than blocked.
 */
export const QA_MODULES: readonly QaModule[] = [
	{
		machine: 'pathauto',
		composer: 'drupal/pathauto',
		needs: [],
		expected: 'ships',
		why: 'pinned in SHIPPED_LOCK_VERSIONS and present in the pack'
	},
	{
		machine: 'token',
		composer: 'drupal/token',
		needs: [],
		expected: 'ships',
		why: 'pinned in SHIPPED_LOCK_VERSIONS and present in the pack'
	},
	{
		machine: 'admin_toolbar',
		composer: 'drupal/admin_toolbar',
		needs: [],
		expected: 'ships',
		why: 'pinned in SHIPPED_LOCK_VERSIONS and present in the pack'
	},
	{
		machine: 'metatag',
		composer: 'drupal/metatag',
		needs: [],
		expected: 'works',
		why: 'renders meta tags from entity data; no outbound, no cron'
	},
	{
		machine: 'redirect',
		composer: 'drupal/redirect',
		needs: [],
		expected: 'works',
		why: 'a route subscriber over its own table'
	},
	{
		machine: 'webform',
		composer: 'drupal/webform',
		needs: [],
		expected: 'works',
		why: 'form building and submission storage are local'
	},
	{
		machine: 'views',
		composer: 'drupal/core',
		needs: [],
		expected: 'core',
		why: 'core in Drupal 11'
	},
	{
		machine: 'paragraphs',
		composer: 'drupal/paragraphs',
		needs: [],
		expected: 'works',
		why: 'entity composition, all local'
	},
	{
		machine: 'entity_reference_revisions',
		composer: 'drupal/entity_reference_revisions',
		needs: [],
		expected: 'works',
		why: 'a field type; paragraphs depends on it'
	},
	{
		machine: 'media',
		composer: 'drupal/core',
		needs: [],
		expected: 'core',
		why: 'core in Drupal 11'
	},
	{
		machine: 'file_entity',
		composer: 'drupal/file_entity',
		needs: [],
		expected: 'obsolete',
		why: 'D7-era, superseded by core Media; no Drupal 11 release'
	},
	{
		machine: 'search_api',
		composer: 'drupal/search_api',
		needs: ['cron'],
		expected: 'needs-cron',
		why: 'indexing runs on cron; the alarm exists but nothing drives indexing from it'
	},
	{
		machine: 'search_api_solr',
		composer: 'drupal/search_api_solr',
		needs: ['blocking-outbound', 'cron'],
		expected: 'refused',
		why: 'the one structural refusal: a query per keystroke against a remote index cannot be deferred without changing the UX. Search API DB backend is the answer'
	},
	{
		machine: 'xmlsitemap',
		composer: 'drupal/xmlsitemap',
		needs: ['cron'],
		expected: 'needs-cron',
		why: 'the sitemap is generated on cron'
	},
	{
		machine: 'simple_sitemap',
		composer: 'drupal/simple_sitemap',
		needs: ['cron'],
		expected: 'needs-cron',
		why: 'generation is a queue drained by cron'
	},
	{
		machine: 'google_analytics',
		composer: 'drupal/google_analytics',
		needs: [],
		expected: 'works',
		why: 'emits a client-side snippet; the browser makes the call, not PHP'
	},
	{
		machine: 'twig_tweak',
		composer: 'drupal/twig_tweak',
		needs: [],
		expected: 'works',
		why: 'Twig functions over local services'
	},
	{
		machine: 'devel',
		composer: 'drupal/devel',
		needs: [],
		expected: 'works',
		why: 'local introspection'
	},
	{
		machine: 'stage_file_proxy',
		composer: 'drupal/stage_file_proxy',
		needs: ['deferrable-outbound'],
		expected: 'needs-deferred-tier',
		why: 'the easiest deferrable case, not a blocked one: serve a placeholder or 202 on the miss, queue the fetch, land it in R2 through the mirror queue that already drains, serve it thereafter. A cache fill, not a synchronous dependency'
	},
	{
		machine: 'coffee',
		composer: 'drupal/coffee',
		needs: [],
		expected: 'works',
		why: 'an admin palette over the local route table'
	},
	{
		machine: 'field_group',
		composer: 'drupal/field_group',
		needs: [],
		expected: 'works',
		why: 'display configuration only'
	},
	{
		machine: 'linkit',
		composer: 'drupal/linkit',
		needs: [],
		expected: 'works',
		why: 'autocomplete over local entities'
	},
	{
		machine: 'honeypot',
		composer: 'drupal/honeypot',
		needs: [],
		expected: 'works',
		why: 'a hidden field and a timer; no third party'
	},
	{
		machine: 'recaptcha',
		composer: 'drupal/recaptcha',
		needs: ['deferrable-outbound'],
		expected: 'needs-deferred-tier',
		why: 'siteverify need not happen inside the render: validate, queue the POST, drain on the alarm, complete on resubmit. Tokens are single-use and expire in ~2 min; the alarm re-arms at +1 ms while the queue is non-empty, so the round trip fits. The cost is a per-module Drupal shim, since captcha validation is a synchronous form constraint'
	},
	{
		machine: 'scheduler',
		composer: 'drupal/scheduler',
		needs: ['cron'],
		expected: 'needs-cron',
		why: 'publishes and unpublishes on cron'
	}
];

/** the four contrib modules the shipped pack actually contains, from `SHIPPED_LOCK_VERSIONS` */
export const SHIPPED_CONTRIB = ['pathauto', 'token', 'admin_toolbar', 'ctools'] as const;

/** core modules in the list, which are neither shipped contrib nor installable contrib */
export const CORE_MODULES = ['views', 'media'] as const;

/**
 * The verdict a module deserves given what the run observed.
 *
 * Pure, and separated from the runner so the classification is testable without a site. The
 * ordering matters: `absent` outranks every prediction, because a module whose code is not on the
 * filesystem cannot be said to "work" or to be "blocked by outbound" -- neither claim has been
 * tested. Reporting a prediction as a result is the failure this function exists to prevent.
 */
export function classify(input: {
	machine: string;
	/** did `extension.list.module` see it */
	discoverable: boolean;
	/** did the enable attempt succeed */
	enabled: boolean;
	needs: readonly Capability[];
	expected: Verdict;
}): Verdict {
	if (CORE_MODULES.includes(input.machine as (typeof CORE_MODULES)[number])) return 'core';
	if (input.expected === 'obsolete') return 'obsolete';
	if (!input.discoverable) return 'absent';
	if (!input.enabled) return 'refused';
	// the only structural refusal: a call that must complete inside one synchronous php._run()
	if (input.needs.includes('blocking-outbound')) return 'refused';
	// deferrable outbound outranks cron: a module needing both is gated on the harder one first,
	// and the deferred tier is a per-module Drupal shim where cron is one shared wiring change
	if (input.needs.includes('deferrable-outbound')) return 'needs-deferred-tier';
	if (input.needs.includes('cron')) return 'needs-cron';
	if (SHIPPED_CONTRIB.includes(input.machine as (typeof SHIPPED_CONTRIB)[number])) return 'ships';
	return 'works';
}

/** one row of the pass, as recorded */
export interface QaResult {
	machine: string;
	composer: string;
	expected: Verdict;
	actual: Verdict;
	/** what `/installable` said, which is a different question from what `/enable` did */
	installable: string;
	installableNote: string;
	discoverable: boolean;
	enabled: boolean;
	rowsWritten: number;
	writeStatements: number;
	routerRebuilds: number | null;
	/** the exact failure text, never a paraphrase */
	error: string | null;
	needs: readonly Capability[];
}
