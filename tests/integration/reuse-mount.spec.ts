import { describe, expect, it, vi } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * REUSE_MOUNT: a restarted interpreter keeps its mount when the module rows, the settings inputs
 * and the filesystem are as the mount left them, and rebuilds it otherwise.
 *
 * Real boots of the shipping binary. A kept mount shows as the same `/drupal` node and the same
 * `mountInfo` object across the restart, with no installed-module read.
 */

type Booted = {
	php: object;
	binary: {
		FS: { lookupPath(path: string): { node: object } };
		mountStamp?: object;
		mountWatch?: object;
	};
};

const boot = async (site: ServeDo) => (await site.ensurePhp()) as unknown as Booted;

const PAGE = /cfw_module_file WHERE path>\?/;
const ROW_SOURCE = /SELECT source FROM cfw_module_file WHERE path=\?/;
const MODULE_READ = /length\(CAST\(source AS BLOB\)\)/;

const MODULES = [1, 2, 3].map((n) => ({
	path: `modules/contrib/reuse_probe${n}/reuse_probe${n}.info.yml`,
	source: `name: Reuse probe ${n}\ntype: module\ncore_version_requirement: ^11\n`
}));

function seedModules(site: ServeDo): void {
	site.ensureServeTables();
	for (const m of MODULES) {
		site.sql.exec(
			`INSERT INTO cfw_module_file (path, package, version, source, installed_at)
			 VALUES (?, 'drupal/reuse_probe', '1.0.0', ?, 100)`,
			m.path,
			m.source
		);
	}
}

const READ = `<?php echo json_encode([
	'class' => class_exists('ReuseProbe', false),
	'mounted' => is_dir('/drupal/core')
]);`;

const SET = `<?php class ReuseProbe {} echo '1';`;

/** counts the statements whose text matches, and lets a case fail one of them */
function watchSql(site: ServeDo, failOn?: RegExp) {
	const seen: string[] = [];
	// the raw storage: `site.sql` is a counting proxy that calls it, so a spy there would recurse
	const raw = site.ctx.storage.sql;
	const original = raw.exec.bind(raw);
	const spy = vi.spyOn(raw, 'exec').mockImplementation((text: string, ...params: unknown[]) => {
		seen.push(text);
		if (failOn?.test(text)) throw new Error('stamp refused');
		return original(text, ...params);
	});
	return {
		count: (pattern: RegExp) => seen.filter((t) => pattern.test(t)).length,
		clear: () => (seen.length = 0),
		restore: () => spy.mockRestore()
	};
}

async function withEnv<T>(site: ServeDo, flags: Record<string, string>, fn: () => Promise<T>) {
	for (const [name, value] of Object.entries(flags)) site.env[name] = value;
	try {
		return await fn();
	} finally {
		for (const name of Object.keys(flags)) delete site.env[name];
	}
}

const BOTH = { REFRESH_INSTANCE: '1', REUSE_MOUNT: '1' };

describe('REUSE_MOUNT off', () => {
	it('adds no statement to a cold boot, with or without restarts on', async () => {
		const arms: Array<Record<string, string>> = [
			{ REFRESH_INSTANCE: '1' },
			{ REUSE_MOUNT: '1' },
			{}
		];
		for (const flags of arms) {
			const out = await inObject(freshSite(), async (site) =>
				withEnv(site, flags, async () => {
					seedModules(site);
					const sql = watchSql(site);
					try {
						const booted = await boot(site);
						return {
							page: sql.count(PAGE),
							rows: sql.count(ROW_SOURCE),
							mountRead: sql.count(MODULE_READ),
							stamp: booted.binary.mountStamp,
							watch: booted.binary.mountWatch
						};
					} finally {
						sql.restore();
					}
				})
			);
			expect(out.page, JSON.stringify(flags)).toBe(0);
			expect(out.rows).toBe(0);
			expect(out.mountRead, 'the mount still reads its modules').toBeGreaterThan(0);
			expect(out.stamp).toBeUndefined();
			expect(out.watch).toBeUndefined();
		}
	}, 120_000);

	it('rebuilds the mount on a restart', async () => {
		const out = await inObject(freshSite(), async (site) =>
			withEnv(site, { REFRESH_INSTANCE: '1' }, async () => {
				const before = (await boot(site)).binary.FS.lookupPath('/drupal').node;
				site.dropInterpreter();
				const after = (await boot(site)).binary.FS.lookupPath('/drupal').node;
				return { same: before === after, verdict: site.lastMountReuse };
			})
		);
		expect(out.same).toBe(false);
		expect(out.verdict).toBeUndefined();
	}, 120_000);
});

describe('REUSE_MOUNT on', () => {
	it('stamps a cold boot with one page statement and one read per module row', async () => {
		const out = await inObject(freshSite(), async (site) =>
			withEnv(site, BOTH, async () => {
				seedModules(site);
				const sql = watchSql(site);
				try {
					const booted = await boot(site);
					return {
						page: sql.count(PAGE),
						rows: sql.count(ROW_SOURCE),
						stamp: booted.binary.mountStamp,
						watch: booted.binary.mountWatch
					};
				} finally {
					sql.restore();
				}
			})
		);
		expect(out.page).toBe(1);
		expect(out.rows).toBe(MODULES.length);
		expect(out.stamp).toBeDefined();
		expect(out.watch).toBeDefined();
	}, 120_000);

	it('keeps the mount across a restart when nothing it was built from changed', async () => {
		const out = await inObject(freshSite(), async (site) =>
			withEnv(site, BOTH, async () => {
				seedModules(site);
				const first = await boot(site);
				const node = first.binary.FS.lookupPath('/drupal').node;
				const info = site.mountInfo;
				await site.run(SET);
				site.dropInterpreter();
				const sql = watchSql(site);
				try {
					const second = await boot(site);
					return {
						sameNode: second.binary.FS.lookupPath('/drupal').node === node,
						sameInfo: site.mountInfo === info,
						mountRead: sql.count(MODULE_READ),
						verdict: site.lastMountReuse,
						refreshed: site.instancesRefreshed,
						read: await site.runJson(READ)
					};
				} finally {
					sql.restore();
				}
			})
		);
		expect(out.refreshed).toBe(1);
		expect(out.verdict).toMatchObject({ kept: true, reason: 'unchanged' });
		expect(out.sameNode).toBe(true);
		expect(out.sameInfo).toBe(true);
		expect(out.mountRead, 'no installed-module read on a kept mount').toBe(0);
		expect(out.read).toEqual({ class: false, mounted: true });
	}, 120_000);

	it('rebuilds the mount when a module row changes, by one byte of the same length', async () => {
		const out = await inObject(freshSite(), async (site) =>
			withEnv(site, BOTH, async () => {
				seedModules(site);
				const first = await boot(site);
				const node = first.binary.FS.lookupPath('/drupal').node;
				site.sql.exec(
					'UPDATE cfw_module_file SET source = ? WHERE path = ?',
					MODULES[0]!.source.replace('probe', 'PROBE'),
					MODULES[0]!.path
				);
				site.dropInterpreter();
				const second = await boot(site);
				return {
					sameNode: second.binary.FS.lookupPath('/drupal').node === node,
					verdict: site.lastMountReuse,
					read: await site.runJson(READ)
				};
			})
		);
		expect(out.verdict).toMatchObject({ kept: false, reason: 'modules changed' });
		expect(out.sameNode).toBe(false);
		expect(out.read['mounted']).toBe(true);
	}, 120_000);

	it('rebuilds the mount when a settings input changes', async () => {
		const out = await inObject(freshSite(), async (site) =>
			withEnv(site, BOTH, async () => {
				await boot(site);
				site.env['ARGON2'] = '1';
				try {
					site.dropInterpreter();
					await boot(site);
					return site.lastMountReuse;
				} finally {
					delete site.env['ARGON2'];
				}
			})
		);
		expect(out).toMatchObject({ kept: false, reason: 'settings changed' });
	}, 120_000);

	it('rebuilds the mount after PHP wrote to the filesystem', async () => {
		const out = await inObject(freshSite(), async (site) =>
			withEnv(site, BOTH, async () => {
				await boot(site);
				await site.run(
					`<?php file_put_contents('/drupal/sites/default/reuse-probe.txt', 'x'); echo '1';`
				);
				site.dropInterpreter();
				await boot(site);
				return site.lastMountReuse;
			})
		);
		expect(out).toMatchObject({ kept: false, reason: 'mutated' });
	}, 120_000);

	it('rebuilds the mount when the stamp cannot be read', async () => {
		const out = await inObject(freshSite(), async (site) =>
			withEnv(site, BOTH, async () => {
				const first = await boot(site);
				const node = first.binary.FS.lookupPath('/drupal').node;
				site.dropInterpreter();
				const sql = watchSql(site, PAGE);
				try {
					const second = await boot(site);
					return {
						sameNode: second.binary.FS.lookupPath('/drupal').node === node,
						verdict: site.lastMountReuse,
						read: await site.runJson(READ)
					};
				} finally {
					sql.restore();
				}
			})
		);
		expect(out.verdict).toMatchObject({ kept: false, reason: 'stamp unreadable' });
		expect(out.sameNode).toBe(false);
		expect(out.read['mounted']).toBe(true);
	}, 120_000);
});
