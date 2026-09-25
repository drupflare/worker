import { afterEach, describe, expect, it } from 'vitest';
import {
	driveAlarms,
	freshSite,
	inObject,
	markProvisioned,
	pageFor,
	statsOf,
	stubRender
} from '../helpers/serve-do';

/**
 * Ported from the `the deferred HTTP queue drains unattended` region of
 * `scripts/test-serve-chain.mjs`.
 *
 * PHP cannot await, so `cfwQueueFetch` records a request and returns immediately; the actual
 * `fetch()` has to happen in JS between PHP runs, and `alarm()` is the only unattended thing that
 * runs between them. Before that existed the only drain was the manual `/httpdrain` route, which
 * meant nothing drained on a real site.
 *
 * What changed from the original:
 *
 *   - **The queue is filled through `queueHttp()` rather than through `/capability`.** The
 *     original asked PHP's capability check to reach a URL, which queued an unpredictable number
 *     of entries -- the check itself calls the fetch capability -- so it could only assert
 *     "the depth went down". Here the queue contents are known, so the drain is asserted exactly.
 *   - **Outbound `fetch` is stubbed, and that keeps the gate hermetic.** The original really did
 *     reach `https://example.com/`; a gate test must not open a socket. `@cloudflare/vitest-pool-workers`
 *     0.21 exports no `fetchMock`, so the global is replaced for the duration of each test -- the
 *     pool runs the worker in the same isolate as the spec, so the object sees the replacement.
 *   - **The three-strike drop, the per-invocation limit, the switch and the quiet-alarm case are
 *     new.** All four are branches of `drainHttpQueue()` and `alarm()` that no HTTP client could
 *     reach.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/**
 * Replaces outbound fetch for this test; the object shares the isolate, so it sees this.
 *
 * The returned recorder filters by host, and that is not tidiness. An object queued in an earlier
 * test arms an alarm at +1 ms, and the runtime fires it whenever it likes -- including in the
 * middle of a later test -- so a global-fetch spy really does see another object's drain. Each
 * test therefore uses a host of its own and asserts only on that.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
	const calls: string[] = [];
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		calls.push(url);
		return handler(url, init);
	}) as typeof fetch;
	return (host: string) => calls.filter((url) => url.includes(host));
}

describe('the deferred queue is durable and its depth is reported', () => {
	it('reports null before the tables exist, so an absence is not read as an invariant', async () => {
		const stub = freshSite();
		const stats = await inObject(stub, (site) => statsOf(site));
		// an unmigrated site has no cfw_http_queue at all; reporting 0 would look verified
		expect(stats.httpQueue).toBeNull();
		expect(stats.lastHttpDrain).toBeNull();
	});

	it('reports a number once something has been queued', async () => {
		const stub = freshSite();
		const stats = await inObject(stub, async (site) => {
			// the drain switched off, because this asserts the COUNTER: an alarm draining it
			// underneath would also leave a live queue behind for the next test to trip over
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			site.queueHttp('https://count.test/one');
			site.queueHttp('https://count.test/two');
			return statsOf(site);
		});
		expect(stats.httpQueue).toBe(2);
	});

	it('de-duplicates by url, because a repeated deferral is the same request', async () => {
		const stub = freshSite();
		const stats = await inObject(stub, async (site) => {
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			site.queueHttp('https://count.test/same');
			site.queueHttp('https://count.test/same');
			return statsOf(site);
		});
		expect(stats.httpQueue).toBe(1);
	});

	it('arms the chain when it queues, or nothing drains on an idle site', async () => {
		const stub = freshSite();
		stubFetch(async () => new Response('ok'));
		const out = await inObject(stub, async (site) => {
			site.queueHttp('https://armed.test/one');
			const armed = { alarmAt: await site.ctx.storage.getAlarm(), now: Date.now() };
			// drained here rather than left for the runtime, so no alarm outlives this test
			await site.drainHttpQueue(5);
			return armed;
		});
		// draining in alarm() alone is half a fix: on an idle site the alarm re-arms 240 s out, so a
		// queued request waited up to four minutes
		expect(out.alarmAt).not.toBeNull();
		expect(Number(out.alarmAt) - out.now).toBeLessThan(1000);
	});
});

describe('an alarm drains the queue unattended', () => {
	it('fetches what PHP deferred, caches the reply and records the drain', async () => {
		const stub = freshSite();
		const calls = stubFetch(async () => new Response('hello', { status: 200 }));
		await inObject(stub, (site) => site.queueHttp('https://drain.test/drained'));
		await driveAlarms(stub, (site) => site.countOrNull('cfw_http_queue') === 0);

		const out = await inObject(stub, async (site) => ({
			stats: await statsOf(site),
			cached: site.httpCacheGet('https://drain.test/drained')
		}));

		expect(calls('drain.test')).toEqual(['https://drain.test/drained']);
		expect(out.stats.httpQueue).toBe(0);
		// auditable rather than silent: what was fetched, and what it cost
		expect(out.stats.lastHttpDrain?.drained).toHaveLength(1);
		expect(out.stats.lastHttpDrain?.drained?.[0]).toMatchObject({
			url: 'https://drain.test/drained',
			status: 200,
			bytes: 5
		});
		// and the reply is where PHP will look for it on its next run
		expect(out.cached?.status).toBe(200);
		expect(out.cached?.body).toBe('hello');
	});

	it('records nothing on a quiet alarm, because an empty array is truthy', async () => {
		const stub = freshSite();
		stubFetch(async () => new Response('unused'));
		const stats = await inObject(stub, async (site) => {
			// the tables exist and the queue is empty, which is the steady state
			site.ensureHttpTables();
			await site.alarm();
			return statsOf(site);
		});
		expect(stats.httpQueue).toBe(0);
		// the obvious `if (drained.drained)` guard records on every firing forever
		expect(stats.lastHttpDrain).toBeNull();
	});

	it('does not drain when the switch is off, so a depth assertion is stable', async () => {
		const stub = freshSite();
		const calls = stubFetch(async () => new Response('nope'));
		const stats = await inObject(stub, async (site) => {
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			site.queueHttp('https://switch.test/off');
			await site.alarm();
			return statsOf(site);
		});
		expect(calls('switch.test')).toHaveLength(0);
		expect(stats.httpQueue).toBe(1);
		expect(stats.lastHttpDrain).toBeNull();
	});
});

describe('the drain is bounded, because each fetch is one of 50 subrequests', () => {
	it('takes only the limit it was given, oldest first', async () => {
		const stub = freshSite();
		const calls = stubFetch(async () => new Response('ok'));
		const out = await inObject(stub, async (site) => {
			// the drain is called directly here, so the alarm is switched off: an alarm left armed
			// over a queue this test does not empty fires after the test has finished
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			for (const n of [1, 2, 3, 4, 5]) site.queueHttp(`https://limit.test/${n}`);
			const drained = await site.drainHttpQueue(2);
			return { drained, stats: await statsOf(site) };
		});
		expect(calls('limit.test')).toEqual(['https://limit.test/1', 'https://limit.test/2']);
		expect(out.drained.drained).toHaveLength(2);
		expect(out.drained.remaining).toBe(3);
		expect(out.stats.httpQueue).toBe(3);
	});

	it('never takes more than 25 however large the limit is', async () => {
		const stub = freshSite();
		const calls = stubFetch(async () => new Response('ok'));
		await inObject(stub, async (site) => {
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			for (let n = 0; n < 30; n++) site.queueHttp(`https://cap.test/${n}`);
			return site.drainHttpQueue(1000);
		});
		expect(calls('cap.test')).toHaveLength(25);
	});
});

describe('a url that cannot be fetched is retried and then dropped', () => {
	it('counts three attempts, records the error, and gives up', async () => {
		const stub = freshSite();
		stubFetch(async () => {
			throw new Error('connection refused');
		});
		const out = await inObject(stub, async (site) => {
			site.queueHttp('https://broken.test/one');
			const first = await site.drainHttpQueue(1);
			const second = await site.drainHttpQueue(1);
			const third = await site.drainHttpQueue(1);
			return { first, second, third, stats: await statsOf(site) };
		});
		expect(out.first.drained[0]).toMatchObject({ attempts: 1 });
		expect(String(out.first.drained[0]?.error)).toContain('connection refused');
		expect(out.second.drained[0]).toMatchObject({ attempts: 2 });
		// dropped rather than retried forever, exactly as the fill queue does
		expect(out.third.drained[0]).toMatchObject({ dropped: true });
		expect(out.third.remaining).toBe(0);
		expect(out.stats.httpQueue).toBe(0);
	});
});

describe('the SSRF guard, through the real capability', () => {
	it('refuses a metadata address PHP asks for, and queues nothing', async () => {
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			// the table exists, so a 0 below means "refused" rather than "never created"
			site.ensureHttpTables();
			site.queueHttp('http://169.254.169.254/latest/meta-data/');
			site.queueHttp('http://localhost:8080/admin');
			// the normalised IPv4-mapped form, which is what `new URL()` turns the dotted one into
			site.queueHttp('https://[::ffff:a9fe:a9fe]/');
			return {
				stats: await statsOf(site),
				refusal: (site as unknown as { lastOutboundRefusal?: { reason: string } })
					.lastOutboundRefusal
			};
		});

		// nothing reached the queue, so nothing can reach the drain
		expect(out.stats.httpQueue).toBe(0);
		expect(out.refusal?.reason).toBeTruthy();
	});

	it('still queues an ordinary public url', async () => {
		const stats = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			site.queueHttp('https://updates.drupal.org/release-history/drupal/11.x');
			return statsOf(site);
		});
		expect(stats.httpQueue).toBe(1);
	});

	it('refuses at the DRAIN as well, for a row that did not come through queueHttp', async () => {
		// the check next to the `fetch()` is the one that matters; a row can reach the table by
		// another path, and a guard only at the queue would not see it
		const calls = stubFetch(
			async () => new Response('should never be reached', { status: 200 })
		);
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			site.ensureHttpTables();
			site.sql.exec(
				`INSERT INTO cfw_http_queue (key, url, method, body, headers, queued_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				'seeded',
				'http://169.254.169.254/latest/meta-data/',
				'GET',
				'',
				'{}',
				Date.now()
			);
			const drained = await site.drainHttpQueue(5);
			return { drained, stats: await statsOf(site) };
		});

		expect(calls('169.254.169.254')).toEqual([]);
		expect(out.stats.httpQueue).toBe(0);
		expect(String(out.drained.drained?.[0]?.refused ?? '')).not.toBe('');
	});
});

describe('the re-drive record says a re-drive HAPPENED, not what one looks like', () => {
	/**
	 * Every re-drive of the same path produces identical counts, so without `seq` a reader polling
	 * `/serve-stats` cannot tell a second occurrence from the first record still sitting there.
	 * Measured on a deployed worker before this field existed: four consecutive re-driven renders
	 * of `/admin/reports/status` reported one, because the harness compared the records.
	 */
	it('advances seq on every re-drive, so a repeat is distinguishable from a leftover', async () => {
		const stub = freshSite();
		stubFetch(async () => new Response('landed', { status: 200 }));
		const seen = await inObject(stub, async (site) => {
			markProvisioned(site);
			// the stub stands in for `cfwFetch` reporting a cache miss, which is the only thing
			// that arms the re-drive; the real one increments this from inside the render
			stubRender(site, (call) => {
				site.deferredInRender = 1;
				return pageFor(call.path);
			});
			const out: unknown[] = [];
			for (const path of ['/redrive-a', '/redrive-b']) {
				site.queueHttp(`https://redrive.test${path}`);
				await site.fillOne(path);
				out.push(site.lastRedrive);
			}
			return out as { path: string; seq: number; at: number }[];
		});

		expect(seen[0]?.seq).toBe(1);
		expect(seen[1]?.seq).toBe(2);
		expect(seen[1]?.at).toBeGreaterThanOrEqual(seen[0]?.at as number);
		// the counts alone are what could not tell the two apart
		expect(seen[0]?.path).toBe('/redrive-a');
		expect(seen[1]?.path).toBe('/redrive-b');
	});
});

describe('what a re-drive costs, against the same fill without one', () => {
	/**
	 * A re-drive happens only when `cfwFetch` defers, which the park makes rare: a Guzzle request
	 * parks, and only an `fopen('https://...')` through the stream wrapper still defers. What one
	 * costs is a second render, the drain it waits on and the rows that drain writes; the render's
	 * CPU is a warm render's, priced from deployed `cpuTime` in the report.
	 */
	it('is one extra render, one outbound fetch, and the rows the drain writes', async () => {
		const stub = freshSite();
		const fetched = stubFetch(async () => new Response('landed', { status: 200 }));
		const out = await inObject(stub, async (site) => {
			markProvisioned(site);
			const rows = () => (site as unknown as { dailyRows(): number }).dailyRows();
			let defer = false;
			const calls = stubRender(site, (call) => {
				if (defer) {
					site.deferredInRender = 1;
					defer = false;
				}
				return pageFor(call.path);
			});
			const r0 = rows();
			const c0 = calls.length;
			await site.fillOne('/plain');
			const plain = { rows: rows() - r0, renders: calls.length - c0 };

			// the tables exist on any site that has queued once, so they are not charged here
			site.ensureHttpTables();
			const r1 = rows();
			const c1 = calls.length;
			const f1 = fetched('redrive.test').length;
			// the queue row the deferring render writes is part of what the re-drive costs
			site.queueHttp('https://redrive.test/x');
			defer = true;
			await site.fillOne('/redriven');
			// the daily counters the spend report reads, and they survive a flush
			(site as unknown as { flushMeters(): void }).flushMeters();
			const stored = (
				site as unknown as { storedMeters(): { renders: number; fetches: number } }
			).storedMeters();
			return {
				counted: { renders: stored.renders, fetches: stored.fetches },
				plain,
				redrive: {
					rows: rows() - r1,
					renders: calls.length - c1,
					fetches: fetched('redrive.test').length - f1
				},
				seq: site.lastRedrive?.seq
			};
		});
		console.log(`[redrive-cost] ${JSON.stringify(out)}`);

		expect(out.seq).toBe(1);
		expect(out.plain.renders).toBe(1);
		expect(out.redrive.renders).toBe(2);
		expect(out.redrive.fetches).toBe(1);
		expect(out.redrive.rows).toBeGreaterThan(out.plain.rows);
		expect(out.counted).toEqual({ renders: 3, fetches: 1 });
	});
});

// #region TEMPORARY assertion counter
import { afterAll as __afterAll, afterEach as __afterEach } from 'vitest';
let __asserts = 0;
__afterEach(() => {
	__asserts += expect.getState().assertionCalls ?? 0;
});
__afterAll(() => {
	console.log(`ASSERTIONS tests/integration/http-queue.spec.ts ${__asserts}`);
});
// #endregion
