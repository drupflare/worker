import { describe, expect, it } from 'vitest';
import { replicaName } from '../../src/ops/replica-routing';
import { freshSite, inObject, namedSite, type ServeDo } from '../helpers/serve-do';

/**
 * The half of routing a pure function cannot decide: whether an object knows what it is.
 *
 * `REPLICA_READ_ONLY` is deployment-wide, so a pool would make the primary read-only too. The role
 * has to come from the object itself, and the only thing that already carries it is the id the
 * router used to address it -- which is also the one thing no request can change.
 */

const TIMEOUT = 900_000;

function role(site: ServeDo, as: 'primary' | 'replica' | 'unset'): void {
	(site.env as Record<string, unknown>).REPLICA_READ_ONLY = as === 'replica' ? '1' : '0';
}

describe('an object reads its role off its own name', () => {
	it(
		'is a replica because it is named as one, with the var off',
		async () => {
			const out = await inObject(namedSite(replicaName('routing.example', 2)), (site) => {
				role(site, 'unset');
				return { replica: site.isReplica(), name: site.ctx.id.name };
			});
			expect(out.name).toBe('routing.example#r2');
			expect(out.replica).toBe(true);
		},
		TIMEOUT
	);

	it(
		'is a primary under the plain site name, with the var off',
		async () => {
			const out = await inObject(namedSite('routing.example'), (site) => {
				role(site, 'unset');
				return site.isReplica();
			});
			expect(out).toBe(false);
		},
		TIMEOUT
	);

	it(
		'still honours the var, so a single object can be put in replica mode by hand',
		async () => {
			// OR rather than a precedence order: a misconfiguration lands on read-only rather than
			// off it
			const out = await inObject(namedSite('routing.byvar'), (site) => {
				role(site, 'replica');
				return { replica: site.isReplica(), lane: site.isPoolLane() };
			});
			expect(out.replica).toBe(true);
			// and it is NOT a pool lane. Nothing drives its stage, so applying the readiness check
			// to it would refuse every request it ever gets and make the generation fence unreachable
			expect(out.lane).toBe(false);
		},
		TIMEOUT
	);

	it(
		'is a primary when it has no name at all',
		async () => {
			// `newUniqueId()` objects report no name; reading undefined as "replica" would make every
			// unnamed object read-only
			const out = await inObject(freshSite(), (site) => {
				role(site, 'unset');
				return { name: site.ctx.id.name ?? null, replica: site.isReplica() };
			});
			expect(out.name).toBeNull();
			expect(out.replica).toBe(false);
		},
		TIMEOUT
	);
});

describe('a replica that is not SERVING hands the request back', () => {
	it(
		'answers 421 with a safe retry rather than serving from a stage nobody checked',
		async () => {
			const res = await inObject(
				namedSite(replicaName('routing.notready', 1)),
				async (site) => {
					role(site, 'unset');
					const answer = await site.fetch(new Request('https://do.local/__serve?path=/'));
					return {
						status: answer.status,
						primary: answer.headers.get('x-cfw-requires-primary'),
						retry: answer.headers.get('x-cfw-retry-safe'),
						tier: answer.headers.get('x-cfw-cache'),
						stage: site.replicaStage()
					};
				}
			);

			expect(res.stage).toBe('CREATED');
			expect(res.status).toBe(421);
			expect(res.primary).not.toBeNull();
			// nothing ran, so `didMutate()` is false and the caller may retry on the primary. This is
			// what lets the router route without knowing whether a lane is ready
			expect(res.retry).toBe('1');
			expect(res.tier).toBe('REFUSED');
		},
		TIMEOUT
	);

	it(
		'serves once the stage reaches SERVING',
		async () => {
			const res = await inObject(namedSite(replicaName('routing.ready', 1)), async (site) => {
				role(site, 'unset');
				for (const to of ['RESTORING', 'VERIFIED', 'CATCHING_UP', 'ELIGIBLE', 'SERVING']) {
					site.setReplicaStage(to as never);
				}
				const answer = await site.fetch(new Request('https://do.local/__serve?path=/'));
				return { status: answer.status, stage: site.replicaStage() };
			});

			expect(res.stage).toBe('SERVING');
			// not the handoff any more; whatever the object answers for an unprovisioned site is
			// fine, the assertion is that the stage guard stopped refusing
			expect(res.status).not.toBe(421);
		},
		TIMEOUT
	);
});
