import { gzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { changeModuleFiles } from '../../src/do/module-files';
import { installLock, install as installRoute } from '../../src/do/routes/packages';
import { sourceBytes } from '../../src/ops/module-bytes';
import { SHIPPED_CORE_VERSION, SHIPPED_LOCK_VERSIONS } from '../../src/ops/shipped-lock';
import { randomKeyBase64, rotateOwnerToken } from '../../src/ops/site-secrets';
import type { SitePhpDurableObject } from '../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

const bytes = (text: string) => new TextEncoder().encode(text);
const hex = (data: ArrayBuffer) =>
	[...new Uint8Array(data)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha1 = async (data: Uint8Array) =>
	hex(await crypto.subtle.digest('SHA-1', data as Uint8Array<ArrayBuffer>));

/** a zip with an archive comment, which is where a GitHub zipball records its commit */
function withComment(zip: Uint8Array, comment: string): Uint8Array {
	const text = bytes(comment);
	const out = new Uint8Array(zip.length + text.length);
	out.set(zip);
	out.set(text, zip.length);
	out[zip.length - 2] = text.length & 0xff;
	out[zip.length - 1] = text.length >> 8;
	return out;
}

/** a minimal ustar archive, gzipped as an npm registry serves it */
function tgzOf(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const [name, body] of entries) {
		const header = new Uint8Array(512);
		const put = (offset: number, text: string) => {
			for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
		};
		put(0, name);
		put(100, '0000644\0');
		put(124, body.length.toString(8).padStart(11, '0') + '\0');
		put(156, '0');
		put(257, 'ustar\0' + '00');
		for (let i = 148; i < 156; i++) header[i] = 32;
		let sum = 0;
		for (const b of header) sum += b;
		put(148, sum.toString(8).padStart(6, '0') + '\0 ');
		blocks.push(header);
		const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
		padded.set(body);
		blocks.push(padded);
	}
	blocks.push(new Uint8Array(1024));
	const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
	let at = 0;
	for (const b of blocks) {
		out.set(b, at);
		at += b.length;
	}
	return gzipSync(out);
}

const assetTgz = tgzOf([
	['package/dist/dropzone.js', bytes('var Dropzone = {};')],
	['package/dist/dropzone.css', bytes('.dropzone {}')],
	['package/README.md', bytes('docs')],
	['package/test/spec.js', bytes('spec')]
]);

const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const modZip = zipSync({
	'mod-1/mod.info.yml': bytes('name: Mod\ntype: module\n'),
	'mod-1/mod.module': bytes('<?php\n')
});
const libZip = withComment(
	zipSync({ 'lib-1/src/Lib.php': bytes('<?php namespace Acme\\Lib; class Lib {}') }),
	COMMIT
);
const shippedName = Object.keys(SHIPPED_LOCK_VERSIONS).find((n) => !n.startsWith('drupal/core'))!;

type Pkg = Record<string, unknown>;
const pkg = (name: string, extra: Pkg = {}): Pkg => ({
	name,
	version: '1.0.0',
	type: 'library',
	...extra
});
const core = (version = SHIPPED_CORE_VERSION) =>
	pkg('drupal/core', { version, dist: { type: 'zip', url: 'https://dist.test/core.zip' } });

async function goodPackages(): Promise<Pkg[]> {
	return [
		core(),
		pkg('acme/mod', {
			type: 'drupal-module',
			dist: { type: 'zip', url: 'https://dist.test/mod.zip', shasum: await sha1(modZip) }
		}),
		pkg('acme/lib', {
			autoload: { 'psr-4': { 'Acme\\Lib\\': 'src/' } },
			dist: {
				type: 'zip',
				url: 'https://dist.test/lib.zip',
				shasum: '',
				reference: COMMIT
			}
		}),
		pkg('acme/plugin', {
			type: 'composer-plugin',
			dist: { type: 'zip', url: 'https://x/p.zip' }
		}),
		pkg('acme/local', { dist: { type: 'path', url: '../local' } }),
		pkg('acme/nodist'),
		pkg(shippedName, {
			version: SHIPPED_LOCK_VERSIONS[shippedName],
			dist: { type: 'zip', url: 'https://x/s.zip' }
		})
	];
}

const archives: Record<string, Uint8Array> = {
	'https://dist.test/mod.zip': modZip,
	'https://dist.test/lib.zip': libZip
};

/** runs `fn` with fetch answering from `archives`, and counts the archive fetches */
async function withArchives<T>(
	served: Record<string, Uint8Array>,
	fn: (fetched: string[]) => Promise<T>
): Promise<T> {
	const real = globalThis.fetch;
	const fetched: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		fetched.push(url);
		const body = served[url];
		return body === undefined ? new Response('gone', { status: 404 }) : new Response(body);
	}) as typeof fetch;
	try {
		return await fn(fetched);
	} finally {
		globalThis.fetch = real;
	}
}

type Json = Record<string, any>;

/** a site with an owner token, and a caller that carries it */
async function claimed(site: ServeDo) {
	const real = site as unknown as SitePhpDurableObject;
	const token = await rotateOwnerToken(real.secretStore(), randomKeyBase64);
	let drops = 0;
	const drop = real.dropCompiledContainer.bind(real);
	real.dropCompiledContainer = () => {
		drops++;
		drop();
	};
	const call = async (method: string, query: string, body?: unknown, auth = true) => {
		const url = new URL(`https://cfw.local/install-lock${query}`);
		const res = await installLock(
			real,
			new Request(url, {
				method,
				headers: auth ? { authorization: `Bearer ${token}` } : {},
				body: body === undefined ? undefined : JSON.stringify(body)
			}),
			url
		);
		return { status: res.status, body: (await res.json()) as Json };
	};
	const rows = () =>
		Number(site.sql.exec('SELECT count(*) AS n FROM cfw_module_file').toArray()[0]?.['n']);
	return { real, call, rows, drops: () => drops };
}

describe('POST /install-lock', () => {
	it('refuses a call without the owner token, and a GET', async () => {
		await inObject(freshSite(), async (site) => {
			const c = await claimed(site);
			const none = await c.call('POST', '', { packages: [] }, false);
			expect(none.status).toBe(401);
			const get = await c.call('GET', '');
			expect(get.status).toBe(405);
		});
	});

	it('installs a lock, reports every skip by name, and repeats without a write', async () => {
		await withArchives(archives, async (fetched) => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				const lock = { packages: await goodPackages(), profile: 'acme_profile' };
				const first = await c.call('POST', '', lock);
				expect(first.body['failed']).toEqual([]);
				expect(first.status).toBe(200);
				expect(first.body).toMatchObject({ ok: true, done: true, patches: 'not applied' });
				expect(first.body['installed'].map((i: Json) => i['name'])).toEqual([
					'acme/mod',
					'acme/lib'
				]);
				expect(first.body['installed'][1]['verified']).toBe(`commit:${COMMIT}`);
				const reasons = Object.fromEntries(
					first.body['skipped'].map((s: Json) => [s['name'], s['reason']])
				);
				expect(reasons['acme/plugin']).toContain('composer-plugin');
				expect(reasons['acme/local']).toContain('path package');
				expect(reasons['acme/nodist']).toContain('no dist url');
				expect(reasons[shippedName]).toContain('shipped');
				expect(reasons['drupal/core']).toContain('core');
				expect(fetched).toHaveLength(2);
				const rows = c.rows();
				expect(rows).toBe(3);
				expect(c.drops()).toBe(1);
				expect(first.body['cache']).toBe('compiled container dropped');
				const autoload = site.sql
					.exec('SELECT package FROM cfw_package_autoload')
					.toArray()
					.map((r) => r['package']);
				expect(autoload).toEqual(['acme/lib']);

				const again = await c.call('POST', '', lock);
				expect(again.body).toEqual(first.body);
				expect(fetched).toHaveLength(2);
				expect(c.rows()).toBe(rows);
				expect(c.drops()).toBe(1);
			});
		});
	});

	it('answers a window at a time and refuses a cursor ahead of the session', async () => {
		const plugins = Array.from({ length: 45 }, (_, i) =>
			pkg(`acme/plug${i}`, { type: 'composer-plugin' })
		);
		await inObject(freshSite(), async (site) => {
			const c = await claimed(site);
			const lock = { packages: [core(), ...plugins] };
			const ahead = await c.call('POST', '', { ...lock, cursor: 5 });
			expect(ahead.status).toBe(409);
			const first = await c.call('POST', '', lock);
			expect(first.body).toMatchObject({ done: false, cursor: 40 });
			expect(c.drops()).toBe(0);
			const second = await c.call('POST', '', { ...lock, cursor: 40 });
			expect(second.body).toMatchObject({ done: true, cursor: 46 });
			expect(second.body['skipped']).toHaveLength(46);
			expect(second.body['cache']).toBe('nothing to drop');
		});
	});

	it('stops at a digest mismatch with nothing written for that package', async () => {
		await withArchives(archives, async (fetched) => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				const [, mod, lib] = await goodPackages();
				const bad = pkg('acme/bad', {
					type: 'drupal-module',
					dist: {
						type: 'zip',
						url: 'https://dist.test/mod.zip',
						shasum: await sha1(bytes('another archive'))
					}
				});
				const lock = { packages: [core(), mod, bad, lib] };
				const out = await c.call('POST', '', lock);
				expect(out.status).toBe(502);
				expect(out.body).toMatchObject({ ok: false, done: false, cursor: 2 });
				expect(out.body['failed'][0]['error']).toContain(
					'does not match its published SHA-1'
				);
				expect(out.body['installed'].map((i: Json) => i['name'])).toEqual(['acme/mod']);
				// the package after the failure is never fetched
				expect(fetched).toHaveLength(2);
				const owners = site.sql
					.exec('SELECT DISTINCT package FROM cfw_module_file')
					.toArray()
					.map((r) => r['package']);
				expect(owners).toEqual(['acme/mod']);
				const retry = await c.call('POST', '', lock);
				expect(retry.status).toBe(502);
				expect(c.drops()).toBe(0);
			});
		});
	});

	it('refuses an archive whose commit is not the lock reference', async () => {
		await withArchives(archives, async () => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				const [, , lib] = await goodPackages();
				const wrong = {
					...lib,
					dist: {
						type: 'zip',
						url: 'https://dist.test/lib.zip',
						shasum: '',
						reference: OTHER
					}
				};
				const out = await c.call('POST', '', { packages: [core(), wrong] });
				expect(out.status).toBe(502);
				expect(out.body['failed'][0]['error']).toContain(`lock names ${OTHER}`);
				expect(c.rows()).toBe(0);
			});
		});
	});

	it('rolls a session back, restoring the rows it replaced', async () => {
		await withArchives(archives, async () => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				site.sql.exec('SELECT 1');
				(c.real as unknown as { ensureServeTables(): void }).ensureServeTables();
				changeModuleFiles(c.real, 'acme/mod', {
					put: [
						{
							path: 'modules/contrib/mod/mod.module',
							version: '0.9.0',
							source: 'old module'
						},
						{
							path: 'modules/contrib/mod/old.txt.php',
							version: '0.9.0',
							source: 'old only'
						}
					],
					installedAt: 1
				});
				const lock = { packages: await goodPackages() };
				const out = await c.call('POST', '', lock);
				expect(out.body['done']).toBe(true);
				const kept = () =>
					site.sql
						.exec('SELECT path, version, source FROM cfw_module_file ORDER BY path')
						.toArray();
				expect(kept().some((r) => r['path'] === 'modules/contrib/mod/mod.info.yml')).toBe(
					true
				);
				const undone = await c.call('DELETE', `?session=${out.body['session']}`);
				expect(undone.body).toMatchObject({ ok: true, rolledBack: true, removed: 2 });
				expect(kept()).toEqual([
					{
						path: 'modules/contrib/mod/mod.module',
						version: '0.9.0',
						source: 'old module'
					},
					{
						path: 'modules/contrib/mod/old.txt.php',
						version: '0.9.0',
						source: 'old only'
					}
				]);
				expect(site.sql.exec('SELECT * FROM cfw_package_autoload').toArray()).toEqual([]);
				const again = await c.call('DELETE', `?session=${out.body['session']}`);
				expect(again.status).toBe(404);
				expect(again.body).toMatchObject({ ok: false, rolledBack: true });
				const missing = await c.call('DELETE', '?session=0123456789abcdef');
				expect(missing.status).toBe(404);
				// the lock installs again after a rollback
				const redo = await c.call('POST', '', lock);
				expect(redo.body['installed']).toHaveLength(2);
			});
		});
	});

	it('reports the reused packages a rollback leaves in place', async () => {
		await withArchives(archives, async () => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				const [, mod, lib] = await goodPackages();
				const first = await c.call('POST', '', { packages: [core(), mod, lib] });
				expect(first.body['done']).toBe(true);

				const bad = pkg('acme/bad', {
					type: 'drupal-module',
					dist: {
						type: 'zip',
						url: 'https://dist.test/mod.zip',
						shasum: await sha1(bytes('another archive'))
					}
				});
				const second = await c.call('POST', '', { packages: [core(), mod, bad] });
				expect(second.status).toBe(502);
				expect(second.body['installed'].map((i: Json) => [i['name'], i['reused']])).toEqual(
					[['acme/mod', true]]
				);
				const undone = await c.call('DELETE', `?session=${second.body['session']}`);
				expect(undone.status).toBe(200);
				expect(undone.body).toMatchObject({ removed: 0, restored: 0 });
				expect(undone.body['leftInPlace']).toEqual([
					{ name: 'acme/mod', version: '1.0.0', files: 2 }
				]);
				// the first session's files are untouched
				expect(c.rows()).toBe(3);
			});
		});
	});

	it('installs a package that ships a tar into libraries', async () => {
		const served = { ...archives, 'https://registry.test/dropzone.tgz': assetTgz };
		await withArchives(served, async () => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				const asset = pkg('npm-asset/dropzone', {
					version: '5.9.3',
					type: 'npm-asset-library',
					dist: {
						type: 'tar',
						url: 'https://registry.test/dropzone.tgz',
						shasum: await sha1(assetTgz)
					}
				});
				const out = await c.call('POST', '', { packages: [core(), asset] });
				expect(out.status).toBe(200);
				expect(out.body['installed']).toEqual([
					expect.objectContaining({ name: 'npm-asset/dropzone', files: 2 })
				]);
				expect(out.body['installed'][0]['verified']).toContain('sha1:');
				const paths = site.sql
					.exec('SELECT path FROM cfw_module_file ORDER BY path')
					.toArray()
					.map((r) => r['path']);
				expect(paths).toEqual([
					'libraries/dropzone/dist/dropzone.css',
					'libraries/dropzone/dist/dropzone.js'
				]);
			});
		});
	});

	it('keeps a tar library images and fonts as stored bytes and lists an oversized one by path', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254, 0]);
		const woff = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 1]);
		const huge = new Uint8Array(1_700_000).fill(0xab);
		const tgz = tgzOf([
			['package/dist/dropzone.js', bytes('var Dropzone = {};')],
			['package/images/spritemap.png', png],
			['package/fonts/icons.woff2', woff],
			['package/images/logo.svg', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')],
			['package/images/big.png', huge],
			['package/notes.txt', bytes('dropped')]
		]);
		await withArchives({ 'https://registry.test/dropzone.tgz': tgz }, async () => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				const asset = pkg('npm-asset/dropzone', {
					version: '5.9.3',
					type: 'npm-asset-library',
					dist: {
						type: 'tar',
						url: 'https://registry.test/dropzone.tgz',
						shasum: await sha1(tgz)
					}
				});
				const out = await c.call('POST', '', { packages: [core(), asset] });
				expect(out.status).toBe(200);
				expect(out.body['ok']).toBe(true);
				expect(out.body['failed']).toEqual([]);
				expect(out.body['installed'][0]['files']).toBe(4);
				expect(out.body['skippedFiles']).toEqual([
					expect.objectContaining({
						package: 'npm-asset/dropzone',
						path: 'libraries/dropzone/images/big.png'
					})
				]);
				const held = new Map(
					site.sql
						.exec('SELECT path, source FROM cfw_module_file')
						.toArray()
						.map((r) => [String(r['path']), String(r['source'])])
				);
				expect([...held.keys()].sort()).toEqual([
					'libraries/dropzone/dist/dropzone.js',
					'libraries/dropzone/fonts/icons.woff2',
					'libraries/dropzone/images/logo.svg',
					'libraries/dropzone/images/spritemap.png'
				]);
				expect(sourceBytes(held.get('libraries/dropzone/images/spritemap.png')!)).toEqual(
					png
				);
				expect(sourceBytes(held.get('libraries/dropzone/fonts/icons.woff2')!)).toEqual(
					woff
				);
				expect(held.get('libraries/dropzone/images/logo.svg')).toContain('<svg');

				// a rollback removes the list with the session
				const session = String(out.body['session']);
				await c.call('DELETE', `?session=${session}`);
				const left = site.sql.exec('SELECT 1 AS n FROM cfw_lock_skipped').toArray();
				expect(left).toEqual([]);
			});
		});
	});

	it('refuses a tar whose digest does not match', async () => {
		await withArchives({ 'https://registry.test/dropzone.tgz': assetTgz }, async () => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				const asset = pkg('npm-asset/dropzone', {
					type: 'npm-asset-library',
					dist: {
						type: 'tar',
						url: 'https://registry.test/dropzone.tgz',
						shasum: await sha1(bytes('another archive'))
					}
				});
				const out = await c.call('POST', '', { packages: [core(), asset] });
				expect(out.status).toBe(502);
				expect(out.body['failed'][0]['error']).toContain(
					'does not match its published SHA-1'
				);
				expect(c.rows()).toBe(0);
			});
		});
	});

	it('refuses a lock built for another core, naming both', async () => {
		await inObject(freshSite(), async (site) => {
			const c = await claimed(site);
			const out = await c.call('POST', '', { packages: [core('10.3.1')] });
			expect(out.status).toBe(422);
			expect(out.body).toMatchObject({ lockCore: '10.3.1', siteCore: SHIPPED_CORE_VERSION });
			const none = await c.call('POST', '', { packages: [pkg('acme/mod')] });
			expect(none.status).toBe(422);
		});
	});

	it('accepts a patch-level difference in core', async () => {
		await inObject(freshSite(), async (site) => {
			const c = await claimed(site);
			const [major, minor] = SHIPPED_CORE_VERSION.split('.');
			const out = await c.call('POST', '', { packages: [core(`${major}.${minor}.0`)] });
			expect(out.status).toBe(200);
		});
	});

	it('refuses a lock above the package cap and a body above the ceiling', async () => {
		await inObject(freshSite(), async (site) => {
			const c = await claimed(site);
			const many = Array.from({ length: 401 }, (_, i) => pkg(`acme/p${i}`));
			const capped = await c.call('POST', '', { packages: [core(), ...many] });
			expect(capped.status).toBe(422);
			expect(capped.body).toMatchObject({ cap: 400 });
			const huge = await c.call('POST', '', {
				packages: [core()],
				_readme: 'x'.repeat(2 * 1024 * 1024 + 1)
			});
			expect(huge.status).toBe(413);
		});
	});

	it('answers 409 and writes nothing while a transaction is open', async () => {
		await withArchives(archives, async (fetched) => {
			await inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				c.real.speculating = true;
				const out = await c.call('POST', '', { packages: await goodPackages() });
				expect(out.status).toBe(409);
				const undo = await c.call('DELETE', '?session=0123456789abcdef');
				expect(undo.status).toBe(409);
				expect(fetched).toHaveLength(0);
				expect(c.rows()).toBe(0);
			});
		});
	});
});

describe('POST /install with a named conflict', () => {
	const conflict = (requires: string) => ({
		requires,
		constraint: '^1.22',
		installed: '1.20.0',
		reason: 'version' as const,
		detail: `${requires} is ${'1.20.0'}`
	});
	const run = async (query: string, conflicts: ReturnType<typeof conflict>[]) =>
		withArchives({}, async () =>
			inObject(freshSite(), async (site) => {
				const c = await claimed(site);
				(c.real as unknown as { installableVerdict: unknown }).installableVerdict =
					async () => ({
						name: 'acme/needs_key',
						version: '1.0.0',
						verdict: 'conflict',
						conflicts
					});
				const url = new URL(`https://cfw.local/install?module=acme/needs_key${query}`);
				const res = await installRoute(
					c.real,
					new Request(url, { method: 'POST', headers: { authorization: 'Bearer x' } }),
					url
				);
				return { status: res.status, body: (await res.json()) as Json };
			})
		);

	it('refuses a conflict nobody named, and says how', async () => {
		const out = await run('', [conflict('drupal/key')]);
		expect(out.status).toBe(409);
		expect(out.body['refused']).toBe('conflict');
		expect(out.body['conflicts']).toHaveLength(1);
	});

	it('goes past the check when every conflict is a named one', async () => {
		const out = await run('&accept=drupal/key', [conflict('drupal/key')]);
		// past the gate, the install reaches the registry, which the stub answers 404
		expect(out.status).not.toBe(409);
		expect(String(out.body['error'])).toContain('metadata 404');
	});

	it('answers 400 naming an accepted package that is not a current conflict', async () => {
		const stale = await run('&accept=drupal/key,drupal/gone', [conflict('drupal/key')]);
		expect(stale.status).toBe(400);
		expect(stale.body['code']).toBe('accept_not_in_conflicts');
		expect(stale.body['unlisted']).toEqual(['drupal/gone']);
		expect(String(stale.body['error'])).toContain('drupal/gone');
		// control: with every accepted package in the conflict set the same call goes through
		const exact = await run('&accept=drupal/key', [conflict('drupal/key')]);
		expect(exact.status).not.toBe(400);
		const resolved = await run('&accept=drupal/key', []);
		expect(resolved.status).toBe(400);
	});

	it('still refuses when a second conflict was not named', async () => {
		const out = await run('&accept=drupal/key', [
			conflict('drupal/key'),
			conflict('drupal/other')
		]);
		expect(out.status).toBe(409);
		expect(out.body['conflicts']).toHaveLength(2);
	});
});
