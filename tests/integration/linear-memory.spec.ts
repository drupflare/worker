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
 *   - **over-reservation is between 0 and 20,185,088 bytes (19.25 MiB)**, and is UNMEASURED;
 *   - the 61,440-byte shortfall that once cost 13,434,880 bytes is the step doing exactly what it
 *     is documented to do. With the step at 0 the same shortfall costs ONE 64 KiB page.
 *
 * **SO THE GATE IS THE GROWTH STEP, NOT `INITIAL_MEMORY`**, and the first version of this file
 * closed the memory objective along with the lever. `MEMORY_GROWTH_GEOMETRIC_STEP` and
 * `MEMORY_GROWTH_LINEAR_STEP` are link-only settings and have never been tested here. See
 * `docs/memory-growth.md` for the ladder.
 *
 * **AND IT IS URGENT RATHER THAN OPTIONAL.** One further step from the current peak is
 * `ceil(120,848,384 * 1.2 / 65,536) * 65,536 = 145,031,168` bytes, 138.31 MiB, which exceeds the
 * isolate limit under either the binary or the decimal reading. The shipping build is ONE GROWTH
 * EVENT from OOM.
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

		// which BOUNDS live demand rather than revealing it: somewhere in this interval, and
		// the width of the interval is the over-reservation nobody has measured
		expect(heap.afterRender - heap.bootedIdle).toBe(20_185_088);
	}, 900_000);

	it('is ONE growth event from exceeding the isolate limit', async () => {
		const heap = await readHeap();
		const next = Math.ceil((heap.afterRender * 1.2) / 65_536) * 65_536;
		// 145,031,168 bytes, 138.31 MiB. Over the limit on the binary reading AND on the
		// decimal one, so a workload that allocates a little more than a front-page render
		// does not get a slightly bigger heap -- it gets an OOM
		expect(next).toBeGreaterThan(ISOLATE_LIMIT);
		expect(next).toBeGreaterThan(128_000_000);
	}, 900_000);
});
