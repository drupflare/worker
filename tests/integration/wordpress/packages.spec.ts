import { describe, expect, it } from 'vitest';
import { OWNER_HASH_KEY } from '../../../src/ops/site/secrets';
import type { SitePhpDurableObject } from '../../../src/site-do';
import { readOverlay, readReceipts } from '../../../src/wordpress/overlay';
import {
	deletePackage,
	deliverPackage,
	rollbackPackage,
	type PackageOutcome
} from '../../../src/wordpress/packages';
import { phpQuoted, wordpressRender } from '../../../src/wordpress/site-php';
import {
	FIXTURE_FILE,
	FIXTURE_SLUG,
	fixturePhp,
	fixtureZip,
	pinArchives
} from '../../fixtures/wordpress/plugin-fixture';
import { buildZip } from '../../fixtures/wordpress/zip-builder';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';
import {
	configureWordpress,
	inWordpress,
	overlayHostPlugin,
	WP_ORIGIN,
	type WordpressSite
} from '../../helpers/wordpress-php';

/**
 * WordPress plugin lifecycle on a real object: real DO SQLite, the real interpreter, the real pack,
 * the host plugin read from the sibling checkout. The archives are built in the spec and served by
 * a stand-in for wordpress.org, which is the platform boundary.
 *
 * Needs `bun run assets:wordpress`. It is listed in `ARTIFACT_SPECS`, so a clean checkout skips it.
 */

const asSite = (site: ServeDo) => site as unknown as SitePhpDurableObject;
const themeDir = '/wordpress/wp-content/themes';

/** the active version of the fixture, as the manifest holds it */
const activeVersion = (site: ServeDo, slug = FIXTURE_SLUG) =>
	readOverlay(asSite(site)).packages[`plugin:${slug}`]?.active?.version;

const rows = (site: ServeDo) =>
	Number(site.ctx.storage.sql.exec('SELECT count(*) AS n FROM cfw_wp_file').toArray()[0]!.n);

/** a session cookie and the nonces a spec names, made on one interpreter and good for every later one */
async function login(
	wp: WordpressSite,
	actions: string[] = []
): Promise<{ cookie: string; nonces: Record<string, string> }> {
	await overlayHostPlugin(wp);
	const session = await inWordpress(
		wp,
		`
$expiration = time() + 3600;
$token = WP_Session_Tokens::get_instance(1)->create($expiration);
$_COOKIE[LOGGED_IN_COOKIE] = wp_generate_auth_cookie(1, $expiration, 'logged_in', $token);
wp_set_current_user(1);
$secure = wp_generate_auth_cookie(1, $expiration, 'secure_auth', $token);
$plain = wp_generate_auth_cookie(1, $expiration, 'auth', $token);
$out['cookie'] = implode('; ', [
	LOGGED_IN_COOKIE . '=' . rawurlencode($_COOKIE[LOGGED_IN_COOKIE]),
	SECURE_AUTH_COOKIE . '=' . rawurlencode($secure),
	AUTH_COOKIE . '=' . rawurlencode($plain),
]);
$out['nonces'] = [];
foreach (json_decode(${phpQuoted(JSON.stringify(actions))}, true) as $action) {
	$out['nonces'][$action] = wp_create_nonce($action);
}
`
	);
	return {
		cookie: String(session.cookie),
		nonces: session.nonces as unknown as Record<string, string>
	};
}

/** one request through the front controller, on a fresh interpreter that carries the sibling's host plugin */
async function request(
	wp: WordpressSite,
	path: string,
	cookie = ''
): Promise<{ status: number; html: string; location: string | null }> {
	await overlayHostPlugin(wp);
	const reply = await wp.runJsonMaybeParked(wordpressRender(path, { origin: WP_ORIGIN, cookie }));
	wp.resetPhp();
	expect(reply.error, String(reply.at)).toBeUndefined();
	return {
		status: Number(reply.status),
		html: String(reply.html ?? ''),
		location: (reply.location as string | null) ?? null
	};
}

const READ_PLUGIN = `
require_once ABSPATH . 'wp-admin/includes/plugin.php';
$file = WP_PLUGIN_DIR . '/${FIXTURE_FILE}';
$out['listed'] = array_keys(get_plugins());
$out['active'] = is_plugin_active('${FIXTURE_FILE}');
$out['exists'] = file_exists($file);
$out['version'] = $out['exists'] ? get_plugin_data($file)['Version'] : null;
$out['activated'] = get_option('fixture_plugin_activated', null);
$out['js'] = @file_get_contents(WP_PLUGIN_DIR . '/${FIXTURE_SLUG}/assets/app.js') ?: null;
`;

const meta = (version: string) => `<meta name="fixture-plugin" content="${version}">`;

describe('a plugin delivered by the host runs through WordPress', () => {
	it('is delivered, activated, used, updated, rolled back, deactivated and deleted', async () => {
		const dep = await pinArchives({
			'1.0.0': fixtureZip('1.0.0'),
			'2.0.0': fixtureZip('2.0.0')
		});
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			const steps: Record<string, unknown> = {};

			steps.first = await deliverPackage(asSite(site), FIXTURE_SLUG, '1.0.0', dep);
			steps.mounted = await inWordpress(wp, READ_PLUGIN);

			const session = await login(wp, [
				`activate-plugin_${FIXTURE_FILE}`,
				`deactivate-plugin_${FIXTURE_FILE}`
			]);
			const query = (action: string) =>
				`/wp-admin/plugins.php?action=${action}&plugin=${encodeURIComponent(FIXTURE_FILE)}&_wpnonce=${
					session.nonces[`${action}-plugin_${FIXTURE_FILE}`]
				}`;
			steps.beforeActivation = (await request(wp, '/')).html.includes(meta('1.0.0'));
			steps.activate = await request(wp, query('activate'), session.cookie);
			steps.activated = await inWordpress(wp, READ_PLUGIN);
			steps.front1 = (await request(wp, '/')).html.includes(meta('1.0.0'));
			steps.admin1 = (
				await request(
					wp,
					'/wp-admin/options-general.php?page=fixture-plugin',
					session.cookie
				)
			).html;

			steps.update = await deliverPackage(asSite(site), FIXTURE_SLUG, '2.0.0', dep);
			steps.front2 = (await request(wp, '/')).html.includes(meta('2.0.0'));
			steps.stillActive = (await inWordpress(wp, READ_PLUGIN)).active;

			steps.back = rollbackPackage(asSite(site), FIXTURE_SLUG);
			steps.front3 = (await request(wp, '/')).html.includes(meta('1.0.0'));
			steps.forward = rollbackPackage(asSite(site), FIXTURE_SLUG);
			steps.front4 = (await request(wp, '/')).html.includes(meta('2.0.0'));

			steps.deleteWhileActive = deletePackage(asSite(site), FIXTURE_SLUG);
			steps.deactivate = await request(wp, query('deactivate'), session.cookie);
			steps.deactivated = await inWordpress(wp, READ_PLUGIN);
			steps.deleted = deletePackage(asSite(site), FIXTURE_SLUG);
			steps.gone = await inWordpress(wp, READ_PLUGIN);
			steps.restored = rollbackPackage(asSite(site), FIXTURE_SLUG);
			steps.back2 = await inWordpress(wp, READ_PLUGIN);
			steps.again = await deliverPackage(asSite(site), FIXTURE_SLUG, '2.0.0', dep);
			steps.receipts = readReceipts(asSite(site));
			steps.requests = dep.requests.length;
			return steps;
		});

		const ok = (o: unknown) => o as Extract<PackageOutcome, { ok: true; receipt: unknown }>;
		const receipt = (o: unknown) => ok(o).receipt;

		expect(ok(out.first).ok, JSON.stringify(out.first)).toBe(true);
		expect(receipt(out.first)).toMatchObject({
			op: 'install',
			slug: FIXTURE_SLUG,
			fromVersion: null,
			toVersion: '1.0.0',
			files: 2
		});
		const mounted = out.mounted as Record<string, unknown>;
		expect(mounted.fatal).toBeUndefined();
		expect(mounted.listed).toContain(FIXTURE_FILE);
		expect(mounted.version).toBe('1.0.0');
		expect(mounted.active).toBe(false);
		expect(mounted.js).toBe("window.fixturePlugin = '1.0.0';");
		expect(out.beforeActivation, 'a plugin that is not active runs nothing').toBe(false);

		const activate = out.activate as { status: number; location: string | null; html: string };
		expect(activate.status, activate.html.slice(0, 300)).toBe(302);
		expect(activate.location, activate.html.replace(/<[^>]+>/g, ' ').slice(-700)).toContain(
			'plugins.php?activate=true'
		);
		const activated = out.activated as Record<string, unknown>;
		expect(activated.active, 'active_plugins holds the plugin after the real request').toBe(
			true
		);
		expect(activated.activated, 'its activation hook ran').toBe('1.0.0');
		expect(out.front1, 'its front-end hook runs on the next request').toBe(true);
		expect(String(out.admin1)).toContain('<h1>Fixture Plugin 1.0.0</h1>');

		expect(receipt(out.update)).toMatchObject({
			op: 'update',
			fromVersion: '1.0.0',
			toVersion: '2.0.0'
		});
		expect(receipt(out.update).fromDigest).not.toBe(receipt(out.update).toDigest);
		expect(out.front2).toBe(true);
		expect(out.stillActive, 'an update keeps the plugin active').toBe(true);

		expect(receipt(out.back)).toMatchObject({
			op: 'rollback',
			fromVersion: '2.0.0',
			toVersion: '1.0.0'
		});
		expect(out.front3).toBe(true);
		expect(receipt(out.forward)).toMatchObject({ op: 'rollback', toVersion: '2.0.0' });
		expect(out.front4).toBe(true);

		expect(out.deleteWhileActive).toMatchObject({ ok: false });
		expect((out.deleteWhileActive as { error: string }).error).toContain('active in WordPress');
		const deactivate = out.deactivate as { status: number; html: string };
		expect(deactivate.status, deactivate.html.slice(0, 300)).toBe(302);
		expect((out.deactivated as Record<string, unknown>).active).toBe(false);

		expect(receipt(out.deleted)).toMatchObject({
			op: 'delete',
			fromVersion: '2.0.0',
			toVersion: null
		});
		expect(receipt(out.deleted).detail).toContain('uninstall hook not run');
		const gone = out.gone as Record<string, unknown>;
		expect(gone.exists).toBe(false);
		expect(gone.listed).not.toContain(FIXTURE_FILE);
		expect(
			gone.activated,
			'the data the plugin kept stays, since its uninstall hook was not run'
		).toBe('1.0.0');

		expect(receipt(out.restored)).toMatchObject({
			op: 'rollback',
			fromVersion: null,
			toVersion: '2.0.0'
		});
		expect((out.back2 as Record<string, unknown>).exists).toBe(true);
		expect(out.again).toEqual({ ok: true, unchanged: true, version: '2.0.0' });
		expect((out.receipts as { op: string }[]).map((r) => r.op).reverse()).toEqual([
			'install',
			'update',
			'rollback',
			'rollback',
			'delete',
			'rollback'
		]);
		expect(out.requests, 'the unchanged delivery downloaded nothing').toBe(2);
	}, 900_000);
});

describe('a delivery that fails leaves the mounted version alone', () => {
	it('survives a failed download, a wrong digest, a hostile archive, a bad header and a failed commit', async () => {
		const good = fixtureZip('1.0.0');
		const traversal = fixtureZip('3.0.0', [{ name: `${FIXTURE_SLUG}/../evil.php`, data: 'x' }]);
		const lying = buildZip([
			{ name: `${FIXTURE_SLUG}/` },
			{ name: FIXTURE_FILE, data: fixturePhp('9.9.9') }
		]);
		const dep = await pinArchives({
			'1.0.0': good,
			'2.0.0': fixtureZip('2.0.0'),
			'3.0.0': traversal,
			'4.0.0': lying
		});
		const out = await inObject(freshSite(), async (site) => {
			await configureWordpress(site);
			const s = asSite(site);
			await deliverPackage(s, FIXTURE_SLUG, '1.0.0', dep);
			const baseline = {
				version: activeVersion(site),
				rows: rows(site),
				receipts: readReceipts(s).length
			};
			const state = () => ({
				version: activeVersion(site),
				rows: rows(site),
				receipts: readReceipts(s).length
			});
			const results: Record<
				string,
				{ out: PackageOutcome; after: ReturnType<typeof state> }
			> = {};
			const attempt = async (name: string, version: string, fetcher: typeof fetch) => {
				results[name] = {
					out: await deliverPackage(s, FIXTURE_SLUG, version, { ...dep, fetcher }),
					after: state()
				};
			};
			await attempt('network', '2.0.0', (async () => {
				throw new Error('connection reset');
			}) as unknown as typeof fetch);
			await attempt(
				'status',
				'2.0.0',
				(async () => new Response('x', { status: 503 })) as unknown as typeof fetch
			);
			await attempt(
				'digest',
				'2.0.0',
				(async () =>
					new Response(good as Uint8Array<ArrayBuffer>)) as unknown as typeof fetch
			);
			await attempt('traversal', '3.0.0', dep.fetcher);
			await attempt('header', '4.0.0', dep.fetcher);

			const original = s.metaRowSet.bind(s);
			s.metaRowSet = () => {
				throw new Error('disk full');
			};
			await attempt('commit', '2.0.0', dep.fetcher);
			s.metaRowSet = original;
			const recovered = await deliverPackage(s, FIXTURE_SLUG, '2.0.0', dep);
			return { baseline, results, recovered, final: state() };
		});

		const refused = (name: string) => out.results[name]!.out;
		expect(refused('network')).toMatchObject({ ok: false, rule: 'fetch' });
		expect(refused('status')).toMatchObject({ ok: false, rule: 'fetch' });
		expect(refused('digest')).toMatchObject({ ok: false, rule: 'digest' });
		expect(refused('traversal')).toMatchObject({ ok: false, rule: 'path-traversal' });
		expect(refused('header')).toMatchObject({ ok: false, rule: 'header' });
		expect(refused('commit')).toMatchObject({ ok: false });
		expect((refused('commit') as { error: string }).error).toContain('disk full');
		for (const [name, { after }] of Object.entries(out.results)) {
			expect(after, `${name} changed what is stored`).toEqual(out.baseline);
		}
		expect(out.recovered, 'the same delivery succeeds once the fault is gone').toMatchObject({
			ok: true
		});
		expect(out.final.version).toBe('2.0.0');
	}, 900_000);

	it('refuses a version that is not pinned and a package that is not in the registry', async () => {
		const dep = await pinArchives({ '1.0.0': fixtureZip('1.0.0') });
		const out = await inObject(freshSite(), async (site) => {
			await configureWordpress(site);
			return {
				version: await deliverPackage(asSite(site), FIXTURE_SLUG, '8.8.8', dep),
				slug: await deliverPackage(asSite(site), 'not-pinned', undefined, dep),
				requests: dep.requests.length
			};
		});
		expect(out.version).toMatchObject({ ok: false });
		expect((out.version as { error: string }).error).toContain('not pinned');
		expect((out.slug as { error: string }).error).toContain('not in the package registry');
		expect(out.requests, 'nothing outside the registry is downloaded').toBe(0);
	}, 900_000);
});

describe('a delivered folder replaces the one in the pack', () => {
	it('drops every file the new version does not carry', async () => {
		const zip = buildZip([
			{ name: 'twentytwentyfive/' },
			{
				name: 'twentytwentyfive/style.css',
				data: '/*\nTheme Name: Stand-in\nVersion: 1.0.0\nRequires PHP: 7.4\n*/\n'
			}
		]);
		const dep = await pinArchives({ '1.0.0': zip }, 'twentytwentyfive', 'theme');
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			const list = `$out['entries'] = array_values(array_diff(scandir('${themeDir}/twentytwentyfive'), ['.', '..']));`;
			const before = await inWordpress(wp, list);
			const delivered = await deliverPackage(asSite(site), 'twentytwentyfive', '1.0.0', dep);
			const after = await inWordpress(wp, list);
			return { before, delivered, after };
		});
		expect(
			(out.before.entries as string[]).length,
			'the pack ships the theme with several entries'
		).toBeGreaterThan(1);
		expect(out.delivered).toMatchObject({ ok: true });
		expect(out.after.entries).toEqual(['style.css']);
	}, 900_000);
});

describe('a delivered file is held to its sealed record on a claimed site', () => {
	it('reads as empty once its row differs, and as itself before', async () => {
		const dep = await pinArchives({ '1.0.0': fixtureZip('1.0.0') });
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			asSite(site).secretStore().sealed.put(OWNER_HASH_KEY, 'owner-hash');
			await deliverPackage(asSite(site), FIXTURE_SLUG, '1.0.0', dep);
			const read = `$out['text'] = file_get_contents(WP_PLUGIN_DIR . '/${FIXTURE_FILE}');`;
			const intact = await inWordpress(wp, read);
			const evil = new TextEncoder().encode('<?php echo "planted";');
			site.ctx.storage.sql.exec(
				"UPDATE cfw_wp_file SET bytes = ? WHERE path = 'fixture-plugin.php'",
				evil.buffer.slice(0) as ArrayBuffer
			);
			const tampered = await inWordpress(wp, read);
			return { intact, tampered, refused: asSite(site).moduleIntegrity?.refused };
		});
		expect(out.intact.text).toBe(fixturePhp('1.0.0'));
		expect(out.tampered.text).toBe('');
		expect(out.refused).toBe(1);
	}, 900_000);
});

describe('what the dashboard says about updates, and Multisite', () => {
	it('answers update screens with the explanation, offers no file-writing update and refuses a network', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const wp = await configureWordpress(site);
			// the version check on an admin page is answered with no offer, so nothing leaves the test
			wp.parkFetchDep = (async () =>
				Response.json({
					offers: [],
					translations: [],
					plugins: {},
					themes: {},
					no_update: {}
				})) as unknown as typeof fetch;
			const session = await login(wp);
			const defined = await inWordpress(
				wp,
				`$out['multisite'] = [defined('MULTISITE') && MULTISITE, defined('WP_ALLOW_MULTISITE'), is_multisite()];`
			);
			const quiet = await request(wp, '/wp-admin/index.php', session.cookie);
			await inWordpress(
				wp,
				`set_site_transient('update_core', (object) [
	'updates' => [(object) ['response' => 'upgrade', 'current' => '99.0.0', 'locale' => 'en_US', 'download' => 'https://example.invalid/x.zip', 'packages' => (object) ['full' => 'https://example.invalid/x.zip']]],
	'last_checked' => time(),
	'version_checked' => $GLOBALS['wp_version'],
	'translations' => [],
]);`
			);
			return {
				defined,
				quiet,
				dashboard: await request(wp, '/wp-admin/index.php', session.cookie),
				updateCore: await request(wp, '/wp-admin/update-core.php', session.cookie),
				updateAnonymous: await request(wp, '/wp-admin/update-core.php'),
				installPlugins: await request(wp, '/wp-admin/plugin-install.php', session.cookie),
				network: await request(wp, '/wp-admin/network.php', session.cookie),
				signup: await request(wp, '/wp-signup.php')
			};
		});
		expect(out.defined.multisite).toEqual([false, false, false]);

		expect(out.quiet.status).toBe(200);
		expect(out.quiet.html, 'no offer, no notice').not.toContain(
			'The platform applies core updates'
		);

		const dashboard = out.dashboard;
		expect(dashboard.status).toBe(200);
		expect(dashboard.html).toContain(
			'WordPress 99.0.0 is available. The platform applies core updates'
		);
		expect(dashboard.html).not.toContain('Please notify the site administrator');
		expect(dashboard.html, 'no link to a screen that would write core').not.toContain(
			'update-core.php'
		);

		for (const screen of [out.updateCore, out.installPlugins]) {
			expect(
				screen.status,
				screen.html
					.replace(/<style[\s\S]*?<\/style>/g, '')
					.replace(/<[^>]+>/g, ' ')
					.trim()
					.slice(0, 400)
			).toBe(200);
			expect(screen.html).toContain('Updates are applied by the platform');
			expect(screen.html).toContain('/wp-packages');
			expect(screen.html).not.toMatch(/<form/i);
			expect(screen.html).not.toContain('Sorry, you are not allowed');
		}
		expect(out.updateAnonymous.status, 'the screen is for a signed-in user').toBe(302);
		expect(out.updateAnonymous.location).toContain('wp-login.php');

		expect(out.network.status).toBe(501);
		expect(out.network.html).toContain('Multisite is not supported');
		expect(out.network.html).not.toContain('WP_ALLOW_MULTISITE');
		expect(out.signup.status).toBe(501);
		expect(out.signup.html).toContain('Multisite is not supported');
	}, 900_000);
});

describe('the /wp-packages owner route', () => {
	const call = (site: ServeDo, query: string, method = 'GET') =>
		site.fetch(new Request(`https://do.local/__wp-packages${query}`, { method }));

	it('lists what was delivered and the registry, and refuses a bad call by name', async () => {
		const out = await inObject(freshSite(), async (site) => {
			await configureWordpress(site, { PW_DIAGNOSTICS: '1' });
			const list = await call(site, '');
			const noSlug = await call(site, '?op=install', 'POST');
			const unknownOp = await call(site, `?op=explode&slug=${FIXTURE_SLUG}`, 'POST');
			const unknownSlug = await call(site, '?op=install&slug=missing', 'POST');
			const nothingDelivered = await call(site, `?op=rollback&slug=${FIXTURE_SLUG}`, 'POST');
			const wrongMethod = await call(site, '', 'DELETE');
			return {
				list: { status: list.status, body: (await list.json()) as Record<string, any> },
				noSlug: noSlug.status,
				unknownOp: unknownOp.status,
				unknownSlug: {
					status: unknownSlug.status,
					body: (await unknownSlug.json()) as { error: string }
				},
				nothingDelivered: nothingDelivered.status,
				wrongMethod: wrongMethod.status
			};
		});
		expect(out.list.status).toBe(200);
		expect(out.list.body.delivered).toEqual({});
		expect(out.list.body.receipts).toEqual([]);
		expect(Object.keys(out.list.body.registry)).toContain('classic-editor');
		expect(out.noSlug).toBe(400);
		expect(out.unknownOp).toBe(400);
		expect(out.unknownSlug.status).toBe(409);
		expect(out.unknownSlug.body.error).toContain('not in the package registry');
		expect(out.nothingDelivered).toBe(409);
		expect(out.wrongMethod).toBe(405);
	}, 900_000);

	it('wants the owner token when diagnostics are off, and answers 404 on a Drupal site', async () => {
		const out = await inObject(freshSite(), async (site) => {
			await configureWordpress(site, { PW_DIAGNOSTICS: '0' });
			const denied = await call(site, '');
			site.env = { ...site.env, CMS: 'drupal' };
			const drupal = await call(site, '');
			return { denied: denied.status, drupal: drupal.status };
		});
		expect(out.denied).toBe(401);
		expect(out.drupal).toBe(404);
	}, 900_000);
});
