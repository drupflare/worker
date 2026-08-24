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
	/**
	 * Capability-contract vector ids this module needs, beyond the three coarse ones.
	 *
	 * `needs` answers one question well -- can the module's outbound calls be split across
	 * invocations -- and cannot express anything else. `simple_sitemap` is the case that forced
	 * this: it refuses to install without `ext-xmlwriter`, which is neither outbound nor cron, so
	 * the coarse vocabulary scored it as installable and the install then failed on its own
	 * `hook_requirements`. Every id here is EXECUTED against the shipping interpreter by
	 * `capability-contract.spec.ts`, so a refusal on this list rests on a measurement.
	 */
	vectors?: readonly string[];
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

	// #region the 25 most-installed projects, classified 2026-08-20
	//
	// Popularity order from the August 2026 drupal.org usage snapshot, plus the four module
	// dependencies composer pulled in with them. All 25 resolve on Drupal 11.4.5 and all 25 enable
	// here, so what these entries record is the capability question, which install cannot answer.
	'drupal/entity': { needs: [], why: 'entity API helpers; bundle plugins and a duplicator' },
	'drupal/jquery_ui': {
		needs: [],
		why: 'asset libraries only. It also declares the libraries of its four sub-modules from a JSON file, through a procedural hook_library_info_alter'
	},
	'drupal/jquery_ui_autocomplete': { needs: [], why: 'one asset library, declared by jquery_ui' },
	'drupal/jquery_ui_datepicker': { needs: [], why: 'one asset library, declared by jquery_ui' },
	'drupal/jquery_ui_menu': { needs: [], why: 'one asset library, declared by jquery_ui' },
	'drupal/libraries': {
		needs: [],
		why: 'a registry of external libraries on the local file system; it reads, it does not fetch'
	},
	'drupal/better_exposed_filters': {
		needs: [],
		why: 'views exposed-filter widgets; three plugin managers over local view data'
	},
	'drupal/imce': {
		needs: [],
		why: 'a file manager over the stream wrappers this runtime already provides'
	},
	'drupal/crop': { needs: [], why: 'an entity type storing crop geometry; no I/O of its own' },
	'drupal/focal_point': {
		needs: [],
		why: 'an image effect over crop. The CROP GEOMETRY is what it stores and that needs nothing. The transform is GD, which this build does NOT have -- `get_loaded_extensions()` on the shipping binary reports 25 extensions and gd is not among them, and `CfwImageToolkit` says so outright -- so the effect is applied by Cloudflare Images at delivery. That toolkit reports full-size dimensions to contrib reading derivative pixels, which is exactly what focal_point does',
		lift: 'none for the stored focal point. The preview widget and any effect chained AFTER the crop are the parts that would need a real toolkit'
	},
	'drupal/views_bulk_operations': {
		needs: [],
		why: 'actions over view results, run through the batch API -- many requests rather than one long one, which is the shape this runtime wants'
	},
	'drupal/mailsystem': {
		needs: [],
		why: 'selects which mail plugin sends. No I/O of its own, and it is how a site points itself at `cfw_mail` instead of `php_mail`'
	},
	'drupal/colorbox': { needs: [], why: 'a lightbox; a library and a field formatter' },
	'drupal/editor_advanced_link': { needs: [], why: 'a CKEditor 5 plugin, entirely client side' },
	'drupal/backup_migrate': {
		needs: ['cron'],
		why: 'schedules are drained by cron, and a backup is a read of the database plus a write to a destination. A remote destination is outbound per destination, not per module',
		lift: 'none for the schedules; the alarm drains them. Sizing is the open question rather than the capability: a full backup as one record meets the 2,199,995-byte ceiling, so a destination here has to chunk'
	},
	'drupal/module_filter': {
		needs: [],
		why: 'filters the Extend page; a form alter and a library'
	},
	'drupal/address': {
		needs: [],
		why: 'a field type over commerceguys/addressing, whose address formats ship as JSON in the package -- so the country repository is a file read rather than a service call'
	},
	'drupal/menu_block': { needs: [], why: 'a block derivative per menu; menu rendering only' },
	'drupal/entity_browser': {
		needs: [],
		why: 'entity selection over local entities; iframes and modals around a view'
	},
	'drupal/views_data_export': {
		needs: [],
		why: 'a views display that serialises rows. The batched export is many requests, and the encoders are pure PHP'
	},
	'drupal/csv_serialization': { needs: [], why: 'a serializer encoder over league/csv' },
	'drupal/google_tag': {
		needs: [],
		why: 'it injects a snippet the BROWSER calls Google with. Nothing leaves PHP, which is why an integration that reads as outbound is not'
	},
	'drupal/externalauth': {
		needs: [],
		why: 'maps an external identity to a local account in its own `authmap` table. The outbound half belongs to whichever provider module sits on top -- openid_connect is the one that is blocked, not this'
	},
	'drupal/easy_breadcrumb': { needs: [], why: 'a breadcrumb builder over the current route' },
	'drupal/config_ignore': {
		needs: [],
		why: 'a config storage filter applied during import; no runtime I/O'
	},
	'drupal/video_embed_field': {
		needs: ['deferrable-outbound'],
		why: 'the field stores a URL and renders an iframe, which needs nothing. The THUMBNAIL is a fetch from the provider on save, and that is the one call it makes',
		lift: 'the existing GET tier covers the thumbnail; what is missing is tolerating a miss on the first save instead of blocking. Without it the field still works and the thumbnail is empty'
	},
	'drupal/svg_image': {
		needs: [],
		why: "it takes over core's `image` formatter and `image_image` widget to pass SVGs through, sanitised by enshrined/svg-sanitize. Pure PHP, and it needs no image toolkit for the SVG path"
	},
	// #endregion

	// #region cron: driven from the alarm, interval-gated and budgeted
	'drupal/scheduler': {
		needs: ['cron'],
		why: 'publishes and unpublishes on cron; the work is a bounded query per run',
		lift: 'none. `driveCron()` is imported and called by `src/site-do.ts`, so scheduler publishes on the alarm. This entry said the driver was unimported for as long as it had been wired, which is what shipping a lift text nobody re-reads costs. Cron is DRIVEN: `alarm()` calls `driveCron()` and has since it shipped, on by default, off with `DRUPAL_CRON=0`. What remains is the cadence -- interval-gated at 15 minutes (`cronDue()`) and budgeted at 6 units / 500 rows / 500 ms per firing -- so work lands within a quarter hour rather than immediately'
	},
	'drupal/simple_sitemap': {
		needs: ['cron'],
		// still keyed on the vector, but the vector now asks whether the CLASS resolves rather than
		// whether the extension was compiled in -- the second is unshimmable and is not what
		// generating a sitemap needs
		vectors: ['runtime.xmlwriter'],
		why: "generation is a queue drained by cron, plus a filesystem write per chunk. It refused to install because its `hook_requirements()` calls `extension_loaded('xmlwriter')`, which is a built-in and cannot be shimmed -- so the fix is Drupal's own `hook_requirements_alter()`, host-side, module unmodified",
		lift: 'shipped: `XMLWRITER_FIX` supplies the eleven methods 4.2.1 calls, byte-identical to libxml across eight documents including both sitemap shapes, escaping, indentation depth and the flush semantics a chunked generator depends on. `Requirements::requirementsAlter()` clears the install block only when the class is present AND round-trips a document, so a build without the polyfill keeps the honest error. What remains for `verified` is a gated enable-and-assert run that generates a real sitemap'
	},
	'drupal/search_api': {
		needs: ['cron'],
		why: 'indexing runs on cron. The DATABASE backend needs nothing else and is the supported shape here',
		lift: 'none for the database backend. A remote backend is a different module and a different tier. Cron is DRIVEN: `alarm()` calls `driveCron()` and has since it shipped, on by default, off with `DRUPAL_CRON=0`. What remains is the cadence -- interval-gated at 15 minutes (`cronDue()`) and budgeted at 6 units / 500 rows / 500 ms per firing -- so work lands within a quarter hour rather than immediately'
	},
	'drupal/queue_ui': {
		needs: ['cron'],
		why: 'a UI over Drupal queues; the queues themselves only move when cron runs them',
		lift: 'none. It also becomes the natural operator view of `cronStep()` queue units, which today have no surface at all. Cron is DRIVEN: `alarm()` calls `driveCron()` and has since it shipped, on by default, off with `DRUPAL_CRON=0`. What remains is the cadence -- interval-gated at 15 minutes (`cronDue()`) and budgeted at 6 units / 500 rows / 500 ms per firing -- so work lands within a quarter hour rather than immediately'
	},
	// RENAMED from `drupal/image_optimize`, which does not exist. `composer show` answers
	// "Package not found", so the row classified a package nobody could ever install and the
	// unresolvable name survived every review because nothing tried to fetch it. The Drupal project
	// is "Image Optimize" and its composer name is `imageapi_optimize`
	'drupal/imageapi_optimize': {
		needs: ['cron'],
		why: 'batch optimisation over managed files. The BINARY pipelines shell out and cannot work; the pure-PHP and remote-service pipelines are the ones in scope',
		lift: 'a pipeline that is neither a subprocess nor a blocking call; the batch itself is already driven. Large: most shipped pipelines are subprocess-based, so this needs a pipeline written for the platform. Cron is DRIVEN: `alarm()` calls `driveCron()` and has since it shipped, on by default, off with `DRUPAL_CRON=0`. What remains is the cadence -- interval-gated at 15 minutes (`cronDue()`) and budgeted at 6 units / 500 rows / 500 ms per firing -- so work lands within a quarter hour rather than immediately'
	},
	'drupal/migrate_plus': {
		needs: ['cron'],
		why: 'migrations run as batches. A local source (JSON on disk, another table) needs only the batch driver; a remote source is deferrable outbound on top',
		lift: 'none for the local-source case; the alarm drives the batch. Remote sources additionally need the deferred tier and a fetcher written against it. Cron is DRIVEN: `alarm()` calls `driveCron()` and has since it shipped, on by default, off with `DRUPAL_CRON=0`. What remains is the cadence -- interval-gated at 15 minutes (`cronDue()`) and budgeted at 6 units / 500 rows / 500 ms per firing -- so work lands within a quarter hour rather than immediately'
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
		lift: 'the POST tier; the cron half is already driven. Worth noting this runtime already invalidates its OWN edge by bumping the generation, so purge is only needed for a CDN in front of it'
	},
	// #endregion

	// #region refused: needs an answer inside one synchronous run
	'drupal/facets': {
		needs: [],
		why: 'facets themselves are local: they read from whatever Search API backend is configured. With the DATABASE backend this needs nothing, which is why it is not refused',
		lift: 'none required with the database backend; it inherits the backend tier'
	},
	'drupal/search_api_solr': {
		needs: ['deferrable-outbound'],
		why: "MEASURED 2026-08-23 against solarium 6.4.2, and the transport IS interceptable, which is what moved this off blocking-outbound. The default connector picks `extension_loaded('curl') ? new Curl() : new Http()` and this build has no curl extension, so it lands on the stream adapter -- which then reads `$http_response_header` and gets [], the P39 defect in a second consumer. `SolariumTransport` subscribes to Solarium's own `PreExecuteRequest`, whose response short-circuits the adapter entirely, and search_api_solr hands Drupal's dispatcher to the client, so it needs NO module change. Indexing is fully deferrable; a query pays one round trip on first ask and is cached after",
		lift: 'shipped: `Drupal\\drupflare\\Search\\SolariumTransport`, 17 assertions in `../drupflare/tests/solarium-transport.php` against real Solarium objects. What is NOT covered is a file-upload extract, which needs a streaming body and is DECLARED rather than sent empty. A live-Solr integration run is what would take this to `verified`'
	},
	// #endregion

	// #region the dependencies of a real site, added 2026-08-19
	//
	// `earth-app/mantle2` is the one workload here that somebody depends on, and NONE of its five
	// contrib dependencies was classified. Two of them are the product's own pitch rather than a
	// compatibility question: this platform REPLACES them, so a site that moves here drops the
	// dependency instead of needing it to work.
	'drupal/json_field': { needs: [], why: 'a field type storing JSON in its own column; no I/O' },
	'drupal/key': {
		needs: [],
		why: 'key management over local config and file storage. The providers that fetch from a remote vault are per-provider, not per-module'
	},
	'drupal/smtp': {
		needs: ['blocking-outbound'],
		why: 'it exists to open an SMTP socket inside the request that sends the mail, which this runtime cannot do. Measured 2026-08-20: it installs cleanly and `smtp.settings` lands, so what refuses it is the socket rather than the installer -- an install verdict was never a capability verdict',
		lift: "the replacement ships and IS now selected: `system.mail` is forced to `cfw_mail` in the settings override, so a site that drops smtp gets a working mailer rather than `php_mail`, which this runtime cannot run. AND ITS CONFIGURATION IS NOW READ, 2026-08-24: the module installs here and its socket never runs, so a site that filled in its relay and saved had a complete SMTP configuration nothing looked at, and its operator had to type the same host, port and password again as Worker vars. `CfwMail` passes `smtp.settings` to `cfwMail`, `mailEnvFromSite()` maps it onto the transport vars and the deployment's own vars still win. The settings are persisted to `cfw_meta` because the ALARM re-resolves the transport and never sees the message. So the module stays blocked -- the socket is what refuses it -- while both the capability and now the configuration are covered"
	},
	'drupal/redis': {
		needs: ['blocking-outbound'],
		why: 'an external cache backend reached over a socket on every cache get. The TCP tier does NOT lift this and it is worth being exact about why: a cache get has to answer inside the request that asked, and a deferred exchange always misses the first time. What `cfwTcp` reaches is the deferrable half -- a publish, a counter, a write nobody blocks on',
		lift: "none needed for the cache: the Durable Object's own SQLite IS the backend, so this is a dependency the architecture removes. `Drupal\\drupflare\\Network\\CfwTcp` covers the rest of what a site would reach Redis for"
	},
	'drupal/openid_connect': {
		needs: ['blocking-outbound'],
		why: 'the authorization-code exchange POSTs to the identity provider token endpoint and must have the answer before it can finish the login response. Unlike a search query there is no partial answer to render',
		lift: 'the MODULE stays refused and the CAPABILITY is covered instead, 2026-08-24. JSPI would not lift it either: `WITH_OPENSSL=0`, so PHP cannot verify an RS256 `id_token` even if handed one synchronously, and an unverified `id_token` is an unauthenticated login. `src/ops/oidc.ts` completes the exchange at a route the host owns, verifies the signature with `crypto.subtle`, and hands PHP a single-use claims ticket; `Drupal\\drupflare\\Network\\CfwOidc` maps it onto `drupal/externalauth`, which is itself `verified`. So a site gets provider login without this module. What is missing is a run against a real IdP and the setup UI'
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
