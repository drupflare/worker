import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { affinityKey, chooseTarget, replicaName } from '../../src/ops/replica-routing';
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

/** a path whose affinity hashes to a replica lane, so the case is not a coin flip */
function pathOnALane(lanes: number): string {
	for (let i = 0; i < 200; i++) {
		const path = `/lane-probe-${i}`;
		const decision = chooseTarget({
			site: SITE,
			method: 'GET',
			affinity: affinityKey({ session: null, address: null, pathname: '/serve' }),
			replicas: lanes,
			pathname: '/serve'
		});
		// `serveThroughWorker` sends no cookie and no client address, so the affinity is the
		// WORKER's pathname -- `/serve` -- not the Drupal path being asked for
		if (decision.role === 'replica') return path;
		break;
	}
	return '/lane-probe-0';
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
			expect(pathOnALane(0)).toBe('/lane-probe-0');
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
