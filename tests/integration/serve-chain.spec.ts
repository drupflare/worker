import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HeapRestoreIncomplete } from '../../src/site-do';
import {
	type FillOutcome,
	type RenderCall,
	type ServeDo,
	decodeRenderCall,
	driveAlarms,
	freshSite,
	inObject,
	markProvisioned,
	pageFor,
	provisionedSite,
	queuePath,
	seedPage,
	serveDirect,
	statsOf,
	stubRender,
	tick
} from '../helpers/serve-do';

/**
 * Ported from the cold-object, alarm-chain, inline-render, over-budget and unrenderable-path
 * regions of `scripts/test-serve-chain.mjs`.
 *
 * The original needed `bunx wrangler dev` running on port 8798 and a human to start it; the whole
 * suite failed with "cannot reach" otherwise, which is why it was never in the gate. Everything
 * here runs against a real Durable Object inside workerd via `runInDurableObject`, so it is a
 * gate test now.
 *
 * What changed from the original:
 *
 *   - **The interpreter is stubbed; nothing else is.** `ctx.storage.sql`, `setAlarm`/`getAlarm`,
 *     the real `alarm()` handler and the FIFO gate are the platform's. `runJson()` is a function
 *     of the path, decoded back out of the PHP fragment the module emitted, so the assertion
 *     "this render was asked for THIS path with THESE bins" is still real. What is gone is
 *     everything whose failure mode lives inside Drupal: the original asserted a real `<title>`
 *     and that `/user/login` differed from `/`, which caught `PageCache` memoizing its cid across
 *     paths. A stub keyed on the path cannot catch that, and it stays with the deployed lane.
 *   - **The alarm is driven rather than waited on.** `waitForHit()` polled `/serve` 40 times at
 *     500 ms; `driveAlarms()` invokes the handler. Same invariant, milliseconds instead of
 *     seconds, and no timing dependence.
 *   - **`renderMs > 10` is gone.** It asserted that a real Drupal render costs more than the
 *     10 ms a user-facing invocation gets, which is a measurement of PHP and cannot be made
 *     here. Its other half survives: the SERVE fits, `x-cfw-hit-ms < 10`, on the real engine.
 *   - **The estimate is now asserted both ways.** The original could only ever see the
 *     measurable-clock path locally. Here a synchronous stub reproduces the edge's frozen wall
 *     clock (`x-cfw-render-clock: unmeasurable`), and a stub that awaits a real tick reproduces
 *     the measurable one, so `estimateRenderMs()` is pinned in both states.
 *   - **The 4,000 ms cold estimate and the destruct tri-state are new.** Both are JS branches the
 *     original could only reach by restarting wrangler with different `--var` flags.
 *
 * Timing assertions are kept only where the number IS the claim: a MISS and a HIT must fit the
 * free plan's 10 ms invocation, and both are pure `ctx.storage.sql` here.
 *
 * EVERY SUBJECT IS `provisionedSite()`, never `freshSite()`. Cold here means a cold INTERPRETER and
 * an empty page cache, which is a different state from a site that has no database yet -- and the
 * two were conflated for as long as an unprovisioned object answered `warming` on every request.
 * Once it started answering `migrating` instead, 16 assertions in this file were reading the
 * first-run placeholder while claiming to measure a MISS. First-run behaviour is
 * `serve-provision.spec.ts`.
 */

/** the wrangler.jsonc default: what a MISS may spend rendering for the visitor */
const BUDGET_MS = 2000;

/** what `estimateRenderMs()` returns with no interpreter, and with one but no measured render */
const COLD_ESTIMATE_MS = 4000;
const FIRST_RENDER_ESTIMATE_MS = 1800;

describe('a cold MISS costs no interpreter and no render', () => {
	it('returns the placeholder, queues the path and says why it did not render', async () => {
		const stub = await provisionedSite();
		const cold = await inObject(stub, (site) => serveDirect(site, '/'));

		expect(cold.status).toBe(503);
		expect(cold.cache).toBe('MISS');
		// the whole point of the tier: a MISS must not instantiate PHP
		expect(cold.phpBooted).toBe('0');
		expect(cold.inline).toBe('cold');
		expect(cold.queueDepth).toBe(1);
		expect(cold.body).toContain('warming');
		// a placeholder must never be cacheable anywhere
		expect(cold.cacheControl).toBe('no-store');
		expect(cold.generation).toBe(1);
		expect(cold.lane).toBe('php-gate');
	});

	it('fits the 10 ms a free-plan invocation gets', async () => {
		const stub = await provisionedSite();
		const cold = await inObject(stub, (site) => serveDirect(site, '/'));
		expect(cold.missMs).toBeGreaterThanOrEqual(0);
		expect(cold.missMs).toBeLessThan(10);
	});

	it('estimates a BOOT rather than a render, so it cannot gamble the visitor on one', async () => {
		const stub = await provisionedSite();
		const cold = await inObject(stub, (site) => serveDirect(site, '/'));
		expect(cold.estimateMs).toBe(COLD_ESTIMATE_MS);
		expect(cold.budgetMs).toBe(BUDGET_MS);
		// the refusal is arithmetic, not a special case: 4,000 does not fit 2,000
		expect(cold.estimateMs).toBeGreaterThan(cold.budgetMs);
	});

	it('counts the request durably and pulls the fill alarm in', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const before = site.metaGet('serve_requests', '0');
			await serveDirect(site, '/');
			return {
				before,
				after: site.metaGet('serve_requests', '0'),
				alarmAt: await site.ctx.storage.getAlarm(),
				now: Date.now()
			};
		});
		expect(out.before).toBe('0');
		expect(out.after).toBe('1');
		expect(out.alarmAt).not.toBeNull();
		// armed for the next tick, not for the 240 s keep-warm interval
		expect(Number(out.alarmAt) - out.now).toBeLessThan(1000);
	});

	it('keeps the counter across an eviction, so an edge-tier assertion can rely on it', async () => {
		const stub = await provisionedSite();
		await inObject(stub, (site) => serveDirect(site, '/'));
		await evictDurableObject(stub);
		const after = await inObject(stub, (site) => site.metaGet('serve_requests', '0'));
		expect(after).toBe('1');
	});
});

describe('inline rendering off is the free-plan shape and stays reachable', () => {
	it('returns the placeholder and leaves the work to the alarm chain', async () => {
		const stub = await provisionedSite();
		const off = await inObject(stub, (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			return serveDirect(site, '/', '&inline=0');
		});
		expect(off.status).toBe(503);
		// off rather than impossible: the interpreter is up, the operator said no
		expect(off.inline).toBe('off');
		expect(off.phpBooted).toBe('1');
		expect(off.queueDepth).toBe(1);
		expect(off.missMs).toBeLessThan(10);
	});

	it('a zero budget disables inline rendering entirely, restoring the always-placeholder shape', async () => {
		const stub = await provisionedSite();
		const off = await inObject(stub, (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			return serveDirect(site, '/', '&budget=0');
		});
		expect(off.status).toBe(503);
		expect(off.inline).toBe('off');
		expect(off.budgetMs).toBe(0);
	});

	it('never renders when the interpreter is absent, whatever the budget says', async () => {
		const stub = await provisionedSite();
		const cold = await inObject(stub, (site) => serveDirect(site, '/', '&budget=99999'));
		expect(cold.inline).toBe('cold');
		expect(cold.status).toBe(503);
	});
});

describe('the alarm chain fills what a MISS queued, unattended', () => {
	it('fills the path and turns the next request into a HIT', async () => {
		const stub = await provisionedSite();
		const calls = await inObject(stub, async (site) => {
			const recorded = stubRender(site, ({ path }) => pageFor(path));
			await serveDirect(site, '/', '&inline=0');
			return recorded;
		});
		await driveAlarms(stub, (site) => site.queueDepth() === 0);

		const out = await inObject(stub, async (site) => ({
			stats: await statsOf(site),
			hit: await serveDirect(site, '/')
		}));

		expect(out.stats.alarmFirings).toBeGreaterThan(0);
		expect(out.stats.queue).toHaveLength(0);
		expect(out.stats.cached.map((r) => r.path)).toEqual(['/']);
		expect(out.hit.status).toBe(200);
		expect(out.hit.cache).toBe('HIT');
		// the serve is what has to fit the budget; the render never did
		expect(out.hit.hitMs).toBeGreaterThanOrEqual(0);
		expect(out.hit.hitMs).toBeLessThan(10);
		expect(out.hit.body).toContain('<title>/</title>');
		// the render's own cost, carried through storage to the response
		expect(out.hit.renderMs).toBe(42);
		expect(out.hit.contentType).toBe('text/html; charset=utf-8');
		// the fill asked PHP for the path the visitor missed on, emptying `page` and NOT
		// `dynamic_page_cache`, which was 6 of the 7 rows a fill charged
		expect(calls.map((c) => c.path)).toEqual(['/']);
		expect(calls[0]?.bins).toEqual(['page']);
	});

	it('fills a BATCH per firing, which is what amortises the re-arm row', async () => {
		const stub = await provisionedSite();
		await inObject(stub, (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			for (const path of ['/a', '/b', '/c']) queuePath(site, path);
		});
		// one firing, three pages: the re-arm costs one row write for the batch rather than three
		const ran = await driveAlarms(stub, (site) => site.queueDepth() === 0, 2);
		const stats = await inObject(stub, (site) => statsOf(site));
		expect(ran).toBeLessThanOrEqual(1);
		expect(stats.cached.map((r) => r.path)).toEqual(['/a', '/b', '/c']);
		expect(stats.queue).toHaveLength(0);
	});

	it('gives each path its own row rather than serving the first one back', async () => {
		const stub = await provisionedSite();
		await inObject(stub, (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			queuePath(site, '/');
			queuePath(site, '/user/login');
		});
		await driveAlarms(stub, (site) => site.queueDepth() === 0);
		const out = await inObject(stub, async (site) => ({
			root: await serveDirect(site, '/'),
			login: await serveDirect(site, '/user/login')
		}));
		expect(out.root.cache).toBe('HIT');
		expect(out.login.cache).toBe('HIT');
		expect(out.login.body).not.toBe(out.root.body);
		expect(out.login.body).toContain('<title>/user/login</title>');
	});

	/**
	 * Both branches, because the idle interval is what decides whether the object stays resident.
	 *
	 * With `SITE_WARM` on -- the default -- an empty queue re-arms UNDER the 10 s hibernation
	 * threshold, which is the whole mechanism: the firing resets the idle clock. With it off the
	 * chain drops back to `KEEP_WARM_MS`, and a later MISS is what pulls it back in.
	 *
	 * This asserted `> 60000` unconditionally and was written before warming existed, so it failed
	 * on the shipped default reading 7,995 ms. The number was right and the assertion was old.
	 */
	async function idleRearmMs(warm: boolean): Promise<number> {
		const stub = await provisionedSite();
		await inObject(stub, (site) => {
			if (!warm) site.env.SITE_WARM = '0';
			stubRender(site, ({ path }) => pageFor(path));
			queuePath(site, '/');
		});
		await driveAlarms(stub, (site) => site.queueDepth() === 0);
		const out = await inObject(stub, async (site) => ({
			alarmAt: await site.ctx.storage.getAlarm(),
			now: Date.now()
		}));
		return Number(out.alarmAt) - out.now;
	}

	it('re-arms under the hibernation threshold once the queue is empty', async () => {
		const gap = await idleRearmMs(true);
		expect(gap).toBeGreaterThan(0);
		// under 10 s or the object hibernates and the warming buys nothing
		expect(gap).toBeLessThan(10_000);
	});

	it('drops back to the keep-warm interval when warming is off', async () => {
		expect(await idleRearmMs(false)).toBeGreaterThan(60_000);
	});
});

/**
 * A REDIRECT IS NOT A PAGE, and storing one shipped a dead end.
 *
 * `cfw_page` is `(path, status, content_type, html, rendered_at, render_ms)` -- there is no column
 * for a `Location`, and `pageResponse()` cannot set a header it has no value for. So a 3xx that
 * took the cacheable branch was written to the table, answered as a bodyless redirect pointing
 * nowhere, and then replayed as a HIT to every later visitor until the next invalidation.
 *
 * It is reachable through Drupal's own code rather than through anything exotic:
 * `AssetControllerBase::deliver()` answers 301 whenever an aggregate URL's hash does not match the
 * one it recomputes, which is every aggregate URL in the prefilled HTML.
 */
describe('cron yields to a fill backlog', () => {
	/**
	 * The quota ladder is a DAILY meter, so it cannot say whether a visitor is waiting right now: a
	 * warming site is well inside quota and still has an empty page for every path. Cron used to be
	 * gated on the ladder alone while its comment claimed it stopped "before anything a visitor can
	 * see". With the outbound-HTTPS hooks back a round is 11 units rather than 7, several entering
	 * the interpreter, and a site took several firings to warm instead of one.
	 */
	it('does not run cron while a fill batch left work behind', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			// more than one batch drains, so the loop ends with the queue still non-empty. One
			// firing that empties its own queue is NOT the case here -- cron rightly runs then
			await site.storage.put('cronLastRunMs', 0);
			for (let i = 0; i < 20; i++) await serveDirect(site, `/p${i}`, '&inline=0');
			const queuedBefore = site.queueDepth();
			await site.alarm();
			return {
				queuedBefore,
				queuedAfter: site.queueDepth(),
				ranCron: site.lastCron !== undefined
			};
		});
		expect(out.queuedBefore).toBeGreaterThan(5);
		// the premise of the assertion below: this firing did not get through the backlog
		expect(out.queuedAfter).toBeGreaterThan(0);
		expect(out.ranCron).toBe(false);
	});

	it('runs it once the queue is empty', async () => {
		const stub = await provisionedSite();
		await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			await site.storage.put('cronLastRunMs', 0);
		});
		await driveAlarms(stub, (site) => site.queueDepth() === 0);
		const ran = await inObject(stub, async (site) => {
			await site.alarm();
			return site.lastCron !== undefined;
		});
		expect(ran).toBe(true);
	});
});

describe('a redirect is answered, not stored', () => {
	it('carries the Location through and writes no cfw_page row', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, () => ({
				html: '',
				status: 301,
				contentType: 'text/html; charset=utf-8',
				location: '/sites/default/files/css/css_correct.css',
				renderMs: 3,
				bytes: 0
			}));
			const first = await serveDirect(site, '/sites/default/files/css/css_stale.css');
			return {
				first,
				// the SECOND request is the one that proves nothing was stored: a stored 301
				// answers x-cfw-cache HIT with no location at all
				second: await serveDirect(site, '/sites/default/files/css/css_stale.css'),
				rows: site.sql
					.exec('SELECT COUNT(*) AS c FROM cfw_page WHERE status >= 300 AND status < 400')
					.toArray()
					.map((r) => Number(r.c))[0],
				queued: site.sql
					.exec('SELECT COUNT(*) AS c FROM cfw_fill_queue')
					.toArray()
					.map((r) => Number(r.c))[0]
			};
		});

		expect(out.first.status).toBe(301);
		expect(out.first.location).toBe('/sites/default/files/css/css_correct.css');
		expect(out.first.cache).toBe('RENDER');

		expect(out.second.status).toBe(301);
		expect(out.second.location, 'a replayed redirect must still point somewhere').toBe(
			'/sites/default/files/css/css_correct.css'
		);
		expect(out.second.cache, 'and must not have come from the page table').toBe('RENDER');

		expect(out.rows, 'no 3xx may be stored').toBe(0);
		// refusing to store must not strand the path in the queue either
		expect(out.queued).toBe(0);
	});

	it('still stores a 200 and a 404, so the guard is a 3xx guard and not a blanket one', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => ({
				...pageFor(path),
				status: path === '/gone' ? 404 : 200
			}));
			await serveDirect(site, '/here');
			await serveDirect(site, '/gone');
			return site.sql
				.exec('SELECT path, status FROM cfw_page ORDER BY path')
				.toArray()
				.map((r) => `${r.path}:${r.status}`);
		});
		expect(out).toEqual(['/gone:404', '/here:200']);
	});
});

describe('a MISS on a warm object renders inline for the visitor', () => {
	it('returns the page rather than the placeholder, and says this invocation rendered it', async () => {
		const stub = await provisionedSite();
		const inline = await inObject(stub, (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			return serveDirect(site, '/user/password');
		});
		expect(inline.status).toBe(200);
		expect(inline.cache).toBe('RENDER');
		expect(inline.inline).toBe('1');
		expect(inline.body).toContain('<title>/user/password</title>');
		expect(inline.body).not.toContain('warming');
		// it rendered because the estimate fitted the declared budget
		expect(inline.estimateMs).toBe(FIRST_RENDER_ESTIMATE_MS);
		expect(inline.estimateMs).toBeLessThanOrEqual(inline.budgetMs);
		expect(inline.lane).toBe('php-gate');
	});

	it('refuses to believe a zero wall-clock delta, which is what the edge reports', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			// FREEZE the clock rather than relying on a synchronous render being fast enough to
			// leave it unmoved. This assertion used to pass by accident and failed under a loaded
			// full-suite run: `Date.now()` crossed a millisecond boundary, `observedMs` came back
			// 1 instead of 0, and the branch under test was simply not taken. The edge really does
			// report 0 here, so pinning it to 0 is the right way to exercise that branch
			const realNow = Date.now;
			const frozen = realNow();
			globalThis.Date.now = () => frozen;
			try {
				const first = await serveDirect(site, '/');
				return {
					first,
					lastRenderMs: site.lastRenderMs,
					unmeasurable: site.renderClockUnmeasurable,
					second: await serveDirect(site, '/other')
				};
			} finally {
				globalThis.Date.now = realNow;
			}
		});
		// a synchronous render advances no clock, so the delta is 0
		expect(out.first.renderClock).toBe('unmeasurable');
		expect(out.lastRenderMs).toBeUndefined();
		expect(out.unmeasurable).toBe(true);
		// and a 0 must not become an estimate of 0, or the budget guard always passes
		expect(out.second.estimateMs).toBe(FIRST_RENDER_ESTIMATE_MS);
	});

	it('discards a measurement from a fill that ALSO booted, because it measures the wrong thing', async () => {
		// Measured on a DEPLOYED worker: a cold alarm fill reported an estimate of 117 ms for work
		// that cost 1,398 ms of cpuTime. The wall clock only advances during I/O, so that 117 ms was
		// asset-fetch time and the synchronous boot and render contributed nothing. Non-zero, so
		// renderClockUnmeasurable did not trip, so the over-budget guard would wave a 1.4 s boot
		// through -- the exact opposite of what it exists for.
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, async ({ path }) => {
				await tick(3);
				return pageFor(path);
			});
			// fillOne directly, not serveDirect: with no interpreter the SERVE path refuses to
			// render inline at all (see the test above), so the boot-inclusive shape only happens
			// on the alarm path, which is exactly where it was measured
			site.php = null;
			const filled = await site.fillOne('/');
			return {
				filled,
				learned: site.lastRenderMs,
				bootInclusive: site.lastBootInclusiveMs,
				unmeasurable: site.renderClockUnmeasurable,
				second: await serveDirect(site, '/other')
			};
		});
		// the wall clock DID move, so this is not the zero-delta case
		expect(out.bootInclusive).toBeGreaterThan(0);
		// but it must not become the warm estimate
		expect(out.learned).toBeUndefined();
		expect(out.unmeasurable).toBe(true);
		// so the guard stays CONSERVATIVE rather than trusting a 117-ms-shaped reading. The exact
		// constant depends on whether an interpreter exists by then (4000 with none, 1800 with one);
		// what must hold either way is that it never drops to the boot-inclusive wall time
		expect(out.second.estimateMs).toBeGreaterThanOrEqual(FIRST_RENDER_ESTIMATE_MS);
		expect(out.second.estimateMs).toBeGreaterThan(out.bootInclusive as number);
	});

	it('learns from a render it COULD measure, and estimates that next time', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, async ({ path }) => {
				// a real await, so the wall clock moves and the delta is real
				await tick(3);
				return pageFor(path);
			});
			const first = await serveDirect(site, '/');
			return { first, learned: site.lastRenderMs, second: await serveDirect(site, '/other') };
		});
		expect(out.first.renderClock).toBe('ok');
		expect(out.learned).toBeGreaterThan(0);
		// the last render is the best predictor available, and it is what gets used
		expect(out.second.estimateMs).toBe(out.learned);
	});
});

describe('a render that cannot fit the budget falls back to the placeholder', () => {
	it('says the estimate exceeded the budget and still queues the path', async () => {
		const stub = await provisionedSite();
		const over = await inObject(stub, (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			return serveDirect(site, '/filter/tips', '&budget=1');
		});
		expect(over.status).toBe(503);
		expect(over.inline).toBe('over-budget');
		expect(over.budgetMs).toBe(1);
		expect(over.estimateMs).toBeGreaterThan(over.budgetMs);
		expect(over.queueDepth).toBe(1);
		expect(over.cacheControl).toBe('no-store');
	});

	it('and the alarm chain still fills what the fallback queued', async () => {
		const stub = await provisionedSite();
		await inObject(stub, (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			return serveDirect(site, '/filter/tips', '&budget=1');
		});
		await driveAlarms(stub, (site) => site.queueDepth() === 0);
		const hit = await inObject(stub, (site) => serveDirect(site, '/filter/tips'));
		expect(hit.cache).toBe('HIT');
		expect(hit.body).toContain('<title>/filter/tips</title>');
	});
});

describe('a path that can never render is retried and then dropped', () => {
	it('takes three strikes, records the error, and leaves the queue', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, () => ({ error: 'no route matched' }));
			queuePath(site, '/definitely-not-a-route');
			const attempts: FillOutcome[] = [];
			const rows: (number | undefined)[] = [];
			for (let i = 0; i < 3; i++) {
				attempts.push(await site.fillOne());
				rows.push(
					site.sql
						.exec(
							'SELECT attempts FROM cfw_fill_queue WHERE path = ?',
							'/definitely-not-a-route'
						)
						.toArray()
						.map((r) => Number(r.attempts))[0]
				);
			}
			return { attempts, rows, stats: await statsOf(site) };
		});

		expect(out.attempts.map((a) => a.failed)).toEqual([
			'/definitely-not-a-route',
			'/definitely-not-a-route',
			'/definitely-not-a-route'
		]);
		expect(out.attempts.map((a) => a.attempts)).toEqual([1, 2, 3]);
		// retried twice, then the row is gone, so one poisoned path cannot own the alarm chain
		expect(out.rows).toEqual([1, 2, undefined]);
		expect(out.attempts[2]?.remaining).toBe(0);
		expect(out.stats.queue).toHaveLength(0);
		expect(out.stats.cached).toHaveLength(0);
	});

	it('records why it failed while the path is still queued', async () => {
		const stub = await provisionedSite();
		const queued = await inObject(stub, async (site) => {
			stubRender(site, () => ({ error: 'no route matched' }));
			queuePath(site, '/nope');
			await site.fillOne();
			return (await statsOf(site)).queue;
		});
		expect(queued).toHaveLength(1);
		expect(queued[0]?.attempts).toBe(1);
		expect(String(queued[0]?.last_error)).toContain('no route matched');
	});

	it('a failed inline render falls through to the placeholder rather than 500 at the visitor', async () => {
		const stub = await provisionedSite();
		const failed = await inObject(stub, (site) => {
			stubRender(site, () => ({ error: 'boom' }));
			return serveDirect(site, '/broken');
		});
		expect(failed.status).toBe(503);
		expect(failed.inline).toBe('failed');
		// counted against its three strikes already, so the row is still there for the chain
		expect(failed.queueDepth).toBe(1);
	});

	it('an html-less reply is a failure, not an empty page', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, () => ({ status: 200, renderMs: 1 }));
			queuePath(site, '/htmlless');
			return site.fillOne();
		});
		expect(out.filled).toBeNull();
		expect(String(out.error)).toContain('render produced no html');
	});

	it('a render that THROWS is struck too, so the chain cannot re-arm forever', async () => {
		// MEASURED AS A SPIN on a deployed worker: a render that threw
		// `TypeError: target is not a function` left the queue row untouched, so `remaining`
		// stayed 1, so the re-arm picked +1 ms -- 196 firings in 14 s, every one `outcome: ok`
		// and every one a Durable Object invocation. fillOne()'s three strikes only run when the
		// render REPORTS a failure; this covers the case where it never got that far.
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, () => {
				throw new TypeError('target is not a function');
			});
			queuePath(site, '/throws');
			const rows: Array<number | undefined> = [];
			const alarms: unknown[] = [];
			for (let i = 0; i < 3; i++) {
				alarms.push(await site.alarm());
				rows.push(
					site.sql
						.exec('SELECT attempts FROM cfw_fill_queue WHERE path = ?', '/throws')
						.toArray()
						.map((r) => Number(r.attempts))[0]
				);
			}
			return { rows, alarms, nextAlarm: await site.ctx.storage.getAlarm(), now: Date.now() };
		});

		// struck on every firing, then dropped -- the same three strikes a reported failure gets
		expect(out.rows).toEqual([1, 2, undefined]);
		// and the chain has gone back to the keep-warm interval rather than +1 ms
		expect((out.nextAlarm ?? 0) - out.now).toBeGreaterThan(1000);
	});

	it('reports the throw as the outcome rather than swallowing it', async () => {
		const stub = await provisionedSite();
		const outcome = await inObject(stub, async (site) => {
			stubRender(site, () => {
				throw new TypeError('target is not a function');
			});
			queuePath(site, '/throws');
			return site.alarm();
		});
		expect(JSON.stringify(outcome)).toContain('target is not a function');
	});

	it('strikeFillHead on an empty queue is a no-op, not a throw', async () => {
		const stub = await provisionedSite();
		const struck = await inObject(stub, (site) => site.strikeFillHead('nothing queued'));
		expect(struck).toBeNull();
	});
});

describe('/__fill drives one fill synchronously', () => {
	it('reports the path it filled and what is left', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			queuePath(site, '/one');
			queuePath(site, '/two');
			const res = await site.fetch(new Request('https://do.local/__fill'));
			return (await res.json()) as FillOutcome;
		});
		expect(out.filled).toBe('/one');
		expect(out.remaining).toBe(1);
	});

	it('answers filled:null on an empty queue instead of entering the interpreter', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			const res = await site.fetch(new Request('https://do.local/__fill'));
			return { body: (await res.json()) as FillOutcome, calls };
		});
		expect(out.body.filled).toBeNull();
		expect(out.body.remaining).toBe(0);
		expect(out.calls).toHaveLength(0);
	});
});

describe('/__assemble decodes destruct as a tri-state, and re-renders rather than serving', () => {
	/** the destruct argument as it reaches `cfw_serve($path, ...)` in the emitted fragment */
	async function assembleDestruct(query: string): Promise<{
		reported: unknown;
		call: RenderCall | undefined;
	}> {
		const stub = await provisionedSite();
		return inObject(stub, async (site: ServeDo) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			const res = await site.fetch(
				new Request(`https://do.local/__assemble?path=%2F${query}`)
			);
			const body = (await res.json()) as { destruct: unknown };
			return { reported: body.destruct, call: calls[0] };
		});
	}

	it('treats absent, empty and "0" as off, which is the shipped default', async () => {
		const absent = await assembleDestruct('');
		const empty = await assembleDestruct('&destruct=');
		const zero = await assembleDestruct('&destruct=0');
		expect(absent.reported).toBe(false);
		expect(empty.reported).toBe(false);
		expect(zero.reported).toBe(false);
		expect(absent.call?.destruct).toBe('false');
	});

	it('treats "1" as the safe set', async () => {
		const on = await assembleDestruct('&destruct=1');
		expect(on.reported).toBe(true);
		expect(on.call?.destruct).toBe('true');
	});

	it('passes any other value through as an allowlist to bisect with', async () => {
		const one = await assembleDestruct('&destruct=theme.registry');
		expect(one.reported).toBe('theme.registry');
		expect(one.call?.destruct).toBe('"theme.registry"');
	});

	it('empties only the bins it was asked for, so dynamic_page_cache can answer', async () => {
		const stub = await provisionedSite();
		const calls = await inObject(stub, async (site) => {
			const recorded = stubRender(site, ({ path }) => pageFor(path));
			await site.fetch(new Request('https://do.local/__assemble?path=%2F&bins=page'));
			return recorded;
		});
		expect(calls[0]?.bins).toEqual(['page']);
	});

	it('deletes the stored row first, so it measures a render rather than a HIT', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path, 7));
			// a page that would otherwise be served straight back
			await site.fillOne('/');
			const res = await site.fetch(new Request('https://do.local/__assemble?path=%2F'));
			return { body: (await res.json()) as FillOutcome & { phpBooted: boolean }, calls };
		});
		expect(out.calls).toHaveLength(2);
		expect(out.body.filled).toBe('/');
		expect(out.body.phpBooted).toBe(true);
	});
});

describe('the fragment decoder used above is not vacuous', () => {
	// CONTROL: without this, a decoder that silently returned '' for every field would make the
	// bins and destruct assertions pass by accident
	it('reads nothing out of a fragment that carries nothing', () => {
		const empty = decodeRenderCall('<?php echo 1;');
		expect(empty.path).toBe('');
		expect(empty.bins).toEqual([]);
		expect(empty.destruct).toBe('');
		expect(empty.origin).toBe('');
	});
});

/**
 * An unclaimed site shows its owner the way in.
 *
 * The pack ships an INSTALLED database, so `install.php` never runs and uid 1 carries an empty hash
 * that no password can match. A freshly deployed site therefore looked finished, served its front
 * page, and had no way in -- and because the claim window IS the unprovisioned state, it was also
 * claimable by anyone who found the URL. The only thing that said so was a README caveat.
 */
describe('a site nobody has claimed serves a setup page', () => {
	const browser = (path: string) =>
		new Request(`https://real.example/__serve?path=${encodeURIComponent(path)}`, {
			headers: { accept: 'text/html,application/xhtml+xml' }
		});

	it('answers a navigation with the claim page rather than the front page', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			const res = await site.fetch(browser('/'));
			return {
				status: res.status,
				setup: res.headers.get('x-cfw-setup'),
				robots: res.headers.get('x-robots-tag'),
				cacheControl: res.headers.get('cache-control'),
				body: await res.text(),
				// nothing rendered, so an unclaimed site costs no interpreter either
				rendered: calls.length
			};
		});

		expect(out.status).toBe(200);
		expect(out.setup).toBe('required');
		expect(out.robots).toBe('noindex');
		expect(out.cacheControl).toBe('no-store');
		expect(out.body).toContain('Claim This Site');
		expect(out.rendered).toBe(0);
	});

	// the page is a signpost for a human; a machine client still gets the site
	it('leaves a non-HTML request on the normal path', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			const res = await site.fetch(new Request('https://real.example/__serve?path=%2F'));
			return {
				status: res.status,
				setup: res.headers.get('x-cfw-setup'),
				body: await res.text()
			};
		});

		expect(out.setup).toBeNull();
		expect(out.body).toContain('<title>/</title>');
	});

	it('stops once the site is claimed', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			const before = await site.fetch(browser('/'));
			site.metaSet('first_run_at', site.nowMs());
			const after = await site.fetch(browser('/'));
			return {
				before: before.headers.get('x-cfw-setup'),
				after: after.headers.get('x-cfw-setup'),
				body: await after.text()
			};
		});

		expect(out.before).toBe('required');
		expect(out.after).toBeNull();
		expect(out.body).toContain('<title>/</title>');
	});

	/**
	 * ORDER MATTERS. A site still replaying its migration is not an unclaimed site, and telling its
	 * owner to claim it while the database is a quarter loaded would invite exactly the wrong action.
	 */
	it('yields to the migration placeholder on a site that is still replaying', async () => {
		const res = await inObject(freshSite(), (site) => site.fetch(browser('/')));
		expect(res.status).toBe(503);
		expect(res.headers.get('x-cfw-setup')).toBeNull();
		expect(res.headers.get('x-cfw-migrate')).not.toBeNull();
	});
});

/**
 * Which host Drupal renders absolute URLs against.
 *
 * Every canonical tag, form action, `Location:` and password-reset link is built from it, and the
 * fragments hardcoded `localhost` -- so a deployed site advertised `http://localhost` to every
 * visitor and every crawler. The origin the object serves is now a property of the SITE: pinned on
 * first use and read back afterwards, never re-read from the request.
 *
 * Asserted off the emitted fragment rather than off rendered HTML, for the reason
 * `decodeRenderCall`'s docblock gives -- this lane has no interpreter, and what is being tested is
 * that the object put the right value into the PHP. `tests/integration/render-origin.spec.ts`
 * carries the other half, where a real interpreter turns it into real markup.
 */
describe('the render origin is pinned, not believed', () => {
	it('pins the first real origin it serves and hands it to the render', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await site.fetch(new Request('https://real.example/__serve?path=%2F'));
			return { calls, pinned: site.metaGet('site_origin') };
		});
		expect(out.pinned).toBe('https://real.example');
		expect(out.calls[0]?.origin).toBe('https://real.example');
	});

	/** the whole defence: after the pin, a forged Host renders against the pinned host anyway */
	it('ignores a later origin, so a forged Host cannot move a reset link', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await site.fetch(new Request('https://real.example/__serve?path=%2Fone'));
			await site.fetch(new Request('https://attacker.example/__serve?path=%2Ftwo'));
			return { calls, pinned: site.metaGet('site_origin') };
		});
		expect(out.pinned).toBe('https://real.example');
		expect(out.calls.map((c) => c.origin)).toEqual([
			'https://real.example',
			'https://real.example'
		]);
	});

	/**
	 * A LOCAL ORIGIN IS USED BUT NEVER PINNED, and the split is the point.
	 *
	 * Used, because `wrangler dev` on `localhost:8787` should render links to `localhost:8787` and
	 * not to port 80. Not pinned, because every spec in this file reaches the object over
	 * `do.local` -- so a pin would mean the first suite run against a persisted object fixed a real
	 * site's canonical URL to a developer's laptop, permanently and invisibly.
	 */
	/**
	 * WHO THE RENDER WAS FOR, which is a different question from what the request carried.
	 *
	 * Every other clause in the `cacheable` predicate reasons about the REQUEST. `uid` is Drupal's
	 * own conclusion, and the fragment computing it already said why it exists -- a render that
	 * comes back as the wrong user is not distinguishable from a correct one by its bytes. It was
	 * transported to JavaScript and read by nobody, so the failure this project actually shipped,
	 * uid 1 surviving inside the persistent interpreter with no cookie anywhere, was invisible to a
	 * guard made on the cookie.
	 */
	it('refuses to store a render that came back as somebody', async () => {
		const stub = await provisionedSite();
		const rows = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => ({ ...pageFor(path), uid: 1 }));
			await serveDirect(site, '/leaked');
			return site.sql
				.exec('SELECT COUNT(*) AS c FROM cfw_page WHERE path = ?', '/leaked')
				.toArray()[0];
		});
		expect(Number(rows?.c ?? -1)).toBe(0);
	});

	/**
	 * `page_cache_kill_switch` SAYS SO IN `Cache-Control`, and nothing read it.
	 *
	 * A module with a reason to opt one page out of caching has exactly this header to say it with.
	 * The render captured `x-drupal-cache` and `x-drupal-dynamic-cache` and neither is the refusal;
	 * the page was stored, promoted to KV, to the edge and to R2 regardless.
	 */
	it.each(['no-store', 'private, no-store', 'private'])(
		'refuses to store a render Drupal marked %s',
		async (header) => {
			const stub = await provisionedSite();
			const rows = await inObject(stub, async (site) => {
				stubRender(site, ({ path }) => ({ ...pageFor(path), cacheControl: header }));
				await serveDirect(site, '/killed');
				return site.sql
					.exec('SELECT COUNT(*) AS c FROM cfw_page WHERE path = ?', '/killed')
					.toArray()[0];
			});
			expect(Number(rows?.c ?? -1)).toBe(0);
		}
	);

	it('CONTROL: an ordinary public max-age is still stored', async () => {
		const stub = await provisionedSite();
		const rows = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => ({
				...pageFor(path),
				cacheControl: 'public, max-age=0, must-revalidate'
			}));
			await serveDirect(site, '/kept');
			return site.sql
				.exec('SELECT COUNT(*) AS c FROM cfw_page WHERE path = ?', '/kept')
				.toArray()[0];
		});
		expect(Number(rows?.c ?? -1)).toBe(1);
	});

	it('CONTROL: an anonymous render of the same path IS stored', async () => {
		const stub = await provisionedSite();
		const rows = await inObject(stub, async (site) => {
			stubRender(site, ({ path }) => ({ ...pageFor(path), uid: 0 }));
			await serveDirect(site, '/leaked');
			return site.sql
				.exec('SELECT COUNT(*) AS c FROM cfw_page WHERE path = ?', '/leaked')
				.toArray()[0];
		});
		expect(Number(rows?.c ?? -1)).toBe(1);
	});

	/**
	 * DRUPAL'S FLOOD CONTROL IDENTIFIES BY `getClientIp()`, and every render reported `127.0.0.1`.
	 *
	 * `user.flood.yml` ships `ip_limit: 50`, `ip_window: 3600`, and `UserLoginForm` checks
	 * `user.failed_login_ip` -- so with one address for the whole site, fifty bad passwords locked
	 * EVERY visitor out of `/user/login` for an hour, and per-IP throttling of contact forms and
	 * password resets did nothing. `CF-Connecting-IP` is overwritten by Cloudflare at the edge, so
	 * the object may read it directly.
	 */
	it('hands the visitor address to the render, so flood control is per-visitor', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await site.fetch(
				new Request('https://real.example/__serve?path=%2F', {
					headers: { 'cf-connecting-ip': '203.0.113.7' }
				})
			);
			return calls;
		});
		expect(out[0]?.clientIp).toBe('203.0.113.7');
	});

	/**
	 * THE ACCEPT HEADER DECIDES THE SHAPE OF EVERY AJAX RESPONSE, and it never reached Symfony.
	 *
	 * `AjaxResponseSubscriber::onResponse()` wraps the JSON in a `<textarea>` and relabels it
	 * `text/html` when `Accept` contains `text/html`, which is an IE9 iframe-upload workaround.
	 * `Request::create()` supplies its own default of `text/html,application/xhtml+xml,...` when the
	 * server bag carries none, so the wrap fired on EVERY AJAX request no matter what the browser
	 * asked for, and `ajax.js` raised `Drupal.AjaxError` on all of them. Measured in a browser on
	 * Add field, where choosing a field type is an AJAX POST: the admin got "Oops, something went
	 * wrong" and no field could be created on any site.
	 */
	it('hands the inbound Accept to the render, so an AJAX response is not wrapped for an iframe', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await site.fetch(
				new Request('https://real.example/__serve?path=%2F', {
					headers: { accept: 'application/json, text/javascript, */*; q=0.01' }
				})
			);
			return calls;
		});
		expect(out[0]?.accept).toBe('application/json, text/javascript, */*; q=0.01');
	});

	it('CONTROL: emits no address when the request carried none', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await site.fetch(new Request('https://real.example/__serve?path=%2F'));
			return calls;
		});
		expect(out[0]?.clientIp).toBe('');
	});

	it('uses a local origin without pinning it', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await serveDirect(site, '/');
			return { calls, pinned: site.metaGet('site_origin') };
		});
		expect(out.pinned, 'nothing may be written for a local host').toBeNull();
		expect(out.calls[0]?.origin).toBe('https://do.local');
	});

	// the alarm chain fills most pages and has no request to read an origin from; without the
	// default in fillOne() the same page carried a different host depending on which lane made it
	it('gives the alarm chain the same origin as an inline render', async () => {
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			const calls = stubRender(site, ({ path }) => pageFor(path));
			await site.fetch(new Request('https://real.example/__serve?path=%2Finline'));
			queuePath(site, '/by-alarm');
			await site.alarm();
			return calls.map((c) => `${c.path}=${c.origin}`);
		});
		expect(out).toContain('/inline=https://real.example');
		expect(out).toContain('/by-alarm=https://real.example');
	});
});

// #region TEMPORARY assertion counter
import { afterAll as __afterAll, afterEach as __afterEach } from 'vitest';
let __asserts = 0;
__afterEach(() => {
	__asserts += expect.getState().assertionCalls ?? 0;
});
__afterAll(() => {
	console.log(`ASSERTIONS tests/integration/serve-chain.spec.ts ${__asserts}`);
});
// #endregion

describe('a heap restore in flight is not a strike against the queued page', () => {
	it('leaves the attempt count alone while the restore chain drives itself', async () => {
		// `ensurePhp()` throws HeapRestoreIncomplete on the boot that applied the first chunk, and
		// alarm()'s restore branch owns every firing after that. Charging the page for the object's
		// own boot would drop a perfectly good path after three cold starts.
		const stub = await provisionedSite();
		const out = await inObject(stub, async (site) => {
			stubRender(site, () => {
				throw new HeapRestoreIncomplete({
					snapshotId: 1,
					nextChunk: 1,
					totalChunks: 41,
					bytesWritten: 200_000,
					firings: 1
				});
			});
			queuePath(site, '/restoring');
			const outcome = await site.alarm();
			return {
				outcome,
				attempts: site.sql
					.exec('SELECT attempts FROM cfw_fill_queue WHERE path = ?', '/restoring')
					.toArray()
					.map((r) => Number(r.attempts))[0]
			};
		});
		expect(out.attempts).toBe(0);
		expect(JSON.stringify(out.outcome)).toContain('restorePending');
	});
});

/**
 * A SUBMISSION IS NEVER ANSWERED FROM `cfw_page`.
 *
 * Found by the e2e mail lane on 2026-08-21, not by any unit test. The cache read ran before the
 * method was considered, so a POST to a path with a stored page got the stored ANONYMOUS GET back
 * with a 200 and Drupal never ran: no validation, no mail, no content, and a success-looking
 * response. `/user/password` ships in `prefill.json`, so it is pre-cached on every site from its
 * first boot -- every password reset was swallowed.
 *
 * Confirmed live before the fix (`x-cfw-cache: HIT` on the POST) and after (`x-cfw-cache: RENDER`,
 * `x-cfw-method: POST`, 303).
 */
describe('the page cache and non-GET methods', () => {
	it('serves a GET from the cache', async () => {
		const site = freshSite();
		const res = await inObject(site, async (obj) => {
			markProvisioned(obj);
			obj.metaSet('first_run_at', String(Date.now()));
			seedPage(obj, '/user/password', '<html><body>the empty form</body></html>');
			const url = new URL('https://site.example/__serve?path=/user/password');
			return obj.handle(new Request(url), url);
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('x-cfw-cache')).toBe('HIT');
	});

	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
		it(`never answers a ${method} from the cache, even when the path is cached`, async () => {
			const site = freshSite();
			const res = await inObject(site, async (obj) => {
				markProvisioned(obj);
				obj.metaSet('first_run_at', String(Date.now()));
				seedPage(obj, '/user/password', '<html><body>the empty form</body></html>');
				const url = new URL('https://site.example/__serve?path=/user/password');
				return obj.handle(new Request(url, { method }), url);
			});
			expect(
				res.headers.get('x-cfw-cache'),
				`${method} was answered from the page cache`
			).not.toBe('HIT');
			expect(await res.text()).not.toContain('the empty form');
		});
	}
});
