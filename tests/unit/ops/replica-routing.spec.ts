import { describe, expect, it } from 'vitest';
import {
	chooseTarget,
	replicaCount,
	replicaName,
	replicaOf,
	shouldFailover
} from '../../../src/ops/replica-routing';
import { encodeSiteId } from '../../../src/ops/site-id';

/**
 * The rule that picks an object, tested without a pool.
 *
 * The properties worth pinning are the ones a deployed test would not catch quickly: that a name
 * cannot collide with a site id, that a visitor stays on one lane, and that a refusal is retried only
 * when the replica itself said the retry is safe.
 */

const SITE = 'example.com';

function get(affinity: string, replicas: number) {
	return chooseTarget({ site: SITE, method: 'GET', affinity, replicas, pathname: '/serve' });
}

describe('a replica name cannot be a site name', () => {
	it('round-trips', () => {
		expect(replicaOf(replicaName(SITE, 3))).toEqual({ site: SITE, lane: 3 });
	});

	it('is unreachable by any hostname encoding', () => {
		// `#` is outside the set encodeSiteId keeps and outside its `_<hex>` escape, so no host can
		// be spelled into a replica's name
		for (const host of ['a#r1.example.com', 'ex#r1', '#r1', 'a-b#r2.co.uk']) {
			expect(encodeSiteId(host)).not.toContain('#');
		}
	});

	it('refuses a name that is not a replica', () => {
		expect(replicaOf(SITE)).toBeNull();
		// lane 0 is the primary and is never addressed by a replica name
		expect(replicaOf(`${SITE}#r0`)).toBeNull();
		expect(replicaOf('#r1')).toBeNull();
		expect(replicaOf(`${SITE}#rx`)).toBeNull();
	});
});

describe('how many lanes there are', () => {
	it('is 0 unless configured, whatever the value looks like', () => {
		expect(replicaCount()).toBe(0);
		expect(replicaCount({ REPLICA_COUNT: '' })).toBe(0);
		expect(replicaCount({ REPLICA_COUNT: 'lots' })).toBe(0);
		expect(replicaCount({ REPLICA_COUNT: '-4' })).toBe(0);
		expect(replicaCount({ REPLICA_COUNT: '0' })).toBe(0);
	});

	it('reads a number and clamps it', () => {
		expect(replicaCount({ REPLICA_COUNT: '3' })).toBe(3);
		expect(replicaCount({ REPLICA_COUNT: '4096' })).toBe(32);
	});
});

describe('which lane answers', () => {
	it('sends everything to the primary when no replicas are configured', () => {
		for (const affinity of ['a', 'b', 'c', 'd', 'e']) {
			const out = get(affinity, 0);
			expect(out.role).toBe('primary');
			expect(out.target).toBe(SITE);
			expect(out.lane).toBe(0);
		}
	});

	it('sends a write to the primary without asking a replica first', () => {
		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'post']) {
			const out = chooseTarget({
				site: SITE,
				method,
				affinity: 'x',
				replicas: 4,
				pathname: '/serve'
			});
			expect(out.role).toBe('primary');
			expect(out.reason).toContain('without asking');
		}
	});

	/**
	 * The routing rule read the METHOD and never the PATH, so every diagnostic and owner GET was
	 * spread across the pool. `/export` answered from a lane's copy and `GET /migrate` re-ran
	 * migration on an object that is not the site.
	 */
	it('pins every route but the serving path to the primary', () => {
		const spread = new Set<string>();
		for (let i = 0; i < 200; i++) spread.add(get(`visitor-${i}`, 4).target);
		expect(spread.size).toBeGreaterThan(1);

		for (const pathname of [
			'/export',
			'/migrate',
			'/sql',
			'/restore',
			'/replica',
			'/heap',
			'/firstrun',
			'/serve-stats',
			'/health'
		]) {
			for (let i = 0; i < 40; i++) {
				const out = chooseTarget({
					site: SITE,
					method: 'GET',
					affinity: `visitor-${i}`,
					replicas: 4,
					pathname
				});
				expect(out.role).toBe('primary');
				expect(out.target).toBe(SITE);
				expect(out.lane).toBe(0);
			}
		}
	});

	it('pins a request carrying no pathname at all', () => {
		// an absent path is an unknown route, and an unknown route resolves toward the primary the way
		// every other unknown in this subsystem does
		const out = chooseTarget({ site: SITE, method: 'GET', affinity: 'x', replicas: 4 });
		expect(out.role).toBe('primary');
	});

	/**
	 * With forwarding off a POST pins to the primary, which left the forwarding path with no workload
	 * -- the only writes reaching a lane were the ones incidental to a GET.
	 */
	it('spreads a write once the lane may forward it', () => {
		const seen = new Set<number>();
		for (let i = 0; i < 200; i++) {
			const out = chooseTarget({
				site: SITE,
				method: 'POST',
				affinity: `visitor-${i}`,
				replicas: 4,
				pathname: '/serve',
				writeForward: true
			});
			seen.add(out.lane);
		}
		expect(seen.size).toBeGreaterThan(1);
	});

	it('still pins a forwarded write that is not on the serving path', () => {
		const out = chooseTarget({
			site: SITE,
			method: 'POST',
			affinity: 'x',
			replicas: 4,
			pathname: '/restore',
			writeForward: true
		});
		expect(out.role).toBe('primary');
		expect(out.reason).toContain('not the serving path');
	});

	it('keeps one visitor on one lane', () => {
		// a visitor moving between lanes pays a cold render on each and warms none; a shared-counter
		// round robin is what produced a completely flat scaling curve on the rig
		const first = get('SESS-abc', 4);
		for (let i = 0; i < 50; i++) expect(get('SESS-abc', 4).target).toBe(first.target);
	});

	it('uses every lane including the primary', () => {
		const seen = new Set<number>();
		for (let i = 0; i < 400; i++) seen.add(get(`visitor-${i}`, 3).lane);
		// the primary is lane 0 rather than a lane apart: excluding it would idle the object that
		// already holds every warm cache while replicas boot cold
		expect([...seen].sort()).toEqual([0, 1, 2, 3]);
	});

	it('names a replica lane as a replica', () => {
		const replica = Array.from({ length: 200 }, (_, i) => get(`v${i}`, 3)).find(
			(d) => d.role === 'replica'
		);
		expect(replica).toBeDefined();
		expect(replicaOf(replica!.target)).toEqual({ site: SITE, lane: replica!.lane });
	});
});

describe('when a refusal may be retried on the primary', () => {
	const res = (status: number, headers: Record<string, string>) => ({
		status,
		headers: { get: (n: string) => headers[n] ?? null }
	});

	it('retries a refusal the replica computed as safe', () => {
		expect(
			shouldFailover(res(421, { 'x-cfw-requires-primary': '1', 'x-cfw-retry-safe': '1' }))
		).toBe(true);
	});

	it('does NOT retry when the replica did not say the retry is safe', () => {
		// the header is computed from `didMutate()`; a retry after a partial mutation double-applies
		// it, so safety is never inferred from the status alone
		expect(shouldFailover(res(421, { 'x-cfw-requires-primary': '1' }))).toBe(false);
		expect(
			shouldFailover(res(421, { 'x-cfw-requires-primary': '1', 'x-cfw-retry-safe': '0' }))
		).toBe(false);
	});

	it('ignores anything that is not the handoff', () => {
		expect(shouldFailover(res(500, { 'x-cfw-retry-safe': '1' }))).toBe(false);
		expect(shouldFailover(res(421, { 'x-cfw-retry-safe': '1' }))).toBe(false);
		expect(shouldFailover(res(200, {}))).toBe(false);
	});
});
