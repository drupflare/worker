import { KNOWN_MODULE_CAPABILITIES, SHIPPED_CAPABILITIES, tierFor } from './catalog.js';
import { MODULE_TIER_NOTES } from './module-tiers.js';

/**
 * The module support table, EMITTED from the classifier rather than hand-written.
 *
 * A hand-maintained README table goes stale the first time a tier moves, and it goes stale silently
 * because nothing compares it to anything. `tests/node/module-table.spec.ts` renders these rows and
 * fails when README.md disagrees -- the same discipline as the driver-pack byte-for-byte check.
 *
 * **THREE STATES, AND ONLY ONE OF THEM IS A SUPPORT CLAIM.**
 *
 *   - `verified`  the gate enabled it against a real site and asserted it FUNCTIONS. Not that the
 *                 installer returned ok; that a thing the module does actually happened.
 *   - `untested`  nobody has enabled it here. The capability analysis says it should work, which is
 *                 an inference about the runtime and not an observation about the module.
 *   - `blocked`   cannot work, with the mechanism and what would lift it.
 *
 * **`supported` WAS A STATE HERE AND IT WAS DISSOLVED** (2026-08-18, Gregory's call). It meant
 * "the capability this module needs was measured WITHOUT the module", which is a reasoned claim and
 * reads to anybody else as a promise. Renaming it `untested` is the whole fix: the row still carries
 * the same evidence, and it no longer claims something no test has shown.
 *
 * The rule that replaces it: **nothing reaches `verified` except through a gated enable-and-assert
 * run.** There is no path in this file that promotes a module on analysis alone, and adding one
 * would put the old problem back under a new name.
 */
export type SupportState = 'verified' | 'untested' | 'blocked';

/**
 * The same three, as a value, so a test can pin the VOCABULARY rather than today's census.
 *
 * The distinction earned its own export: the spec used to assert the exact set of states in use,
 * which passed while every row happened to be `verified` or `blocked` and then failed the moment a
 * module was honestly reclassified to `untested`.
 */
export const MODULE_STATES: readonly SupportState[] = ['verified', 'untested', 'blocked'];

/**
 * The contrib modules the SHIPPING pack carries, which is four and has always been four.
 *
 * `scripts/pack-drupal.ts` puts `modules/contrib` behind `PACK_CONTRIB=1` and says why in its own
 * comment: the other modules under `drupal-src/modules/contrib` are a QA fixture rather than
 * product. So a `verified` row outside this list was established against a fixture build, and
 * re-running the gate against the shipping artifact SKIPS it rather than re-establishing it.
 *
 * Measured from `assets/drupal-pf/core.pf.json` rather than believed --
 * `tests/node/module-table.spec.ts` reads the pack index and fails if this list and the artifact
 * disagree in either direction.
 */
export const SHIPPING_PACK_CONTRIB: readonly string[] = [
	'drupal/admin_toolbar',
	'drupal/ctools',
	'drupal/pathauto',
	'drupal/token'
];

/**
 * The clause every fixture-verified row carries, so the reader is not left to infer it.
 *
 * One string rather than twelve copies: the distinction is a property of the pack, so a row gains
 * or loses it by moving in or out of {@link SHIPPING_PACK_CONTRIB}, never by someone editing prose.
 */
export const FIXTURE_CLAUSE =
	'. Required as a dev dependency and verified against the test build rather than shipped, so a ' +
	'site does not carry it unless it asks for it';

/**
 * Modules whose BEHAVIOUR the gate has asserted, with what was asserted.
 *
 * Under `wrangler dev` an enable killed the host process, so no follow-up request could be made and
 * nothing could be verified. Re-run under `@cloudflare/vitest-pool-workers` that limit does not
 * exist: an enable survives, a follow-up request answers, and TWO enables in one object survive --
 * the exact case that killed wrangler dev hardest. The failure was miniflare's proxy controller, a
 * component that only exists locally, and suspecting the instrument first was right.
 *
 * What that left was a configuration gap rather than a runtime one, and **the gap was closed by
 * supplying the configuration rather than by waiting for it.** This block used to record `pathauto`
 * as inert (no `pathauto.pattern.*` ships, so a node save produces no alias) and `token` as
 * unverifiable for the same reason. A pattern is a config entity a SITE OWNER creates, so the test
 * creates one; both are now verified against an alias the run generated.
 *
 * The distinction worth keeping: absent CONFIGURATION is a fixture gap a test can fill, absent CODE
 * is not. Twelve rows here are in the second class -- see {@link SHIPPING_PACK_CONTRIB}.
 */
export const VERIFIED_BEHAVIOURS: Readonly<Record<string, string>> = {
	'drupal/filefield_sources':
		'enabled against a real site; `plugin.manager.filefield_sources`, its field access check and its own service all resolve. Ships no stable release, so this is the 2.0 development branch and the row says so',
	'drupal/imageapi_optimize':
		'enabled against a real site; its processor plugin manager resolves, `imageapi_optimize.settings` is installed and the pipeline config entity type is registered. The BINARY pipelines shell out and cannot run here; the pipeline plugin point is what was verified',
	'drupal/coffee':
		'enabled against a real site; `coffee.url_generator` resolves and `coffee.configuration` is installed, which is the config its command palette reads',
	'drupal/devel':
		'enabled against a real site; `devel.dumper` and `plugin.manager.devel_dumper` resolve, its route and error subscribers are in the container, and it installs its own menu',
	'drupal/facets':
		'enabled against a real site; all five of its plugin managers resolve. It creates no table and ships no config, so the container IS the observable',
	'drupal/google_analytics':
		'enabled against a real site; `google_analytics.visibility`, `.accounts` and `.javascript_cache` resolve and `google_analytics.settings` is installed. The tag it emits is client-side, so nothing outbound is involved',
	'drupal/json_field':
		"enabled against a real site; it registers the `json` field type with core's field-type manager and its `json_field.views` service resolves. Its normalizer is a TAGGED service, which the compiler folds into the serializer and removes from the public map, so asking the container for it by id fails on a module that installed correctly",
	'drupal/key':
		'enabled against a real site; its repository and three plugin managers resolve and the `key` config entity type is registered. A key PROVIDER that reads a file or an external service is a separate question',
	'drupal/linkit':
		'enabled against a real site; its matcher and substitution managers resolve alongside the suggestion manager, and `linkit_profile` is registered',
	'drupal/purge':
		'enabled against a real site; `purge.queue`, `purge.processors`, `purge.purgers` and the invalidation factory all resolve. What it would PURGE is this host, which already invalidates from cache tags',
	'drupal/twig_tweak':
		'enabled against a real site; its twig extension and four view builders resolve, which is the whole of what it adds',
	'drupal/webform':
		'enabled against a real site; four of its plugin managers resolve, the `webform` table exists and its shipped option sets are installed. Submissions are ordinary form POSTs',
	'drupal/xmlsitemap':
		'enabled against a real site; `xmlsitemap_generator` and `xmlsitemap.link_storage` resolve, the `xmlsitemap` table exists and its settings are installed',
	'drupal/field_group':
		'enabled against a real site; it creates no table and ships no settings, so what was asserted is what it adds to the CONTAINER -- `plugin.manager.field_group.formatters`, `field_group.subscriber` and `field_group.param_converter` all resolve after the install, with a core service as the control',
	'drupal/honeypot':
		'enabled against a real site; its schema hook created `honeypot_user`. The recommended default over any captcha here, because a hidden field and a submission timer are entirely local and cost no outbound round trip',
	'drupal/redirect':
		'enabled against a real site; the `redirect` table exists and 11 of its routes are in the `router` table, so both halves of a route subscriber over its own table are present',
	'drupal/search_api':
		'enabled against a real site; it created `search_api_item` and `search_api_task`, which is where the database backend writes, and its index routes are in the `router` table',
	'drupal/stage_file_proxy':
		'enabled against a real site; `stage_file_proxy.settings` is installed, which is what its fetch path reads',
	'drupal/captcha':
		'enabled against a real site; its schema hook created `captcha_sessions` and 8 routes appear in the `router` table. Its routes are named with underscores, so a dotted module-prefix match finds none of them',
	'drupal/metatag':
		'enabled against a real site; it installed 8 config objects of its own, so it has defaults to apply rather than enabling inert the way pathauto does',
	'drupal/migrate_plus':
		'enabled against a real site; both config entity types it exists to provide are installed -- `migration.entity_type` and `migration_group.entity_type`. It ships no config OBJECTS, so a `migrate_plus.%` config probe finds nothing and would read as inert',
	'drupal/paragraphs':
		'enabled against a real site; it created its entity type as four tables -- `paragraphs_item`, `paragraphs_item_field_data`, `paragraphs_item_revision`, `paragraphs_item_revision_field_data`',
	'drupal/queue_ui':
		'enabled against a real site; its admin routes are in the `router` table, and routes are the whole module',
	'drupal/recaptcha':
		'enabled against a real site; captcha came with it, so dependency resolution ran, and it installed its own configuration',
	'drupal/scheduler':
		'enabled against a real site; it installed its own configuration and its routes are in the `router` table',
	'drupal/admin_toolbar':
		'enabled against a real site in the workers lane; its own routes appear in the `router` table after the install-triggered rebuild',
	'drupal/ctools':
		'enabled against a real site in the workers lane; `core.extension` grew and the site still saved content afterwards. A library module with no user-visible behaviour of its own, so this is the strongest observable it has',
	'drupal/pathauto':
		'enabled against a real site, given the pattern the shipped database does not carry; a node saved as "Pathauto Probe Title" produced the `path_alias` row `/node/1 -> /probe/pathauto-probe-title`. Pointed at `canonical_entities:user` the same run writes no row, so the assertion tracks this pattern rather than an ambient alias',
	'drupal/token':
		"enabled against a real site; `[random:hash:md5]` resolves to 32 hex digits, and it is declared by `token.tokens.inc` and by nothing in core -- with `ctools` enabled in its place the same call returns the literal. Controls both ways: `[nosuchtype:nosuchtoken]` comes back untouched, and core's `[site:name]` still answers",

	// #region driven 2026-08-20 in the fixture lane, each asserted absent before the enable
	'drupal/address':
		'enabled against a real site; the `address`, `address_country` and `address_zone` field types are registered and `address.country_repository`, `address.address_format_repository` and `address.subdivision_repository` resolve. None of the three is in the container beforehand',
	'drupal/backup_migrate':
		'enabled against a real site; it installed four config entity types and six default source and destination entities -- `default_db`, `entire_site`, the two file destinations and a daily schedule -- and 24 routes',
	'drupal/better_exposed_filters':
		'enabled against a real site; its three widget plugin managers and `better_exposed_filters.bef_helper` are in the container afterwards and absent before',
	'drupal/colorbox':
		'enabled against a real site; `colorbox.settings` is installed and its admin route is in the `router` table',
	'drupal/config_ignore':
		'enabled against a real site; `config_ignore.settings` is installed and its admin route is in the `router` table',
	'drupal/crop':
		'enabled against a real site; it created the crop entity type as four tables -- `crop`, `crop_field_data`, `crop_revision`, `crop_field_revision` -- and installed `crop_type` as a config entity type',
	'drupal/csv_serialization':
		"enabled against a real site; `serializer->supportsEncoding('csv')` is true afterwards and false before, with `json` true throughout as the control that the serializer is answering at all",
	'drupal/easy_breadcrumb':
		'enabled against a real site; `easy_breadcrumb.settings` is installed and its admin route is in the `router` table',
	'drupal/editor_advanced_link':
		'enabled against a real site; the `editor_advanced_link_link` CKEditor 5 plugin is registered and its two asset libraries resolve. Library discovery needs `common.inc` loaded first -- `JS_LIBRARY` and `CSS_COMPONENT` are defined there, not by the autoloader',
	'drupal/entity':
		'enabled against a real site; `entity.bundle_plugin_installer`, `entity.bundle_entity_duplicator` and `access_checker.entity_revision` resolve afterwards and are absent before. A substring match on its name is NOT evidence here: most of what matches `entity` in the container is core',
	'drupal/entity_browser':
		'enabled against a real site; the `entity_browser` config entity type is installed and six of its routes are in the `router` table',
	'drupal/entity_reference_revisions':
		'enabled against a real site; the `entity_reference_revisions` field type and its `entity_reference_revisions_entity_view` formatter are registered, and `entity_reference_revisions.orphan_purger` is in the container',
	'drupal/externalauth':
		'enabled against a real site; its schema hook created `authmap`, which is the table the identity mapping lives in',
	'drupal/focal_point':
		'enabled against a real site; `focal_point.settings` is installed and it created the `crop.type.focal_point` crop type inside the dependency it pulled in',
	'drupal/google_tag':
		'enabled against a real site; the `google_tag_container` config entity type and `google_tag.settings` are installed, with eight routes. Nothing outbound happens in PHP -- the snippet it injects is called by the browser',
	'drupal/imce':
		'enabled against a real site; the `imce_profile` config entity type and both shipped profiles -- `admin` and `member` -- are installed, with nine routes',
	'drupal/jquery_ui':
		'enabled against a real site; 24 asset libraries resolve for it afterwards and none before, `core` and `widget` among them',
	'drupal/jquery_ui_autocomplete':
		'enabled against a real site; the `autocomplete` library resolves for it afterwards and none before. It ships no code of its own -- jquery_ui declares the library on its behalf, so the library existing IS the module working',
	'drupal/jquery_ui_datepicker':
		'enabled against a real site; the `datepicker` library resolves for it afterwards and none before. Four files on disk and no PHP, so its library is the only observable it has',
	'drupal/jquery_ui_menu':
		'enabled against a real site; the `menu` library resolves for it afterwards and none before',
	'drupal/libraries':
		'enabled against a real site; `libraries.settings` is installed, which is where its external library definitions are read from',
	'drupal/mailsystem':
		'enabled against a real site; `mailsystem.settings` is installed and its admin route is in the `router` table. It is how a site selects `cfw_mail`, so it is the module a site drops smtp in favour of',
	'drupal/menu_block':
		"enabled against a real site; `menu_block:main` and `menu_block:footer` are block plugin derivatives it provides. `access_check.admin_menu_block_page` reads as its service and is CORE's -- the before reading is what said so",
	'drupal/module_filter':
		'enabled against a real site; `module_filter.settings` is installed and its admin route is in the `router` table',
	'drupal/simple_sitemap':
		"enabled against a real site; `simple_sitemap.generator`, `simple_sitemap.queue_worker` and `simple_sitemap.sitemap_writer` resolve, both `simple_sitemap` and `simple_sitemap_type` are registered entity types and `simple_sitemap.settings` is installed, none of it before. It was refused outright until the host supplied a pure-PHP `XMLWriter` and cleared its one install block through `hook_requirements_alter()` -- `extension_loaded('xmlwriter')` is a built-in and cannot be shimmed",
	'drupal/svg_image':
		"enabled against a real site; the `image` field formatter is `Drupal\\svg_image\\...\\SvgImageFormatter` afterwards and core's `ImageFormatter` before, and the `image_image` widget moves the same way. It takes core's plugin ids over rather than adding its own",
	'drupal/video_embed_field':
		'enabled against a real site; the `video_embed_field` field type, its `video_embed_field_video` formatter and `video_embed_field.provider_manager` are all present afterwards and absent before',
	'drupal/views_bulk_operations':
		'enabled against a real site; `views_bulk_operations.processor`, `views_bulk_operations.data` and its action plugin manager resolve, the `views_bulk_operations_delete_entity` action is registered, and four of its routes are in the `router` table',
	'drupal/views_data_export':
		'enabled against a real site; the `data_export` views display and style plugins are registered, which is the whole module',
	// #endregion

	// #region driven 2026-08-27, the US federal track
	'drupal/search_api_solr':
		"enabled against a real site with composer's platform check ON; `plugin.manager.search_api_solr.connector` and `solarium.query_helper` resolve and all four solr config entity types -- `solr_cache`, `solr_field_type`, `solr_request_handler`, `solr_request_dispatcher` -- are registered, none of them before. The `php-64bit` constraint that used to abort every request before Drupal booted is satisfied by the long64 build. A Solr SERVER is still an outbound dependency reached through the deferred tier, so what was asserted is the module installing rather than a query answering",
	'drupal/usfedgov_google_analytics':
		'enabled against a real site; its three hook services resolve, `usfedgov_google_analytics.settings` is installed, its admin route is in the `router` table and seven asset libraries resolve for it afterwards and none before. The DAP tag is fetched by the BROWSER from dap.digitalgov.gov, so nothing outbound happens in PHP',
	'drupal/metatag_search_gov':
		'enabled against a real site; the `search_gov` metatag group and the `searchgov_custom1` and `searchgov_custom3` tag plugins name this module afterwards and are absent before. It installs no config, creates no table and registers no route of its own, so the plugin definitions are the whole observable',
	'drupal/uswds_base':
		'installed against a real site through `theme_installer`, which is a different installer from every other row here: its asset libraries resolve afterwards and none before, and it lands in the `theme` key of `core.extension` rather than the `module` key. Its default library mode loads USWDS from a CDN, and a federal deployment picks the local mode instead'
	// #endregion
};

/**
 * Modules whose CAPABILITY the gate exercised end to end, while the module itself is absent.
 */
export const CAPABILITY_EVIDENCE: Readonly<Record<string, string>> = {
	'drupal/captcha':
		'the deferred POST it needs is measured end to end in `deferred-post.spec.ts` -- body intact, two submissions to one endpoint kept apart, answered from the queue with no second visitor. The module is not in the pack, so the module itself is unexercised',
	'drupal/recaptcha':
		'siteverify is a POST inside form validation, and that exact shape is measured in `deferred-post.spec.ts` against a mocked endpoint. The tier keys on method + url + body, which is what keeps two submissions to one endpoint apart. The module is not in the pack',
	'drupal/scheduler':
		"its work is `hook_cron` and nothing else; `cron-wire.spec.ts` invokes Drupal's cron handlers across several firings, inside the 6-unit / 500-row budget, and a second sweep runs again rather than latching. The module is not in the pack",
	'drupal/queue_ui':
		'a UI over queues that only move when cron runs them, and the cron wire is measured in `cron-wire.spec.ts`. The module is not in the pack',
	'drupal/search_api':
		'indexing runs on cron with the database backend, and the cron wire is measured in `cron-wire.spec.ts`. The module is not in the pack'
};

export interface TableRow {
	/** composer name */
	name: string;
	/** the short name a reader recognises */
	label: string;
	state: SupportState;
	/** what the gate asserted, for `verified`; what the analysis concluded, otherwise */
	evidence: string;
}

/**
 * Words a machine name spells lowercase and a reader does not.
 *
 * Word-by-word rather than whole-name, so `jquery_ui_datepicker` and `jquery_ui` both read right
 * from one entry each. A machine name is snake_case by Drupal convention, and capitalising each
 * part gave `Uswds Base`, `Xmlsitemap` and `Jquery Ui` -- correct by the rule and wrong on the page.
 */
const WORD_CASING: Readonly<Record<string, string>> = {
	api: 'API',
	captcha: 'CAPTCHA',
	cdn: 'CDN',
	ckeditor: 'CKEditor',
	csv: 'CSV',
	dap: 'DAP',
	gov: 'Gov',
	imce: 'IMCE',
	jquery: 'jQuery',
	js: 'JS',
	json: 'JSON',
	oidc: 'OIDC',
	php: 'PHP',
	pdf: 'PDF',
	rss: 'RSS',
	seo: 'SEO',
	smtp: 'SMTP',
	solr: 'Solr',
	sql: 'SQL',
	svg: 'SVG',
	ui: 'UI',
	url: 'URL',
	usfedgov: 'USFedGov',
	uswds: 'USWDS',
	vbo: 'VBO',
	xml: 'XML',
	xmlsitemap: 'XMLSitemap'
};

/** the label a reader recognises, derived rather than stored twice */
export function labelFor(name: string): string {
	const machine = name.split('/')[1] ?? name;
	return machine
		.split('_')
		.map((part) => WORD_CASING[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

/**
 * Every classified module as a row.
 *
 * `blocked` comes from the classifier, never from this file, so a capability change moves the table
 * without anyone editing it. `verified` is the only state that needs evidence recorded by hand,
 * because only a test run can establish it.
 */
export function moduleTable(
	capabilities = SHIPPED_CAPABILITIES,
	verified: Readonly<Record<string, string>> = VERIFIED_BEHAVIOURS,
	capabilityEvidence: Readonly<Record<string, string>> = CAPABILITY_EVIDENCE
): TableRow[] {
	const names = new Set([
		...Object.keys(MODULE_TIER_NOTES),
		...Object.keys(KNOWN_MODULE_CAPABILITIES)
	]);
	const rows: TableRow[] = [];
	for (const name of [...names].sort()) {
		const verdict = tierFor(name, capabilities);
		const note = MODULE_TIER_NOTES[name];
		let state: SupportState;
		let evidence: string;

		if (name in verified) {
			state = 'verified';
			// the fixture clause is appended rather than written into each entry, so a row gains or
			// loses it by moving in or out of the shipping pack
			evidence =
				(verified[name] as string) +
				(SHIPPING_PACK_CONTRIB.includes(name) ? '' : FIXTURE_CLAUSE);
		} else if (verdict.tier === 'refused') {
			state = 'blocked';
			evidence = verdict.reason ?? note?.why ?? 'refused by the capability model';
		} else if (verdict.tier === 'unknown') {
			// an unclassified module is not a support claim at all, so it stays out of the table
			continue;
		} else {
			state = 'untested';
			evidence =
				capabilityEvidence[name] ??
				note?.why ??
				verdict.reason ??
				'not enabled here; nothing has been asserted about it';
		}
		rows.push({ name, label: labelFor(name), state, evidence });
	}
	return rows;
}

/** `blocked` rows carry the lift, because a refusal without a route out is a shrug */
export function liftFor(name: string): string | null {
	return MODULE_TIER_NOTES[name]?.lift ?? null;
}
