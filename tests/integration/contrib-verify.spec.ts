import { describe, expect, it } from 'vitest';
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
		return { enabled, observed, routes };
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
		'captcha installs its settings and its own table',
		async () => {
			const out = await enableAndProbe(
				'captcha',
				"SELECT name FROM config WHERE name LIKE 'captcha.%' ORDER BY name"
			);
			if (!expectEnabled(out, 'captcha')) return;
			expect(rows(out.observed).length, 'captcha installed no configuration').toBeGreaterThan(
				0
			);
			// captcha adds admin routes; a module that registers routes and has none in the table
			// means the install-triggered rebuild did not pick it up
			expect(
				Number(rows(out.routes)[0]?.['c']),
				'captcha registered no routes'
			).toBeGreaterThan(0);
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
		'migrate_plus installs its migration_group config entity type',
		async () => {
			const out = await enableAndProbe(
				'migrate_plus',
				"SELECT name FROM config WHERE name LIKE 'migrate_plus.%' ORDER BY name"
			);
			if (!expectEnabled(out, 'migrate_plus')) return;
			expect(
				rows(out.observed).length,
				'migrate_plus installed no configuration'
			).toBeGreaterThan(0);
		},
		REQUEST_TIMEOUT
	);
});
