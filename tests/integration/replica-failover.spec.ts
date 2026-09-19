import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { drupalSessionRowId, ReplicaRequiresPrimary } from '../../src/ops/replica';
import {
	affinityKey,
	believedLanes,
	chooseTarget,
	REPLICA_HEADER,
	replicaName,
	resetLaneBeliefs,
	shouldFailover
} from '../../src/ops/replica-routing';
import { primeLanes, writeLanes } from '../../src/site';
import {
	asBrowser,
	inObject,
	markProvisioned,
	namedSite,
	pageFor,
	provisionedNamedSite,
	seedPage,
	serveThroughWorker,
	SESSION_COOKIE,
	stubRender,
	type ServeDo
} from '../helpers/serve-do';

/**
 * The front worker's half of routing, which no pure test reaches.
 *
 * `chooseTarget()` is decided without a pool and `isPoolLane()` is decided without a worker. What
 * neither covers is the wiring between them: that a request really is sent to a lane, that a lane's
 * refusal really is retried on the primary, and that a visitor cannot tell the difference. That
 * retry is the whole safety property of routing to objects whose readiness nobody tracks.
 */

const TIMEOUT = 900_000;
const SITE = 'failover.example';
const HTML = '<html><body>from the primary</body></html>';

function setLanes(count: number): void {
	(env as unknown as Record<string, unknown>).REPLICA_COUNT = String(count);
}

afterEach(() => {
	// `env` is module scope and shared by every spec in the lane; a leaked lane count would route
	// another file's requests at objects it never created
	setLanes(0);
});

/**
 * A path whose affinity hashes to a replica lane, so the case is not a coin flip.
 *
 * THIS USED TO RETURN ON THE FIRST ITERATION WHATEVER THE ANSWER WAS, because the affinity it
 * computed was the front worker's own `/serve` for every candidate -- a constant, so the loop had
 * nothing to search. That was the defect rather than a quirk of the helper: `affinityKey()`'s path
 * fallback saw `/serve` in production too, so every request carrying no session and no
 * `cf-connecting-ip` piled onto whichever single lane that one string hashes to.
 */
function pathOnALane(lanes: number): string {
	for (let i = 0; i < 200; i++) {
		const path = `/lane-probe-${i}`;
		const decision = laneFor(path, lanes);
		if (decision.role === 'replica') return path;
	}
	throw new Error(`no path out of 200 hashed to a lane at ${lanes} lanes`);
}

/** the routing decision the front worker makes for a visitor path, with no session and no address */
function laneFor(path: string, lanes: number) {
	return chooseTarget({
		site: SITE,
		method: 'GET',
		affinity: affinityKey({ session: null, address: null, pathname: path }),
		replicas: lanes,
		pathname: '/serve'
	});
}

describe('a lane that cannot serve is invisible to the visitor', () => {
	it(
		'answers from the primary when the affinity chose a lane that is not ready',
		async () => {
			await provisionedNamedSite(SITE);
			await inObject(namedSite(SITE), (site: ServeDo) => {
				seedPage(site, '/routed', HTML);
			});

			setLanes(3);
			const decision = chooseTarget({
				site: SITE,
				method: 'GET',
				affinity: affinityKey({ session: null, address: null, pathname: '/serve' }),
				replicas: 3,
				pathname: '/serve'
			});
			// the control: this case is only meaningful if the affinity actually picked a lane
			expect(decision.role, 'the affinity did not choose a replica lane').toBe('replica');

			const out = await serveThroughWorker(SITE, '/routed');
			// the lane is CREATED, refuses with 421 and a safe retry, and the worker goes to the
			// primary -- so the visitor gets the page rather than a status they cannot act on
			expect(out.status).toBe(200);
			expect(out.body).toContain('from the primary');
			expect(out.status).not.toBe(421);

			// and the lane really was addressed: it exists and is still where it started
			const stage = await inObject(namedSite(decision.target), (lane: ServeDo) =>
				lane.replicaStage()
			);
			expect(stage).toBe('CREATED');
		},
		TIMEOUT
	);

	it(
		'is byte-identical to the no-replica answer',
		async () => {
			await provisionedNamedSite(SITE);
			await inObject(namedSite(SITE), (site: ServeDo) => {
				seedPage(site, '/same', HTML);
			});

			// THE LANE PATH GOES FIRST. Fetched second it can be answered by
			// `caches.default` from the first call and never reach a stub at all -- which passed
			// with failover disabled and made this case look like it tested something
			setLanes(3);
			const viaLane = await serveThroughWorker(SITE, '/same');
			setLanes(0);
			const direct = await serveThroughWorker(SITE, '/same');

			expect(viaLane.status).toBe(200);
			expect(viaLane.body).toBe(direct.body);
		},
		TIMEOUT
	);

	it(
		'never addresses a lane for a write the lane could not forward',
		async () => {
			// with forwarding off there is nothing a lane can do with a write except hand it back, so
			// it goes to the primary without spending a hop to be refused
			const decision = chooseTarget({
				site: SITE,
				method: 'POST',
				affinity: affinityKey({ session: null, address: null, pathname: '/serve' }),
				replicas: 3,
				pathname: '/serve',
				writeForward: false
			});
			expect(decision.target).toBe(SITE);
			expect(decision.role).toBe('primary');
		},
		TIMEOUT
	);
});

describe('what the lane count does and does not change', () => {
	it(
		'addresses only the primary at 0, which is the default',
		async () => {
			for (const affinity of ['a', 'b', 'c']) {
				const decision = chooseTarget({ site: SITE, method: 'GET', affinity, replicas: 0 });
				expect(decision.target).toBe(SITE);
			}
			// the name a lane WOULD have, so a reader can see the two are different objects
			expect(replicaName(SITE, 1)).toBe(`${SITE}#r1`);
			// and no path can reach a lane at all, which is what the helper searching 200 of them
			// and finding none says
			expect(() => pathOnALane(0)).toThrow(/no path/);
		},
		TIMEOUT
	);

	it(
		'seeds and serves without an interpreter, so this file measures routing only',
		async () => {
			await provisionedNamedSite(SITE);
			await inObject(namedSite(SITE), (site: ServeDo) => {
				seedPage(site, '/norender', pageFor('/norender').html ?? HTML);
			});
			setLanes(2);
			const out = await serveThroughWorker(SITE, '/norender');
			expect(out.status).toBe(200);
		},
		TIMEOUT
	);
});

/**
 * What the front worker does with a WRITE once a lane may take one.
 *
 * These three could not fail before, because nothing ever routed to a lane: `action=provision`
 * copied a lane and left `lanes_provisioned` unwritten, that key is the only thing that puts
 * `x-cfw-lanes` on a response, and `REPLICA_COUNT` is unset in the canonical config. So the router
 * never learned a pool existed and every arm labelled `3 lanes` was the single-object arm.
 */
describe('a write that reaches a lane', () => {
	it(
		'reports which object answered, so a reading about lanes can be believed',
		async () => {
			await provisionedNamedSite(SITE);
			await inObject(namedSite(SITE), (site: ServeDo) => {
				seedPage(site, '/reported', HTML);
			});

			setLanes(0);
			const direct = await serveThroughWorker(SITE, '/reported');
			expect(direct.header(REPLICA_HEADER)).toBe('primary');

			setLanes(3);
			const path = pathOnALane(3);
			await inObject(namedSite(SITE), (site: ServeDo) => {
				seedPage(site, path, HTML);
			});
			const viaLane = await serveThroughWorker(SITE, path);
			// THE HEADER USED TO NAME THE OBJECT THE REQUEST WAS SENT TO, and this case pinned that
			// on the reasoning that a measurement had no other way to read the routing decision. It
			// made the header say a lane served traffic it had refused: a deployed 32-lane pool
			// reported every authenticated request against a lane while the primary answered all of
			// them. Both facts are readable now, so both are asserted.
			expect(viaLane.header(REPLICA_HEADER)).toBe('primary');
			expect(viaLane.header('x-cfw-failover')).toBe(`r${laneFor(path, 3).lane}`);
		},
		TIMEOUT
	);

	it(
		'retries a POST on the primary instead of hanging on a teed body',
		async () => {
			await provisionedNamedSite(SITE);
			setLanes(3);
			const path = pathOnALane(3);
			expect(laneFor(path, 3).role, 'the control: this path must choose a lane').toBe(
				'replica'
			);

			// A CLONE WOULD NEVER RETURN. `retryOnPrimary` was `innerRequest.clone()` under a comment
			// asserting only GET and HEAD could arrive; write forwarding made that false, and an
			// unread tee branch does not release -- a login POST hung past 240 s on the first rig
			// where traffic actually met a lane. Bounded here so a regression is a failure rather
			// than a suite that never finishes
			const res = await Promise.race([
				SELF.fetch(
					`https://cfw.local/serve?site=${SITE}&path=${encodeURIComponent(path)}`,
					{
						method: 'POST',
						body: new URLSearchParams({ probe: 'write' }),
						headers: { 'content-type': 'application/x-www-form-urlencoded' }
					}
				),
				new Promise<'timed out'>((resolve) =>
					setTimeout(() => resolve('timed out'), 60_000)
				)
			]);
			expect(res, 'the POST never returned; the body was teed and never read').not.toBe(
				'timed out'
			);
			// and it did not come back as the lane's own refusal
			expect((res as Response).status).not.toBe(421);
		},
		TIMEOUT
	);
});

/**
 * A refusal PHP CAUGHT, which used to reach the visitor as a 500.
 *
 * `fetch()`'s catch turns `ReplicaRequiresPrimary` into a 421 the router retries, but only when the
 * throw unwinds all the way out. Drupal catches a failed session write and raises its own
 * `RuntimeException: Failed to start the session.`, so the guard's signal never reached the catch:
 * `/user` answered 500 from a lane on roughly one authenticated request in ten during a host
 * comparison, and `replicaRefusals` -- the field that records exactly "this request needed the
 * primary" -- was read by three call sites, all of them stats.
 *
 * ATTRIBUTION, stated because the rate is low: the 500 was observed and the missing consumer was
 * read off the source, but the intermittent did not reproduce on demand (0 in 40 with the handoff
 * and 0 in 40 without), so these assert the MECHANISM rather than the rate.
 */
describe('a refusal the interpreter swallowed', () => {
	const refusalFrom = (site: ServeDo, status: number) => {
		// patched on the instance so the wrapper under test is the real one; a request that records
		// a refusal and then answers an error is the shape Drupal produces and no fixture can
		const inner = site as unknown as {
			route: (r: Request) => Promise<Response>;
			replicaRefusals: unknown[];
			replicaRefusalsTotal: number;
			replicaGuard: { didMutate: () => boolean } | null;
		};
		// a lane that rendered has a guard installed; `replicaHandoff()` reads `didMutate()` off it
		// and fails CLOSED when there is none, which is right and is not the case under test
		inner.replicaGuard = { didMutate: () => false };
		inner.route = async () => {
			// RECORDED THE WAY THE REAL BRIDGE RECORDS IT: push, bump the monotonic total, and cap
			// the ring at 20. The first version of this fixture pushed only, so it could not have
			// produced the saturation defect below however many times it ran
			inner.replicaRefusals.push(
				new ReplicaRequiresPrimary('cfwSqlExec', 'a write on the exec bridge')
			);
			inner.replicaRefusalsTotal += 1;
			if (inner.replicaRefusals.length > 20) inner.replicaRefusals.shift();
			return new Response('failed to start the session', { status });
		};
	};

	it(
		'hands off to the primary instead of answering the error',
		async () => {
			const lane = namedSite(replicaName(SITE, 1));
			const out = await inObject(lane, async (site: ServeDo) => {
				refusalFrom(site, 500);
				const res = await site.fetch(
					new Request('https://do.local/__serve?path=/swallowed')
				);
				return {
					status: res.status,
					requiresPrimary: res.headers.get('x-cfw-requires-primary'),
					retrySafe: res.headers.get('x-cfw-retry-safe')
				};
			});
			expect(out.status).toBe(421);
			expect(out.requiresPrimary).toBe('cfwSqlExec');
			// and the router only retries when the lane says so; see `shouldFailover()`
			expect(out.retrySafe).toBe('1');
			expect(
				shouldFailover({
					status: out.status,
					headers: {
						get: (n: string) =>
							n === 'x-cfw-requires-primary' ? out.requiresPrimary : out.retrySafe
					}
				})
			).toBe(true);
		},
		TIMEOUT
	);

	/**
	 * THE 21ST REFUSAL, and the reason the rate never reproduced.
	 *
	 * `replicaRefusals` is a ring capped at 20 by a `shift()` and is never cleared, so its `length`
	 * saturates. The wrapper compared `length > refusalsBefore`, which becomes `20 > 20` for the
	 * rest of the incarnation: the handoff worked for exactly the first 20 refusals an object ever
	 * saw and every refusal after that reached the visitor as a 500 -- permanently, and invisibly
	 * to any run short enough to stay under the cap. Both attempts to reproduce the intermittent
	 * drove 40 requests, and 429 of one 600-request arm never reached a Durable Object at all
	 * because a compiled plan answered them in the front worker's isolate.
	 *
	 * Asserted at 25 rather than 21 so the case keeps failing if the cap is raised a little.
	 */
	it(
		'keeps handing off past the refusal ring cap',
		async () => {
			const lane = namedSite(replicaName(SITE, 3));
			const out = await inObject(lane, async (site: ServeDo) => {
				refusalFrom(site, 500);
				const statuses: number[] = [];
				for (let i = 0; i < 25; i++) {
					const res = await site.fetch(
						new Request(`https://do.local/__serve?path=/swallowed-${i}`)
					);
					statuses.push(res.status);
				}
				return statuses;
			});
			// every one, not most: a 500 here is the refusal reaching the visitor
			expect(out.filter((s) => s === 421)).toHaveLength(25);
			expect(out.filter((s) => s >= 500)).toEqual([]);
		},
		TIMEOUT
	);

	it(
		'leaves an ordinary error alone when no refusal was recorded',
		async () => {
			const lane = namedSite(replicaName(SITE, 2));
			const out = await inObject(lane, async (site: ServeDo) => {
				const inner = site as unknown as { route: (r: Request) => Promise<Response> };
				inner.route = async () => new Response('a real fault', { status: 500 });
				const res = await site.fetch(new Request('https://do.local/__serve?path=/genuine'));
				return res.status;
			});
			// the control: a 500 is not turned into a retry just for being a 500
			expect(out).toBe(500);
		},
		TIMEOUT
	);

	it(
		'leaves a non-error answer alone even when a refusal was recorded',
		async () => {
			const lane = namedSite(replicaName(SITE, 3));
			const out = await inObject(lane, async (site: ServeDo) => {
				refusalFrom(site, 200);
				const res = await site.fetch(new Request('https://do.local/__serve?path=/served'));
				return res.status;
			});
			// a request that refused something and still answered has nothing to hand off
			expect(out).toBe(200);
		},
		TIMEOUT
	);
});

/**
 * The session a lane has not received yet.
 *
 * A session row is authoritative: it is written on the primary and reaches a lane by replication.
 * A lane asked for a page before that arrives finds no row, renders uid 0, and Drupal answers 403 on
 * anything needing a permission -- so the visitor is logged out for one request instead of the
 * request being served. Measured on a deployed 16-lane pool: 41 of 240 immediately after
 * provisioning and ~1 in 43 once settled, `x-cfw-roles: anonymous` from the lane while the primary
 * resolved the same cookie in the same second. It does not converge; five warmup rounds over ~100 s
 * still refused.
 */
describe('a lane that cannot see the session hands back', () => {
	/**
	 * OWED: the refusal case itself, against a genuinely SERVING lane.
	 *
	 * `metaSet('replica_stage', 'SERVING')` puts a lane in a state the real flow never produces --
	 * it answered 200 with no tier header at all, and non-deterministically 421 on a rerun -- so the
	 * case built that way tested the shortcut rather than the handoff. A real lane needs the
	 * provisioning fixture (`installed()` -> `provision()` -> `driveAlarms()` to SERVING) that lives
	 * in `replica-provision.spec.ts`; lifting those helpers into `tests/helpers/serve-do.ts` is the
	 * piece of work this is waiting on.
	 *
	 * The fix is not unverified in the meantime: it was falsified on a DEPLOYED 4-lane pool, signing
	 * in after provisioning so no lane held the session. Fix on, 48 of 48 served
	 * `administrator,authenticated`; fix off, 1 replica 403 anonymous and 2 with no role set at all.
	 * The two controls below still run here and pin the halves that do not need a real lane.
	 */
	it(
		'serves normally once the lane can see the session',
		async () => {
			const lane = namedSite(replicaName(SITE, 5));
			const status = await inObject(lane, async (site: ServeDo) => {
				markProvisioned(site);
				site.metaSet('replica_stage', 'SERVING');
				stubRender(site, (call) => ({
					...pageFor(call.path),
					roles: ['administrator', 'authenticated']
				}));
				const res = await site.fetch(
					new Request(
						'https://do.local/__serve?path=/has-session',
						asBrowser(SESSION_COOKIE)
					)
				);
				return res.status;
			});
			// the control that makes the case above mean something: the refusal is about the ROLE
			// SET, not about a lane refusing every authenticated request
			expect(status).toBe(200);
		},
		TIMEOUT
	);

	it(
		'leaves an anonymous visitor alone, who has no session to be missing',
		async () => {
			const lane = namedSite(replicaName(SITE, 6));
			const status = await inObject(lane, async (site: ServeDo) => {
				markProvisioned(site);
				site.metaSet('replica_stage', 'SERVING');
				stubRender(site, (call) => ({ ...pageFor(call.path), roles: ['anonymous'] }));
				const res = await site.fetch(
					new Request('https://do.local/__serve?path=/public', asBrowser())
				);
				return res.status;
			});
			// the second control: anonymous roles are CORRECT for a request carrying no cookie, so
			// keying on the role set alone would refuse the bulk of a site's traffic
			expect(status).toBe(200);
		},
		TIMEOUT
	);
});

/**
 * The pool a cold isolate cannot see.
 *
 * `believedLanes()` is per-isolate and is learned from `x-cfw-lanes` on a response the isolate has
 * ALREADY received, so its first request goes to the primary whatever the pool size, and the
 * knowledge expires after `LANES_TRUST_MS`. Workers spawn isolates continuously; after a deploy none
 * of them has seen the pool at all. Measured on a deployed 32-lane site before the edge pointer
 * existed: the primary's own `serveRequests` counter moved by 904 across a 904-request drive, so the
 * pool served none of it, and an anonymous drive reported `answeredBy` as `{primary: 904}`. That is
 * why adding lanes did not add throughput -- the lanes were never asked.
 */
describe('a lane count survives the isolate that learned it', () => {
	it(
		'routes to the pool from a belief this isolate never learned itself',
		async () => {
			const origin = 'https://pointer.example';
			await writeLanes(caches.default, origin, SITE, 3);

			// where every fresh isolate starts, and where EVERY isolate is after a deploy
			resetLaneBeliefs();
			setLanes(0);
			expect(believedLanes(SITE, Date.now())).toBe(0);

			await primeLanes(caches.default, origin, SITE);
			expect(believedLanes(SITE, Date.now()), 'the pool is still invisible').toBe(3);

			// and the belief is what routing reads, so a visitor path now reaches a lane
			const decision = chooseTarget({
				site: SITE,
				method: 'GET',
				affinity: affinityKey({
					session: null,
					address: null,
					pathname: pathOnALane(3)
				}),
				replicas: Math.max(0, believedLanes(SITE, Date.now())),
				pathname: '/serve'
			});
			expect(decision.role).toBe('replica');
		},
		TIMEOUT
	);

	it(
		'leaves a site with no pointer routing to the primary',
		async () => {
			// the control: priming is a read, not an invention
			resetLaneBeliefs();
			setLanes(0);
			await primeLanes(caches.default, 'https://pointer.example', 'never-published.example');
			expect(believedLanes('never-published.example', Date.now())).toBe(0);
		},
		TIMEOUT
	);
});

/**
 * The window between a login and the lane that has to serve it.
 *
 * Replication is alarm-driven, so a session written on the primary reaches a lane on ITS next
 * firing. Measured on a deployed 32-lane pool: immediately after a login `head` was 735 and every
 * lane read `repl_applied` 733, converging over **20-62 s**. A drive with a fresh cookie read 100%
 * failover; the same drive with a replicated one read 22 requests served across 4 lane objects. So
 * signing in pinned the next minute of a visitor's traffic to the primary.
 *
 * `sessionReach()` asks BEFORE the render, so a miss costs one indexed read rather than a render
 * thrown away, and chases one catch-up so the window is a round rather than an alarm interval.
 */
describe('a lane chases a session it has not received', () => {
	const VALUE = 'a9f3c1d2e4b5a6978c0d1e2f3a4b5c6d';
	const COOKIE = (value: string) => `SESS${'0123456789abcdef'.repeat(2)}=${value}`;

	function withSessions(site: ServeDo, rows: string[]): void {
		site.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, uid INTEGER)`);
		for (const sid of rows) {
			site.sql.exec(`INSERT OR REPLACE INTO sessions (sid, uid) VALUES (?, 1)`, sid);
		}
	}

	/**
	 * SCOPE: the predicate the serve path branches on, not the branch.
	 *
	 * The same fixture limit the OWED note above records applies here -- a lane built by
	 * `metaSet('replica_stage', 'SERVING')` answers `/__serve` with no tier header at all, so a case
	 * written through it would assert a 200 that never reached the render path. The refusal ITSELF
	 * was falsified on the deployed 32-lane pool instead: a cookie the lane held answered 200
	 * `administrator,authenticated`, and one it did not answered 421 `x-cfw-requires-primary:
	 * session`, with `x-cfw-failover` naming the lane.
	 */
	it(
		'reads held, absent and unknown, and chases the primary exactly once before giving up',
		async () => {
			const held = await drupalSessionRowId(VALUE);
			const out = await inObject(namedSite(replicaName(SITE, 7)), async (site: ServeDo) => {
				markProvisioned(site);
				site.metaSet('replica_stage', 'SERVING');
				const before = await site.sessionReach(COOKIE(VALUE));

				withSessions(site, [held]);
				const mine = await site.sessionReach(COOKIE(VALUE));
				const other = await site.sessionReach(COOKIE('deadbeefdeadbeefdeadbeefdeadbeef'));
				// a second miss inside the rate-limit window must not buy another hop
				const again = await site.sessionReach(COOKIE('feedfacefeedfacefeedfacefeedface'));
				return {
					before,
					mine,
					other,
					again,
					isLane: site.isPoolLane(),
					tally: site.sessionCatchUps ?? { tried: 0, found: 0 }
				};
			});

			// THE GOLDEN VECTOR, and without it this case cannot fail. Every other assertion here
			// stores the row under the same function it later looks it up with, so a broken hash
			// moves both sides together and the case stays green -- measured, by returning the
			// cookie value unhashed. This pair came off a DEPLOYED site: Drupal wrote the row and
			// the cookie is what the browser held, so it is an external oracle rather than a
			// restatement of the implementation
			expect(await drupalSessionRowId('78e094846386248b8a5685a8a2dd4568')).toBe(
				'TIkEn6fkVm-NaFDE5eDlIfIXxgfFJXI2XRRnMxjurwI'
			);
			// the control: this object really is a lane, or none of the rest is about lanes
			expect(out.isLane).toBe(true);
			// no `sessions` table yet is NOT evidence the visitor has no session; refusing on it
			// would hand back every authenticated request on a half-built lane
			expect(out.before).toBe('unknown');
			// THE HASH IS DRUPAL'S. `SessionHandler::read()` looks the row up by
			// `Crypt::hashBase64($sid)`, so a lane can answer this without rendering anything --
			// and if this ever drifts the lane silently resolves nobody
			expect(out.mine).toBe('held');
			expect(out.other).toBe('absent');
			expect(out.again).toBe('absent');
			// it chased ONCE for the first miss and the rate limit absorbed the second, which is
			// what stops an attacker-supplied cookie buying a hop to the primary per request
			expect(out.tally.tried).toBe(1);
			expect(out.tally.found).toBe(0);
		},
		TIMEOUT
	);
});
