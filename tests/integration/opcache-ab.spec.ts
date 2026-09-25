import { describe, expect, it } from 'vitest';
import { SHIPPING_STEP } from '../../scripts/measure/growth-glue';
import { INITIAL_BYTES } from '../../scripts/measure/initial-pages';
import { layerPath, serialiseOpcachePack, systemIdOf } from '../../scripts/opcache-layer';
import { memfsCensus, renderPage } from '../../src/drupal/site-php';
import {
	DEFAULT_OPCACHE_MODE,
	OPCACHE_MODES,
	opcacheIni,
	opcacheMode,
	opcachePackState,
	opcacheSourceKey
} from '../../src/runtime/opcache';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

/**
 * P30: what the write-only opcache file cache actually costs, arm by arm.
 *
 * The file cache is measurably write-only on this runtime -- 1,301 `.bin` files after one render,
 * nothing ever reads them -- and it was left in place because `file_cache_only=1` makes it opcache's
 * ONLY backing store, so deleting it may disable opcache rather than merely stop the writes.
 * Removing opcache ini blind is what produced the 8.5 `exit(-2)` on a deployed worker.
 *
 * MEASURED 2026-08-23, one object per arm, boot + one real fill:
 *
 * | arm    | `.bin` files | MEMFS bytes | linear memory | `opcache_get_status()` | cached scripts |
 * | ------ | ------------ | ----------- | ------------- | ---------------------- | -------------- |
 * | `file` | 2,346        | 32,141,312  | 105,709,568   | **enabled: false**     | --             |
 * | `shm`  | 0            | 0           | **200,540,160** | enabled: true        | 2,346          |
 * | `off`  | 0            | 0           | 100,663,296   | --                     | --             |
 *
 * **READ THE HEAP COLUMN BEFORE CONCLUDING ANYTHING.** On the first three columns `shm` looks like a
 * strict win: real acceleration, 2,346 cached scripts, and none of the 30.65 MiB of MEMFS the
 * shipping arm writes for a cache that reports itself DISABLED. It puts opcache's arena in PHP's
 * linear memory and lands at 191.25 MiB -- **63 MiB over the 128 MiB isolate cap**. It cannot ship.
 * The gate does not enforce that cap, which is the only reason the reading exists to be read.
 *
 * So the surviving comparison is `file` against `off`, and on memory `off` wins twice: 5,046,272
 * fewer bytes of linear memory AND 32,141,312 fewer bytes of MEMFS, both inside the same isolate.
 * What it might cost is compile CPU, and **that cannot be settled here** -- RULE 0, a local wall
 * clock cannot order two boot profiles and the figure has to come from `cpuTime` on a deployed
 * worker.
 *
 * MILLISECONDS ARE THEREFORE NOT ASSERTED. Counts and bytes are what this lane can measure honestly.
 */

/** the Durable Object isolate limit; a platform figure rather than a budget chosen here */
const ISOLATE_LIMIT = 128 * 1_048_576;
/**
 * What the BINARY starts the heap at, so an arm reading exactly this one has grown by nothing.
 *
 * Read from the figure the build step sets rather than written here as `96 * 1_048_576`: tuning the
 * memory section to 80 MiB turned this red against an arm that had allocated nothing.
 */
const INITIAL_MEMORY = INITIAL_BYTES;

async function armProfile(mode: string) {
	return inObject(freshSite(), async (site: ServeDo) => {
		site.env.OPCACHE_MODE = mode;
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		const booted = await site.fetch(new Request('https://do.local/__php'));
		const info = (await booted.json()) as Record<string, unknown>;
		queuePath(site, '/', { arm: false });
		const filled = await site.fetch(new Request('https://do.local/__fill'));
		const outcome = (await filled.json()) as Record<string, unknown>;
		// GATE-LANE WALL CLOCK and a RATIO, never an absolute (RULE 0). A compile-CPU difference
		// large enough to matter would be visible here; one that is not is what needs a deploy
		const renderMs: number[] = [];
		for (let i = 0; i < 5; i++) {
			const r = (await site.runJson(
				renderPage('/', ['dynamic_page_cache', 'render'])
			)) as Record<string, unknown>;
			renderMs.push(Number(r['renderMs'] ?? 0));
		}
		const census = (await site.runJson(memfsCensus('/tmp'))) as Record<string, unknown>;
		const heap = Number(
			(
				(await (
					await site.fetch(new Request('https://do.local/__heap?op=status'))
				).json()) as Record<string, unknown>
			).linearMemoryBytes ?? 0
		);
		return {
			mode,
			bootOk: booted.status === 200,
			php: String(info['version'] ?? info['phpVersion'] ?? ''),
			filled: outcome['filled'] ?? null,
			error: outcome['failed'] ?? outcome['error'] ?? null,
			files: census['files'],
			bin: census['bin'],
			bytes: census['bytes'],
			dirs: census['dirs'],
			opcache: census['opcacheStatus'] ?? null,
			enabled: census['opcacheEnabled'],
			fileCacheOnly: census['fileCacheOnly'],
			renderMs,
			medianMs: [...renderMs].sort((a, b) => a - b)[2],
			heap
		};
	});
}

describe('P30: the opcache arms', () => {
	it('names four arms and falls back to the shipping one', () => {
		expect([...OPCACHE_MODES]).toEqual(['file', 'shm', 'off', 'pack']);
		// the shipped cache is read and never written, or a miss spends the MEMFS `file` spends
		expect(opcacheIni('pack')).toContain('opcache.file_cache_read_only=1');
		expect(opcacheIni('pack')).toContain('opcache.file_cache=/tmp');
		expect(opcacheIni('file')).not.toContain('opcache.file_cache_read_only=1');
		expect(DEFAULT_OPCACHE_MODE).toBe('off');
		expect(opcacheMode('shm')).toBe('shm');
		expect(opcacheMode('nonsense')).toBe('off');
		expect(opcacheMode(undefined)).toBe('off');
		// the shipping arm keeps the file cache; the other two must not carry it, or the A/B is
		// three copies of one measurement
		expect(opcacheIni('file')).toContain('opcache.file_cache_only=1');
		expect(opcacheIni('shm')).not.toContain('opcache.file_cache_only=1');
		expect(opcacheIni('shm')).toContain('opcache.enable=1');
		expect(opcacheIni('off')).toEqual(['opcache.enable=0', 'opcache.enable_cli=0']);
	});

	it('boots and renders on every arm, and prices each one', async () => {
		const arms: Awaited<ReturnType<typeof armProfile>>[] = [];
		for (const mode of OPCACHE_MODES) arms.push(await armProfile(mode));
		console.log(`[p30] ${JSON.stringify(arms)}`);
		const by = (mode: string) => arms.find((a) => a.mode === mode)!;

		// every arm has to work at all, which is the half that stops a blind removal
		for (const arm of arms) {
			expect(arm.bootOk, `${arm.mode} booted`).toBe(true);
			expect(arm.filled, `${arm.mode} rendered`).toBe('/');
		}

		// the shipping arm pays 30+ MiB of MEMFS for a cache that reports itself disabled
		expect(by('file').bin).toBeGreaterThan(1000);
		expect(by('file').bytes).toBeGreaterThan(16 * 1024 * 1024);
		expect((by('file').opcache as { enabled: boolean } | null)?.enabled).toBe(false);

		// shm is the arm that looks best and cannot ship: its arena is linear memory
		expect(by('shm').bytes).toBe(0);
		expect((by('shm').opcache as { enabled: boolean } | null)?.enabled).toBe(true);
		expect(by('shm').heap).toBeGreaterThan(ISOLATE_LIMIT);

		// and off is cheaper than the shipping arm on BOTH axes, which is what the docblock's
		// table measured and what an equality assertion here denied. The two read the same heap
		// for a while and that was a coincidence of the growth step, not a property: MEMFS lives
		// in linear memory, so 26 MB of write-only `.bin` files has to appear on the heap axis as
		// soon as it crosses a step. Pinning them equal made the arm's own documented cost
		// unassertable, and the pack growing by a few hundred KB was enough to end it.
		//
		// The ORDERING is the durable claim; the magnitude moves with the pack and is reported
		// rather than pinned. `off` sitting exactly at INITIAL_MEMORY is the sharp half: it says
		// the arm costs nothing at all, not merely less.
		expect(by('off').bytes).toBe(0);
		expect(by('off').heap).toBeLessThanOrEqual(by('file').heap);
		// AT MOST ONE GROWTH STEP, not zero. A render's demand is ~90.4 MiB, which fitted inside the
		// old 96 MiB start and does not fit inside the tuned 80 -- so `off` now grows once while
		// still allocating nothing of its own. The claim that survives is that it does not grow
		// MORE than the step the glue takes, which is what "costs nothing" was standing in for
		const oneStep = Math.ceil((INITIAL_MEMORY * (1 + SHIPPING_STEP)) / 65_536) * 65_536;
		expect(
			by('off').heap,
			'the off arm grew more than one step, so something other than opcache allocated'
		).toBeLessThanOrEqual(oneStep);
	}, 900_000);
});

describe('the pack arm, which ships a baked cache as a second layer', () => {
	const ID = '944d2daeb7b3af487437a92413cf43ac';

	it('places a core script beside the tree and never packs sites/', () => {
		expect(layerPath(`/tmp/${ID}/drupal/core/lib/Drupal.php.bin`)).toBe(
			`.opcache/${ID}/drupal/core/lib/Drupal.php.bin`
		);
		// settings.php compiles with the baking site's hash_salt in it, and the layer is public
		expect(layerPath(`/tmp/${ID}/drupal/sites/default/settings.php.bin`)).toBeNull();
		expect(layerPath('/tmp/not-an-id/drupal/core/x.php.bin')).toBeNull();
		expect(layerPath(`/tmp/${ID}/elsewhere/x.php.bin`)).toBeNull();
	});

	it('refuses a cache that mixes two interpreter builds', () => {
		expect(systemIdOf([`.opcache/${ID}/drupal/a.bin`, `.opcache/${ID}/drupal/b.bin`])).toBe(ID);
		expect(() =>
			systemIdOf([`.opcache/${ID}/drupal/a.bin`, '.opcache/other/drupal/b.bin'])
		).toThrow();
	});

	it('writes a descriptor the mount reads, and null when nothing was baked', () => {
		expect(serialiseOpcachePack(null)).toContain('| null = null;');
		const written = serialiseOpcachePack({ systemId: ID, files: 3, bytes: 9, source: 'd:k' });
		expect(written).toContain(`systemId: '${ID}'`);
		expect(written).toContain(`source: 'd:k'`);
	});

	it('keys a cache on the driver and every locked version, in any order', () => {
		const lock = { 'drupal/core': '11.4.7', 'drupal/token': '1.15.0' };
		const key = opcacheSourceKey('9cbc5c32c89c1f3a', lock);
		expect(key).toMatch(/^9cbc5c32c89c1f3a:[0-9a-f]{8}$/);
		expect(
			opcacheSourceKey('9cbc5c32c89c1f3a', {
				'drupal/token': '1.15.0',
				'drupal/core': '11.4.7'
			})
		).toBe(key);
		expect(opcacheSourceKey('2c2c311d38e6d68c', lock)).not.toBe(key);
		expect(
			opcacheSourceKey('9cbc5c32c89c1f3a', { ...lock, 'drupal/token': '1.16.0' })
		).not.toBe(key);
	});

	it('refuses a cache compiled from other sources, since scripts are never revalidated', () => {
		expect(opcacheIni('pack')).toContain('opcache.validate_timestamps=0');
		const pack = { source: 'a:1' };
		expect(opcachePackState(pack, 'pack', true, 'a:1')).toBe('usable');
		expect(opcachePackState(pack, 'pack', true, 'b:1')).toBe('stale');
		expect(opcachePackState(null, 'pack', true, 'a:1')).toBe('none');
		expect(opcachePackState(pack, 'off', true, 'a:1')).toBe('none');
		expect(opcachePackState(pack, 'pack', false, 'a:1')).toBe('none');
	});

	it('lists and reads what the file arm wrote, and refuses any other path', async () => {
		const out = await inObject(freshSite(), async (site: ServeDo) => {
			site.env.OPCACHE_MODE = 'file';
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			await site.runJson(renderPage('/', ['dynamic_page_cache', 'render']));
			const listed = (await (
				await site.fetch(new Request('https://do.local/__opcache?op=list'))
			).json()) as { mode: string; files: { path: string; bytes: number }[] };
			const first = listed.files[0];
			const read = first
				? await site.fetch(
						new Request(
							`https://do.local/__opcache?op=read&path=${encodeURIComponent(first.path)}`
						)
					)
				: null;
			const refused = await site.fetch(
				new Request(
					'https://do.local/__opcache?op=read&path=%2Fdrupal%2Fsites%2Fdefault%2Fsettings.php'
				)
			);
			return {
				mode: listed.mode,
				files: listed.files.length,
				readBytes: read ? (await read.arrayBuffer()).byteLength : 0,
				expected: first?.bytes ?? -1,
				refused: refused.status
			};
		});
		expect(out.mode).toBe('file');
		expect(out.files).toBeGreaterThan(0);
		expect(out.readBytes).toBe(out.expected);
		expect(out.refused).toBe(400);
	}, 900_000);
});
