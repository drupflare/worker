import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	freshSite,
	inObject,
	pageFor,
	probe,
	seedPage,
	serveDirect,
	statsOf,
	stubRender,
	tick
} from '../helpers/serve-do';

/**
 * Ported from the `the lane split: a HIT must not queue behind a render` region of
 * `scripts/test-serve-chain.mjs`.
 *
 * What is not asserted here, and why -- carried across from the original, because it records a
 * measurement rather than an opinion:
 *
 *   The split was built to stop cache HITs queueing behind a render, and it does NOT measurably
 *   do that today. Measured on the deployed worker, 4 identical renders raced against 8 HITs on
 *   one object, one fresh site per lane so the work was equal: storage lane 286/328/339 ms, gated
 *   lane 284/293/295 ms. No difference, and every HIT's latency equals the whole round.
 *
 *   The mechanism is that the gate was never the binding constraint. `php._run()` is one
 *   synchronous wasm call, so the isolate's single thread is occupied for the entire render and an
 *   incoming HIT cannot be PROCESSED whichever lane it would take. `x-cfw-gate-active` read 0 on
 *   every one of 8 HITs raced against 4 concurrent renders, which is that fact stated directly:
 *   there is never an instant when a render is in flight and a HIT is being served.
 *
 *   The split is therefore insurance rather than a speed-up, and the thing it insures against
 *   arrives with slicing: a sliced render yields the thread between slices and re-arms its alarm
 *   at +1 ms, so a HIT competing for a FIFO ticket could be starved indefinitely by a chain that
 *   is always about to take the gate again. A storage lane cannot be starved because it does not
 *   take a ticket.
 *
 * What changed from the original. Two things, and the first is the reason this port is worth
 * more than the script it replaces:
 *
 *   - **The overlap is now asserted rather than declared unreachable.** The original could not
 *     produce an instant where a render was in flight and a HIT was answered, because a real
 *     `php._run()` never yields. A stubbed render that awaits DOES yield -- which is exactly the
 *     shape of the sliced render the split exists to insure against -- so `x-cfw-gate-active: 1`
 *     on a storage-lane HIT is observable here. It is not evidence about today's synchronous
 *     renders; it is evidence that the lane holds under the future the comment above describes.
 *   - **`hitMs < 10` is kept but demoted.** The engine-independent statement of "did not enter the
 *     gate" is the gate's own `completed` counter, so that is asserted too; a millisecond
 *     threshold on a loaded machine was always the weaker instrument.
 *   - **The memo-lied path and the non-GET path are new.** Both are branches of
 *     `serveFromStorage()` the original had no way to reach from an HTTP client.
 */

describe('a HIT on a ready object takes the storage lane', () => {
	it('answers from storage, reports the lane, and never enters the PHP gate', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			// one gated request first, so the tables exist: condition 1 of the split
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>cached</title>');
			const gateBefore = (await statsOf(site)).gate.completed;
			const hit = await serveDirect(site, '/', '&edge=0');
			return { hit, gateBefore, stats: await statsOf(site) };
		});

		expect(out.hit.cache).toBe('HIT');
		expect(out.hit.lane).toBe('storage');
		expect(out.hit.hitMs).toBeGreaterThanOrEqual(0);
		expect(out.hit.hitMs).toBeLessThan(10);
		// the engine's own counter: the gate ran nothing for this request. `+1` rather than
		// equality because reading the stats afterwards is itself a gated request
		expect(out.stats.gate.completed).toBe(out.gateBefore + 1);
		expect(out.hit.gateActive).toBe('0');
		expect(out.hit.gateQueued).toBe('0');
	});

	it('counts a storage-lane serve exactly once, in the durable counter', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>cached</title>');
			const before = Number(site.metaGet('serve_requests', '0'));
			const hit = await serveDirect(site, '/', '&edge=0');
			return { before, after: Number(site.metaGet('serve_requests', '0')), lane: hit.lane };
		});
		expect(out.lane).toBe('storage');
		expect(out.after).toBe(out.before + 1);
	});

	it('is counted separately from the PHP lane, so the split is observable', async () => {
		const stub = freshSite();
		const stats = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>cached</title>');
			await serveDirect(site, '/', '&edge=0');
			return statsOf(site);
		});
		expect(stats.storageLaneServes).toBeGreaterThan(0);
		expect(stats.phpLaneEntries).toBeGreaterThan(0);
		// the invariant the gate exists for; anything above 1 is a serialization failure
		expect(stats.gate.maxConcurrent).toBe(1);
	});
});

describe('lane=gate forces the gated lane, so the split is testable both ways', () => {
	it('answers the same bytes from either lane', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>cached</title>');
			const storage = await serveDirect(site, '/', '&edge=0');
			const gated = await serveDirect(site, '/', '&edge=0&lane=gate');
			return { storage, gated };
		});
		expect(out.storage.lane).toBe('storage');
		expect(out.gated.lane).toBe('php-gate');
		expect(out.gated.cache).toBe('HIT');
		expect(out.gated.body).toBe(out.storage.body);
		expect(out.gated.status).toBe(out.storage.status);
	});

	it('takes the gated lane for a method the fast lane will not answer', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>cached</title>');
			const res = await site.fetch(
				new Request('https://do.local/__serve?path=%2F', { method: 'POST' })
			);
			return probe(res);
		});
		// one SELECT and one response with nothing able to interleave is only safe for a read
		expect(out.lane).toBe('php-gate');
		expect(out.cache).toBe('HIT');
	});
});

describe('the fast lane refuses to run DDL, which is the constraint that makes it safe', () => {
	it('declines on an object whose serve tables do not exist yet', async () => {
		const stub = freshSite();
		const first = await inObject(stub, (site) => serveDirect(site, '/'));
		// CREATE TABLE next to an open transaction replay dirties sqlite_master and turns every
		// later read in that transaction into a speculative replay
		expect(first.lane).toBe('php-gate');
	});

	it('declines again after an eviction, because the memo is in-memory state', async () => {
		const stub = freshSite();
		await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>cached</title>');
			return null;
		});
		const warm = await inObject(stub, (site) => serveDirect(site, '/', '&edge=0'));
		await evictDurableObject(stub);
		const afterEviction = await inObject(stub, (site) => serveDirect(site, '/', '&edge=0'));
		const again = await inObject(stub, (site) => serveDirect(site, '/', '&edge=0'));

		expect(warm.lane).toBe('storage');
		// the tables DO exist; what was lost is the proof that they do
		expect(afterEviction.lane).toBe('php-gate');
		expect(afterEviction.cache).toBe('HIT');
		expect(again.lane).toBe('storage');
	});

	it('hands back to the gated lane when the memo turns out to have lied', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/', '<title>cached</title>');
			// the table goes away underneath a memo that still says it is there
			site.sql.exec('DROP TABLE cfw_page');
			site.serveTablesReady = true;
			const served = await serveDirect(site, '/', '&edge=0');
			return { served, readyAfter: site.serveTablesReady };
		});
		// no throw at the visitor: the fast lane returns null and the gated lane sorts it out
		expect(out.served.lane).toBe('php-gate');
		expect(out.served.status).toBe(503);
		// and the memo has been re-established by the gated lane's ensureServeTables()
		expect(out.readyAfter).toBe(true);
	});
});

describe('a storage-lane HIT is answered while the PHP lane is occupied', () => {
	it('reports gate-active 1 for a HIT overlapping a render that yields', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/warm', '<title>warm</title>');
			stubRender(site, async ({ path }) => {
				// a render that yields the thread, which is what a SLICED render does and what a
				// synchronous php._run() never does
				await tick(30);
				return pageFor(path);
			});
			// not awaited yet: it has to still be inside the gate
			const render = serveDirect(site, '/slow');
			await tick(5);
			const hit = await serveDirect(site, '/warm', '&edge=0');
			return { hit, render: await render };
		});

		expect(out.render.cache).toBe('RENDER');
		expect(out.hit.cache).toBe('HIT');
		expect(out.hit.lane).toBe('storage');
		// the entire claim of the split, with no milliseconds involved
		expect(out.hit.gateActive).toBe('1');
	});

	it('CONTROL: the same HIT forced through the gate reports no overlap', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			await serveDirect(site, '/');
			seedPage(site, '/warm', '<title>warm</title>');
			stubRender(site, async ({ path }) => {
				await tick(30);
				return pageFor(path);
			});
			const render = serveDirect(site, '/slow');
			await tick(5);
			const gated = await serveDirect(site, '/warm', '&edge=0&lane=gate');
			return { gated, render: await render };
		});
		expect(out.gated.lane).toBe('php-gate');
		expect(out.gated.cache).toBe('HIT');
		// it waited for the render, so by the time it answered the gate was empty again; the
		// gated lane reports no gate headers at all
		expect(out.gated.gateActive).toBeNull();
	});
});

// #region TEMPORARY assertion counter
import { afterAll as __afterAll, afterEach as __afterEach } from 'vitest';
let __asserts = 0;
__afterEach(() => {
	__asserts += expect.getState().assertionCalls ?? 0;
});
__afterAll(() => {
	console.log(`ASSERTIONS tests/integration/serve-lanes.spec.ts ${__asserts}`);
});
// #endregion
