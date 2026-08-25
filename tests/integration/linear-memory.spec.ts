import { describe, expect, it } from 'vitest';
import { SHIPPING_STEP } from '../../scripts/measure/growth-glue';
import { freshSite, inObject, queuePath, type ServeDo } from '../helpers/serve-do';

/**
 * The wasm heap's real shape on the SHIPPING interpreter, which P16 asked for before anything
 * proposes changing `INITIAL_MEMORY`.
 *
 * MEASURED 2026-08-23, one object, PHP 8.5 from `.interp/`:
 *
 * | quantity                           | bytes       | MiB    |
 * | ---------------------------------- | ----------- | ------ |
 * | booted and idle (`INITIAL_MEMORY`) | 100,663,296 | 96.00  |
 * | after one real fill                | 105,709,568 | 100.81 |
 * | isolate limit                      | 134,217,728 | 128.00 |
 *
 * **THIS CONTRADICTS THE ITEM'S PREMISE.** P16 wants 96 -> 80 MB to buy room for a larger lazy-FS
 * budget. But `INITIAL_MEMORY` is where the heap STARTS, not where it stops: the render reaches
 * 115.25 MiB by GROWING, and it would reach it from 80 MB too.
 *
 * **THE PEAK IS A GEOMETRIC SERIES, NOT AN ALLOCATOR HIGH-WATER.** Growth is `oldSize * (1 + step)`
 * rounded up to a 64 KiB page, so the peak is `INITIAL_MEMORY` advanced N rungs. At emscripten's
 * 0.20 that was exactly one rung -- `ceil(100,663,296 * 1.2 / 65,536) * 65,536 = 120,848,384`, the
 * measured peak to the byte -- which is what made 61,440 bytes of shortfall cost 13,434,880. At the
 * shipping 0.08 the same shortfall costs one rung of 8,060,928 bytes, and a render takes none.
 *
 * **THE INTERVAL IS NOW COLLAPSED, and it took a glue rewrite rather than a rebuild.** The growth
 * policy is NOT a link-only setting: emscripten emits `MEMORY_GROWTH_GEOMETRIC_STEP` into
 * `_emscripten_resize_heap` as the JavaScript literal `.2`, and the `.wasm` carries no growth policy
 * at all. `scripts/measure/growth-glue.ts` re-emits it and `growth-ladder.ts` drives the arms.
 *
 * **AND THE STEP IS NO LONGER 0.20, BECAUSE A THIRD WORKLOAD CHANGED THE ANSWER.** The ladder scored
 * an anonymous render and an install and concluded over-reservation was worth about 1%. Adding an
 * AUTHENTICATED render -- the workload the shell work exists to serve, and the one nobody had run --
 * is where the peak actually lives. The full sweep lives in the `SHIPPING_STEP` docblock in
 * `scripts/measure/growth-glue.ts`; the arms that bracket the choice, measured 2026-08-24:
 *
 * | step | render MiB | install MiB | auth MiB | worst  | headroom to 128 MiB | grow events |
 * | ---- | ---------- | ----------- | -------- | ------ | ------------------- | ----------- |
 * | 0.20 | 96.00      | 115.25      | 115.25   | 115.25 | 12.75               | 1           |
 * | 0.10 | 96.00      | 105.63      | 105.63   | 105.63 | 22.38               | 1           |
 * | 0.08 | 96.00      | 103.69      | 103.69   | 103.69 | 24.31               | 1           |
 * | 0.05 | 96.00      | 100.81      | 105.88   | 105.88 | 22.13               | 2           |
 * | 0.01 | 96.00      | 97.00       | 103.13   | 103.13 | 24.88               | 7           |
 * | 0    | 96.00      | 96.88       | 102.69   | 102.69 | 25.31               | many        |
 *
 * **A RENDER NO LONGER GROWS THE HEAP AT ALL**, on any arm, which is why this file's second case
 * asserts the opposite of what it used to. That is opcache: its compile-time working set was
 * roughly 5 MiB of the render peak and 19 MiB of an install, and none of it is spent now.
 *
 * `SHIPPING_STEP` is 0.08, emitted by `restore-artifacts.ts` after the pristine glue is
 * sha256-verified and imported by `src/runtime/php-binary-85.ts`. It is the lowest step whose FIRST
 * rung clears the authenticated demand with real margin, so it reaches the binding peak in one grow
 * rather than two and still leaves 24.31 MiB. 0.05 shipped until 2026-08-24 and was dominated on
 * every metric; the arms below 0.07 that look better sit on a 7 MiB cliff and one of them was
 * measured falling off it.
 *
 * **THE FIRST VERSION OF THIS TABLE DID NOT SURVIVE ITS OWN RE-MEASUREMENT**, and that is worth more
 * than the table. Taken with opcache still on, it read 138.31 MiB for the authenticated arm at 0.20
 * and concluded "emscripten's default does not fit inside the isolate AT ALL". True of that build,
 * false of the one that ships. Two changes landed in one session and each was measured against a
 * tree the other had not touched yet.
 *
 * **THE BUILD IS ALSO NOT ONE GROWTH EVENT FROM OOM**, which is what this file used to say.
 * `getHeapMax()` returns 4,294,901,760, so the module declares no maximum and the 128 MiB ceiling is
 * workerd's, enforced by `grow()` THROWING. Emscripten catches that and retries at a smaller step --
 * `for (cutDown = 1; cutDown <= 4; cutDown *= 2)`. At 0.08 the first candidate already fits, so the
 * retry ladder is no longer on the path of an ordinary render at all.
 *
 * ASSERTED AS BOUNDS AND A RELATIONSHIP, never as equalities: the absolutes move with the pack and
 * the workload, and this repository is full of pinned figures that went stale in a direction nobody
 * noticed. What must not move is that the heap starts well under the limit, grows for a render, and
 * leaves real room at the peak.
 */

const MIB = 1_048_576;

/** the Durable Object isolate limit; a platform figure rather than a budget chosen here */
const ISOLATE_LIMIT = 128 * MIB;

type Reading = { bootedIdle: number; afterRender: number };

async function heapOf(site: ServeDo): Promise<number> {
	const res = await site.fetch(new Request('https://do.local/__heap?op=status'));
	const body = (await res.json()) as Record<string, unknown>;
	return Number(body.linearMemoryBytes ?? 0);
}

async function readHeap(): Promise<Reading> {
	return inObject(freshSite(), async (site: ServeDo) => {
		await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
		// `/__php` boots the interpreter and does nothing else, so this is the heap the object
		// holds while idle -- which is the quantity `INITIAL_MEMORY` actually governs
		await site.fetch(new Request('https://do.local/__php'));
		const bootedIdle = await heapOf(site);
		queuePath(site, '/', { arm: false });
		await site.fetch(new Request('https://do.local/__fill'));
		return { bootedIdle, afterRender: await heapOf(site) };
	});
}

describe('the wasm heap on the shipping 8.5 build', () => {
	it('starts at INITIAL_MEMORY and leaves the JS side room it also needs', async () => {
		const heap = await readHeap();
		expect(heap.bootedIdle).toBeGreaterThan(0);
		// 96 MiB today. Bounded rather than pinned, because a rebuild is allowed to change it
		// and this file exists to say what changed, not to forbid it
		expect(heap.bootedIdle).toBeGreaterThanOrEqual(64 * MIB);
		expect(heap.bootedIdle).toBeLessThanOrEqual(112 * MIB);
		expect(heap.bootedIdle % 65_536, 'wasm pages are 64 KiB').toBe(0);
	}, 900_000);

	it('does NOT grow for an anonymous render any more, which P30 is what changed', async () => {
		const heap = await readHeap();
		// THIS ASSERTED GROWTH UNTIL 2026-08-23 and now asserts none. With `OPCACHE_MODE=off` a
		// render completes inside `INITIAL_MEMORY`; opcache's compile-time working set was the
		// growth. The install and the authenticated render still grow, which is where the step
		// earns its keep and why the table above has three columns rather than one
		expect(heap.afterRender).toBe(heap.bootedIdle);
		expect(heap.afterRender % 65_536).toBe(0);
	}, 900_000);

	it('leaves room an AUTHENTICATED render still has to fit into', async () => {
		const heap = await readHeap();
		const headroom = ISOLATE_LIMIT - heap.afterRender;
		// 32.00 MiB from an anonymous render. NOT spare room: the lazy-FS budget is 4 MiB and the
		// compressed layer blob ~11 MiB, both on the JS side of the SAME isolate, and an
		// authenticated render spends another 9.88 MiB of it. The binding figure is the auth
		// column in the table above, never this one
		expect(headroom).toBeGreaterThan(16 * MIB);
		expect(headroom).toBeLessThan(48 * MIB);
	}, 900_000);

	it('no longer needs the retry ladder for an ordinary growth', async () => {
		const heap = await readHeap();
		const PAGE = 65_536;
		// emscripten's retry loop, transcribed: `cutDown` 1, 2, 4 divides the step
		const tries = [1, 2, 4].map(
			(cutDown) => Math.ceil((heap.afterRender * (1 + SHIPPING_STEP / cutDown)) / PAGE) * PAGE
		);

		// at 0.20 the FIRST candidate was 145,031,168 -- over the limit -- and only the third fit.
		// At 0.08 the first one fits, so a growth from the peak costs one `grow()` rather than
		// three, two of which threw. The ladder still exists and still degrades; it is simply no
		// longer on the path of an ordinary render
		expect(tries[0]).toBeLessThan(ISOLATE_LIMIT);
		expect(tries[1]).toBeLessThan(tries[0]!);
		expect(tries[2]).toBeLessThan(tries[1]!);
	}, 900_000);
});
