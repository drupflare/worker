import { describe, expect, it } from 'vitest';
import { drupalOp } from '../../src/drupal/php/site';
import { readAudit } from '../../src/ops/owner/audit';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * `/uninstall` and `/theme-default`: the two owner routes that change which extensions a site runs.
 *
 * Both are driven against a real kernel. A stubbed bridge would pass whatever the route told it, and
 * what matters here is what Drupal's installer and config layer do with the request: that a module
 * something else needs is refused and stays enabled, and that the theme setting is the stored one.
 */

const ORIGIN = 'https://do.local';
const BASE = 'cfw_probe_mod';
const DEPENDENT = 'cfw_probe_dep';
const THEME = 'cfw_probe_theme';

type Json = Record<string, unknown>;

async function ownerToken(site: ServeDo): Promise<string> {
	await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
	const res = await site.fetch(
		new Request(`${ORIGIN}/__firstrun`, {
			method: 'POST',
			body: JSON.stringify({ adminPass: 'cfw-Extension-Pass-5521', siteName: 'Extension' }),
			headers: { 'content-type': 'application/json' }
		})
	);
	return String(((await res.json()) as { ownerToken?: string }).ownerToken ?? '');
}

async function sha256(source: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function owner(site: ServeDo, token: string) {
	return async (method: string, path: string, body?: unknown) => {
		const res = await site.fetch(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			})
		);
		return { status: res.status, body: (await res.json()) as Json };
	};
}

/** delivers a tree through `/modify` and enables the named extension */
async function deliver(
	call: ReturnType<typeof owner>,
	pkg: string,
	files: Record<string, string>,
	enable: string
) {
	const entries = await Promise.all(
		Object.entries(files).map(async ([path, source]) => ({
			path,
			source,
			hash: await sha256(source)
		}))
	);
	await call('POST', `/__modify?action=blobs&package=${pkg}`, {
		blobs: entries.map((e) => ({ hash: e.hash, source: e.source }))
	});
	const commit = await call('POST', `/__modify?action=commit&package=${pkg}`, {
		files: entries.map((e) => ({ path: e.path, hash: e.hash }))
	});
	expect(commit.body).toMatchObject({ ok: true, applied: true });
	return call('POST', `/__enable?module=${enable}`);
}

const info = (name: string, extra = '') =>
	`name: ${name}\ntype: module\ncore_version_requirement: ^11\n${extra}`;

const enabledNow = async (site: ServeDo) =>
	(
		(await site.runJson(
			drupalOp(
				`$out['modules'] = array_keys(\\Drupal::config('core.extension')->get('module') ?? []);`
			)
		)) as { modules: string[] }
	).modules;

describe('uninstalling a module', () => {
	it('refuses what it should, names dependents, and removes a module nothing needs', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const call = owner(site, await ownerToken(site));
			const wrongMethod = await call('GET', `/__uninstall?module=${BASE}`);
			const noName = await call('POST', '/__uninstall');
			const badName = await call('POST', '/__uninstall?module=..%2Fx');
			const unknown = await call('POST', '/__uninstall?module=never_installed');
			const unknownDry = await call('POST', '/__uninstall?module=never_installed&dry=1');
			await deliver(
				call,
				BASE,
				{ [`modules/custom/${BASE}/${BASE}.info.yml`]: info('Probe') },
				BASE
			);
			const enabled = await deliver(
				call,
				DEPENDENT,
				{
					[`modules/custom/${DEPENDENT}/${DEPENDENT}.info.yml`]: info(
						'Probe dependent',
						`dependencies:\n  - ${BASE}\n`
					)
				},
				DEPENDENT
			);
			const dry = await call('POST', `/__uninstall?module=${BASE}&dry=1`);
			const afterDry = await enabledNow(site);
			const refused = await call('POST', `/__uninstall?module=${BASE}`);
			const afterRefusal = await enabledNow(site);
			const dependent = await call('POST', `/__uninstall?module=${DEPENDENT}`);
			const afterDependent = await enabledNow(site);
			const base = await call('POST', `/__uninstall?module=${BASE}`);
			const afterBase = await enabledNow(site);
			return {
				wrongMethod,
				noName,
				badName,
				unknown,
				unknownDry,
				enabled,
				dry,
				afterDry,
				refused,
				afterRefusal,
				dependent,
				afterDependent,
				base,
				afterBase
			};
		});
		expect(seen.wrongMethod.status).toBe(405);
		expect(seen.noName.status).toBe(400);
		expect(seen.badName.status).toBe(400);
		expect(seen.unknown).toMatchObject({ status: 404, body: { error: 'module_not_enabled' } });
		expect(seen.unknownDry.status).toBe(404);
		// the control for every refusal below: both modules really are enabled first
		expect(seen.enabled.body['ok']).toBe(true);
		expect(seen.afterDry).toEqual(expect.arrayContaining([BASE, DEPENDENT]));
		expect(seen.dry.body).toMatchObject({ ok: true, dryRun: true, dependents: [DEPENDENT] });
		expect(seen.dry.body['enabledModules']).toEqual(expect.arrayContaining([BASE, DEPENDENT]));
		expect(seen.refused).toMatchObject({
			status: 409,
			body: { error: 'module_has_dependents', dependents: [DEPENDENT] }
		});
		expect(seen.afterRefusal).toEqual(expect.arrayContaining([BASE, DEPENDENT]));
		expect(seen.dependent.body, JSON.stringify(seen.dependent)).toMatchObject({
			ok: true,
			uninstalled: true
		});
		expect(seen.afterDependent).toContain(BASE);
		expect(seen.afterDependent).not.toContain(DEPENDENT);
		expect(seen.base.body).toMatchObject({ ok: true, uninstalled: true });
		expect(seen.afterBase).not.toContain(BASE);
	}, 900_000);

	it('refuses a module that ships with every site, and leaves it enabled', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const call = owner(site, await ownerToken(site));
			const system = await call('POST', '/__uninstall?module=system');
			return { system, after: await enabledNow(site) };
		});
		expect(seen.system.status).toBe(409);
		expect(seen.system.body['error']).toMatch(/module_has_dependents|uninstall_blocked/);
		expect(seen.after).toContain('system');
	}, 900_000);
});

describe('setting the default and admin theme', () => {
	const readTheme = async (site: ServeDo) =>
		(await site.runJson(
			drupalOp(
				`$c = \\Drupal::config('system.theme'); $out['default'] = $c->get('default'); $out['admin'] = $c->get('admin');`
			)
		)) as { default: string; admin: string };

	it('reads the settings, sets one key at a time, and refuses what is not installed', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const call = owner(site, await ownerToken(site));
			const before = await call('GET', '/__theme-default');
			const enabled = await deliver(
				call,
				THEME,
				{
					[`themes/custom/${THEME}/${THEME}.info.yml`]: `name: Probe theme\ntype: theme\nbase theme: false\ncore_version_requirement: ^11\n`
				},
				THEME
			);
			const wrongMethod = await call('PUT', '/__theme-default', {});
			const badBody = await call('POST', '/__theme-default', { project: THEME });
			const badTarget = await call('POST', '/__theme-default', {
				project: THEME,
				target: 'both'
			});
			const missing = await call('POST', '/__theme-default', {
				project: 'never_installed',
				target: 'default'
			});
			const dry = await call('POST', '/__theme-default?dry=1', {
				project: THEME,
				target: 'default'
			});
			const afterDry = await readTheme(site);
			const admin = await call('POST', '/__theme-default', {
				project: THEME,
				target: 'admin'
			});
			const afterAdmin = await readTheme(site);
			const again = await call('POST', '/__theme-default', {
				project: THEME,
				target: 'admin'
			});
			const second = await call('POST', '/__theme-default', {
				project: THEME,
				target: 'default'
			});
			const afterSecond = await readTheme(site);
			const cleared = await call('POST', '/__theme-default', {
				project: '',
				target: 'admin'
			});
			const afterCleared = await readTheme(site);
			const emptyDefault = await call('POST', '/__theme-default', {
				project: '',
				target: 'default'
			});
			const afterEmptyDefault = await readTheme(site);
			return {
				before,
				enabled,
				wrongMethod,
				badBody,
				badTarget,
				missing,
				dry,
				afterDry,
				admin,
				afterAdmin,
				again,
				second,
				afterSecond,
				cleared,
				afterCleared,
				emptyDefault,
				afterEmptyDefault
			};
		});
		const start = seen.before.body as { default: string; admin: string; installed: string[] };
		expect(seen.before.status).toBe(200);
		expect(start.default).not.toBe('');
		// the control: the probe theme is installed and is not what the site started with
		expect(seen.enabled.body['ok']).toBe(true);
		expect(start.default).not.toBe(THEME);
		expect(seen.wrongMethod.status).toBe(405);
		expect(seen.badBody.status).toBe(400);
		expect(seen.badTarget.status).toBe(400);
		expect(seen.missing).toMatchObject({ status: 404, body: { error: 'theme_not_installed' } });
		expect(seen.dry.body).toMatchObject({ default: start.default, admin: start.admin });
		expect(seen.afterDry).toMatchObject({ default: start.default, admin: start.admin });
		expect(seen.admin.body).toMatchObject({
			admin: THEME,
			default: start.default,
			applied: true,
			previous: { default: start.default, admin: start.admin }
		});
		expect(seen.afterAdmin).toMatchObject({ default: start.default, admin: THEME });
		expect(seen.again.body).toMatchObject({ admin: THEME, applied: true });
		expect(seen.second.body).toMatchObject({ default: THEME, admin: THEME });
		expect(seen.afterSecond).toMatchObject({ default: THEME, admin: THEME });
		// an empty admin clears it to "same as default"; an empty default is refused and changes nothing
		expect(seen.cleared.body).toMatchObject({ default: THEME, admin: '', applied: true });
		expect(seen.afterCleared).toMatchObject({ default: THEME, admin: '' });
		expect(seen.emptyDefault.status).toBe(400);
		expect(seen.afterEmptyDefault).toMatchObject({ default: THEME, admin: '' });
	}, 900_000);
});

describe('listing the extensions', () => {
	type Row = { name: string; kind: string; version: string | null; enabled: boolean };
	const rowsOf = (res: { body: unknown }) => res.body as Row[];

	it('refuses a wrong method and changes nothing', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const call = owner(site, await ownerToken(site));
			const before = await enabledNow(site);
			const post = await call('POST', '/__extensions');
			const put = await call('PUT', '/__extensions');
			return { before, post, put, after: await enabledNow(site) };
		});
		expect(seen.post.status).toBe(405);
		expect(seen.put.status).toBe(405);
		expect(seen.after).toEqual(seen.before);
	}, 900_000);

	it('lists what is discovered with its version, marks a delivered module enabled only once it is', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const call = owner(site, await ownerToken(site));
			const files = {
				[`modules/custom/${BASE}/${BASE}.info.yml`]: info('Probe', 'version: 2.4.1\n')
			};
			const entries = await Promise.all(
				Object.entries(files).map(async ([path, source]) => ({
					path,
					source,
					hash: await sha256(source)
				}))
			);
			await call('POST', `/__modify?action=blobs&package=${BASE}`, {
				blobs: entries.map((e) => ({ hash: e.hash, source: e.source }))
			});
			await call('POST', `/__modify?action=commit&package=${BASE}`, {
				files: entries.map((e) => ({ path: e.path, hash: e.hash }))
			});
			const delivered = await call('GET', '/__extensions');
			await call('POST', `/__enable?module=${BASE}`);
			const enabled = await call('GET', '/__extensions');
			await call('POST', `/__uninstall?module=${BASE}`);
			const removed = await call('GET', '/__extensions');
			return { delivered, enabled, removed };
		});
		const find = (res: { body: unknown }, name: string) =>
			rowsOf(res).find((r) => r.name === name && r.kind === 'module');
		expect(seen.delivered.status).toBe(200);
		expect(find(seen.delivered, BASE)).toEqual({
			name: BASE,
			kind: 'module',
			version: '2.4.1',
			enabled: false
		});
		expect(find(seen.enabled, BASE)).toMatchObject({ version: '2.4.1', enabled: true });
		expect(find(seen.removed, BASE)).toMatchObject({ enabled: false });
	}, 900_000);

	it('reports core, a theme and the install profile once each, with a null version where the info file has none', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const call = owner(site, await ownerToken(site));
			await deliver(
				call,
				THEME,
				{
					[`themes/custom/${THEME}/${THEME}.info.yml`]: `name: Probe theme\ntype: theme\nbase theme: false\ncore_version_requirement: ^11\n`
				},
				THEME
			);
			const res = await site.fetch(
				new Request(`${ORIGIN}/__extensions`, {
					headers: { authorization: `Bearer ${await ownerToken(site)}` }
				})
			);
			return { res, listed: await call('GET', '/__extensions') };
		});
		const rows = rowsOf(seen.listed);
		expect(seen.res.headers.get('cache-control')).toBe('no-store');
		expect(rows.length).toBeGreaterThan(50);
		const system = rows.find((r) => r.name === 'system' && r.kind === 'module');
		expect(system).toMatchObject({ enabled: true });
		expect(system?.version).toMatch(/^11\./);
		expect(rows.find((r) => r.name === THEME)).toEqual({
			name: THEME,
			kind: 'theme',
			version: null,
			enabled: true
		});
		const profiles = rows.filter((r) => r.kind === 'profile');
		expect(profiles.filter((r) => r.enabled)).toHaveLength(1);
		for (const profile of profiles) {
			expect(rows.filter((r) => r.name === profile.name)).toHaveLength(1);
		}
		const keys = rows.map((r) => `${r.name}:${r.kind}`);
		expect(new Set(keys).size).toBe(keys.length);
		const before = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
		expect(rows).toEqual(
			[...rows].sort((a, b) => before(a.name, b.name) || before(a.kind, b.kind))
		);
	}, 900_000);

	it('answers the same list on a replica, which only reads', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const call = owner(site, await ownerToken(site));
			const primary = await call('GET', '/__extensions');
			const host = site as unknown as { isReplica: () => boolean };
			const wasReplica = host.isReplica;
			host.isReplica = () => true;
			const replica = await call('GET', '/__extensions');
			host.isReplica = wasReplica;
			return { primary, replica };
		});
		expect(seen.replica.status).toBe(200);
		expect(seen.replica.body).toEqual(seen.primary.body);
	}, 900_000);
});

describe('resetting the admin password', () => {
	const storedHash = async (site: ServeDo) =>
		(
			(await site.runJson(
				drupalOp(
					`\\Drupal::entityTypeManager()->getStorage('user')->resetCache([1]); $out['hash'] = \\Drupal\\user\\Entity\\User::load(1)->getPassword();`
				)
			)) as { hash: string }
		).hash;

	it('sets a generated password for user 1, returns it once, and refuses a GET', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const token = await ownerToken(site);
			const call = owner(site, token);
			const before = await storedHash(site);
			const wrongMethod = await call('GET', '/__admin-password');
			const afterRefusal = await storedHash(site);
			// a fresh interpreter has not loaded the legacy include that defines SAVED_UPDATED, as a
			// site that has rendered since its claim has not; without the include the save fatals
			(site as unknown as { dropInterpreter(): void }).dropInterpreter();
			const raw = await site.fetch(
				new Request(`${ORIGIN}/__admin-password`, {
					method: 'POST',
					headers: { authorization: `Bearer ${token}` }
				})
			);
			const first = (await raw.json()) as Json;
			const afterFirst = await storedHash(site);
			const second = await call('POST', '/__admin-password');
			const afterSecond = await storedHash(site);
			return {
				before,
				wrongMethod,
				afterRefusal,
				raw,
				first,
				afterFirst,
				second,
				afterSecond
			};
		});
		// the refused GET is the control: it leaves the stored hash as the first run wrote it
		expect(seen.before).not.toBe('');
		expect(seen.wrongMethod.status).toBe(405);
		expect(seen.afterRefusal).toBe(seen.before);
		expect(seen.raw.status).toBe(200);
		expect(seen.raw.headers.get('cache-control')).toBe('no-store');
		expect(seen.first).toMatchObject({ ok: true, uid: 1, applied: true });
		expect(String(seen.first['password'])).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(seen.afterFirst).not.toBe(seen.before);
		expect(seen.second.body['password']).not.toBe(seen.first['password']);
		expect(seen.afterSecond).not.toBe(seen.afterFirst);
	}, 900_000);

	it('answers 409 and changes nothing while a transaction is open or on a replica, and audits a reset', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const token = await ownerToken(site);
			const call = owner(site, token);
			const before = await storedHash(site);
			const host = site as unknown as { speculating: boolean; isReplica: () => boolean };
			host.speculating = true;
			const open = await call('POST', '/__admin-password');
			host.speculating = false;
			const wasReplica = host.isReplica;
			host.isReplica = () => true;
			const replica = await call('POST', '/__admin-password');
			host.isReplica = wasReplica;
			const afterRefusals = await storedHash(site);
			const reset = await call('POST', '/__admin-password');
			const entries = readAudit(site.secretStore().sealed).entries as {
				route: string;
				status: number;
			}[];
			return { before, open, replica, afterRefusals, reset, entries };
		});
		expect(seen.open.status).toBe(409);
		expect(seen.replica.status).toBe(409);
		expect(seen.afterRefusals).toBe(seen.before);
		expect(seen.reset.status).toBe(200);
		// the refused call on a replica is not recorded; the open transaction and the reset are
		const audited = seen.entries.filter((e) => e.route === '/admin-password');
		expect(audited.map((e) => e.status)).toEqual([409, 200]);
		expect(JSON.stringify(seen.entries)).not.toContain(String(seen.reset.body['password']));
	}, 900_000);
});
