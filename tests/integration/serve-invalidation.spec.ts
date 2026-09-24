import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { emptyTally } from '../../src/db/write-tally';
import { saveDebounceMs } from '../../src/site-do';
import {
	driveAlarms,
	freshSite,
	inObject,
	invalidateTag,
	markProvisioned,
	namedSite,
	pageFor,
	seedPage,
	seedTaggedPage,
	serveDirect,
	serveThroughWorker,
	statsOf,
	stubRender,
	type BumpResult,
	type ServeDo,
	type ServeProbe
} from '../helpers/serve-do';

/**
 * Ported from the `the generation counter` and `save-triggered prefill` regions of
 * `scripts/test-serve-chain.mjs`.
 *
 * What changed from the original, where the first item is why this port is stronger than what it
 * replaces:
 *
 *   - **The automatic seam is driven at the seam.** The original reached it through
 *     `/invalidate`, which runs Drupal's `Cache::invalidateTags()` in PHP. The mechanism being
 *     tested is not Drupal's, though: it is `execSql()` matching a MUTATING statement against
 *     `cachetags` and bumping. Here the statement is issued directly, so the CONTROL the original
 *     could not run is available -- a SELECT against the same table must NOT bump, because the
 *     checksum service reads it on every single request, and a regex that matched a read would
 *     invalidate the whole site on every page view.
 *   - **`suppressBump` is asserted against the real pack.** Replaying the packed site inserts the
 *     packed `cachetags` rows; if that counted as a content change, every first-run migration
 *     would bump the generation ~15 times. The original could not see this because it migrated
 *     before it started reading generations.
 *   - **The prefill cap is now a test rather than a field.** `PREFILL_ON_SAVE_LIMIT` and
 *     `PREFILL_ON_SAVE` are env vars, so the original could only assert `droppedFromRequeue` was
 *     "a number" and that a site with nothing cached re-queued nothing. Both switches are set
 *     here and the tail really is dropped.
 *
 * What is NOT covered: that Drupal's own `invalidateTags()` reaches `cachetags` through
 * `Connection::merge()`. That is a PHP claim and stays with the deployed lane.
 */

const bumpThroughWorker = async (site: string, reason: string) => {
	const res = await SELF.fetch(`https://cfw.local/bump?site=${site}&reason=${reason}`);
	return {
		body: (await res.json()) as BumpResult & { bumps: number },
		generationHeader: res.headers.get('x-cfw-generation')
	};
};

/** the pointer is discovered once per window, so an edge hit is retried; see src/site.js */
async function untilEdge(site: string, path: string, tries = 6): Promise<ServeProbe | null> {
	for (let i = 0; i < tries; i++) {
		const hit = await serveThroughWorker(site, path);
		if (hit.cache === 'EDGE') return hit;
	}
	return null;
}

/** a table with the shape `DatabaseCacheTagsChecksum` writes to, and nothing else */
function seedCachetags(site: ServeDo) {
	site.ensureServeTables();
	site.sql.exec(
		`CREATE TABLE IF NOT EXISTS cachetags (
			tag VARCHAR(255) NOT NULL PRIMARY KEY, invalidations INTEGER NOT NULL DEFAULT 0)`
	);
}

describe('one integer write invalidates every edge-cached URL for a site', () => {
	it('bumps the counter, purges the page cache, and re-queues what it purged', async () => {
		const site = 'bumped';
		await inObject(namedSite(site), (obj) => {
			stubRender(obj, ({ path }) => pageFor(path));
			seedPage(obj, '/', '<title>before</title>');
			// no KV copy, or the read after the bump is the stale-generation tier and not the object
			obj.env = { ...obj.env, KV_WRITES_PER_DAY: '0' };
		});
		await serveThroughWorker(site, '/');
		const cached = await untilEdge(site, '/');
		expect(cached?.cache).toBe('EDGE');

		const bump = await bumpThroughWorker(site, 'test');
		expect(bump.body.generation).toBe(2);
		expect(bump.generationHeader).toBe('2');
		// both halves are required: without the DELETE the next request would edge-miss, reach the
		// object, be served the same stale HTML and be re-cached under the new generation
		expect(bump.body.purgedPages).toBe(1);
		expect(bump.body.requeued).toBe(1);
		expect(bump.body.droppedFromRequeue).toBe(0);
		expect(bump.body.reason).toBe('test');

		// DRIVEN, not raced. The bump arms an alarm at +1 ms and the assertion below wants the page
		// back; whether the alarm or the inline render gets there first is a race, and it decided
		// this spec's result -- it passed or failed depending on how long the object spent on
		// unrelated work in the same invocation. Waiting for the queue to drain is what the two
		// permitted outcomes below were already written for
		await driveAlarms(namedSite(site), (obj) => obj.queueDepth() === 0, 12);
		const after = await serveThroughWorker(site, '/');
		expect(after.cache).not.toBe('EDGE');
		expect(after.edge).toBe('MISS');
		// RENDER or HIT, both correct: the prefill may already have refilled this path from the
		// alarm chain, which is what it is for. What is asserted is that the bytes are a real page
		expect(after.status).toBe(200);
		expect(['RENDER', 'HIT']).toContain(after.cache);
		expect(after.body).toContain('<title>/</title>');
		// and a render must NOT bump, or the edge cache could never hold anything
		expect(after.generation).toBe(2);
	});

	it('reports the reason on the durable record, so a bump can be traced', async () => {
		const stub = freshSite();
		const stats = await inObject(stub, async (site) => {
			site.bumpGeneration('manual');
			return statsOf(site);
		});
		expect(stats.generation).toBe(2);
		expect(stats.bumps).toBe(1);
		expect(String(stats.lastBump)).toContain('2:manual:');
	});

	it('purges the dynamic page cache on a manual bump, or the bump does nothing', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.ensureServeTables();
			site.sql.exec(
				`CREATE TABLE IF NOT EXISTS cache_dynamic_page_cache (
					cid VARCHAR(255) NOT NULL PRIMARY KEY, data BLOB,
					expire INTEGER NOT NULL DEFAULT 0, created NUMERIC NOT NULL DEFAULT 0,
					serialized INTEGER NOT NULL DEFAULT 0, tags TEXT,
					checksum VARCHAR(255) NOT NULL)`
			);
			for (const cid of ['a', 'b', 'c']) {
				site.sql.exec(
					'INSERT INTO cache_dynamic_page_cache (cid, data, expire, created, serialized, tags, checksum) VALUES (?, ?, -1, 0, 0, ?, ?)',
					cid,
					'x',
					'rendered',
					'0'
				);
			}
			const bumped = site.bumpGeneration('manual');
			const left = Number(
				(
					site.sql
						.exec('SELECT COUNT(*) AS c FROM cache_dynamic_page_cache')
						.toArray()[0] as { c: number }
				).c
			);
			return { purgedDynamic: bumped.purgedDynamic, left };
		});
		expect(out.purgedDynamic).toBe(3);
		expect(out.left).toBe(0);
	});

	it('leaves it alone on a cachetags bump, because tags already reach the warm entry', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.ensureServeTables();
			site.sql.exec(
				`CREATE TABLE IF NOT EXISTS cache_dynamic_page_cache (
					cid VARCHAR(255) NOT NULL PRIMARY KEY, data BLOB,
					expire INTEGER NOT NULL DEFAULT 0, created NUMERIC NOT NULL DEFAULT 0,
					serialized INTEGER NOT NULL DEFAULT 0, tags TEXT,
					checksum VARCHAR(255) NOT NULL)`
			);
			site.sql.exec(
				'INSERT INTO cache_dynamic_page_cache (cid, data, expire, created, serialized, tags, checksum) VALUES (?, ?, -1, 0, 0, ?, ?)',
				'a',
				'x',
				'rendered',
				'0'
			);
			const bumped = site.bumpGeneration('cachetags');
			const left = Number(
				(
					site.sql
						.exec('SELECT COUNT(*) AS c FROM cache_dynamic_page_cache')
						.toArray()[0] as { c: number }
				).c
			);
			return { purgedDynamic: bumped.purgedDynamic, left };
		});
		expect(out.purgedDynamic).toBe(0);
		expect(out.left).toBe(1);
	});

	it('tolerates a site whose dynamic bin has never been created', async () => {
		const stub = freshSite();
		const bumped = await inObject(stub, async (site) => site.bumpGeneration('manual'));
		expect(bumped.purgedDynamic).toBe(-1);
		expect(bumped.generation).toBe(2);
	});

	it('starts at 1 and writes the row on first read, so a key is never built from null', async () => {
		const stub = freshSite();
		const out = await inObject(stub, (site) => ({
			first: site.generation(),
			stored: site.metaGet('generation'),
			second: site.generation()
		}));
		expect(out.first).toBe(1);
		expect(out.stored).toBe('1');
		expect(out.second).toBe(1);
	});
});

describe('the automatic seam: a cachetags WRITE bumps, a cachetags READ does not', () => {
	it('bumps with nothing calling bumpGeneration directly', async () => {
		const stub = freshSite();
		const out = await inObject(stub, (site) => {
			seedCachetags(site);
			const before = site.generation();
			site.execSql("INSERT INTO cachetags (tag, invalidations) VALUES ('rendered', 1)", []);
			return { before, after: site.generation(), lastBump: site.metaGet('last_bump') };
		});
		expect(out.before).toBe(1);
		expect(out.after).toBe(2);
		// the reason names the seam, so an automatic bump is distinguishable from a manual one
		expect(String(out.lastBump)).toContain(':cachetags:');
	});

	it('CONTROL: a SELECT against the same table changes nothing', async () => {
		const stub = freshSite();
		const out = await inObject(stub, (site) => {
			seedCachetags(site);
			site.sql.exec("INSERT INTO cachetags (tag, invalidations) VALUES ('rendered', 1)");
			const before = site.generation();
			site.execSql("SELECT invalidations FROM cachetags WHERE tag = 'rendered'", []);
			return { before, after: site.generation() };
		});
		// the checksum service reads this table on every request; a bump here would invalidate the
		// site on every page view
		expect(out.after).toBe(out.before);
	});

	it('coalesces the many writes one save makes into a single bump', async () => {
		const stub = freshSite();
		const out = await inObject(stub, (site) => {
			seedCachetags(site);
			site.execSql("INSERT INTO cachetags (tag, invalidations) VALUES ('rendered', 1)", []);
			const afterFirst = site.generation();
			// one content save invalidates many tags and each is its own merge('cachetags')
			site.execSql("UPDATE cachetags SET invalidations = 2 WHERE tag = 'rendered'", []);
			site.execSql("UPDATE cachetags SET invalidations = 3 WHERE tag = 'rendered'", []);
			return { afterFirst, afterRest: site.generation() };
		});
		expect(out.afterFirst).toBe(2);
		expect(out.afterRest).toBe(2);
	});

	it('re-arms once something is cacheable again, which is what fillOne clears', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			seedCachetags(site);
			stubRender(site, ({ path }) => pageFor(path));
			site.execSql("INSERT INTO cachetags (tag, invalidations) VALUES ('rendered', 1)", []);
			const afterFirst = site.generation();
			// a fill means there is something to invalidate again
			await site.fillOne('/');
			site.execSql("UPDATE cachetags SET invalidations = 2 WHERE tag = 'rendered'", []);
			return { afterFirst, afterFill: site.generation() };
		});
		expect(out.afterFirst).toBe(2);
		expect(out.afterFill).toBe(3);
	});

	it('arms the refill a bounded window after a save, and a later save does not push it', async () => {
		const arm = async (debounce?: string) =>
			inObject(freshSite(), async (site) => {
				if (debounce !== undefined) site.env = { ...site.env, SAVE_DEBOUNCE_MS: debounce };
				stubRender(site, ({ path }) => pageFor(path));
				await site.fillOne('/');
				// start from no pending alarm, so the reading below is the save's own arm
				await site.ctx.storage.deleteAlarm();
				(site as unknown as { alarmDueMs?: number }).alarmDueMs = undefined;
				const t = Date.now();
				site.bumpGeneration('save');
				const first = (await site.ctx.storage.getAlarm()) ?? 0;
				// a second save in the same burst, with a page stored again so it has one to requeue
				await site.fillOne('/');
				site.bumpGeneration('save');
				const second = (await site.ctx.storage.getAlarm()) ?? 0;
				return { firstIn: first - t, second, first };
			});
		const debounced = await arm();
		expect(debounced.firstIn).toBeGreaterThanOrEqual(saveDebounceMs({} as never));
		// the window is bounded by the FIRST save: the second one cannot move it later
		expect(debounced.second).toBeLessThanOrEqual(debounced.first);
		const immediate = await arm('0');
		expect(immediate.firstIn).toBeLessThan(saveDebounceMs({} as never));
	});

	it('stays silent while the packed site is being replayed', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			const res = await site.fetch(new Request('https://do.local/__migrate?all=1'));
			const body = (await res.json()) as { done: boolean };
			return {
				done: body.done,
				generation: site.generation(),
				cachetags: Number(
					site.sql.exec('SELECT count(*) AS n FROM cachetags').toArray()[0]?.n ?? 0
				)
			};
		});
		expect(out.done).toBe(true);
		// the pack really does carry cachetags rows, so the suppression is doing work
		expect(out.cachetags).toBeGreaterThan(0);
		// replaying them is setup, not a content change
		expect(out.generation).toBe(1);
	});
});

describe('a save must not hand the next visitor a 202', () => {
	it('re-queues the purged paths and the alarm chain refills them', async () => {
		const stub = freshSite();
		const bump = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			await site.fillOne('/');
			await site.fillOne('/node');
			expect((await statsOf(site)).cached).toHaveLength(2);
			return site.bumpGeneration('prefilltest');
		});
		expect(bump.purgedPages).toBe(2);
		// the paths have to be read BEFORE the DELETE, which is the whole subtlety
		expect(bump.requeued).toBe(2);

		await driveAlarms(stub, (site) => site.queueDepth() === 0);
		const out = await inObject(stub, async (site) => ({
			// inline=0 throughout, so a HIT can ONLY have come from the chain's prefill and never
			// from the polling request rendering the page itself
			root: await serveDirect(site, '/', '&inline=0'),
			node: await serveDirect(site, '/node', '&inline=0')
		}));
		expect(out.root.status).toBe(200);
		expect(out.root.cache).toBe('HIT');
		expect(out.node.cache).toBe('HIT');
	});

	it('drops the tail rather than turning one save into thousands of fills', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, PREFILL_ON_SAVE_LIMIT: '2' };
			stubRender(site, ({ path }) => pageFor(path));
			for (const path of ['/a', '/b', '/c']) await site.fillOne(path);
			const bump = site.bumpGeneration('capped');
			return { bump, depth: site.queueDepth() };
		});
		expect(out.bump.purgedPages).toBe(3);
		expect(out.bump.requeued).toBe(2);
		// rows written is the free plan's binding meter, so the cap is reported
		expect(out.bump.droppedFromRequeue).toBe(1);
		expect(out.depth).toBe(2);
	});

	it('re-queues nothing when the switch is off, so the switch is real', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, PREFILL_ON_SAVE: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			await site.fillOne('/');
			await site.fillOne('/node');
			const bump = site.bumpGeneration('offtest');
			return { bump, depth: site.queueDepth() };
		});
		expect(out.bump.purgedPages).toBe(2);
		expect(out.bump.requeued).toBe(0);
		expect(out.depth).toBe(0);
	});

	it('re-queues nothing on a site with nothing cached', async () => {
		const stub = freshSite();
		const bump = await inObject(stub, (site) => site.bumpGeneration('empty'));
		expect(bump.purgedPages).toBe(0);
		expect(bump.requeued).toBe(0);
		expect(bump.generation).toBe(2);
	});

	/**
	 * THE 503 STORM. A bump used to empty `cfw_page`, so between a save and the refill every
	 * anonymous visitor -- 0.82 of the traffic weight -- got an error, on every site and every save.
	 * `PREFILL_ON_SAVE` re-queues and is not the fix: it bounds how many pages come BACK, not the
	 * window in which there are none. The row is superseded rather than deleted now.
	 */
	it('answers the drain window with content instead of a 503', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			await site.fillOne('/');
			site.bumpGeneration('storm');
			// nothing has refilled yet: this is the exact instant that used to be an error
			return await serveDirect(site, '/', '&inline=0');
		});
		expect(out.status).toBe(200);
		expect(out.cache).toBe('AGED');
	});

	it('goes back to HIT once the chain has refilled it', async () => {
		const stub = freshSite();
		await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			await site.fillOne('/');
			site.bumpGeneration('storm');
		});
		await driveAlarms(stub, (site) => site.queueDepth() === 0);
		const out = await inObject(stub, (site) => serveDirect(site, '/', '&inline=0'));
		// the refill clears the mark, so an aged row cannot survive its own replacement
		expect(out.cache).toBe('HIT');
	});

	it('queues a refill for a path the cap left out, so the tail self-heals on its first visit', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, PREFILL_ON_SAVE_LIMIT: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			await site.fillOne('/tail');
			const bump = site.bumpGeneration('capped');
			const before = site.queueDepth();
			const served = await serveDirect(site, '/tail', '&inline=0');
			return { bump, before, after: site.queueDepth(), served };
		});
		// the cap re-queued nothing, so without the serve-side enqueue this path stays aged forever
		expect(out.bump.requeued).toBe(0);
		expect(out.before).toBe(0);
		expect(out.served.cache).toBe('AGED');
		expect(out.after).toBe(1);
	});

	it('degrades to the old refusal once the window has passed, rather than serving forever', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			// an object whose alarm chain has stopped is the case this bound exists for
			site.env = { ...site.env, AGED_SERVE_MAX_MS: '0' };
			stubRender(site, ({ path }) => pageFor(path));
			await site.fillOne('/');
			site.bumpGeneration('expired');
			return await serveDirect(site, '/', '&inline=0');
		});
		expect(out.cache).not.toBe('AGED');
		expect(out.status).toBeGreaterThanOrEqual(400);
	});

	it('honours an operator exclusion and refuses to age that path', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			site.env = { ...site.env, NEVER_STALE: '/checkout' };
			stubRender(site, ({ path }) => pageFor(path));
			await site.fillOne('/checkout');
			await site.fillOne('/');
			site.bumpGeneration('excluded');
			return {
				checkout: await serveDirect(site, '/checkout', '&inline=0'),
				root: await serveDirect(site, '/', '&inline=0')
			};
		});
		expect(out.checkout.cache).not.toBe('AGED');
		// the control: the exclusion is a path rule, not a switch that turned the tier off
		expect(out.root.cache).toBe('AGED');
	});

	/**
	 * A visitor's miss must not wait behind work nobody is waiting for. A bump queues up to
	 * `PREFILL_ON_SAVE_LIMIT` background paths; the queue was FIFO, so a miss arriving after one
	 * was served last. Measured deployed with a queue ~28 deep: time-to-served p50 19,004 ms and
	 * 4 of 8 probes never served at all, against a VPS answering all 8 first time at p50 78 ms.
	 *
	 * `markProvisioned()` because `freshSite()` has never migrated, and every `/__serve` on one
	 * returns the `migrating` warming page before it reaches the enqueue -- which is why the first
	 * version of this test saw an empty queue and looked like a broken promotion.
	 */
	it('serves a visitor-demanded miss before background prefill', async () => {
		const stub = freshSite();
		const order = await inObject(stub, async (site) => {
			markProvisioned(site);
			stubRender(site, ({ path }) => pageFor(path));
			for (const path of ['/a', '/b', '/c']) await site.fillOne(path);
			// the bump queues all three as background work
			site.bumpGeneration('prefill');
			// and now a visitor misses a path none of them is
			const probe = await serveDirect(site, '/wanted', '&inline=0');
			expect(probe.status).toBe(503);
			return site.sql
				.exec('SELECT path, priority FROM cfw_fill_queue ORDER BY priority, queued_at')
				.toArray()
				.map((r) => `${r.path}:${r.priority}`);
		});
		expect(order[0]).toBe('/wanted:0');
		expect(order).toHaveLength(4);
	});

	it('promotes a path background prefill had already queued', async () => {
		const stub = freshSite();
		const order = await inObject(stub, async (site) => {
			markProvisioned(site);
			site.ensureServeTables();
			stubRender(site, ({ path }) => pageFor(path));
			// queued as background work, with nothing stored for it, so a visitor still misses
			site.sql.exec(
				'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?)',
				'/slow',
				Date.now() - 1000
			);
			site.sql.exec(
				'INSERT INTO cfw_fill_queue (path, queued_at) VALUES (?, ?)',
				'/wanted',
				Date.now()
			);
			await serveDirect(site, '/wanted', '&inline=0');
			return site.sql
				.exec('SELECT path, priority FROM cfw_fill_queue ORDER BY priority, queued_at')
				.toArray()
				.map((r) => `${r.path}:${r.priority}`);
		});
		// DO UPDATE rather than DO NOTHING: the row already existed, and leaving it at background
		// priority is exactly the case the visitor is waiting through
		expect(order[0]).toBe('/wanted:0');
	});

	it('arms the chain, because a bump is not otherwise a wake-up', async () => {
		const stub = freshSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			await site.fillOne('/');
			// 240 s out after the fill drained the queue
			await site.ctx.storage.setAlarm(Date.now() + 240_000);
			site.bumpGeneration('wake');
			return { alarmAt: await site.ctx.storage.getAlarm(), now: Date.now() };
		});
		// inside the save debounce, and far before the keep-warm alarm it would otherwise wait for
		expect(Number(out.alarmAt) - out.now).toBeLessThan(saveDebounceMs({} as never) + 1000);
	});
});

// #region TEMPORARY assertion counter
import { afterAll as __afterAll, afterEach as __afterEach } from 'vitest';
let __asserts = 0;
__afterEach(() => {
	__asserts += expect.getState().assertionCalls ?? 0;
});
__afterAll(() => {
	console.log(`ASSERTIONS tests/integration/serve-invalidation.spec.ts ${__asserts}`);
});
// #endregion

/**
 * Staleness derived from tag state, which is what stops a save charging a row per page it reached.
 *
 * `UPDATE cfw_page SET stale_at = ?` is charged per ROW, so a save reaching 34 pages spent 34 rows
 * saying so -- on the meter that binds regeneration, before regenerating anything. The page already
 * carries the sum of its tags' invalidation counters, which is Drupal's own freshness test, so the
 * marking is derivable and the write can wait for the serve that first meets the page stale. A page
 * refilled before anyone asks for it never pays it.
 */
describe('a bump does not write a row per page it superseded', () => {
	const TAGS = ['node_list', 'config:system.site'];

	it('charges nothing to mark, and marks once at the first stale serve', async () => {
		const seen = await inObject(freshSite(), (site: ServeDo) => {
			markProvisioned(site);
			for (let i = 0; i < 12; i++) {
				seedTaggedPage(site, `/tagged-${i}`, `<p>page ${i}</p>`, TAGS);
			}
			// and one stored before the column existed, which cannot be derived
			seedPage(site, '/legacy', '<p>legacy</p>');

			site.writeTally = emptyTally();
			site.bumpGeneration('cachetags');
			const bumpRows = site.writeTally?.byTable?.['cfw_page'] ?? 0;
			site.writeTally = undefined;

			const markedBySave = site.sql
				.exec('SELECT path FROM cfw_page WHERE stale_at IS NOT NULL')
				.toArray()
				.map((r) => String(r['path']));

			// now a real invalidation moves the counters the checksum is taken over
			invalidateTag(site, 'node_list');

			site.writeTally = emptyTally();
			const first = site.serveFromStorage(new URL('https://do.local/__serve?path=/tagged-0'));
			const serveRows = site.writeTally?.byTable?.['cfw_page'] ?? 0;
			site.writeTally = undefined;

			site.writeTally = emptyTally();
			const second = site.serveFromStorage(
				new URL('https://do.local/__serve?path=/tagged-0')
			);
			const repeatRows = site.writeTally?.byTable?.['cfw_page'] ?? 0;
			site.writeTally = undefined;

			return {
				bumpRows,
				markedBySave,
				serveRows,
				repeatRows,
				firstTier: first?.headers.get('x-cfw-cache') ?? null,
				secondTier: second?.headers.get('x-cfw-cache') ?? null,
				markedAfterServe: site.sql
					.exec('SELECT path FROM cfw_page WHERE stale_at IS NOT NULL')
					.toArray()
					.map((r) => String(r['path']))
					.sort()
			};
		});

		// THE CONTROL: the legacy row has no checksum to derive from, so it IS marked at the
		// save -- one row, not the thirteen the old statement charged
		expect(seen.markedBySave).toEqual(['/legacy']);
		expect(seen.bumpRows).toBe(1);

		// the first serve of a superseded page pays the mark, and answers AGED rather than
		// pretending the page is current
		expect(seen.firstTier).toBe('AGED');
		expect(seen.serveRows).toBe(1);
		// and the second pays nothing: the transition happened once
		expect(seen.secondTier).toBe('AGED');
		expect(seen.repeatRows).toBe(0);

		// eleven pages nobody asked for are still unmarked, which is the whole saving
		expect(seen.markedAfterServe).toEqual(['/legacy', '/tagged-0']);
	}, 600_000);

	/**
	 * THE DERIVATION IS ONLY VALID FOR A TAG INVALIDATION, and this is the control.
	 *
	 * A module install, a firstrun or a manual bump changes what a page renders without moving any
	 * `cachetags` counter, so a checksum comparison would answer "current" for a page the install
	 * changed. Those reasons mark eagerly, exactly as before.
	 */
	it('still marks every page eagerly on a bump no counter can speak for', async () => {
		const seen = await inObject(freshSite(), (site: ServeDo) => {
			markProvisioned(site);
			for (let i = 0; i < 4; i++) {
				seedTaggedPage(site, `/install-${i}`, `<p>page ${i}</p>`, TAGS);
			}
			site.bumpGeneration('install');
			const marked = site.sql
				.exec('SELECT path FROM cfw_page WHERE stale_at IS NOT NULL')
				.toArray().length;
			const tier =
				site
					.serveFromStorage(new URL('https://do.local/__serve?path=/install-0'))
					?.headers.get('x-cfw-cache') ?? null;
			return { marked, tier };
		});

		expect(seen.marked).toBe(4);
		expect(seen.tier).toBe('AGED');
	}, 600_000);

	it('answers HIT while the tags have not moved, so the derivation is not a blanket stale', async () => {
		const seen = await inObject(freshSite(), (site: ServeDo) => {
			markProvisioned(site);
			seedTaggedPage(site, '/fresh', '<p>fresh</p>', TAGS);
			site.bumpGeneration('cachetags');
			const before = site.serveFromStorage(new URL('https://do.local/__serve?path=/fresh'));
			invalidateTag(site, 'config:system.site');
			const after = site.serveFromStorage(new URL('https://do.local/__serve?path=/fresh'));
			return {
				before: before?.headers.get('x-cfw-cache') ?? null,
				after: after?.headers.get('x-cfw-cache') ?? null
			};
		});

		// a bump alone does not make a page stale any more; moving the counter does
		expect(seen.before).toBe('HIT');
		expect(seen.after).toBe('AGED');
	}, 600_000);
});
