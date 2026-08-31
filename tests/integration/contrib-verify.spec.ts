import { env } from 'cloudflare:test';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { vectorFor } from '../../src/ops/capability-contract';
import { SHIPPED_CAPABILITIES } from '../../src/ops/catalog';
import { SHIPPING_PACK_CONTRIB } from '../../src/ops/module-table';
import { SUSPEND_PROBE } from '../helpers/drupal-probes';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Contrib modules, enabled and then asked to DO something.
 *
 * Contrib is a DEV DEPENDENCY here: `scripts/pack-drupal.ts` puts `modules/contrib` behind
 * `PACK_CONTRIB=1`, so the shipping artifact carries four modules and the rest are verified against a
 * build that has them. `bun run test:contrib` is that build -- it swaps a fixture pack into
 * `assets/drupal-pf`, runs this file, and puts the shipping pack back.
 *
 * **THE SKIP USED TO BE INDISTINGUISHABLE FROM A PASS.** Against the shipping pack eleven of twelve
 * cases logged `not in the mounted pack, skipped` and went green, so twelve `verified` rows had no
 * gate that could fail. Three outcomes now, decided by reading the index of the pack the object
 * actually mounted rather than by a flag anyone can forget:
 *
 *   - the pack carries it                  run the assertions
 *   - absent, and it is the SHIPPING pack  `ctx.skip()`, which the reporter counts as skipped
 *   - absent, and it is a FIXTURE pack     fail: the fixture build was supposed to carry it
 *
 * **EVERY CASE ASSERTS BOTH DIRECTIONS.** The observable is read before the enable and after it, and
 * the before reading must NOT show it. A one-sided assertion cannot tell a module that did something
 * from an observable the shipped site already had -- which is how `pathauto` was once read as working
 * off an alias no pattern of its own produced. It has already earned its place: `menu_block` was
 * written against `access_check.admin_menu_block_page`, which reads as its service and is core's,
 * and the before reading is what said so.
 *
 * Falsified 2026-08-20, both directions, 41/41 red each time. Map every name in {@link CASES}
 * through `'zz' + name` and each row fails on its own observable; enable a DIFFERENT module in place
 * of the case's and each row fails again, `svg_image` reporting core's `ImageFormatter` back.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;

const call = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<Payload>);

const migrate = (site: ServeDo) => call(site, '/__migrate?all=1&prefill=0');
const enable = (site: ServeDo, module: string) =>
	call(site, `/__enable?module=${encodeURIComponent(module)}`);
const sql = (site: ServeDo, query: string) => call(site, `/__sql?q=${encodeURIComponent(query)}`);
const rows = (reply: Payload): Record<string, unknown>[] =>
	Array.isArray(reply['rows']) ? (reply['rows'] as Record<string, unknown>[]) : [];

// #region what the mounted pack carries

/**
 * The contrib machine names in the index the Durable Object mounts.
 *
 * Read through the real ASSETS binding, so it is the same bytes `mountDrupalLazy()` fetches. As text
 * plus a scan rather than `JSON.parse`, because the fixture index is 1.7 MB and every path in it is
 * a string this only has to match against.
 */
let packedOnce: Promise<Set<string>> | null = null;
function packedContrib(): Promise<Set<string>> {
	packedOnce ??= (async () => {
		const res = await env.ASSETS.fetch(new URL('https://a.local/drupal-pf/core.pf.json'));
		if (!res.ok) throw new Error(`pack index not reachable: core.pf.json ${res.status}`);
		const found = new Set<string>();
		// BOTH prefixes: composer/installers puts a theme under `themes/contrib`, so scanning
		// modules alone reported every contrib theme as absent from a pack that carries it
		for (const m of (await res.text()).matchAll(/"(?:modules|themes)\/contrib\/([^/"]+)\//g)) {
			found.add(m[1] as string);
		}
		return found;
	})();
	return packedOnce;
}

const shippingNames = SHIPPING_PACK_CONTRIB.map((n) => n.split('/')[1] as string);

/** a pack carrying anything past the shipping four is a fixture build, and owes every case */
const isFixturePack = (packed: Set<string>) =>
	[...packed].some((name) => !shippingNames.includes(name));

async function reachable(ctx: TestContext, module: string): Promise<boolean> {
	const packed = await packedContrib();
	if (packed.has(module)) return true;
	if (isFixturePack(packed)) {
		throw new Error(
			`${module} is not in the mounted FIXTURE pack. The fixture build carries ` +
				`modules/contrib wholesale, so this means composer never installed it: ` +
				`composer require --dev drupal/${module} in drupal-src, then re-run`
		);
	}
	ctx.skip(
		`${module} is not in the shipping pack, so nothing re-established this row. ` +
			'`bun run test:contrib` mounts the fixture build that can.'
	);
	return false;
}

// #endregion

// #region the report row every case contributes

type Verdict = 'verified' | 'blocked' | 'failed';

type Row = {
	module: string;
	enabled: boolean;
	observable: string;
	charged: number;
	verdict: Verdict;
};

const report: Row[] = [];

afterAll(() => {
	if (report.length === 0) return;
	const header = ['module', 'enabled', 'observable asserted', 'charged rows', 'verdict'];
	const body = report
		.sort((a, b) => a.module.localeCompare(b.module))
		.map((r) => [r.module, r.enabled ? 'y' : 'n', r.observable, String(r.charged), r.verdict]);
	const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
	const line = (cells: string[]) =>
		`| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
	console.log(
		['', line(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...body.map(line)]
			.map((l) => `[contrib] ${l}`)
			.join('\n')
	);
});

// #endregion

// #region the two probes

/** the four SQL surfaces an install can change, read as one row each so `/__sql` never truncates */
const SNAPSHOT = {
	tables: "SELECT group_concat(name) AS v FROM sqlite_master WHERE type = 'table'",
	config: 'SELECT group_concat(name) AS v FROM config',
	routes: 'SELECT group_concat(name) AS v FROM router',
	types: "SELECT group_concat(name) AS v FROM key_value WHERE name LIKE '%.entity_type'"
} as const;

type Surface = keyof typeof SNAPSHOT;
type Snapshot = Record<Surface, Set<string>>;

async function snapshot(site: ServeDo): Promise<Snapshot> {
	const out = {} as Snapshot;
	for (const key of Object.keys(SNAPSHOT) as Surface[]) {
		const reply = await sql(site, SNAPSHOT[key]);
		const v = rows(reply)[0]?.['v'];
		out[key] = new Set((typeof v === 'string' ? v : '').split(',').filter(Boolean));
	}
	return out;
}

/**
 * What a module adds to the CONTAINER, for the modules that create no table and ship no settings.
 *
 * `common.inc` first, and it is not optional: `CSS_COMPONENT` and `JS_LIBRARY` are defined there
 * rather than by the autoloader, so library discovery and every plugin manager that resolves a
 * library throw `Invalid CSS category` from a kernel boot that has not loaded it. A request on the
 * stack for the same class of reason -- `CurrentRouteMatch` refuses a null request -- and
 * `loadAll()` because a procedural `hook_library_info_alter` in a `.module` file does not exist
 * until its file is included, which is how `jquery_ui` declares the libraries of its four
 * sub-modules.
 */
type AskSpec = {
	services?: readonly string[];
	/** `[plugin manager service, plugin id]`; ownership is provider OR class naming the module */
	plugins?: readonly (readonly [string, string])[];
	/** the extension whose libraries to list, when the module's whole output is asset libraries */
	libraries?: string;
	encodings?: readonly string[];
};

const askProbe = (spec: AskSpec) => String.raw`<?php
$spec = json_decode(${JSON.stringify(JSON.stringify(spec))}, true);
$out = ['ok' => true];
if (!defined('CSS_COMPONENT')) { require_once '/drupal/core/includes/common.inc'; }
\Drupal::service('request_stack')->push(\Symfony\Component\HttpFoundation\Request::create('/', 'GET'));
\Drupal::moduleHandler()->loadAll();
$c = \Drupal::getContainer();
$services = [];
foreach (($spec['services'] ?? []) as $id) { $services[$id] = $c->has($id); }
$out['services'] = $services;
$plugins = [];
foreach (($spec['plugins'] ?? []) as $want) {
  $key = $want[0] . ' ' . $want[1];
  try {
    $def = \Drupal::service($want[0])->getDefinition($want[1], false);
    if ($def === null) { $plugins[$key] = null; }
    elseif (is_array($def)) { $plugins[$key] = ($def['provider'] ?? '') . '|' . ($def['class'] ?? ''); }
    else {
      $provider = method_exists($def, 'getProvider') ? $def->getProvider() : '';
      $class = method_exists($def, 'getClass') ? $def->getClass() : '';
      $plugins[$key] = $provider . '|' . $class;
    }
  } catch (\Throwable $e) { $plugins[$key] = 'ERR:' . $e->getMessage(); }
}
$out['plugins'] = $plugins;
if (isset($spec['libraries'])) {
  try {
    $out['libraries'] = array_keys(\Drupal::service('library.discovery')->getLibrariesByExtension($spec['libraries']));
  } catch (\Throwable $e) { $out['libraries'] = []; }
}
$encodings = [];
foreach (($spec['encodings'] ?? []) as $format) {
  try { $encodings[$format] = \Drupal::service('serializer')->supportsEncoding($format); }
  catch (\Throwable $e) { $encodings[$format] = false; }
}
$out['encodings'] = $encodings;
// the control: a core service the probe must see either way, so an all-false reading reads as a
// broken probe rather than as a module that did nothing
$out['control'] = $c->has('entity_type.manager');
echo json_encode($out);`;

// #endregion

// #region the cases

/**
 * A module and the thing it has to have DONE.
 *
 * Every field is a name the module owns, and each is asserted absent before the enable and present
 * after. `routes` is a floor rather than a list where the module's route names are derivative or
 * numerous; a floor of zero would assert nothing, so it is only set where it is meaningful.
 */
type Case = {
	module: string;
	/** one line for the report, naming what was actually asserted */
	observable: string;
	tables?: readonly string[];
	config?: readonly string[];
	types?: readonly string[];
	routes?: number;
	ask?: AskSpec;
	/**
	 * A module the classifier REFUSES.
	 *
	 * The case still enables it, because "cannot work here" is a claim about the capability and not
	 * about the installer -- and the two were never the same thing. What it may not do is reach
	 * `verified`: the run additionally asserts the mechanism the refusal rests on is still in force,
	 * so the row is blocked against a measurement rather than against a constant.
	 */
	blocked?: string;
	/**
	 * A module whose own `hook_requirements()` REFUSES the install.
	 *
	 * A different thing from `blocked`, which covers a module that installs and then cannot do its
	 * job. Here the installer declines, so there is no container to inspect and the observable is
	 * the refusal itself. The value is the capability-contract vector the requirement rests on.
	 */
	refusesToInstall?: string;
};

const CASES: readonly Case[] = [
	{
		module: 'filefield_sources',
		observable:
			'its source plugin manager, its access check and its field-widget third-party settings',
		ask: {
			services: [
				'plugin.manager.filefield_sources',
				'access_check.filefield_sources.field',
				'filefield_sources'
			]
		}
	},
	{
		module: 'imageapi_optimize',
		observable:
			'its processor plugin manager, its settings and the pipeline config entity type',
		ask: { services: ['plugin.manager.imageapi_optimize.processor'] },
		config: ['imageapi_optimize.settings'],
		types: ['imageapi_optimize_pipeline.entity_type']
	},
	{
		module: 'coffee',
		observable: 'its url generator service and the configuration entity it installs',
		ask: { services: ['coffee.url_generator'] },
		config: ['coffee.configuration']
	},
	{
		module: 'devel',
		observable: 'its dumper plugin manager, four event subscribers and its own menu',
		ask: {
			services: [
				'devel.dumper',
				'plugin.manager.devel_dumper',
				'devel.route_subscriber',
				'devel.error_subscriber'
			]
		},
		config: ['devel.settings', 'system.menu.devel']
	},
	{
		module: 'facets',
		observable: 'its five plugin managers, which are the whole extension point',
		ask: {
			services: [
				'plugin.manager.facets.query_type',
				'plugin.manager.facets.widget',
				'plugin.manager.facets.facet_source',
				'plugin.manager.facets.processor',
				'plugin.manager.facets.url_processor'
			]
		}
	},
	{
		module: 'google_analytics',
		observable: 'its visibility/accounts services and its settings config',
		ask: {
			services: [
				'google_analytics.visibility',
				'google_analytics.accounts',
				'google_analytics.javascript_cache'
			]
		},
		config: ['google_analytics.settings']
	},
	{
		module: 'json_field',
		observable: 'the field type it registers plus its own serializer normalizer',
		// NOT `serializer.normalizer.json_item.native`. It is a TAGGED service, so the compiler
		// folds it into the serializer's collection and drops it from the public map -- asking the
		// container for it by id fails on a module that installed perfectly
		ask: {
			services: ['json_field.views'],
			plugins: [['plugin.manager.field.field_type', 'json']]
		}
	},
	{
		module: 'key',
		observable: 'its repository and three plugin managers',
		ask: {
			services: [
				'key.repository',
				'plugin.manager.key.key_type',
				'plugin.manager.key.key_provider',
				'plugin.manager.key.key_input'
			]
		},
		types: ['key.entity_type']
	},
	{
		module: 'linkit',
		observable: 'its matcher and substitution managers plus the suggestion manager',
		ask: {
			services: [
				'plugin.manager.linkit.matcher',
				'plugin.manager.linkit.substitution',
				'linkit.suggestion_manager'
			]
		},
		types: ['linkit_profile.entity_type']
	},
	{
		module: 'purge',
		observable: 'its queue, processors and purgers services',
		ask: {
			services: [
				'purge.queue',
				'purge.processors',
				'purge.purgers',
				'purge.invalidation.factory'
			]
		}
	},
	{
		module: 'simple_sitemap',
		observable: 'its generator, queue worker and sitemap writer, plus both of its entity types',
		// this asserted `refusesToInstall: 'runtime.xmlwriter'` until the pure-PHP XMLWriter and
		// `hook_requirements_alter()` landed; the case then FAILED saying the module installed
		ask: {
			services: [
				'simple_sitemap.generator',
				'simple_sitemap.queue_worker',
				'simple_sitemap.sitemap_writer'
			]
		},
		types: ['simple_sitemap.entity_type', 'simple_sitemap_type.entity_type'],
		config: ['simple_sitemap.settings']
	},
	{
		module: 'twig_tweak',
		observable: 'its twig extension and the five view builders it adds',
		ask: {
			services: [
				'twig_tweak.twig_extension',
				'twig_tweak.block_view_builder',
				'twig_tweak.region_view_builder',
				'twig_tweak.entity_view_builder'
			]
		}
	},
	{
		module: 'webform',
		observable: 'its five plugin managers, its submission table and its shipped option sets',
		ask: {
			services: [
				'plugin.manager.webform.element',
				'plugin.manager.webform.handler',
				'plugin.manager.webform.variant',
				'plugin.manager.webform.exporter'
			]
		},
		tables: ['webform'],
		config: ['webform.webform_options.months']
	},
	{
		module: 'xmlsitemap',
		observable: 'its generator and link storage, its table and its settings',
		ask: { services: ['xmlsitemap_generator', 'xmlsitemap.link_storage'] },
		tables: ['xmlsitemap'],
		config: ['xmlsitemap.settings']
	},
	{
		module: 'address',
		observable: 'field types address/address_country/address_zone, address.country_repository',
		ask: {
			services: [
				'address.country_repository',
				'address.address_format_repository',
				'address.subdivision_repository'
			],
			plugins: [
				['plugin.manager.field.field_type', 'address'],
				['plugin.manager.field.widget', 'address_default']
			]
		}
	},
	{
		module: 'backup_migrate',
		observable: 'its four config entity types plus the six default source/destination entities',
		config: [
			'backup_migrate.backup_migrate_source.default_db',
			'backup_migrate.backup_migrate_destination.private_files',
			'backup_migrate.backup_migrate_schedule.daily_schedule'
		],
		types: [
			'backup_migrate_source.entity_type',
			'backup_migrate_destination.entity_type',
			'backup_migrate_schedule.entity_type'
		],
		routes: 20
	},
	{
		module: 'better_exposed_filters',
		observable: 'its three widget plugin managers and bef_helper in the container',
		ask: {
			services: [
				'better_exposed_filters.bef_helper',
				'plugin.manager.better_exposed_filters_filter_widget',
				'plugin.manager.better_exposed_filters_pager_widget',
				'plugin.manager.better_exposed_filters_sort_widget'
			]
		}
	},
	{
		module: 'captcha',
		observable: 'the captcha_sessions table its schema hook creates, plus 5 captcha points',
		tables: ['captcha_sessions'],
		config: ['captcha.settings', 'captcha.captcha_point.user_login_form'],
		types: ['captcha_point.entity_type'],
		routes: 8
	},
	{
		module: 'colorbox',
		observable: 'colorbox.settings and its admin route',
		config: ['colorbox.settings'],
		routes: 1
	},
	{
		module: 'config_ignore',
		observable: 'config_ignore.settings and its admin route',
		config: ['config_ignore.settings'],
		routes: 1
	},
	{
		module: 'crop',
		observable: 'the crop entity type as four tables, and crop_type as a config entity type',
		tables: ['crop', 'crop_field_data', 'crop_revision', 'crop_field_revision'],
		config: ['crop.settings'],
		types: ['crop.entity_type', 'crop_type.entity_type'],
		routes: 5
	},
	{
		module: 'csv_serialization',
		observable: "serializer->supportsEncoding('csv'), with json as the control",
		ask: { encodings: ['csv', 'json'] }
	},
	{
		module: 'easy_breadcrumb',
		observable: 'easy_breadcrumb.settings and its admin route',
		config: ['easy_breadcrumb.settings'],
		routes: 1
	},
	{
		module: 'editor_advanced_link',
		observable: 'the editor_advanced_link_link CKEditor 5 plugin and its two libraries',
		ask: {
			plugins: [['plugin.manager.ckeditor5.plugin', 'editor_advanced_link_link']],
			libraries: 'editor_advanced_link'
		}
	},
	{
		module: 'entity',
		observable: 'the bundle-plugin services it exists to provide',
		ask: {
			services: [
				'entity.bundle_plugin_installer',
				'entity.bundle_entity_duplicator',
				'access_checker.entity_revision'
			]
		}
	},
	{
		module: 'entity_browser',
		observable: 'the entity_browser config entity type and its six routes',
		types: ['entity_browser.entity_type'],
		routes: 6
	},
	{
		module: 'entity_reference_revisions',
		observable: 'the entity_reference_revisions field type and its orphan purger',
		ask: {
			services: ['entity_reference_revisions.orphan_purger'],
			plugins: [
				['plugin.manager.field.field_type', 'entity_reference_revisions'],
				['plugin.manager.field.formatter', 'entity_reference_revisions_entity_view']
			]
		}
	},
	{
		module: 'externalauth',
		observable: 'the authmap table its schema hook creates',
		tables: ['authmap'],
		config: ['views.view.authmap'],
		routes: 2
	},
	{
		module: 'field_group',
		observable: 'its plugin manager, subscriber and param converter in the container',
		ask: {
			services: [
				'plugin.manager.field_group.formatters',
				'field_group.subscriber',
				'field_group.param_converter'
			]
		},
		routes: 30
	},
	{
		module: 'focal_point',
		observable: 'focal_point.settings and the focal_point crop type it installs into crop',
		config: ['focal_point.settings', 'crop.type.focal_point'],
		tables: ['crop', 'crop_field_data'],
		routes: 5
	},
	{
		module: 'google_tag',
		observable: 'the google_tag_container config entity type and google_tag.settings',
		config: ['google_tag.settings'],
		types: ['google_tag_container.entity_type'],
		routes: 8
	},
	{
		module: 'honeypot',
		observable: 'the honeypot_user table, which is what it uses instead of a remote captcha',
		tables: ['honeypot_user'],
		config: ['honeypot.settings'],
		routes: 1
	},
	{
		module: 'imce',
		observable: 'the imce_profile config entity type and the two profiles it ships',
		config: ['imce.settings', 'imce.profile.admin', 'imce.profile.member'],
		types: ['imce_profile.entity_type'],
		routes: 9
	},
	{
		module: 'jquery_ui',
		observable: 'the asset libraries it exists to provide, core and widget among them',
		ask: { libraries: 'jquery_ui' }
	},
	{
		module: 'jquery_ui_autocomplete',
		observable: 'the autocomplete library jquery_ui declares on its behalf',
		ask: { libraries: 'jquery_ui_autocomplete' }
	},
	{
		module: 'jquery_ui_datepicker',
		observable: 'the datepicker library jquery_ui declares on its behalf',
		ask: { libraries: 'jquery_ui_datepicker' }
	},
	{
		module: 'jquery_ui_menu',
		observable: 'the menu library jquery_ui declares on its behalf',
		ask: { libraries: 'jquery_ui_menu' }
	},
	{
		module: 'libraries',
		observable: 'libraries.settings, which is where its external library definitions are read',
		config: ['libraries.settings']
	},
	{
		module: 'mailsystem',
		observable: 'mailsystem.settings and its admin route',
		config: ['mailsystem.settings'],
		routes: 1
	},
	{
		module: 'menu_block',
		observable: 'a menu_block: block plugin derivative per menu',
		// `access_check.admin_menu_block_page` looks like its service and is core's, from the block
		// module. The before reading is what caught that; it is not asserted here
		ask: {
			plugins: [
				['plugin.manager.block', 'menu_block:main'],
				['plugin.manager.block', 'menu_block:footer']
			]
		}
	},
	{
		module: 'metatag',
		observable: 'the metatag_defaults config entity type and the seven defaults it ships',
		config: [
			'metatag.settings',
			'metatag.metatag_defaults.global',
			'metatag.metatag_defaults.404'
		],
		types: ['metatag_defaults.entity_type'],
		routes: 8
	},
	{
		module: 'migrate_plus',
		observable: 'both config entity types it provides -- migration and migration_group',
		types: ['migration.entity_type', 'migration_group.entity_type'],
		tables: ['cache_discovery_migration'],
		routes: 2
	},
	{
		module: 'module_filter',
		observable: 'module_filter.settings and its admin route',
		config: ['module_filter.settings'],
		routes: 1
	},
	{
		module: 'paragraphs',
		observable: 'the paragraph entity type as four tables',
		tables: [
			'paragraphs_item',
			'paragraphs_item_field_data',
			'paragraphs_item_revision',
			'paragraphs_item_revision_field_data'
		],
		types: ['paragraph.entity_type', 'paragraphs_type.entity_type'],
		routes: 20
	},
	{
		module: 'queue_ui',
		observable: 'its admin routes, which are the whole module',
		routes: 9
	},
	{
		module: 'recaptcha',
		observable: 'recaptcha.settings, and captcha_sessions from the dependency it pulled in',
		config: ['recaptcha.settings', 'captcha.settings'],
		tables: ['captcha_sessions'],
		routes: 9
	},
	{
		module: 'redirect',
		observable: 'the redirect entity type as a table, and its routes',
		tables: ['redirect'],
		config: ['redirect.settings'],
		types: ['redirect.entity_type'],
		routes: 11
	},
	{
		module: 'scheduler',
		observable: 'scheduler.settings and the three views it installs',
		config: ['scheduler.settings', 'views.view.scheduler_scheduled_content'],
		routes: 9
	},
	{
		module: 'search_api',
		observable: 'search_api_item and search_api_task, where the database backend writes',
		tables: ['search_api_item', 'search_api_task'],
		config: ['search_api.settings'],
		types: ['search_api_index.entity_type', 'search_api_server.entity_type'],
		routes: 25
	},
	{
		module: 'smtp',
		observable: 'smtp.settings installs; the socket it exists to open still cannot be opened',
		config: ['smtp.settings'],
		routes: 1,
		blocked: 'it needs an SMTP socket inside the request that sends the mail'
	},
	{
		module: 'stage_file_proxy',
		observable: 'stage_file_proxy.settings, which is what its fetch path reads',
		config: ['stage_file_proxy.settings'],
		routes: 1
	},
	{
		module: 'svg_image',
		observable: "it takes over core's image field formatter and image_image widget",
		ask: {
			plugins: [
				['plugin.manager.field.formatter', 'image'],
				['plugin.manager.field.widget', 'image_image']
			]
		}
	},
	{
		module: 'video_embed_field',
		observable: 'the video_embed_field field type and its provider manager',
		ask: {
			services: ['video_embed_field.provider_manager'],
			plugins: [
				['plugin.manager.field.field_type', 'video_embed_field'],
				['plugin.manager.field.formatter', 'video_embed_field_video']
			]
		}
	},
	{
		module: 'views_bulk_operations',
		observable: 'its processor and action plugin manager, plus the delete action it ships',
		ask: {
			services: [
				'views_bulk_operations.processor',
				'views_bulk_operations.data',
				'plugin.manager.views_bulk_operations_action'
			],
			plugins: [['plugin.manager.action', 'views_bulk_operations_delete_entity']]
		},
		routes: 4
	},
	{
		module: 'views_data_export',
		observable: 'the data_export views display and style plugins',
		ask: {
			plugins: [
				['plugin.manager.views.display', 'data_export'],
				['plugin.manager.views.style', 'data_export']
			]
		}
	},
	{
		module: 'search_api_solr',
		observable:
			'its connector manager, solarium.query_helper and its four solr config entity types',
		ask: { services: ['plugin.manager.search_api_solr.connector', 'solarium.query_helper'] },
		types: [
			'solr_cache.entity_type',
			'solr_field_type.entity_type',
			'solr_request_handler.entity_type',
			'solr_request_dispatcher.entity_type'
		]
	},
	{
		module: 'usfedgov_google_analytics',
		observable: 'its three hook services, its DAP settings and the seven analytics libraries',
		ask: {
			services: [
				'Drupal\\usfedgov_google_analytics\\Hook\\PageAttachments',
				'Drupal\\usfedgov_google_analytics\\Hook\\JsUrlQueryBuilder',
				'Drupal\\usfedgov_google_analytics\\Hook\\RuntimeRequirements'
			],
			libraries: 'usfedgov_google_analytics'
		},
		config: ['usfedgov_google_analytics.settings'],
		routes: 1
	},
	{
		module: 'metatag_search_gov',
		observable: 'the search_gov metatag group and its three searchgov_custom tag plugins',
		// no config, no table, no route of its own, so the plugin definitions ARE the module. The
		// managers belong to metatag, which the install pulls in; the definitions name this module
		ask: {
			plugins: [
				['plugin.manager.metatag.group', 'search_gov'],
				['plugin.manager.metatag.tag', 'searchgov_custom1'],
				['plugin.manager.metatag.tag', 'searchgov_custom3']
			]
		}
	},
	{
		module: 'search_gov_results_api',
		observable: 'its two routes install; the GET to api.gsa.gov that fills them cannot run',
		routes: 1,
		blocked: 'its results page needs an outbound GET to answer inside the render that asked'
	},
	{
		module: 'uswds_base',
		// THE ONLY THEME IN THIS FILE. It installs through `theme_installer`, so its observable is
		// `core.extension`'s THEME key rather than its module key, and the asset libraries are what
		// a theme owns in place of services -- there are no PHP classes to resolve
		observable: 'the theme installs and its own USWDS asset libraries resolve',
		ask: { libraries: 'uswds_base' }
	}
];

/**
 * Contrib the fixture pack carries with no case of its own.
 *
 * Listed rather than tolerated, because a module in the pack and in nobody's assertion is the
 * stale-exemption shape: `everything the pack carries is covered` below fails on an addition, and
 * this is where an addition is answered explicitly.
 */
const COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
	admin_toolbar: 'shipping pack; tests/integration/module-behaviour.spec.ts',
	ctools: 'shipping pack; tests/integration/module-behaviour.spec.ts',
	pathauto: 'shipping pack; tests/integration/module-behaviour.spec.ts',
	token: 'shipping pack; tests/integration/module-behaviour.spec.ts'
};

// #endregion

/** the names a case declared, so the before reading can be checked for every one of them */
function declared(one: Case): Array<[Surface, string]> {
	const out: Array<[Surface, string]> = [];
	for (const surface of ['tables', 'config', 'types'] as const) {
		for (const name of one[surface] ?? []) out.push([surface, name]);
	}
	return out;
}

const added = (before: Set<string>, after: Set<string>) => [...after].filter((x) => !before.has(x));

/** ownership: the definition names the module, either as its provider or in its class */
const owns = (value: unknown, module: string) =>
	typeof value === 'string' && (value.split('|')[0] === module || value.includes(module));

describe('contrib modules, enabled against a real site', () => {
	for (const one of CASES) {
		it(
			`${one.module}: ${one.observable}`,
			async (ctx) => {
				if (!(await reachable(ctx, one.module))) return;

				const out = await inObject(freshSite(), async (site) => {
					await migrate(site);
					const before = await snapshot(site);
					let askBefore: Payload | null = null;
					if (one.ask) {
						await site.runJson(BOOT_KERNEL);
						askBefore = await site.runJson(askProbe(one.ask));
					}
					const enabled = await enable(site, one.module);
					const after = await snapshot(site);
					let askAfter: Payload | null = null;
					if (one.ask) {
						// on a dropped interpreter, which is what `/__enable` leaves behind: the
						// install rebuilt the container, so a service resolved in the same breath
						// could still be answered by the graph already in memory
						await site.runJson(BOOT_KERNEL);
						askAfter = await site.runJson(askProbe(one.ask));
					}
					let suspend: Payload | null = null;
					if (one.blocked) {
						await site.runJson(BOOT_KERNEL);
						suspend = await site.runJson(SUSPEND_PROBE);
					}
					return { enabled, before, after, askBefore, askAfter, suspend };
				});

				const charged = Number(out.enabled['rowsWritten'] ?? 0);
				const row: Row = {
					module: one.module,
					enabled: out.enabled['nowEnabled'] === true,
					observable: one.observable,
					charged,
					verdict: 'failed'
				};
				report.push(row);

				if (one.refusesToInstall) {
					// the refusal IS the observable. Asserted on `requirementsPass` rather than on
					// `ok` alone, so an install that failed for an unrelated reason cannot pass as
					// this module declining on its own requirement
					expect(
						out.enabled['ok'],
						`${one.module} installed, and it was expected to refuse on ${one.refusesToInstall}`
					).toBe(false);
					expect(
						out.enabled['requirementsPass'],
						`${one.module} failed for something other than its own requirements: ${JSON.stringify(out.enabled).slice(0, 300)}`
					).toBe(false);
					const vector = vectorFor(one.refusesToInstall);
					expect(
						vector,
						`${one.refusesToInstall} is not a contract vector`
					).toBeDefined();
					expect(
						vector?.expected,
						`${one.module} is blocked on ${one.refusesToInstall}, which the runtime now satisfies`
					).toBe(false);
					row.verdict = 'blocked';
					return;
				}

				expect(
					out.enabled['ok'],
					`${one.module} failed to install: ${JSON.stringify(out.enabled).slice(0, 400)}`
				).toBe(true);
				expect(out.enabled['nowEnabled'], `${one.module} is not in core.extension`).toBe(
					true
				);

				for (const [surface, name] of declared(one)) {
					expect(
						out.after[surface].has(name),
						`${one.module}: ${surface} is missing ${name} after the install`
					).toBe(true);
					expect(
						out.before[surface].has(name),
						`${one.module}: ${surface} already had ${name} before the install, so it is ` +
							'not this module that produced it'
					).toBe(false);
				}

				if (one.routes !== undefined) {
					const own = added(out.before.routes, out.after.routes);
					expect(
						own.length,
						`${one.module} registered ${own.length} routes, wanted at least ${one.routes}`
					).toBeGreaterThanOrEqual(one.routes);
				}

				if (one.ask) {
					const before = out.askBefore as Payload;
					const after = out.askAfter as Payload;
					expect(
						after['control'],
						`${one.module}: CONTROL, the probe cannot see the container`
					).toBe(true);
					expect(before['control']).toBe(true);

					const serviceBefore = (before['services'] ?? {}) as Record<string, unknown>;
					const serviceAfter = (after['services'] ?? {}) as Record<string, unknown>;
					for (const id of one.ask.services ?? []) {
						expect(
							serviceAfter[id],
							`${one.module}: ${id} is not in the container`
						).toBe(true);
						expect(
							serviceBefore[id],
							`${one.module}: ${id} was in the container before the install`
						).toBe(false);
					}

					const pluginBefore = (before['plugins'] ?? {}) as Record<string, unknown>;
					const pluginAfter = (after['plugins'] ?? {}) as Record<string, unknown>;
					for (const [manager, id] of one.ask.plugins ?? []) {
						const key = `${manager} ${id}`;
						expect(
							owns(pluginAfter[key], one.module),
							`${one.module}: ${id} is ${JSON.stringify(pluginAfter[key])}, which does ` +
								'not name this module'
						).toBe(true);
						expect(
							owns(pluginBefore[key], one.module),
							`${one.module}: ${id} already named this module before the install`
						).toBe(false);
					}

					if (one.ask.libraries !== undefined) {
						const list = (after['libraries'] ?? []) as string[];
						const was = (before['libraries'] ?? []) as string[];
						expect(
							list.length,
							`${one.module} declared no asset library`
						).toBeGreaterThan(0);
						expect(
							was.length,
							`${one.module} declared libraries before the install`
						).toBe(0);
					}

					for (const format of one.ask.encodings ?? []) {
						const now = (after['encodings'] ?? {}) as Record<string, unknown>;
						expect(now[format], `${one.module}: ${format} encoding unsupported`).toBe(
							true
						);
					}
				}

				if (one.blocked) {
					const suspend = out.suspend as Payload;
					// the host sets the flag on every build, so a null here means the probe missed
					// rather than that the build cannot suspend
					expect(
						suspend['hasVrznoEnv'],
						`${one.module}: no vrzno_env, so this probe cannot see the flag`
					).toBe(true);
					expect(
						suspend['canSuspend'],
						`${one.module} is blocked on ${one.blocked}, and the interpreter now says it CAN suspend`
					).toBe(false);
					expect(SHIPPED_CAPABILITIES.blockingOutbound).toBe(suspend['canSuspend']);
				}

				row.verdict = one.blocked ? 'blocked' : 'verified';
			},
			REQUEST_TIMEOUT
		);
	}

	/**
	 * `search_gov_results_api` rendering real results, over two renders.
	 *
	 * Its own case above asserts only that the routes install, because its results page GETs
	 * `api.gsa.gov` while BUILDING the form. That reads as a refusal and is not one: the deferred
	 * tier carries the call, so the first render rejects and queues and a later render answers.
	 *
	 * The network is the dependency, so the network is what gets stubbed -- the module's own request
	 * building, JSON decode, node resolution and render array all run for real. The queued URL is
	 * READ BACK rather than reconstructed here, so nothing in this test has to know how the module
	 * spells its query string; getting that wrong would seed a row the module never looks for and
	 * the test would pass by asserting a miss.
	 */
	it(
		'renders Search.gov results on the render after the one that asked',
		async () => {
			const packed = await packedContrib();
			if (!packed.has('search_gov_results_api')) return;

			const searchPath = '/search?search=benefits';
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				await enable(site, 'search_gov_results_api');
				// the enable drops the interpreter, and its `.module` carries a procedural
				// `hook_preprocess_node` that Drupal 11 resolves as a CLASS when the file is not loaded
				await site.runJson(BOOT_KERNEL);
				const setup = (await site.runJson(`<?php
				// SAVED_NEW, MARK_NEW and CSS_COMPONENT live in the legacy includes, which
				// DrupalKernel loads from preHandle() rather than boot() -- so a bare kernel cannot
				// save an entity or render a node teaser
				$kernel = $GLOBALS['__pw_kernel'] ?? null;
				if ($kernel !== null && method_exists($kernel, 'loadLegacyIncludes')) {
					$kernel->loadLegacyIncludes();
				}
				\\Drupal::moduleHandler()->loadAll();
				\\Drupal::configFactory()->getEditable('search_gov_results_api.settings')
					->set('site_handle', 'cfw-test')
					->set('api_key', 'cfw-test-key')
					->set('site_base', 'https://example.gov')
					->set('display_mode', 'node.teaser')
					->set('results_per_page', 20)
					->set('facets', ['enable' => false])
					->save();
				// the module maps a Search.gov url back to a LOCAL node and renders its teaser, so
				// the assertion needs a node for the stubbed result to resolve to
				$node = \\Drupal\\node\\Entity\\Node::create([
					'type' => 'page',
					'title' => 'Veterans Benefits',
					'status' => 1,
				]);
				$node->save();
				echo json_encode(['nid' => (int) $node->id()]);`)) as Payload;
				const nid = Number(setup['nid'] ?? 0);
				if (!nid)
					throw new Error(`node not created: ${JSON.stringify(setup).slice(0, 400)}`);

				// THE PRODUCTION RENDER PATH, not a hand-built request. Reconstructing one by hand needs
				// a session, a render context and a base url before Drupal will render a node teaser,
				// and getting any of them wrong measures the harness instead of the module
				site.ensureHttpTables();
				const serve = (p: string) =>
					site.fetch(
						new Request(`https://do.local/__serve?path=${encodeURIComponent(p)}&edge=0`)
					);
				const first = await serve(searchPath);
				const queued = site.sql
					.exec('SELECT key, url FROM cfw_http_queue')
					.toArray() as unknown as { key: string; url: string }[];

				const reply = JSON.stringify({
					web: {
						total: 1,
						results: [
							{
								title: 'Veterans Benefits',
								url: `https://example.gov/node/${nid}`,
								snippet: 'A stubbed Search.gov result body'
							}
						]
					}
				});
				for (const row of queued) {
					site.sql.exec('DELETE FROM cfw_http_queue WHERE key = ?', row.key);
					site.sql.exec(
						`INSERT INTO cfw_http_cache (key, url, status, headers, body, fetched_at, expires_at)
					 VALUES (?, ?, 200, ?, ?, ?, ?)`,
						row.key,
						row.url,
						JSON.stringify({ 'content-type': 'application/json' }),
						reply,
						site.nowMs(),
						site.nowMs() + 3_600_000
					);
				}
				// the stored page would answer the second request without rendering
				site.sql.exec('DELETE FROM cfw_page');
				const second = await serve(searchPath);
				const requeued = site.sql
					.exec('SELECT url FROM cfw_http_queue')
					.toArray() as unknown as { url: string }[];
				const cached = site.sql
					.exec('SELECT key, status, length(body) AS n FROM cfw_http_cache')
					.toArray() as unknown as { key: string; status: number; n: number }[];

				return {
					requeued,
					cached,
					queued,
					nid,
					firstHtml: await first.text(),
					secondHtml: await second.text()
				};
			});

			const queued = out.queued as { url: string }[];
			const firstHtml = String(out.firstHtml ?? '');
			const secondHtml = String(out.secondHtml ?? '');
			console.log(
				`[search-gov] ${JSON.stringify({
					queued: queued.map((q) => q.url),
					secondBytes: secondHtml.length,
					requeued: (out.requeued as unknown[]).length,
					cached: (out.cached as { status: number }[]).map((c) => c.status)
				})}`
			);

			// the module built its own request, against its own configured handle and key
			expect(queued.length, 'the form build queued no outbound call').toBe(1);
			const url = queued[0]?.url as string;
			expect(url).toContain('api.gsa.gov/technology/searchgov/v2/results/i14y');
			expect(url).toContain('affiliate=cfw-test');
			expect(url).toContain('access_key=cfw-test-key');
			expect(url).toContain('query=benefits');

			// THE CLAIM UNDER TEST: the second render consumed the reply instead of asking again. An
			// empty requeue with the cache row still present is the deferred tier having delivered it,
			// which is what "a deferred exchange always misses" said could not happen
			expect(out.requeued, 'the second render asked again, so nothing was delivered').toEqual(
				[]
			);
			expect((out.cached as { status: number }[]).map((c) => c.status)).toEqual([200]);

			// the module's form reaches a real page on both renders
			expect(secondHtml).toContain('search-gov-results-api-search-page');
			expect(secondHtml.length).toBeGreaterThan(10_000);

			// AND IT STILL RENDERS NOTHING, for a reason that is not this runtime's. `processResults()`
			// pulls each entity's child array out of a `viewMultiple()` result and renders it on its own;
			// `buildMultiple` is a `#pre_render` on the PARENT, so a detached child renders as an empty
			// shell. That is why the row is `untested` rather than `verified`: the platform carries the
			// module and the module does not produce the observable it owns
			expect(secondHtml).not.toContain('Veterans Benefits');
		},
		REQUEST_TIMEOUT
	);

	/**
	 * The other direction, and it is the one that waves the next skipped row through.
	 *
	 * A module in the pack and in nobody's assertion is a support claim nothing establishes -- the
	 * same shape as an allow-list nobody prunes. This fails on a module ADDED to the fixture with no
	 * case, and `COVERED_ELSEWHERE` is where that is answered.
	 */
	it('covers every contrib module the mounted pack carries', async () => {
		const packed = [...(await packedContrib())].sort();
		const covered = new Set([...CASES.map((c) => c.module), ...Object.keys(COVERED_ELSEWHERE)]);
		const uncovered = packed.filter((name) => !covered.has(name));
		expect(
			uncovered,
			`in the pack with no case here: ${uncovered.join(', ')}. Add one, or record it in ` +
				'COVERED_ELSEWHERE with where it is covered'
		).toEqual([]);
		// and the reverse: a case for a module the fixture build does not carry
		if (isFixturePack(new Set(packed))) {
			const missing = CASES.map((c) => c.module).filter((m) => !packed.includes(m));
			expect(missing, 'a case whose module the fixture pack does not carry').toEqual([]);
		}
	});
});
