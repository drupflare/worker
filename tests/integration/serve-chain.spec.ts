import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { HeapRestoreIncomplete } from '../../src/site-do';
import {
	type FillOutcome,
	type RenderCall,
	type ServeDo,
	decodeRenderCall,
	driveAlarms,
	inObject,
	pageFor,
	provisionedSite,
	queuePath,
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
		// the fill asked PHP for the path the visitor missed on, with both bins emptied
		expect(calls.map((c) => c.path)).toEqual(['/']);
		expect(calls[0]?.bins).toEqual(['page', 'dynamic_page_cache']);
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

	it('drops back to the keep-warm interval once the queue is empty', async () => {
		const stub = await provisionedSite();
		await inObject(stub, (site) => {
			stubRender(site, ({ path }) => pageFor(path));
			queuePath(site, '/');
		});
		await driveAlarms(stub, (site) => site.queueDepth() === 0);
		const out = await inObject(stub, async (site) => ({
			alarmAt: await site.ctx.storage.getAlarm(),
			now: Date.now()
		}));
		// 240 s, and a later MISS is what pulls it back in; see the /__serve comment
		expect(Number(out.alarmAt) - out.now).toBeGreaterThan(60000);
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
