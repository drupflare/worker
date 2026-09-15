import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listSites } from '../../src/ops/fleet';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/**
 * The fleet inventory, written by the object rather than by a caller holding a stand-in.
 *
 * `tests/unit/ops/fleet.spec.ts` owns the pure half -- `shouldReport()`, `warmTargets()`,
 * `fleetSummary()` -- and it passed for the whole time `env.FLEET_DB` was undefined in this lane.
 * That is the gap this file exists for: the pool creates no D1 database unless
 * `vitest.config.ts` names one, so `reportToFleet()` returned at its first line on every spec that
 * ever reached an alarm, and the wiring had a production caller with no lane able to observe one.
 *
 * Same shape as the OIDC callback that answered 404 with 25 assertions covering the exchange: a
 * test that drives the PRODUCER proves nothing about whether the CONSUMER is reachable.
 */

const REQUEST_TIMEOUT = 900_000;

/** the binding the object writes through, which the test reads back directly */
const fleetDb = () => env.FLEET_DB as unknown as Parameters<typeof listSites>[0];

describe('the fleet inventory, written through the real binding', () => {
	it(
		'writes one row, and writes nothing the second time because nothing moved',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				markProvisioned(site, 'fleet-wire-gen');

				await site.reportToFleet();
				const first = await listSites(fleetDb());

				// the predicate is the entire write budget: an unchanged identity inside the
				// heartbeat must cost no row at all
				await site.reportToFleet();
				const second = await listSites(fleetDb());

				return {
					first,
					second,
					error: (site as unknown as { lastFleetError?: string }).lastFleetError ?? null
				};
			});

			// the write reached D1 rather than being swallowed by the catch
			expect(out.error).toBeNull();
			expect(out.first.length).toBeGreaterThanOrEqual(1);
			const row = out.first.find((r) => r.packGeneration === 'fleet-wire-gen');
			expect(row).toBeDefined();
			expect(row?.coreVersion).toMatch(/^\d+\.\d+/);
			expect(row?.plan).toBe('free');

			// the second call may not add a row and must not change the one that is there
			expect(out.second.length).toBe(out.first.length);
			expect(out.second.find((r) => r.site === row?.site)?.lastSeenMs).toBe(row?.lastSeenMs);
		},
		REQUEST_TIMEOUT
	);

	it(
		'reports a failed inventory write on /serve-stats rather than silencing it',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				markProvisioned(site, 'fleet-wire-broken');
				// a binding that throws is what a revoked D1 database or an exhausted quota looks
				// like from inside the object; the alarm must survive it AND must say so
				const broken = {
					prepare: () => ({
						bind: () => ({
							run: () => Promise.reject(new Error('d1 is unreachable')),
							all: () => Promise.reject(new Error('d1 is unreachable'))
						})
					})
				};
				const held = (site.env as Record<string, unknown>)['FLEET_DB'];
				(site.env as Record<string, unknown>)['FLEET_DB'] = broken;
				let threw = false;
				try {
					await site.reportToFleet();
				} catch {
					threw = true;
				}
				(site.env as Record<string, unknown>)['FLEET_DB'] = held;

				const stats = await site.fetch(new Request('https://do.local/__serve-stats'));
				const body = (await stats.json()) as Record<string, unknown>;
				return { threw, lastFleetError: body['lastFleetError'] ?? null };
			});

			// the catch is correct: D1 must never take down the alarm that serves the site
			expect(out.threw).toBe(false);
			// and the field it catches into has a reader, which is the half that was missing
			expect(String(out.lastFleetError)).toContain('d1 is unreachable');
		},
		REQUEST_TIMEOUT
	);
});
