import { describe, expect, it } from 'vitest';
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
 * | after one real fill                | 120,848,384 | 115.25 |
 * | isolate limit                      | 134,217,728 | 128.00 |
 *
 * **THIS CONTRADICTS THE ITEM'S PREMISE.** P16 wants 96 -> 80 MB to buy room for a larger lazy-FS
 * budget. But `INITIAL_MEMORY` is where the heap STARTS, not where it stops: the render reaches
 * 115.25 MiB by GROWING, and it would reach it from 80 MB too.
 *
 * **AND THE PEAK IS ONE GROWTH EVENT, EXACTLY.** Emscripten's `MEMORY_GROWTH_GEOMETRIC_STEP`
 * defaults to 0.20 and growth is rounded up to a 64 KiB page:
 *
 *     ceil(100,663,296 * 1.2 / 65,536) * 65,536 = 120,848,384
 *
 * which is the measured peak TO THE BYTE. The same rule reproduces the report's 64 MiB arm
 * (80,543,744). So the heap takes exactly ONE geometric step across boot and first render, and:
 *
 *   - **live demand is bounded, not unknown**: `100,663,296 < demand <= 120,848,384`;
 *   - the 61,440-byte shortfall that once cost 13,434,880 bytes is the step doing exactly what it
 *     is documented to do. With the step at 0 the same shortfall costs ONE 64 KiB page.
 *
 * **THE INTERVAL IS NOW COLLAPSED, and it took a glue rewrite rather than a rebuild.** The growth
 * policy is NOT a link-only setting: emscripten emits `MEMORY_GROWTH_GEOMETRIC_STEP` into
 * `_emscripten_resize_heap` as the JavaScript literal `.2`, and the `.wasm` carries no growth policy
 * at all. `scripts/measure/growth-glue.ts` re-emits it, `growth-ladder.ts` drives the arms, and at a
 * step of 0 the peak IS demand rounded to a page:
 *
 * | step | render peak | install peak | worst-case headroom |
 * | ---- | ----------- | ------------ | ------------------- |
 * | 0.20 | 120,848,384 | 120,848,384  | 12.75 MiB           |
 * | 0.10 | 110,755,840 | 121,896,960  | 11.75 MiB           |
 * | 0.05 | 105,709,568 | 116,588,544  | 16.81 MiB           |
 * | 0.01 | 104,857,600 | 115,015,680  | 18.31 MiB           |
 * | 0    | 104,726,528 | 114,229,248  | 19.06 MiB           |
 *
 * **SCORE A STEP AGAINST THE INSTALL, NEVER AGAINST A RENDER.** Read the render column alone and
 * 0.05 looks like it recovers 14.44 MiB and 0.10 looks like a strict improvement. Neither survives
 * the install, which is the workload that peaks highest: 0.05 recovers 4.06 MiB and **0.10 is a
 * REGRESSION on 0.20**. Growth compounds from the previous size, so a finer step can take more steps
 * and land on a worse rung. This is RULE 0c's "under which workload?" with a number attached.
 *
 * So over-reservation against the BINDING workload is `120,848,384 - 114,229,248` = **6,619,136
 * bytes (6.31 MiB), 5.5% of the peak** -- not the 15.38 MiB the render column implies.
 *
 * **AND THE BUILD IS NOT ONE GROWTH EVENT FROM OOM**, which is what this file used to say. The same
 * arithmetic, read to its end, refutes it: `getHeapMax()` returns 4,294,901,760, so the module
 * declares no maximum and the 128 MiB ceiling is workerd's, enforced by `grow()` THROWING. Emscripten
 * catches that and retries at a smaller step -- `for (cutDown = 1; cutDown <= 4; cutDown *= 2)` gives
 * 145,031,168 then 132,972,544 then 126,943,232, and the third fits. A growth from the shipping peak
 * degrades; it does not abort.
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

	it('GROWS for a render, so INITIAL_MEMORY is a floor and the PEAK is what binds', async () => {
		const heap = await readHeap();
		// the claim P16 rests on, and the one that refutes it. If this ever reads equal the
		// heap is not growing and the item's arithmetic would become true again
		expect(heap.afterRender).toBeGreaterThan(heap.bootedIdle);
		expect(heap.afterRender % 65_536).toBe(0);
	}, 900_000);

	it('leaves under 16 MiB at the peak, which is what a lazy-FS increase has to fit in', async () => {
		const heap = await readHeap();
		const headroom = ISOLATE_LIMIT - heap.afterRender;
		// ~12.75 MiB measured. The lazy-FS budget is 4 MiB and the compressed layer blob is
		// ~11 MiB, both on the JS side of the SAME isolate, so this is not spare room -- it is
		// the room those already occupy. C41 measured that raising the budget to fit renders
		// breaks the install envelope, and this is why
		expect(headroom).toBeGreaterThan(0);
		expect(headroom).toBeLessThan(16 * MIB);
	}, 900_000);

	it('reaches the peak in exactly ONE geometric growth step, which is the real lever', async () => {
		const heap = await readHeap();
		// emscripten's documented default: grow by 20%, rounded up to a 64 KiB page
		const GEOMETRIC_STEP = 0.2;
		const PAGE = 65_536;
		const grown = (from: number) => Math.ceil((from * (1 + GEOMETRIC_STEP)) / PAGE) * PAGE;

		// the peak is not an allocator high-water; it is `INITIAL_MEMORY` grown once
		expect(grown(heap.bootedIdle)).toBe(heap.afterRender);

		// the interval this once only BOUNDED. `growth-ladder.ts` collapsed it: render demand
		// is 104,726,528 and install demand is 114,229,248, so the shipping peak carries
		// 6,619,136 bytes of over-reservation against the workload that binds
		expect(heap.afterRender - heap.bootedIdle).toBe(20_185_088);
		expect(heap.afterRender).toBeGreaterThan(114_229_248);
	}, 900_000);

	it('DEGRADES rather than aborting when the next geometric step will not fit', async () => {
		const heap = await readHeap();
		const PAGE = 65_536;
		// emscripten's retry loop, transcribed: `cutDown` 1, 2, 4 gives 0.20, 0.10, 0.05
		const tries = [1, 2, 4].map(
			(cutDown) => Math.ceil((heap.afterRender * (1 + 0.2 / cutDown)) / PAGE) * PAGE
		);

		// the first try IS over the limit, which is the true half of the old claim
		expect(tries[0]).toBeGreaterThan(ISOLATE_LIMIT);
		// and the third fits, which is the half that refutes "one growth event from OOM".
		// `grow()` throwing is caught and retried, so the object gets a smaller heap rather
		// than an abort. An OOM needs a single allocation larger than the whole ceiling
		expect(tries[2]).toBeLessThan(ISOLATE_LIMIT);
		expect(tries[1]).toBeLessThan(tries[0]!);
		expect(tries[2]).toBeLessThan(tries[1]!);
	}, 900_000);
});
