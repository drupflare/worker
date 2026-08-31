import { describe, expect, it } from 'vitest';
import { memfsCensus, renderPage } from '../../src/drupal/site-php';
import {
	DEFAULT_OPCACHE_MODE,
	OPCACHE_MODES,
	opcacheIni,
	opcacheMode
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
	it('names three arms and falls back to the shipping one', () => {
		expect([...OPCACHE_MODES]).toEqual(['file', 'shm', 'off']);
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

		// and off is cheaper than the shipping arm on the MEMFS axis. The heap axis no longer
		// separates them: it moves in whole growth steps, and once the packed `cache_container`
		// row became readable neither arm builds a container, so both read `INITIAL_MEMORY`
		// exactly. Asserting a difference below the reading's resolution is a probe that cannot
		// fail either way.
		expect(by('off').bytes).toBe(0);
		expect(by('off').heap).toBe(by('file').heap);
	}, 900_000);
});
