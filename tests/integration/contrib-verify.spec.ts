import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { BOOT_KERNEL, drupalOp, renderPage } from '../../src/drupal/site-php';
import { vectorFor } from '../../src/ops/capability-contract';
import { SHIPPED_CAPABILITIES, tierFor } from '../../src/ops/catalog';
import {
	GENERATED_MODULES,
	PHASE_OWNERS,
	REQUEST_TIMEOUT,
	call,
	enable,
	migrate,
	mustCarry,
	packedContrib,
	type Payload
} from '../helpers/contrib-pack';
import {
	claimSite,
	encodeForm,
	formPost,
	hiddenFields,
	loginJar,
	render
} from '../helpers/drupal-forms';
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

const sql = (site: ServeDo, query: string) => call(site, `/__sql?q=${encodeURIComponent(query)}`);
const rows = (reply: Payload): Record<string, unknown>[] =>
	Array.isArray(reply['rows']) ? (reply['rows'] as Record<string, unknown>[]) : [];

// #region what the mounted pack carries

async function reachable(ctx: TestContext, module: string): Promise<boolean> {
	const packed = await packedContrib();
	if (packed.has(module)) return true;
	if (mustCarry(packed) && !PHASE_OWNERS.includes(module)) {
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

/** the version the packaging script stamped into the mounted info.yml, which the extension list may not have scanned yet */
const versionProbe = (module: string) => String.raw`<?php
$file = \Drupal::root() . '/modules/contrib/${module}/${module}.info.yml';
preg_match("/^version: *'?([^'\\s]+)/m", (string) @file_get_contents($file), $m);
echo json_encode(['version' => $m[1] ?? '']);`;

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
	/** a prefix of the installed version; a row for another branch skips, so two rows can share a module */
	branch?: string;
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
		module: 'memcache',
		observable: 'its backend factory, its lock factory and the memcache client factory',
		ask: {
			services: ['cache.backend.memcache', 'memcache.lock.factory', 'memcache.factory']
		}
	},
	{
		module: 'imageapi_optimize_binaries',
		observable:
			'its shell operations service, which finds and runs image binaries through exec()',
		ask: { services: ['imageapi_optimize_binaries.shell_operations'] }
	},
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
		module: 'jquery_ui_slider',
		observable: 'the slider library jquery_ui declares on its behalf',
		ask: { libraries: 'jquery_ui_slider' }
	},
	{
		module: 'migrate_source_csv',
		observable: 'the csv migrate source plugin, owned by this module',
		ask: { plugins: [['plugin.manager.migrate.source', 'csv']] }
	},
	{
		module: 'jquery_ui_touch_punch',
		observable: 'the touch-punch library the module declares on top of jquery_ui core',
		ask: { libraries: 'jquery_ui_touch_punch' }
	},
	{
		module: 'inline_entity_form',
		observable: 'the migration helper service it registers, its only service',
		ask: { services: ['inline_entity_form.migration_helper'] }
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
	/**
	 * WAS `blocked` UNTIL 2026-09-08, on a refusal that was measuring the wrong thing.
	 *
	 * The row said "it needs an SMTP socket inside the request that sends the mail". PHPMailer does
	 * open one; the SITE does not need it to answer inside the render, because `MailManager::mail()`
	 * returns a bool and the send is deferrable by construction. `CfwMail` already hands
	 * `smtp.settings` to the host transport, so the module's own configuration drives delivery.
	 * The observable asserted here is the mail PLUGIN in the manager, which is the thing the module
	 * exists to add.
	 */
	{
		module: 'smtp',
		observable: 'its mail plugin in the mail manager, smtp.settings and its connection tester',
		config: ['smtp.settings'],
		ask: {
			services: ['smtp.config', 'smtp.connection_tester'],
			plugins: [['plugin.manager.mail', 'SMTPMailSystem']]
		},
		routes: 1
	},
	/**
	 * The one module the park exists for.
	 *
	 * It ships no config and creates no table, so the CONTAINER is the observable -- the same shape
	 * as `facets`. What is asserted is the four backends it adds; whether a cache get reaches a real
	 * Redis is a separate question, measured in `tests/integration/park-interpreter.spec.ts` against
	 * the rig rather than here.
	 */
	{
		module: 'redis',
		observable: 'its cache, lock, flood and queue backends in the container',
		ask: {
			services: [
				'cache.backend.redis',
				'redis.factory',
				'redis.lock.factory',
				'redis.flood.factory',
				'queue.redis'
			]
		},
		routes: 1
	},
	/**
	 * Enabled and asserted on what it owns, with the exchange still belonging to the host.
	 *
	 * WAS `blocked` UNTIL 2026-09-08, and its own client runs now.
	 *
	 * The refusal was real and is closed: the token POST goes through `ParkFetchHandler`, which
	 * yields to the Zend park, and the park declined under the one internal frame Drupal's dispatch
	 * puts in the chain. `park_flatten()` splices that frame out. What this case still asserts is the
	 * plugin surface; the LOGIN is `park-oidc.spec.ts`, which drives a real authorization code from
	 * the rig Keycloak through this module's own client and reads the `authmap` row back.
	 */
	{
		module: 'openid_connect',
		branch: '8.x-1.',
		observable:
			'its client plugin manager, the generic client plugin and the settings object it installs for it (8.x-1)',
		// 8.x-1.6 declares no client entity type; a client is a plugin with one settings object
		config: ['openid_connect.settings', 'openid_connect.settings.generic'],
		ask: {
			services: [
				'plugin.manager.openid_connect_client',
				'openid_connect.claims',
				'openid_connect.state_token'
			],
			plugins: [['plugin.manager.openid_connect_client', 'generic']]
		},
		routes: 3
	},
	/**
	 * 3.0.x, which 28,700 of the module's 36,179 sites run. A client is a config entity here, so the
	 * entity type and its admin routes are what the 8.x-1 row cannot see.
	 */
	{
		module: 'openid_connect',
		branch: '3.',
		observable:
			'its client config entity type, the client plugin manager and the generic client plugin (3.0.x)',
		config: ['openid_connect.settings'],
		types: ['openid_connect_client.entity_type'],
		ask: {
			services: [
				'plugin.manager.openid_connect_client',
				'openid_connect.claims',
				'openid_connect.state_token',
				'openid_connect.session',
				'openid_connect.autodiscover'
			],
			plugins: [['plugin.manager.openid_connect_client', 'generic']]
		},
		routes: 13
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
		// ITS GET RUNS NOW, so this stopped being a `blocked` case on 2026-09-08. The park carries
		// the request out of the form build and the real api.gsa.gov answered it -- `400 affiliate
		// not found`, which is the rig's fake credentials rather than a refusal. The row stays
		// `untested` for a reason that has nothing to do with the fetch: `processResults()` detaches
		// each child from a `viewMultiple()` result while `buildMultiple` is a `#pre_render` on the
		// parent, so a detached child renders as an empty shell on any Drupal 11 site.
		module: 'search_gov_results_api',
		observable: 'its route installs, and its search page is the thing that needs a live key',
		routes: 1
	},
	{
		module: 'uswds_base',
		// A THEME. It installs through `theme_installer`, so its observable is
		// `core.extension`'s THEME key rather than its module key, and the asset libraries are what
		// a theme owns in place of services -- there are no PHP classes to resolve
		observable: 'the theme installs and its own USWDS asset libraries resolve',
		ask: { libraries: 'uswds_base' }
	},
	{
		module: 'gin',
		observable: 'the admin theme installs and the libraries it declares resolve',
		ask: { libraries: 'gin' }
	},
	{
		module: 'gin_toolbar',
		observable: 'the active-trail service it registers, its only service',
		ask: { services: ['gin_toolbar.active_trail'] }
	},
	{
		module: 'strata',
		observable:
			'its key maker and engine services, its two settings configs and its seven settings routes',
		ask: { services: ['strata.key_maker', 'strata.engine', 'strata.journal'] },
		config: ['strata.settings', 'strata.webhooks'],
		routes: 7
	},
	{
		module: 'simplesamlphp_auth',
		observable:
			'its manager and Drupal-auth services, its settings config and its four admin and login routes',
		ask: { services: ['simplesamlphp_auth.manager', 'simplesamlphp_auth.drupalauth'] },
		config: ['simplesamlphp_auth.settings'],
		routes: 4
	},
	{
		module: 'seckit',
		observable: 'its response subscriber, its settings config and its two routes',
		ask: { services: ['seckit.subscriber'] },
		config: ['seckit.settings'],
		routes: 2
	},
	{
		module: 'access_unpublished',
		observable:
			'its token table, its token manager and token getter services, its settings config and its two routes',
		tables: ['access_token'],
		ask: {
			services: ['access_unpublished.access_token_manager', 'access_unpublished.token_getter']
		},
		config: ['access_unpublished.settings'],
		routes: 2
	},
	{
		module: 'contact_storage',
		observable: 'its message table, its settings config and its four admin routes',
		tables: ['contact_message'],
		config: ['contact_storage.settings'],
		routes: 4
	},
	{
		module: 'editoria11y',
		observable:
			'its three result tables, its API and page-signer services, its settings config and its nine routes',
		tables: ['ed11y_page', 'ed11y_result', 'ed11y_action'],
		ask: { services: ['editoria11y.api', 'editoria11y.page_signer'] },
		config: ['editoria11y.settings'],
		routes: 9
	},
	{
		module: 'password_policy',
		observable:
			'its validator and validation manager services, its settings config and its nine routes',
		ask: {
			services: ['password_policy.validator', 'password_policy.validation_manager']
		},
		config: ['password_policy.settings'],
		routes: 9
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
	token: 'shipping pack; tests/integration/module-behaviour.spec.ts',
	js_cookie: 'a dependency of cas, which contrib-generic.spec.ts covers',
	contact: 'a dependency of contact_storage, whose message round trip below needs it'
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

/**
 * Ownership: the definition names the module, either as its provider or in its class.
 *
 * **AN `ERR:` READING IS NOT AN OWNERSHIP READING**, and treating it as one broke both directions.
 * When the manager service is absent the probe records the exception message, which CONTAINS the
 * service id -- so `plugin.manager.openid_connect_client` not existing yet read as `openid_connect`
 * owning the plugin, and the before reading that exists to catch a false positive was itself one.
 * The after direction was worse: an `ERR:` naming the module would have passed as the module working.
 */
const owns = (value: unknown, module: string) =>
	typeof value === 'string' &&
	!value.startsWith('ERR:') &&
	(value.split('|')[0] === module || value.includes(module));

describe('contrib modules, enabled against a real site', () => {
	for (const one of CASES) {
		it(
			`${one.module}: ${one.observable}`,
			async (ctx) => {
				if (!(await reachable(ctx, one.module))) return;

				const out = await inObject(freshSite(), async (site) => {
					await migrate(site);
					if (one.branch) {
						await site.runJson(BOOT_KERNEL);
						const read = await site.runJson(versionProbe(one.module));
						const version = String(read['version'] ?? '');
						if (!version.startsWith(one.branch)) return { skipped: version };
					}
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

				if ('skipped' in out) {
					ctx.skip(
						`${one.module} is ${out.skipped}, not the ${one.branch} this row is for`
					);
					return;
				}
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
					// THE CLASSIFIER DECIDES IT, and it used to be `blockingOutbound` pinned against
					// the suspend probe. That equality was an inference -- that a blocking outbound
					// call needs a suspended wasm stack -- and the park refuted it: the interpreter
					// still cannot suspend and `blockingOutbound` is true. A row must be refused by
					// whatever IT declares, not by whichever flag this assertion was written against
					expect(
						tierFor(`drupal/${one.module}`).tier,
						`${one.module} is a blocked case and the classifier does not refuse it`
					).toBe('refused');
				}

				row.verdict = one.blocked ? 'blocked' : 'verified';
			},
			REQUEST_TIMEOUT
		);
	}

	/**
	 * `search_gov_results_api` fetching its results INSIDE the render that asked for them.
	 *
	 * Its own case above asserts only that the route installs, because its results page GETs
	 * `api.gsa.gov` while BUILDING the form. That used to read as a refusal and be carried by the
	 * deferred tier across two renders; the park carries it inside one, so what is asserted here is
	 * the answer arriving in the same request and the deferred queue staying EMPTY.
	 *
	 * **THE PARK IS WHY THIS SPEC CHANGED SHAPE, and the earlier version is worth knowing.** It
	 * queued the module's GET, seeded `cfw_http_cache` by hand, rendered again and asserted the
	 * second render consumed the reply. It was red for a harness reason -- `/__serve` answers 503
	 * `warming` and queues rather than rendering inline, so the body it read was the refusal and the
	 * form was never built -- and by the time that was understood the tier it measured was no longer
	 * the one the site uses. `deferred-post.spec.ts` still drives the deferred tier end to end.
	 *
	 * **A BLOCKING CALL IS NOT SERVED FROM A CACHE, on purpose.** `ParkFetchHandler` does not read
	 * `cfw_http_cache` before parking, so a module that fetches on every render pays a round trip on
	 * every render -- the same cost a VPS pays. Reading a cache first would be cheaper and wrong: a
	 * replayed token-endpoint response is exactly the single-use-code hazard `openid_connect` exists
	 * inside of.
	 *
	 * The network is the dependency, so the network is what gets stubbed, through the
	 * `parkFetchDep` seam. Everything above it runs for real: the module's request building, the
	 * park, the real classifier, the real outbound guard, the resume, the JSON decode and the render
	 * array. The stub asserts the URL it was ASKED for rather than reconstructing it here, so
	 * nothing in this test has to know how the module spells its query string.
	 */
	it(
		'fetches its Search.gov results inside the render that asked, not on a later one',
		async () => {
			const packed = await packedContrib();
			if (!packed.has('search_gov_results_api')) return;
			// the park is what carries it; with the capability off this would measure the deferred
			// tier, which is a different claim and has its own spec
			expect(SHIPPED_CAPABILITIES.blockingOutbound).toBe(true);

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

				const asked: string[] = [];
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
				site.parkFetchDep = (async (input: RequestInfo | URL) => {
					asked.push(String(input));
					return new Response(reply, {
						status: 200,
						headers: { 'content-type': 'application/json' }
					});
				}) as unknown as typeof fetch;

				// THE PRODUCTION RENDER PATH, not a hand-built request. Reconstructing one by hand needs
				// a session, a render context and a base url before Drupal will render a node teaser,
				// and getting any of them wrong measures the harness instead of the module
				site.ensureHttpTables();
				const served = await site.fetch(
					new Request(
						`https://do.local/__serve?path=${encodeURIComponent(searchPath)}&edge=0`
					)
				);
				const serveHtml = await served.text();
				// BOTH BODIES, because which one carries the page depends on whether the serve
				// rendered inline or queued and answered `warming`. Asserting against only the fill
				// read `{"filled":null,"remaining":0}` on a run where the serve had already rendered
				const filled = await site.fetch(new Request('https://do.local/__fill'));
				const fillHtml = await filled.text();
				const queued = site.sql
					.exec('SELECT url FROM cfw_http_queue')
					.toArray() as unknown as { url: string }[];
				return { asked, queued, nid, serveHtml, fillHtml, park: site.lastPark ?? null };
			});

			const asked = out.asked as string[];
			const queued = out.queued as { url: string }[];
			const bodies = [String(out.serveHtml ?? ''), String(out.fillHtml ?? '')];
			const html = bodies.reduce((a, b) => (b.length > a.length ? b : a), '');
			console.log(
				`[search-gov] ${JSON.stringify({
					asked,
					bytes: bodies.map((b) => b.length),
					queued: queued.map((q) => q.url),
					park: out.park
				})}`
			);

			// THE CLAIM UNDER TEST: the module's own GET left the Worker during the render that
			// needed it, built from its own configured handle and key
			const mine = asked.filter((u) => u.includes('api.gsa.gov'));
			expect(mine.length, 'the form build made no outbound call').toBeGreaterThanOrEqual(1);
			const url = mine[0] as string;
			expect(url).toContain('api.gsa.gov/technology/searchgov/v2/results/i14y');
			expect(url).toContain('affiliate=cfw-test');
			expect(url).toContain('access_key=cfw-test-key');
			expect(url).toContain('query=benefits');
			// and nothing was deferred, which is the half that says the answer arrived in time
			expect(
				queued.filter((q) => q.url.includes('api.gsa.gov')),
				'the GET was queued for a later render as well as parked'
			).toEqual([]);

			// the module's form reaches a real page
			expect(html).toContain('search-gov-results-api-search-page');
			expect(html.length).toBeGreaterThan(10_000);

			// AND IT STILL RENDERS NOTHING, for a reason that is not this runtime's. `processResults()`
			// pulls each entity's child array out of a `viewMultiple()` result and renders it on its own;
			// `buildMultiple` is a `#pre_render` on the PARENT, so a detached child renders as an empty
			// shell. That is why the row is `untested` rather than `verified`: the platform carries the
			// module and the module does not produce the observable it owns
			expect(html).not.toContain('Veterans Benefits');
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A migrated site carries memcache in `core.extension` and selects no memcache backend here.
	 *
	 * The module is enabled and unused: its services exist, nothing asks them to connect, so pages
	 * render, and the one visible consequence is its own runtime requirement, which names the missing
	 * PHP extension. Both directions: the requirement is absent before the enable, so the reading is
	 * this module's and not the shipped site's.
	 */
	it(
		'memcache: enabled and not selected as a backend, pages render and the status report names the missing extension',
		async (ctx) => {
			if (!(await reachable(ctx, 'memcache'))) return;
			const REQUIREMENT = String.raw`<?php
if (!defined('CSS_COMPONENT')) { require_once '/drupal/core/includes/common.inc'; }
\Drupal::service('request_stack')->push(\Symfony\Component\HttpFoundation\Request::create('/', 'GET'));
\Drupal::moduleHandler()->loadAll();
require_once '/drupal/core/includes/install.inc';
$all = \Drupal::service('system.manager')->listRequirements();
$row = $all['memcache_extension'] ?? null;
echo json_encode([
  'present' => $row !== null,
  'value' => $row === null ? null : (string) $row['value'],
  'error' => $row !== null && (int) ($row['severity']->value ?? $row['severity']) === 2,
  'selected' => \Drupal\Core\Site\Settings::get('cache')['default'] ?? null,
]);`;
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				await site.runJson(BOOT_KERNEL);
				const before = await site.runJson(REQUIREMENT);
				const enabled = await enable(site, 'memcache');
				await site.runJson(BOOT_KERNEL);
				const after = await site.runJson(REQUIREMENT);
				const page = (await site.runJson(renderPage('/', []))) as Payload;
				return { before, enabled, after, page };
			});
			expect(
				out.before['present'],
				'the shipped site already reported a memcache extension row'
			).toBe(false);
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);
			expect(out.enabled['nowEnabled']).toBe(true);
			// the installer does not refuse on it (`ModuleInstaller` runs no hook_requirements)
			expect(out.enabled['requirementsPass']).toBe(false);
			expect(out.after['present']).toBe(true);
			expect(out.after['value']).toBe('Extensions not available');
			expect(out.after['error']).toBe(true);
			expect(
				String(out.after['selected']),
				'a memcache backend was selected on this site'
			).not.toMatch(/memcache/);
			expect(out.page['status']).toBe(200);
			expect(String(out.page['html'] ?? '').length).toBeGreaterThan(500);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A module that shells out finds no binary and says so, instead of failing the request.
	 *
	 * `ShellOperations` searches with `exec('which ...')` and runs `exec($command)`. There is no
	 * process table, so a program outside the exec router's table is a failed launch: `false` and
	 * exit 127. The module's own contract turns that into "binary not found", and each launch is
	 * recorded as a degradation naming the program, which is what the status report shows. Both
	 * directions: nothing is recorded before the calls, and a served program (`echo`) still runs, so
	 * the refusal is about the missing binary and not about exec as a whole.
	 */
	it(
		'imageapi_optimize_binaries: finds no image binary, records the launch as degraded, and the page renders',
		async (ctx) => {
			if (!(await reachable(ctx, 'imageapi_optimize_binaries'))) return;
			const PROBE = String.raw`<?php
$ops = \Drupal::service('imageapi_optimize_binaries.shell_operations');
$before = array_keys(\Drupal\drupflare\Degradation::all());
$found = $ops->findExecutablePath('pngquant');
$ran = $ops->execShellCommand('pngquant', ['--quality=65-80'], ['/tmp/in.png']);
$served = exec('echo hi', $lines, $code);
echo json_encode([
  'found' => $found,
  'ran' => $ran,
  'served' => [$served, $code],
  'before' => $before,
  'after' => array_keys(\Drupal\drupflare\Degradation::all()),
]);`;
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enable(site, 'imageapi_optimize_binaries');
				await site.runJson(BOOT_KERNEL);
				const probe = await site.runJson(PROBE);
				const page = (await site.runJson(renderPage('/', []))) as Payload;
				return { enabled, probe, page };
			});
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);
			expect(out.probe['found']).toBe(false);
			expect(out.probe['ran']).toBe(false);
			expect(out.probe['served']).toEqual(['hi', 0]);
			expect(out.probe['before']).not.toContain('exec pngquant');
			expect(out.probe['after']).toContain('exec pngquant');
			expect(out.page['status']).toBe(200);
		},
		REQUEST_TIMEOUT
	);

	/**
	 * strata seals a frame through its own cipher, under a key it created itself.
	 *
	 * `extension_loaded('sodium')` is true here because the sodium stand-in covers the whole
	 * ext-sodium API, so `strata_sodium` reads Available; `strata_storage` says not usable without a
	 * store, and the claim is exactly that plus a working cipher.
	 * The key comes from `KeyMaker::create()`, the way an operator gets one, and is never printed.
	 * The known answer was sealed by native libsodium (PHP 8.5.7) with the same nonce
	 * derivation, so the shim's BLAKE2b and AEAD are held to the real library and not to themselves.
	 */
	it(
		'strata: seals and opens a frame under a key it made, refuses tampering, matches native libsodium',
		async (ctx) => {
			if (!(await reachable(ctx, 'strata'))) return;
			const KAT_KEY = '1af5d3942a322f335523acceaa04a40bfd1123d637a597498af1b6377bd449f7';
			const KAT_SEALED =
				'7547dca24c9548919d80ef04a667f3ae4b56339241bc8d1dc66f72294d6cbd7aecf7a4b4b47ca84da9c0f430914071fc4049e6bff633e9fc762479183b98c9d8f39e497a3d1077167533d882cde044f9de5278bc8c89c8';
			const PROBE = String.raw`<?php
if (!defined('CSS_COMPONENT')) { require_once '/drupal/core/includes/common.inc'; }
\Drupal::service('request_stack')->push(\Symfony\Component\HttpFoundation\Request::create('/', 'GET'));
\Drupal::moduleHandler()->loadAll();
require_once '/drupal/core/includes/install.inc';
$c = \Drupal::getContainer();
$out = ['maker' => $c->has('strata.key_maker'), 'engine' => $c->has('strata.engine')];
$all = \Drupal::service('system.manager')->listRequirements();
foreach (['strata_sodium', 'strata_storage'] as $k) {
  $row = $all[$k] ?? null;
  $out['req ' . $k] = $row === null ? null : [
    'value' => (string) $row['value'],
    'severity' => (int) ($row['severity']->value ?? $row['severity']),
  ];
}
$out['extension_loaded'] = extension_loaded('sodium');
if (!$out['maker'] || !$out['engine']) { echo json_encode($out); return; }
$maker = \Drupal::service('strata.key_maker');
$id = $maker->create();
$second = $maker->create();
$repo = \Drupal::service('key.repository');
$a = $repo->getKey($id)->getKeyValue();
$b = $repo->getKey($second)->getKeyValue();
$out['key bytes'] = [strlen($a), strlen($b)];
$out['keys differ'] = $a !== $b;
\Drupal::configFactory()->getEditable('strata.settings')->set('key', $id)->save();
$cipher = \Drupal::service('strata.engine')->cipher();
$out['cipher'] = get_class($cipher);
$out['available'] = $cipher->isAvailable();
$plain = 'strata round trip ' . bin2hex(random_bytes(16)) . str_repeat("\0\xff", 40);
$aad = hash('sha256', $plain);
$sealed = $cipher->seal($plain, $aad);
$out['sealed'] = [
  'differs' => $sealed !== $plain,
  'hides plaintext' => !str_contains($sealed, substr($plain, 0, 20)),
  'length' => strlen($sealed) === 24 + strlen($plain) + 16,
  'opens' => $cipher->open($sealed, $aad) === $plain,
  'deterministic' => $cipher->seal($plain, $aad) === $sealed,
];
$flip = function (string $s, int $at): string { $s[$at] = chr(ord($s[$at]) ^ 1); return $s; };
$other = new \Drupal\strata\Crypto\XChaCha20Poly1305Cipher(random_bytes(32));
$cases = [
  'last byte' => fn() => $cipher->open($flip($sealed, strlen($sealed) - 1), $aad),
  'first byte' => fn() => $cipher->open($flip($sealed, 0), $aad),
  'middle byte' => fn() => $cipher->open($flip($sealed, intdiv(strlen($sealed), 2)), $aad),
  'associated data' => fn() => $cipher->open($sealed, hash('sha256', 'other')),
  'another key' => fn() => $other->open($sealed, $aad),
  'truncated' => fn() => $cipher->open(substr($sealed, 0, 20), $aad),
];
$tamper = [];
foreach ($cases as $label => $fn) {
  try { $fn(); $tamper[$label] = 'opened'; }
  catch (\Drupal\strata\Crypto\AuthenticationFailure $e) { $tamper[$label] = 'auth'; }
  catch (\Throwable $e) { $tamper[$label] = get_class($e); }
}
$out['tamper'] = $tamper;
$kat = new \Drupal\strata\Crypto\XChaCha20Poly1305Cipher(hex2bin('${KAT_KEY}'));
$known = 'strata known answer: sealed by native libsodium';
$out['native'] = [
  'seal equals' => bin2hex($kat->seal($known, 'frame-digest-0001')) === '${KAT_SEALED}',
  'opens' => $kat->open(hex2bin('${KAT_SEALED}'), 'frame-digest-0001') === $known,
];
echo json_encode($out);`;

			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				await site.runJson(BOOT_KERNEL);
				const before = await site.runJson(PROBE);
				const enabled = await enable(site, 'strata');
				await site.runJson(BOOT_KERNEL);
				const after = await site.runJson(PROBE);
				return { before, enabled, after };
			});
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);

			// before: no service to ask and no status row, so what follows is this module's
			expect(out.before['maker']).toBe(false);
			expect(out.before['engine']).toBe(false);
			expect(out.before['req strata_sodium']).toBeNull();

			const after = out.after;
			// the two status rows: the extension reads loaded, and no store is configured
			expect(after['extension_loaded']).toBe(true);
			expect(after['req strata_sodium']).toEqual({ value: 'Available', severity: 0 });
			expect(after['req strata_storage']).toEqual({
				value: 'Local, not usable',
				severity: 2
			});

			expect(after['key bytes']).toEqual([32, 32]);
			expect(after['keys differ']).toBe(true);
			expect(after['cipher']).toBe('Drupal\\strata\\Crypto\\XChaCha20Poly1305Cipher');
			expect(after['available']).toBe(true);
			expect(after['sealed']).toEqual({
				differs: true,
				'hides plaintext': true,
				length: true,
				opens: true,
				deterministic: true
			});
			expect(after['tamper']).toEqual({
				'last byte': 'auth',
				'first byte': 'auth',
				'middle byte': 'auth',
				'associated data': 'auth',
				'another key': 'auth',
				truncated: 'RuntimeException'
			});
			expect(after['native']).toEqual({ 'seal equals': true, opens: true });
		},
		REQUEST_TIMEOUT
	);

	/**
	 * simplesamlphp_auth builds a SimpleSAMLphp service provider from its own settings.
	 *
	 * It installs in a phase after smtp is removed, because SimpleSAMLphp 2.5 needs phpmailer 7 and
	 * smtp needs phpmailer 6. The library classes autoload before the enable too, since they come from
	 * the lock, so only the module's own service, routes and settings are read as before and after.
	 * No identity provider is involved: nothing here sends an AuthnRequest or checks an assertion.
	 */
	it(
		'simplesamlphp_auth: its manager builds a SimpleSAMLphp config and service provider from its settings',
		async (ctx) => {
			if (!(await reachable(ctx, 'simplesamlphp_auth'))) return;
			const PROBE = String.raw`<?php
if (!defined('CSS_COMPONENT')) { require_once '/drupal/core/includes/common.inc'; }
\Drupal::service('request_stack')->push(\Symfony\Component\HttpFoundation\Request::create('/', 'GET'));
\Drupal::moduleHandler()->loadAll();
$c = \Drupal::getContainer();
$out = ['control' => $c->has('entity_type.manager')];
$out['manager service'] = $c->has('simplesamlphp_auth.manager');
$out['manager class'] = class_exists('Drupal\simplesamlphp_auth\Service\SimplesamlphpAuthManager');
$have = array_flip(\Drupal::database()->query('SELECT name FROM {router}')->fetchCol());
$out['routes'] = [
  'admin' => isset($have['simplesamlphp_auth.admin_settings']),
  'login' => isset($have['simplesamlphp_auth.saml_login']),
];
$out['settings'] = \Drupal::service('config.storage')->exists('simplesamlphp_auth.settings');
$out['classes'] = [];
foreach (['SimpleSAML\Configuration', 'SimpleSAML\Auth\Simple', 'SimpleSAML\Session', 'SimpleSAML\SAML2\XML\samlp\AuthnRequest', 'PHPMailer\PHPMailer\PHPMailer'] as $cls) {
  $out['classes'][$cls] = class_exists($cls);
}
$out['phpmailer'] = class_exists('PHPMailer\PHPMailer\PHPMailer') ? \PHPMailer\PHPMailer\PHPMailer::VERSION : null;
if (!$out['manager service']) { echo json_encode($out); return; }
$settings = \Drupal::config('simplesamlphp_auth.settings');
$out['auth_source'] = $settings->get('auth_source');
$out['activate'] = $settings->get('activate');
$dir = '/tmp/ssp-config';
@mkdir($dir, 0777, true);
file_put_contents($dir . '/config.php', "<?php\n\$config = ['baseurlpath' => 'simplesaml/', 'secretsalt' => 'rig-salt', 'store.type' => 'phpsession', 'technicalcontact_email' => 'na@example.test', 'technicalcontact_name' => 'rig', 'timezone' => 'UTC'];\n");
file_put_contents($dir . '/authsources.php', "<?php\n\$config = [" . var_export($out['auth_source'], true) . " => ['saml:SP', 'entityID' => 'https://sp.example.test/']];\n");
\SimpleSAML\Configuration::setConfigDir($dir);
$m = \Drupal::service('simplesamlphp_auth.manager');
$out['manager'] = get_class($m);
$out['activated'] = $m->isActivated();
$out['storage'] = $m->getStorage();
$out['authenticated'] = $m->isAuthenticated();
$sp = \SimpleSAML\Auth\Source::getById($out['auth_source']);
$out['sp class'] = get_class($sp);
$out['sp entity'] = $sp->getEntityId();
$builder = new \SimpleSAML\Metadata\SAMLBuilder($sp->getEntityId());
$builder->addMetadataSP20($sp->getHostedMetadata(), $sp->getSupportedProtocols());
$dom = new \DOMDocument();
$out['metadata parses'] = $dom->loadXML($builder->getEntityDescriptorText(false));
$out['metadata root'] = $dom->documentElement->localName;
$out['metadata entityID'] = $dom->documentElement->getAttribute('entityID');
$out['metadata acs'] = $dom->getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:metadata', 'AssertionConsumerService')->length;
echo json_encode($out);`;

			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				await site.runJson(BOOT_KERNEL);
				const before = await site.runJson(PROBE);
				const enabled = await enable(site, 'simplesamlphp_auth');
				await site.runJson(BOOT_KERNEL);
				const after = await site.runJson(PROBE);
				return { before, enabled, after };
			});
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);
			expect(out.enabled['nowEnabled']).toBe(true);

			const { before, after } = out;
			expect(before['control']).toBe(true);
			expect(after['control']).toBe(true);
			expect(before['manager service']).toBe(false);
			expect(before['manager class']).toBe(false);
			expect(before['routes']).toEqual({ admin: false, login: false });
			expect(before['settings']).toBe(false);

			// the lock this phase builds: phpmailer 7 beside SimpleSAMLphp 2.5, no smtp
			const libraries = {
				'SimpleSAML\\Configuration': true,
				'SimpleSAML\\Auth\\Simple': true,
				'SimpleSAML\\Session': true,
				'SimpleSAML\\SAML2\\XML\\samlp\\AuthnRequest': true,
				'PHPMailer\\PHPMailer\\PHPMailer': true
			};
			expect(after['classes']).toEqual(libraries);
			expect(String(after['phpmailer'])).toMatch(/^7\./);

			expect(after['manager service']).toBe(true);
			expect(after['manager class']).toBe(true);
			expect(after['routes']).toEqual({ admin: true, login: true });
			expect(after['settings']).toBe(true);
			expect(after['auth_source']).toBe('default-sp');
			expect(after['activate']).toBe(false);

			expect(after['manager']).toBe(
				'Drupal\\simplesamlphp_auth\\Service\\SimplesamlphpAuthManager'
			);
			expect(after['activated']).toBe(false);
			expect(after['storage']).toBe('phpsession');
			expect(after['authenticated']).toBe(false);
			expect(after['sp class']).toBe('SimpleSAML\\Module\\saml\\Auth\\Source\\SP');
			expect(after['sp entity']).toBe('https://sp.example.test/');
			expect(after['metadata parses']).toBe(true);
			expect(after['metadata root']).toBe('EntityDescriptor');
			expect(after['metadata entityID']).toBe('https://sp.example.test/');
			expect(Number(after['metadata acs'])).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	// #region headline behaviours, driven through the real serve path

	const PRE = String.raw`
$request = \Symfony\Component\HttpFoundation\Request::create('/', 'GET');
\Drupal::service('request_stack')->push($request);
\Drupal::service('router.request_context')->fromRequest($request);
\Drupal::moduleHandler()->loadAll();
`;
	const ORIGIN = 'https://do.local';
	const sqlRows = async (site: ServeDo, query: string) => rows(await sql(site, query));
	// the first enable can drop the interpreter to free its heap and ask for a repeat
	const enableOn = async (site: ServeDo, module: string) => {
		let out = await enable(site, module);
		if (out['retry']) out = await enable(site, module);
		return out;
	};

	it(
		'seckit: sends its CSP, HSTS and referrer headers, overrides X-Frame-Options, and refuses a foreign Origin on a POST',
		async (ctx) => {
			if (!(await reachable(ctx, 'seckit'))) return;
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const before = await render(site, '/');
				const enabled = await enableOn(site, 'seckit');
				await site.runJson(BOOT_KERNEL);
				await site.runJson(
					drupalOp(`${PRE}
					\\Drupal::configFactory()->getEditable('seckit.settings')
						->set('seckit_xss.csp.checkbox', true)
						->set('seckit_xss.csp.default-src', "'self'")
						->set('seckit_ssl.hsts', true)
						->set('seckit_ssl.hsts_max_age', 31536000)
						->set('seckit_various.referrer_policy', true)
						->set('seckit_various.referrer_policy_policy', 'no-referrer')
						->set('seckit_clickjacking.x_frame', '2')
						->set('seckit_csrf.origin', true)
						->save();`)
				);
				const after = await render(site, '/');
				const login = 'name=x&pass=y&form_id=user_login_form&op=Log+in';
				const foreign = await render(site, '/user/login', {
					...formPost(login),
					origin: ORIGIN,
					headers: { Origin: 'https://evil.example' }
				});
				const own = await render(site, '/user/login', {
					...formPost(login),
					origin: ORIGIN,
					headers: { Origin: ORIGIN }
				});
				return { enabled, before, after, foreign, own };
			});
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);
			const was = out.before['passHeaders'] as Record<string, string>;
			const now = out.after['passHeaders'] as Record<string, string>;
			for (const name of [
				'content-security-policy',
				'strict-transport-security',
				'referrer-policy'
			]) {
				expect(was[name], `${name} was sent before the enable`).toBeUndefined();
			}
			expect(was['x-frame-options']).toBe('SAMEORIGIN');
			expect(now['content-security-policy']).toContain("default-src 'self'");
			expect(now['strict-transport-security']).toBe('max-age=31536000');
			expect(now['referrer-policy']).toBe('no-referrer');
			expect(now['x-frame-options']).toBe('DENY');
			expect(out.foreign['status']).toBe(403);
			expect(String(out.foreign['html'])).toContain('Access denied');
			expect(out.own['status']).toBe(200);
		},
		REQUEST_TIMEOUT
	);

	it(
		'access_unpublished: a token URL shows an unpublished node, and the next visitor with no token does not',
		async (ctx) => {
			if (!(await reachable(ctx, 'access_unpublished'))) return;
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enableOn(site, 'access_unpublished');
				await site.runJson(BOOT_KERNEL);
				const made = await site.runJson(
					drupalOp(`${PRE}
					$node = \\Drupal\\node\\Entity\\Node::create(
						['type' => 'page', 'title' => 'Embargoed Announcement', 'status' => 0]
					);
					$node->save();
					\\Drupal\\user\\Entity\\Role::load('anonymous')
						->grantPermission('access_unpublished node page')->save();
					\\Drupal\\access_unpublished\\Entity\\AccessToken::create([
						'entity_type' => 'node', 'entity_id' => $node->id(),
						'value' => 'cfw108tok', 'expire' => time() + 3600,
					])->save();
					$out['nid'] = (int) $node->id();`)
				);
				const path = `/node/${made['nid']}`;
				const seen = async (url: string) => {
					const r = await render(site, url);
					return [
						r['status'],
						String(r['html'] ?? '').includes('Embargoed Announcement')
					];
				};
				return {
					enabled,
					made,
					bare: await seen(path),
					token: await seen(`${path}?auHash=cfw108tok`),
					// the request after a tokened one is the leak: the token getter is a service
					// that lives as long as the interpreter
					afterToken: await seen(path),
					wrong: await seen(`${path}?auHash=nope`)
				};
			});
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);
			expect(out.made['error'], String(out.made['error'] ?? '')).toBeUndefined();
			expect(out.bare, 'an anonymous visitor saw it with no token').toEqual([403, false]);
			expect(out.token, 'the token URL did not show it').toEqual([200, true]);
			expect(out.afterToken, 'the previous visitor token unlocked it').toEqual([403, false]);
			expect(out.wrong).toEqual([403, false]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'contact_storage: an anonymous contact form submission is stored as a contact_message row',
		async (ctx) => {
			if (!(await reachable(ctx, 'contact_storage'))) return;
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const before = await sqlRows(
					site,
					"SELECT name FROM sqlite_master WHERE name = 'contact_message'"
				);
				const enabled = await enableOn(site, 'contact_storage');
				await site.runJson(BOOT_KERNEL);
				const made = await site.runJson(
					drupalOp(`${PRE}
					\\Drupal\\contact\\Entity\\ContactForm::create([
						'id' => 'feedback', 'label' => 'Feedback',
						'recipients' => ['office@example.test'], 'reply' => 'Thanks', 'weight' => 0,
					])->save();
					\\Drupal\\user\\Entity\\Role::load('anonymous')
						->grantPermission('access site-wide contact form')->save();`)
				);
				const form = await render(site, '/contact/feedback');
				const body = encodeForm({
					...hiddenFields(String(form['html'] ?? '')),
					name: 'Ada Applicant',
					mail: 'ada@example.test',
					'subject[0][value]': 'Campus visit',
					'message[0][value]': 'Can I tour the labs?',
					op: 'Send message'
				});
				const post = await render(site, '/contact/feedback', formPost(body));
				const stored = await sqlRows(
					site,
					'SELECT contact_form, name, mail, subject, message FROM contact_message'
				);
				return { before, enabled, made, form, post, stored };
			});
			expect(out.before, 'the table existed before the enable').toEqual([]);
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);
			expect(out.made['error'], String(out.made['error'] ?? '')).toBeUndefined();
			expect(out.form['status']).toBe(200);
			expect(out.post['status'], 'the submission did not redirect').toBe(303);
			expect(out.stored).toEqual([
				{
					contact_form: 'feedback',
					name: 'Ada Applicant',
					mail: 'ada@example.test',
					subject: 'Campus visit',
					message: 'Can I tour the labs?'
				}
			]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'password_policy: its length constraint rejects a short password with its own message and accepts a long one',
		async (ctx) => {
			if (!(await reachable(ctx, 'password_policy'))) return;
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enableOn(site, 'password_policy_length');
				await site.runJson(BOOT_KERNEL);
				const checked = await site.runJson(
					drupalOp(`${PRE}
					\\Drupal\\password_policy\\Entity\\PasswordPolicy::create([
						'id' => 'cfw108', 'label' => 'CFW 108', 'password_reset' => 0,
						'send_reset_email' => false, 'send_pending_email' => [],
						'show_policy_table' => true,
						'policy_constraints' => [[
							'id' => 'password_length', 'character_length' => 12,
							'character_operation' => 'minimum',
						]],
						'roles' => ['authenticated' => 'authenticated'],
					])->save();
					$u = \\Drupal\\user\\Entity\\User::create(
						['name' => 'pp108', 'mail' => 'pp108@example.test', 'status' => 1]
					);
					$u->save();
					$v = \\Drupal::service('password_policy.validator');
					$weak = $v->validatePassword('short1', $u);
					$strong = $v->validatePassword('a-much-longer-passphrase', $u);
					$out['weak'] = [$weak->isInvalid(), (string) $weak->getErrors()];
					$out['strong'] = [$strong->isInvalid(), $strong->hasErrors()];`)
				);
				return { enabled, checked };
			});
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);
			expect(out.checked['error'], String(out.checked['error'] ?? '')).toBeUndefined();
			expect(out.checked['weak']).toEqual([
				true,
				'Password length must be at least 12 characters.'
			]);
			expect(out.checked['strong']).toEqual([false, false]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'editoria11y: attaches its checker and signed settings for an editor only, and stores a signed report',
		async (ctx) => {
			if (!(await reachable(ctx, 'editoria11y'))) return;
			const PASS = 'cfw-108-ed11y-pass';
			const out = await inObject(freshSite(), async (site) => {
				await claimSite(site, PASS, 'Ed11y');
				const anonBefore = await render(site, '/', { origin: ORIGIN });
				const enabled = await enableOn(site, 'editoria11y');
				await site.runJson(BOOT_KERNEL);
				const jar = await loginJar(site, 'admin', PASS, ORIGIN);
				const as = { cookie: jar, origin: ORIGIN };
				const anon = await render(site, '/', { origin: ORIGIN });
				const editor = await render(site, '/', as);
				const json = /data-drupal-selector="drupal-settings-json">(.*?)<\/script>/s.exec(
					String(editor['html'] ?? '')
				)?.[1];
				const s = JSON.parse(json ?? '{}').editoria11y ?? {};
				const token = String((await render(site, '/session/token', as))['html']);
				const payload = {
					page_path: s.page_path,
					entity_type: s.entity_type,
					entity_id: s.entity_id,
					route_name: s.route_name,
					language: s.content_language,
					signature: s.signature,
					page_title: s.page_title,
					results: {
						'img-alt': {
							result_name: 'Missing alt text',
							content_count: 2,
							dev_count: 0
						}
					},
					oks: {},
					content_total: 2,
					dev_total: 0,
					extensions: {}
				};
				const post = (body: object, jar?: string) =>
					render(site, s.api_url, {
						method: 'POST',
						body: JSON.stringify(body),
						contentType: 'application/json',
						origin: ORIGIN,
						...(jar ? { cookie: jar, headers: { 'X-CSRF-Token': token } } : {})
					});
				const forged = await post({ ...payload, signature: 'forged' }, jar);
				const rejectedRows = await sqlRows(site, 'SELECT result_key FROM ed11y_result');
				const reported = await post(payload, jar);
				const anonReport = await post(payload);
				const stored = await sqlRows(
					site,
					'SELECT result_key, content_count, dev_count, result_name FROM ed11y_result'
				);
				return {
					anonBefore,
					enabled,
					anon,
					editor,
					s,
					forged,
					rejectedRows,
					reported,
					anonReport,
					stored
				};
			});
			expect(out.enabled['ok'], JSON.stringify(out.enabled).slice(0, 300)).toBe(true);
			const html = (r: Payload) => String(r['html'] ?? '');
			expect(html(out.anonBefore)).not.toContain('editoria11y');
			expect(html(out.anon), 'an anonymous visitor got the checker').not.toContain(
				'editoria11y'
			);
			expect(html(out.editor)).toContain(
				'/modules/contrib/editoria11y/dist/editoria11y.min.js'
			);
			expect(out.s.signature, 'no page signature in drupalSettings').toBeTruthy();
			expect(out.s.api_url).toBe('/editoria11y/api/results/report');
			expect(out.forged['status']).toBe(400);
			expect(out.rejectedRows, 'a forged report stored a row').toEqual([]);
			expect(out.reported['status']).toBe(200);
			expect(out.anonReport['status']).toBe(403);
			expect(out.stored).toEqual([
				{
					result_key: 'img-alt',
					content_count: 2,
					dev_count: 0,
					result_name: 'Missing alt text'
				}
			]);
		},
		REQUEST_TIMEOUT
	);

	// #endregion

	/**
	 * The other direction, and it is the one that waves the next skipped row through.
	 *
	 * A module in the pack and in nobody's assertion is a support claim nothing establishes -- the
	 * same shape as an allow-list nobody prunes. This fails on a module ADDED to the fixture with no
	 * case, and `COVERED_ELSEWHERE` is where that is answered.
	 */
	it('covers every contrib module the mounted pack carries', async () => {
		const packed = [...(await packedContrib())].sort();
		const covered = new Set([
			...CASES.map((c) => c.module),
			...GENERATED_MODULES,
			...PHASE_OWNERS,
			...Object.keys(COVERED_ELSEWHERE)
		]);
		const uncovered = packed.filter((name) => !covered.has(name));
		expect(
			uncovered,
			`in the pack with no case here: ${uncovered.join(', ')}. Add one, or record it in ` +
				'COVERED_ELSEWHERE with where it is covered'
		).toEqual([]);
		// and the reverse: a case for a module the fixture build does not carry
		if (mustCarry(new Set(packed))) {
			const missing = CASES.map((c) => c.module)
				.filter((m) => !PHASE_OWNERS.includes(m))
				.filter((m) => !packed.includes(m));
			expect(missing, 'a case whose module the fixture pack does not carry').toEqual([]);
		}
	});
});
