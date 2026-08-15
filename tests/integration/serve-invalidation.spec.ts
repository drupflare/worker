import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	type BumpResult,
	type ServeDo,
	type ServeProbe,
	driveAlarms,
	freshSite,
	inObject,
	namedSite,
	pageFor,
	seedPage,
	serveDirect,
	serveThroughWorker,
	statsOf,
	stubRender
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
		expect(Number(out.alarmAt) - out.now).toBeLessThan(1000);
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
