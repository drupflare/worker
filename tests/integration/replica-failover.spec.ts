import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplicaRequiresPrimary } from '../../src/ops/replica';
import {
	affinityKey,
	chooseTarget,
	REPLICA_HEADER,
	replicaName,
	shouldFailover
} from '../../src/ops/replica-routing';
import {
	inObject,
	namedSite,
	pageFor,
	provisionedNamedSite,
	seedPage,
	serveThroughWorker,
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
			// the lane refuses and the primary answers, but the header names the object the request
			// was SENT to -- which is the fact a measurement needs and had no way to read
			expect(viaLane.header(REPLICA_HEADER)).toBe(
				`r${laneFor(path, 3).lane}`.replace('r0', 'primary')
			);
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
			replicaGuard: { didMutate: () => boolean } | null;
		};
		// a lane that rendered has a guard installed; `replicaHandoff()` reads `didMutate()` off it
		// and fails CLOSED when there is none, which is right and is not the case under test
		inner.replicaGuard = { didMutate: () => false };
		inner.route = async () => {
			inner.replicaRefusals.push(
				new ReplicaRequiresPrimary('cfwSqlExec', 'a write on the exec bridge')
			);
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
