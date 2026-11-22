import { describe, expect, it, vi } from 'vitest';
import { spareMemoryBytes } from '../../src/do/isolate';
import { blockRefresh, parkForRefresh, type RefreshHost } from '../../src/ops/refresh-instance';
import type { PhpInstance } from '../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * REFRESH_INSTANCE: a dropped interpreter restarts PHP in place for the next boot.
 *
 * Real boots of the shipping binary, so each case pays a mount. `pib_refresh` resets user classes,
 * statics, globals and constants (measured on the shipping binary), keeps the wasm instance, and
 * the next boot rebuilds the mount over a released one.
 */

type Booted = {
	php: { refresh(): Promise<number>; shared: Record<string, unknown> };
	binary: { onRefresh: Set<() => void> };
};

const boot = async (site: ServeDo) => (await site.ensurePhp()) as unknown as Booted;

const SET = `<?php class RefreshProbe { public static int $n = 0; }
RefreshProbe::$n = 7; $GLOBALS['refresh_marker'] = 'kept'; define('REFRESH_CONST', 1); echo '1';`;

const READ = `<?php echo json_encode([
	'class' => class_exists('RefreshProbe', false),
	'marker' => $GLOBALS['refresh_marker'] ?? null,
	'const' => defined('REFRESH_CONST'),
	'mounted' => is_dir('/drupal/core')
]);`;

/** the flag is read off a shared env, so it is put back whatever the case does */
async function armed<T>(site: ServeDo, fn: () => Promise<T>): Promise<T> {
	site.env['REFRESH_INSTANCE'] = '1';
	try {
		return await fn();
	} finally {
		delete site.env['REFRESH_INSTANCE'];
	}
}

const fakeHost = (env: RefreshHost['env']): RefreshHost => ({
	env,
	ctx: { id: { toString: () => 'object-under-test' } },
	restartBlocked: false,
	nowMs: () => 0
});

const instance = (memory?: WebAssembly.Memory) =>
	({ php: {}, binary: { wasmMemory: memory }, out: [] }) as unknown as PhpInstance;

describe('REFRESH_INSTANCE off', () => {
	it('parks nothing and boots a new interpreter', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const first = await boot(site);
			await site.run(SET);
			site.dropInterpreter();
			const parked = site.pendingRefresh;
			const second = await boot(site);
			return {
				parked: parked !== undefined,
				same: second.php === first.php,
				refreshed: site.instancesRefreshed,
				last: site.lastRefresh
			};
		});
		expect(out.parked).toBe(false);
		expect(out.same).toBe(false);
		expect(out.refreshed).toBeUndefined();
		expect(out.last).toBeUndefined();
	}, 120_000);

	it('parks nothing for any value other than 1', () => {
		const host = fakeHost({ REFRESH_INSTANCE: '0' });
		expect(parkForRefresh(host, instance())).toBe(false);
		expect(host.pendingRefresh).toBeUndefined();
	});

	it('leaves restartBlocked alone when a fault is recorded', () => {
		const host = fakeHost({});
		blockRefresh(host);
		expect(host.restartBlocked).toBe(false);
	});
});

describe('REFRESH_INSTANCE on', () => {
	it('restarts the parked interpreter, resets PHP state and runs the next request', async () => {
		const out = await inObject(freshSite(), async (site) =>
			armed(site, async () => {
				const first = await boot(site);
				await site.run(SET);
				site.dropInterpreter();
				const parked = site.pendingRefresh;
				const second = await boot(site);
				const read = await site.runJson(READ);
				return {
					parked: parked !== undefined,
					same: second.php === first.php,
					refreshed: site.instancesRefreshed,
					last: site.lastRefresh,
					read
				};
			})
		);
		expect(out.parked).toBe(true);
		expect(out.same, 'the interpreter object is the one that was dropped').toBe(true);
		expect(out.refreshed).toBe(1);
		expect(out.last?.ok).toBe(true);
		expect(out.read['class'], 'a user class and its statics are gone').toBe(false);
		expect(out.read['marker'], 'a global is gone').toBeNull();
		expect(out.read['const'], 'a constant is gone').toBe(false);
		expect(out.read['mounted'], 'the tree was mounted again').toBe(true);
	}, 120_000);

	it('answers once per run after repeated restarts, so no listener doubles', async () => {
		const out = await inObject(freshSite(), async (site) =>
			armed(site, async () => {
				await boot(site);
				for (let i = 0; i < 2; i++) {
					site.dropInterpreter();
					await boot(site);
				}
				return {
					echoed: await site.run('<?php echo "x";'),
					refreshed: site.instancesRefreshed
				};
			})
		);
		expect(out.refreshed).toBe(2);
		expect(out.echoed).toBe('x');
	}, 120_000);

	it('runs the onRefresh callbacks once and clears the shared table', async () => {
		const out = await inObject(freshSite(), async (site) =>
			armed(site, async () => {
				const first = await boot(site);
				const callback = vi.fn();
				first.binary.onRefresh.add(callback);
				first.php.shared['marker'] = 1;
				site.dropInterpreter();
				const second = await boot(site);
				return { calls: callback.mock.calls.length, shared: { ...second.php.shared } };
			})
		);
		expect(out.calls).toBe(1);
		expect(out.shared).toEqual({});
	}, 120_000);

	it('falls back to a new interpreter when the restart throws', async () => {
		const out = await inObject(freshSite(), async (site) =>
			armed(site, async () => {
				const first = await boot(site);
				site.dropInterpreter();
				vi.spyOn(first.php, 'refresh').mockRejectedValue(new Error('refresh refused'));
				const second = await boot(site);
				return {
					same: second.php === first.php,
					refreshed: site.instancesRefreshed,
					last: site.lastRefresh,
					echoed: await site.run('<?php echo "ok";')
				};
			})
		);
		expect(out.same).toBe(false);
		expect(out.refreshed).toBeUndefined();
		expect(out.last).toMatchObject({ ok: false, reason: 'refresh refused' });
		expect(out.echoed).toBe('ok');
	}, 120_000);

	it('falls back when the restart reports a nonzero status', async () => {
		const out = await inObject(freshSite(), async (site) =>
			armed(site, async () => {
				const first = await boot(site);
				site.dropInterpreter();
				vi.spyOn(first.php, 'refresh').mockResolvedValue(1);
				const second = await boot(site);
				return { same: second.php === first.php, last: site.lastRefresh };
			})
		);
		expect(out.same).toBe(false);
		expect(out.last).toMatchObject({ ok: false, reason: 'pib_refresh returned 1' });
	}, 120_000);

	it('does not park after a trap, and a new interpreter clears the block', async () => {
		const out = await inObject(freshSite(), async (site) =>
			armed(site, async () => {
				site.php = { binary: {}, out: [] };
				site.ensurePhp = async () =>
					({
						php: {
							_run: async () => {
								throw new WebAssembly.RuntimeError('unreachable');
							}
						},
						binary: {}
					}) as never;
				await site.run('<?php echo 1;').catch(() => undefined);
				const blocked = site.restartBlocked;
				const parked = site.pendingRefresh;
				site.php = { binary: {}, out: [] };
				return { blocked, parked: parked !== undefined, cleared: !site.restartBlocked };
			})
		);
		expect(out).toEqual({ blocked: true, parked: false, cleared: true });
	});
});

describe('parkForRefresh', () => {
	const on = { REFRESH_INSTANCE: '1' };

	it('parks an interpreter with a binary and tells the isolate it is not resident', () => {
		const host = fakeHost(on);
		const was = instance();
		expect(parkForRefresh(host, was)).toBe(true);
		expect(host.pendingRefresh).toBe(was);
	});

	it('refuses after a fault', () => {
		const host = fakeHost(on);
		blockRefresh(host);
		expect(host.restartBlocked).toBe(true);
		expect(parkForRefresh(host, instance())).toBe(false);
	});

	it('refuses an interpreter with no binary and a CMS the mount release does not know', () => {
		expect(parkForRefresh(fakeHost(on), { php: {}, out: [] } as unknown as PhpInstance)).toBe(
			false
		);
		const wordpress = fakeHost({ ...on, CMS: 'wordpress' } as RefreshHost['env']);
		expect(parkForRefresh(wordpress, instance())).toBe(false);
		expect(
			parkForRefresh(fakeHost({ ...on, CMS: 'drupal' } as RefreshHost['env']), instance())
		).toBe(true);
	});

	it('gives the memory of an older parked interpreter to the spare slot', () => {
		const host = fakeHost(on);
		const memory = new WebAssembly.Memory({ initial: 1 });
		const older = instance(memory);
		const newer = instance();
		parkForRefresh(host, older);
		parkForRefresh(host, newer);
		expect(host.pendingRefresh).toBe(newer);
		expect(spareMemoryBytes()).toBe(memory.buffer.byteLength);
	});
});
