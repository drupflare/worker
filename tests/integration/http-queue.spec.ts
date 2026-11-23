import { afterEach, describe, expect, it } from 'vitest';
import { alarmDelayMs } from '../../src/do/levers';
import { OUTBOX_POLICIES, openOutbox } from '../../src/ops/outbox';
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
		expect(Number(out.alarmAt) - out.now).toBeLessThan(alarmDelayMs() + 1000);
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

	it('refuses a redirect from an allowed host to a blocked one, and never fetches it', async () => {
		const calls = stubFetch(async (url) =>
			url.includes('redirector.test')
				? new Response(null, {
						status: 302,
						headers: { location: 'http://169.254.169.254/latest/meta-data/' }
					})
				: new Response('should never be reached', { status: 200 })
		);
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			site.ensureHttpTables();
			site.sql.exec(
				`INSERT INTO cfw_http_queue (key, url, method, body, headers, queued_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				'redirected',
				'https://redirector.test/hop',
				'GET',
				'',
				'{}',
				Date.now()
			);
			return await site.drainHttpQueue(5);
		});

		expect(calls('redirector.test')).toHaveLength(1);
		expect(calls('169.254.169.254')).toEqual([]);
		expect(String(out.drained?.[0]?.error ?? '')).toMatch(/redirect to .* refused/);
	});

	it('follows a redirect between allowed hosts when the guard is on', async () => {
		const calls = stubFetch(async (url) =>
			url.includes('first-hop.test')
				? new Response(null, {
						status: 301,
						headers: { location: 'https://second-hop.test/x' }
					})
				: new Response('arrived', { status: 200 })
		);
		const out = await inObject(freshSite(), async (site) => {
			site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
			site.ensureHttpTables();
			site.sql.exec(
				`INSERT INTO cfw_http_queue (key, url, method, body, headers, queued_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				'followed',
				'https://first-hop.test/a',
				'GET',
				'',
				'{}',
				Date.now()
			);
			return await site.drainHttpQueue(5);
		});

		expect(calls('first-hop.test')).toHaveLength(1);
		expect(calls('second-hop.test')).toHaveLength(1);
		expect(out.drained?.[0]?.status).toBe(200);
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

describe('each queued request runs through the http outbox', () => {
	type Seen = { url: string; method?: string; headers: Record<string, string> };

	/** records what reached the network, with the headers, per host */
	function recordFetch(handler: (n: number) => Response | Promise<Response>) {
		const seen: Seen[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
			seen.push({
				url,
				method: init?.method,
				headers: Object.fromEntries(new Headers(init?.headers).entries())
			});
			return handler(seen.length);
		}) as typeof fetch;
		return (host: string) => seen.filter((s) => s.url.includes(host));
	}

	const rowsOf = (
		site: { sql: { exec: (q: string) => { toArray(): unknown[] } } },
		table: string
	) => site.sql.exec(`SELECT * FROM ${table}`).toArray();
	const quiet = (site: { env: Record<string, unknown> }) => {
		site.env = { ...site.env, HTTP_DRAIN_ON_ALARM: '0' };
	};

	/** what a predecessor left: a claimed outbox row whose lease ended, and its queue row */
	function seedLost(site: any, kind: string, url: string, method: string, body: string) {
		site.ensureHttpTables();
		site.sql.exec(
			`INSERT INTO cfw_http_queue (key, url, method, body, headers, queued_at) VALUES (?, ?, ?, ?, '{}', ?)`,
			`k-${kind}`,
			url,
			method,
			body,
			12345
		);
		const id = `http-k-${kind}-12345`;
		const outbox = openOutbox(site.sql, 'http', () => {});
		outbox.table.enqueue(
			id,
			kind,
			JSON.stringify({
				key: `k-${kind}`,
				url,
				method,
				body,
				headers: {},
				queuedAt: 12345
			}),
			kind
		);
		outbox.table.claim(Date.now() - 60_000, 15_000, 1, { policies: OUTBOX_POLICIES });
		return { id, outbox };
	}

	it('sends an unsafe method with Idempotency-Key set to the outbox key, and a GET without one', async () => {
		const stub = freshSite();
		const seen = recordFetch(() => new Response('ok', { status: 200 }));
		const out = await inObject(stub, async (site) => {
			quiet(site);
			site.queueHttp('https://idem.test/post', 'POST', 'a=1');
			site.queueHttp('https://idem.test/get');
			const queued = Object.fromEntries(
				site.sql
					.exec('SELECT url, key, queued_at FROM cfw_http_queue')
					.toArray()
					.map((r) => [r.url, `http-${r.key}-${r.queued_at}`])
			);
			await site.drainHttpQueue(5);
			return {
				queued,
				outbox: rowsOf(site, 'cfw_outbox_http'),
				queue: rowsOf(site, 'cfw_http_queue')
			};
		});
		const [post, get] = [seen('idem.test/post')[0]!, seen('idem.test/get')[0]!];
		expect(post.headers['idempotency-key']).toBe(out.queued['https://idem.test/post']);
		expect(get.headers['idempotency-key']).toBeUndefined();
		// settled: nothing is left in the outbox or the queue
		expect(out.outbox).toEqual([]);
		expect(out.queue).toEqual([]);
	});

	it('ends a client error as permanent: the answer is cached and the request is not asked again', async () => {
		const stub = freshSite();
		const seen = recordFetch(() => new Response('gone', { status: 404 }));
		const out = await inObject(stub, async (site) => {
			quiet(site);
			site.queueHttp('https://perm.test/missing');
			const first = await site.drainHttpQueue(5);
			const second = await site.drainHttpQueue(5);
			return {
				first,
				second,
				cached: site.httpCacheGet('https://perm.test/missing'),
				outbox: rowsOf(site, 'cfw_outbox_http')
			};
		});
		expect(seen('perm.test')).toHaveLength(1);
		expect(out.first.drained[0]).toMatchObject({ status: 404 });
		expect(out.cached).toMatchObject({ status: 404, body: 'gone' });
		expect(out.second.drained).toEqual([]);
		expect(out.outbox).toEqual([]);
	});

	it.each([[408], [429], [503]])(
		'asks again after a %i while the budget lasts, and caches the last answer',
		async (status) => {
			const stub = freshSite();
			const seen = recordFetch(() => new Response('later', { status }));
			const out = await inObject(stub, async (site) => {
				quiet(site);
				site.queueHttp(`https://transient.test/${status}`);
				const rounds = [];
				for (let n = 0; n < 3; n++) rounds.push(await site.drainHttpQueue(1));
				return {
					rounds,
					cached: site.httpCacheGet(`https://transient.test/${status}`),
					queue: rowsOf(site, 'cfw_http_queue')
				};
			});
			// a GET has a budget of three, and the third answer is the one PHP reads
			expect(seen('transient.test')).toHaveLength(3);
			expect(out.rounds[0]!.drained[0]).toMatchObject({ attempts: 1 });
			expect(String(out.rounds[0]!.drained[0]!.error)).toContain(`HTTP ${status}`);
			expect(out.rounds[1]!.drained[0]).toMatchObject({ attempts: 2 });
			expect(out.rounds[2]!.drained[0]).toMatchObject({ status });
			expect(out.cached?.status).toBe(status);
			expect(out.queue).toEqual([]);
		}
	);

	it('gives a POST one attempt: its 503 is cached at once, never sent again', async () => {
		const stub = freshSite();
		const seen = recordFetch(() => new Response('busy', { status: 503 }));
		const out = await inObject(stub, async (site) => {
			quiet(site);
			site.queueHttp('https://post503.test/x', 'POST', 'a=1');
			const first = await site.drainHttpQueue(1);
			const second = await site.drainHttpQueue(1);
			return { first, second };
		});
		expect(seen('post503.test')).toHaveLength(1);
		expect(out.first.drained[0]).toMatchObject({ status: 503 });
		expect(out.second.drained).toEqual([]);
	});

	it('replays a resend row a reset left running, under the same key', async () => {
		const stub = freshSite();
		const seen = recordFetch(() => new Response('ok', { status: 200 }));
		const out = await inObject(stub, async (site) => {
			quiet(site);
			const { id, outbox } = seedLost(site, 'http', 'https://replay.test/p', 'POST', 'a=1');
			expect(outbox.results()[0]).toMatchObject({ state: 'running', attempt: 1 });
			const drained = await site.drainHttpQueue(5);
			return {
				id,
				drained,
				outbox: rowsOf(site, 'cfw_outbox_http'),
				queue: rowsOf(site, 'cfw_http_queue')
			};
		});
		// the predecessor's send may have landed, so the replay carries the key the far end can drop
		expect(seen('replay.test')).toHaveLength(1);
		expect(seen('replay.test')[0]!.headers['idempotency-key']).toBe(out.id);
		expect(out.drained.drained[0]).toMatchObject({ status: 200 });
		expect(out.outbox).toEqual([]);
		expect(out.queue).toEqual([]);
	});

	it('never sends a Redis command a reset may have run: the caller reads an error, the operator a report', async () => {
		const stub = freshSite();
		const seen = recordFetch(() => new Response('unused'));
		const out = await inObject(stub, async (site) => {
			quiet(site);
			site.env = { ...site.env, OUTBOUND_GUARD: '0', REDIS_URL: 'redis://redis.test:6379/0' };
			const { id } = seedLost(
				site,
				'redis',
				'tcp+redis://redis.test:6379/',
				'POST',
				JSON.stringify(['INCR', 'visits'])
			);
			const first = await site.drainHttpQueue(5);
			const second = await site.drainHttpQueue(5);
			return {
				id,
				first,
				second,
				cached: site.sql
					.exec("SELECT status, body FROM cfw_http_cache WHERE key = 'k-redis'")
					.toArray(),
				reported: ((await statsOf(site)) as unknown as { outboxReported: unknown[] })
					.outboxReported,
				row: site.sql.exec('SELECT state, error FROM cfw_outbox_http').toArray()
			};
		});
		expect(seen('redis.test')).toHaveLength(0);
		expect(out.first.drained[0]).toMatchObject({ reported: true });
		expect(String(out.first.drained[0]!.error)).toContain(
			'check the receiver before re-enqueueing'
		);
		expect(out.cached).toHaveLength(1);
		expect(out.cached[0]).toMatchObject({ status: 503 });
		expect(String(out.cached[0]!.body)).toContain('delivery uncertain');
		// the second drain finds nothing new to say
		expect(out.second.drained).toEqual([]);
		expect(out.row).toHaveLength(1);
		expect(out.row[0]).toMatchObject({ state: 'failed' });
		expect(String(out.row[0]!.error)).toContain('policy report');
		expect(out.reported).toEqual([
			expect.objectContaining({
				lane: 'http',
				id: out.id,
				kind: 'redis',
				hint: expect.stringContaining('check the receiver before re-enqueueing')
			})
		]);
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
