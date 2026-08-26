import { describe, expect, it } from 'vitest';
import { SHIPPING_STEP } from '../../scripts/measure/growth-glue';
import { renderPage } from '../../src/drupal/site-php';
import { freshSite, inObject, seedPage, type ServeDo } from '../helpers/serve-do';

/**
 * What a module install costs in MEMORY, and what that memory then refuses.
 *
 * A module install did not work on a deployed worker, and it took TWO stacked causes to explain
 * why. The first was a lock: `microtime()` returns 0 on the edge, so a `DatabaseLockBackend` row
 * can never expire, `RouteBuilder::rebuild()` falls into `wait()`, and `usleep()` spins for 30
 * seconds of billed CPU. `CfwLockBackend` fixes that and takes the install from 32,500 ms of
 * `exceededCpu` to 6,810 ms that completes.
 *
 * THE SECOND IS THIS FILE, and it is memory. `memory.grow` has no inverse, so wasm linear memory
 * only ever rises and an object carries every byte its renders ever claimed. The figures below were
 * taken on the SHIPPING PHP 8.5 interpreter; the 8.3 numbers this table used to carry (fresh
 * 64.0 -> 92.2 MB) were from `vendor/static-free-v1`, which is what the gate ran until the lane was
 * repointed at `.interp/`, and they are ~20 MB lower than what actually ships:
 *
 *   | interpreter        | before  | after enable | grew     |
 *   | fresh boot         | 96.0 MB | 115.0 MB     | +19.0 MB |
 *   | after four renders | 96.0 MB | 115.0 MB     | +19.0 MB |
 *
 * against a 128 MB isolate. So an install ends with almost no headroom left, and the NEXT event in
 * that isolate is refused -- "Durable Object's isolate exceeded its memory limit and was reset" on
 * 6 of 6 deployed installs when the fill chain was poked immediately afterwards. Armed from inside
 * the install's own event that reset takes the install with it, which is what a whole session read
 * as a storage-layer failure.
 *
 * Hence the two behaviours pinned below: the install runs on a FRESH interpreter, and it requeues
 * the pages it purged without arming anything. Measured on the edge, 6/6 land and 6/6 refill after
 * one visitor request.
 *
 * THIS LANE DOES NOT ENFORCE THE 128 MB CAP, which is exactly why the install completes here and
 * died there. So these cases assert the BYTES and the WIRING, never the outcome -- asserting the
 * outcome would pass on a runtime that cannot fail the way the edge does.
 */

type Payload = Record<string, unknown>;
const REQUEST_TIMEOUT = 900_000;

/** the Durable Object isolate limit, which is a platform figure rather than a budget chosen here */
const ISOLATE_LIMIT = 128 * 1_048_576;

/**
 * The pin, and it is deliberately not the isolate limit.
 *
 * wasm linear memory is not the whole isolate: the compiled interpreter, the JS heap and the
 * mounted pack sit beside it and are not counted here. So the ceiling this asserts leaves room for
 * everything the instrument cannot see, and a regression that eats that room fails here rather than
 * on the edge.
 *
 * **RE-BASED from 100 MB, and the old number was measured on the wrong interpreter.** The gate ran
 * PHP 8.3 from `vendor/static-free-v1` while production shipped 8.5, so 100 MB looked like 8 MB of
 * headroom over a 92 MB install. On the interpreter that actually ships an install peaks at
 * **115 MB**, which agrees with the ~110.6 MB measured on a deployed worker. 120 MB keeps this a
 * real pin -- 5 MB of regression headroom under a 128 MB isolate -- rather than a number no build
 * could pass.
 *
 * That margin is thin ON PURPOSE and is a product statement, not a test tolerance: an install on the
 * shipping interpreter genuinely runs close to the isolate limit, which is why it drops the
 * interpreter first and requeues rather than re-rendering.
 */
const HEAP_CEILING = 120 * 1_048_576;

/**
 * What the JS side may hold: the compressed layer blob plus the inflated file cache.
 *
 * Separate from the heap ceiling because they are separate allocators and the isolate limit covers
 * both. 11 MB of blob plus a 4 MB `LAZY_FS_BUDGET_BYTES` is the shipping shape; this fails if a
 * change puts the budget back to the 20 MB code default, which would take the pair to 31 MB and
 * leave the wasm heap less room than a render already uses.
 */
const JS_SIDE_CEILING = 20 * 1_048_576;

const call = (site: ServeDo, path: string) =>
	site.fetch(new Request(`https://do.local${path}`)).then((r) => r.json() as Promise<Payload>);

const heapOf = (reply: Payload) => ({
	before: Number(reply['heapBefore'] ?? 0),
	after: Number(reply['heapAfter'] ?? 0)
});

/** the four renders that put a real object into the state the deployed measurement was taken in */
async function warmWithRenders(site: ServeDo) {
	for (const path of ['/', '/user/login', '/node', '/filter/tips']) {
		await site.runJson(renderPage(path, [], false, {}));
	}
}

describe('the memory an enable costs', () => {
	it(
		'runs the install on a fresh interpreter even when the object has been rendering',
		async () => {
			const fresh = heapOf(
				await inObject(freshSite(), async (site) => {
					await call(site, '/__migrate?all=1&prefill=0');
					return call(site, '/__enable?module=token');
				})
			);

			const out = await inObject(freshSite(), async (site) => {
				await call(site, '/__migrate?all=1&prefill=0');
				await warmWithRenders(site);
				return call(site, '/__enable?module=token');
			});

			const heap = heapOf(out);
			expect(out['ok'], JSON.stringify(out).slice(0, 400)).toBe(true);
			// four renders raise the highwater; `memory.grow` has no inverse, so an install that
			// inherited them would start measurably above a fresh one. A small margin absorbs
			// allocator noise without absorbing a whole render's worth of growth
			expect(
				heap.before,
				`the enable inherited a ${Math.round(heap.before / 1_048_576)} MB heap against a fresh ` +
					`${Math.round(fresh.before / 1_048_576)} MB; it was supposed to drop the interpreter first`
			).toBeLessThan(fresh.before + 8 * 1_048_576);
			expect(
				heap.after,
				`the enable peaked at ${Math.round(heap.after / 1_048_576)} MB against a ${ISOLATE_LIMIT / 1_048_576} MB isolate`
			).toBeLessThan(HEAP_CEILING);
		},
		REQUEST_TIMEOUT
	);

	it(
		'costs at most ONE grow event on a fresh interpreter, since opcache stopped being on',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await call(site, '/__migrate?all=1&prefill=0');
				return call(site, '/__enable?module=token');
			});

			const heap = heapOf(out);
			const grew = heap.after - heap.before;
			expect(out['ok']).toBe(true);

			// this asserted 15-35 MB, then none, and now one rung. Dropping opcache took the
			// enable inside `INITIAL_MEMORY` on wasm32; 64-bit `zend_long` puts its working set
			// back over 96 MB, so it grows ONCE. The peak is the invariant, not the growth: a
			// bound on `grew` alone reads a step change as a regression
			const oneRung = Math.ceil(heap.before * SHIPPING_STEP) + 65_536;
			expect(grew, `grew ${grew} bytes, more than one grow event`).toBeLessThanOrEqual(
				oneRung
			);
			// the instrument check the growth bound used to provide. A reading of zero from a
			// BROKEN probe and a reading of zero from a heap that did not grow look identical, so
			// the heap has to be a real, page-aligned, plausible figure either way
			expect(heap.before).toBeGreaterThan(64 * 1_048_576);
			expect(heap.after).toBeGreaterThan(64 * 1_048_576);
			expect(heap.after % 65_536, 'wasm pages are 64 KiB').toBe(0);
			expect(heap.after).toBeLessThan(HEAP_CEILING);

			// THE OTHER HALF, and it has to be read or the ceiling above is a reading of one
			// allocator. `LAZY_FS_BUDGET_BYTES` is 4 MB in the shipping config, and the blob and
			// index stay resident by design -- 1,006 individual fetches would exceed the
			// 50-subrequest cap, so a range-fetching mount cannot serve one page
			const mount = out['mountBytes'] as Record<string, number>;
			expect(mount).toBeDefined();
			expect(mount['budget']).toBeDefined();

			const budget = mount['budget']!!;
			expect(budget, 'the lazy mount is not bounded in this lane').toBeGreaterThan(0);
			expect(
				mount['resident'],
				`the resident file cache is ${mount['resident']} bytes against a ${mount['budget']} budget`
			).toBeLessThanOrEqual(budget);

			expect(mount['blob'], 'the blob is not resident').toBeGreaterThan(0);
			const blob = mount['blob']!!;

			expect(mount['resident'], 'the resident cache is not resident').toBeGreaterThan(0);
			const resident = mount['resident']!!;

			// the budget bounds the INFLATED cache and nothing else: the compressed layer is
			// held outside it deliberately, because eviction is only reversible while the blob
			// is there. So the pin on the pair is a JS-side ceiling, not the budget
			expect(
				blob + resident,
				`the JS side holds ${Math.round((blob + resident) / 1_048_576)} MB; the wasm heap needs the rest of the 128 MB isolate`
			).toBeLessThan(JS_SIDE_CEILING);

			console.log(
				`[enable] wasm ${Math.round(heap.before / 1_048_576)} -> ${Math.round(heap.after / 1_048_576)} MB (+${Math.round(grew / 1_048_576)}), ` +
					`js-side blob ${Math.round(blob / 1_048_576)} MB + cache ${Math.round(resident / 1_048_576)}/${Math.round(budget / 1_048_576)} MB`
			);
		},
		REQUEST_TIMEOUT
	);

	it(
		'resolves the lock to the backend that does not need a clock',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await call(site, '/__migrate?all=1&prefill=0');
				await call(site, '/__enable?module=token');
				// read after a render rather than from the install's own reply: the container is
				// rebuilt during the install, so a service resolved in the same breath could be
				// answered by the one still in memory
				await site.runJson(renderPage('/', [], false, {}));
				return site.runJson(`<?php
echo json_encode([
  'ok' => true,
  'lock' => get_class(\\Drupal::service('lock')),
  'persistent' => get_class(\\Drupal::service('lock.persistent')),
  'waitReturns' => \\Drupal::service('lock')->wait('router_rebuild', 30),
]);`);
			});

			// THE ASSERTION THAT MAPS TO THE EDGE FAILURE. Core's backend spins usleep() for 30 s
			// against a lock that can never expire while microtime() returns 0, and that is billed
			// as CPU. This lane's clock works, so the cost does NOT reproduce here -- only the
			// wiring can be checked, and the wiring is what was wrong
			expect(out['lock']).toBe('Drupal\\drupflare\\Lock\\CfwLockBackend');
			expect(out['persistent']).toBe('Drupal\\drupflare\\Lock\\CfwLockBackend');
			// FALSE is "stop waiting"; TRUE sends RouteBuilder back around the loop
			expect(out['waitReturns']).toBe(false);
		},
		REQUEST_TIMEOUT
	);

	it(
		'requeues the pages it purged but leaves the chain for a later event to wake',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await call(site, '/__migrate?all=1&prefill=0');
				// prefill the pages a bump would purge, which is what makes `requeued` non-zero
				for (const path of ['/', '/user/login']) {
					await site.runJson(renderPage(path, [], false, {}));
					seedPage(site, path, `<html><title>${path}</title></html>`);
				}
				const enabled = await call(site, '/__enable?module=token');
				return {
					enabled,
					queue: site.queueDepth(),
					alarm: await site.ctx.storage.getAlarm()
				};
			});

			const enabled = out.enabled as Payload;
			expect(enabled['ok']).toBe(true);
			const bump = enabled['bump'] as Record<string, number> | null;
			expect(
				bump,
				'an install must invalidate; every cached page is stale after it'
			).not.toBe(null);
			expect(Number(bump?.['purgedPages'])).toBeGreaterThan(0);
			expect(Number(bump?.['requeued'])).toBeGreaterThan(0);
			// the rows are there so a later wake has something to do
			expect(out.queue).toBeGreaterThan(0);
			// AND NOTHING WAS ARMED FROM INSIDE THE INSTALL'S EVENT. On the edge that alarm fires
			// into an object sitting at ~110 MB of a 128 MB cap, the isolate is reset, and the
			// install rolls back with it -- measured 0/6 landing with the arm and 6/6 without
			expect(
				out.alarm,
				'the install armed its own fill alarm; on the edge that resets the object'
			).toBe(null);
			expect(enabled['armFill']).toBe(true);
		},
		REQUEST_TIMEOUT
	);

	it(
		'wakes the chain from a separate event, which is what makes it safe',
		async () => {
			const out = await inObject(freshSite(), async (site) => {
				await call(site, '/__migrate?all=1&prefill=0');
				seedPage(site, '/', '<html><title>/</title></html>');
				await call(site, '/__enable?module=token');
				const before = await site.ctx.storage.getAlarm();
				const armed = await call(site, '/__armfill');
				return { before, armed, after: await site.ctx.storage.getAlarm() };
			});

			expect(out.before).toBe(null);
			expect((out.armed as Payload)['armed']).toBe(true);
			expect(out.after, '/__armfill did not schedule the chain').not.toBe(null);
		},
		REQUEST_TIMEOUT
	);

	it(
		'reproduces the failing order under keep=1, which is what the deployed run did',
		async () => {
			const keep = heapOf(
				await inObject(freshSite(), async (site) => {
					await call(site, '/__migrate?all=1&prefill=0');
					await warmWithRenders(site);
					return call(site, '/__enable?module=token&keep=1');
				})
			);
			const dropped = heapOf(
				await inObject(freshSite(), async (site) => {
					await call(site, '/__migrate?all=1&prefill=0');
					await warmWithRenders(site);
					return call(site, '/__enable?module=token');
				})
			);

			// THE CONTROL, and it is now a RELATIONSHIP rather than an absolute ceiling. It used to
			// assert `keep=1` exceeded 120 MB, which it no longer does: with opcache off the same
			// order peaks at 116,588,544 instead. That is P30 removing part of the hazard, not the
			// hazard disappearing -- keeping the warm interpreter still costs ~20 MB of heap that
			// dropping it does not, and that difference is the whole reason the fix exists.
			//
			// An absolute would have to be re-pinned every time an unrelated memory change lands,
			// and a re-pinned control is one nobody has seen fail
			expect(keep.before).toBeGreaterThan(80 * 1_048_576);
			expect(
				keep.after - dropped.after,
				`keep=1 peaked at ${Math.round(keep.after / 1_048_576)} MB against ` +
					`${Math.round(dropped.after / 1_048_576)} MB dropped; the order no longer costs anything`
			).toBeGreaterThan(8 * 1_048_576);
			// and the fix still lands under the ceiling, which is the half that matters on the edge
			expect(dropped.after).toBeLessThan(HEAP_CEILING);
		},
		REQUEST_TIMEOUT
	);
});
