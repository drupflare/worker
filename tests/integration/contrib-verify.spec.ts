import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * Contrib modules, enabled and then asked to DO something.
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

/** enables one module and reads back an observable it owns */
async function enableAndProbe(module: string, probe: string) {
	return inObject(freshSite(), async (site) => {
		await migrate(site);
		const enabled = await enable(site, module);
		const observed = await sql(site, probe);
		const routes = await sql(
			site,
			`SELECT COUNT(*) AS c FROM router WHERE name LIKE '${module}.%'`
		);
		// a second, looser count: several modules name their routes with underscores rather than the
		// dotted `module.route` convention, and a prefix match on the dotted form finds none of them
		const namedRoutes = await sql(
			site,
			`SELECT COUNT(*) AS c FROM router WHERE name LIKE '%${module}%'`
		);
		return { enabled, observed, routes, namedRoutes };
	});
}

/**
 * The shared assertions.
 *
 * `discoverable` gates rather than fails: with the shipping pack the module is not on the
 * filesystem and there is nothing to assert about it.
 */
function expectEnabled(out: { enabled: Payload }, module: string) {
	if (out.enabled['discoverable'] !== true) {
		console.log(`[contrib] ${module}: not in the mounted pack, skipped`);
		return false;
	}
	expect(
		out.enabled['ok'],
		`${module} failed to install: ${JSON.stringify(out.enabled).slice(0, 400)}`
	).toBe(true);
	expect(out.enabled['nowEnabled']).toBe(true);
	return true;
}

describe('contrib modules, enabled against a real site', () => {
	it(
		'metatag installs its own configuration and defaults',
		async () => {
			const out = await enableAndProbe(
				'metatag',
				"SELECT name FROM config WHERE name LIKE 'metatag.%' ORDER BY name"
			);
			if (!expectEnabled(out, 'metatag')) return;
			// metatag ships default tag config as part of its install; an empty result means it
			// enabled and has nothing to apply, which is the pathauto failure shape
			expect(rows(out.observed).length, 'metatag installed no configuration').toBeGreaterThan(
				0
			);
			console.log(`[contrib] metatag: ${rows(out.observed).length} config objects`);
		},
		REQUEST_TIMEOUT
	);

	it(
		'paragraphs registers its entity type, which is a schema change rather than a setting',
		async () => {
			const out = await enableAndProbe(
				'paragraphs',
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'paragraph%' ORDER BY name"
			);
			if (!expectEnabled(out, 'paragraphs')) return;
			// an entity type is tables, so this is the strongest observable a field module has
			expect(rows(out.observed).length, 'no paragraphs tables were created').toBeGreaterThan(
				0
			);
			console.log(
				`[contrib] paragraphs: tables ${rows(out.observed)
					.map((r) => r['name'])
					.join(', ')}`
			);
		},
		REQUEST_TIMEOUT
	);

	it(
		'captcha creates its own table, which is a schema change rather than a setting',
		async () => {
			const out = await enableAndProbe(
				'captcha',
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%captcha%' ORDER BY name"
			);
			if (!expectEnabled(out, 'captcha')) return;
			// `captcha_sessions` is created by its schema hook, so this is the install doing work
			// rather than the installer returning
			expect(rows(out.observed).map((r) => r['name'])).toContain('captcha_sessions');
			// its routes are named with underscores (`captcha_settings`, `captcha_point.add`), which
			// is why the module-prefixed LIKE this file used first found none
			expect(
				Number(rows(out.namedRoutes)[0]?.['c']),
				'captcha registered no routes'
			).toBeGreaterThan(0);
			console.log(`[contrib] captcha: ${Number(rows(out.namedRoutes)[0]?.['c'])} routes`);
		},
		REQUEST_TIMEOUT
	);

	it(
		'recaptcha installs on top of captcha and contributes its settings',
		async () => {
			const out = await enableAndProbe(
				'recaptcha',
				"SELECT name FROM config WHERE name LIKE 'recaptcha.%' ORDER BY name"
			);
			if (!expectEnabled(out, 'recaptcha')) return;
			// it depends on captcha, so a successful install also proves dependency resolution ran
			expect(out.enabled['added']).toContain('captcha');
			expect(
				rows(out.observed).length,
				'recaptcha installed no configuration'
			).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'scheduler installs its settings and registers routes',
		async () => {
			const out = await enableAndProbe(
				'scheduler',
				"SELECT name FROM config WHERE name LIKE 'scheduler.%' ORDER BY name"
			);
			if (!expectEnabled(out, 'scheduler')) return;
			expect(
				rows(out.observed).length,
				'scheduler installed no configuration'
			).toBeGreaterThan(0);
			expect(Number(rows(out.routes)[0]?.['c'])).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'queue_ui registers the admin routes it exists to provide',
		async () => {
			const out = await enableAndProbe(
				'queue_ui',
				"SELECT COUNT(*) AS c FROM router WHERE name LIKE 'queue_ui.%'"
			);
			if (!expectEnabled(out, 'queue_ui')) return;
			// queue_ui IS a UI: routes are the whole module, so zero routes is zero module
			expect(
				Number(rows(out.observed)[0]?.['c']),
				'queue_ui registered no routes'
			).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);

	it(
		'migrate_plus installs the migration_group entity type it exists to provide',
		async () => {
			const out = await enableAndProbe(
				'migrate_plus',
				"SELECT name FROM key_value WHERE name LIKE 'migration%.entity_type' ORDER BY name"
			);
			if (!expectEnabled(out, 'migrate_plus')) return;
			// it ships no config OBJECTS of its own -- what it adds is two config ENTITY TYPES, whose
			// installed definitions land in key_value. Asserting on `migrate_plus.%` config found
			// nothing and would have read as a module that installed and did nothing
			const names = rows(out.observed).map((r) => r['name']);
			expect(names).toContain('migration_group.entity_type');
			expect(names).toContain('migration.entity_type');
			console.log(`[contrib] migrate_plus: entity types ${names.join(', ')}`);
		},
		REQUEST_TIMEOUT
	);
	it(
		'search_api creates the index tables its backend writes to',
		async () => {
			const out = await enableAndProbe(
				'search_api',
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'search_api%' ORDER BY name"
			);
			if (!expectEnabled(out, 'search_api')) return;
			const names = rows(out.observed).map((r) => r['name']);
			expect(names).toContain('search_api_item');
			expect(names).toContain('search_api_task');
			expect(Number(rows(out.namedRoutes)[0]?.['c'])).toBeGreaterThan(0);
			console.log(`[contrib] search_api: tables ${names.join(', ')}`);
		},
		REQUEST_TIMEOUT
	);

	it(
		'honeypot creates its own table, which is what it uses instead of a remote captcha',
		async () => {
			const out = await enableAndProbe(
				'honeypot',
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'honeypot%' ORDER BY name"
			);
			if (!expectEnabled(out, 'honeypot')) return;
			// the advertised captcha replacement here, and the reason is structural: a hidden field
			// and a submission timer are entirely local, so it costs no outbound round trip at all
			expect(rows(out.observed).map((r) => r['name'])).toContain('honeypot_user');
			console.log('[contrib] honeypot: honeypot_user created');
		},
		REQUEST_TIMEOUT
	);

	it(
		'redirect installs its entity type and the table behind it',
		async () => {
			const out = await enableAndProbe(
				'redirect',
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'redirect'"
			);
			if (!expectEnabled(out, 'redirect')) return;
			expect(rows(out.observed).length, 'the redirect table was not created').toBe(1);
			// a route subscriber over its own table, so both halves have to be present
			expect(Number(rows(out.namedRoutes)[0]?.['c'])).toBeGreaterThan(0);
			console.log(`[contrib] redirect: ${Number(rows(out.namedRoutes)[0]?.['c'])} routes`);
		},
		REQUEST_TIMEOUT
	);

	it(
		'stage_file_proxy installs the settings its fetch path reads',
		async () => {
			const out = await enableAndProbe(
				'stage_file_proxy',
				"SELECT name FROM config WHERE name LIKE 'stage_file_proxy.%' ORDER BY name"
			);
			if (!expectEnabled(out, 'stage_file_proxy')) return;
			expect(rows(out.observed).map((r) => r['name'])).toContain('stage_file_proxy.settings');
		},
		REQUEST_TIMEOUT
	);

	it(
		'field_group contributes its plugin manager to the container',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await migrate(site);
				const enabled = await enable(site, 'field_group');
				// A DISPLAY-CONFIGURATION MODULE CREATES NO TABLE AND SHIPS NO SETTINGS, so the
				// observable is what it adds to the CONTAINER. Read after a render rather than from
				// the install's own reply: the container is rebuilt during the install and a service
				// resolved in the same breath could be answered by the one still in memory.
				await site.runJson(renderPage('/', [], false, {}));
				const services = await site.runJson(`<?php
echo json_encode([
  'ok' => true,
  'formatters' => \\Drupal::hasService('plugin.manager.field_group.formatters'),
  'subscriber' => \\Drupal::hasService('field_group.subscriber'),
  'converter' => \\Drupal::hasService('field_group.param_converter'),
  'core' => \\Drupal::hasService('entity_type.manager'),
]);`);
				return { enabled, services };
			});
			if (!expectEnabled(out, 'field_group')) return;

			const services = out.services as Payload;
			expect(services['formatters'], 'its plugin manager is not in the container').toBe(true);
			expect(services['subscriber']).toBe(true);
			expect(services['converter']).toBe(true);
			// the control: a core service answering true is what proves the probe can see the
			// container at all, so three falses would mean a broken probe rather than a dead module
			expect(services['core'], 'CONTROL: the probe cannot see the container').toBe(true);
		},
		REQUEST_TIMEOUT
	);
});
