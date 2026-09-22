import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	FLEET_SCHEMA_VERSION,
	ensureFleetTable,
	fleetSummary,
	listSites,
	reportSite
} from '../../src/ops/fleet';
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

/**
 * The inventory as a SCHEMA, smoke-tested end to end.
 *
 * The roadmap promoted this ahead of the control plane for one reason: a schema designed against a
 * consumer that does not exist yet is a schema that gets replaced. So the test is not "does a row
 * round-trip" -- it is the three things a first consumer will do on day one and cannot do if the
 * shape is wrong: read a fleet written by two Worker versions at once, tell an unwell site from one
 * nobody has heard from, and add a field without a migration on every live site.
 */
describe('the fleet schema answers what a control plane asks first', () => {
	const db = () => env.FLEET_DB as unknown as Parameters<typeof listSites>[0];

	const row = (over: Partial<Parameters<typeof reportSite>[1]> = {}) => ({
		site: 'schema-a',
		packGeneration: 'pack-1',
		coreVersion: '11.4.6',
		workerVersion: 'w1',
		plan: 'free' as const,
		lastSeenMs: 1_700_000_000_000,
		reconcileVersion: 3,
		schemaVersion: FLEET_SCHEMA_VERSION,
		cms: 'drupal',
		tier: 'managed' as const,
		health: 'ok' as const,
		...over
	});

	it(
		'round-trips every field the schema declares',
		async () => {
			await ensureFleetTable(db());
			await reportSite(db(), row({ site: 'schema-roundtrip', health: 'degraded' }));
			const found = (await listSites(db())).find((r) => r.site === 'schema-roundtrip');
			expect(found).toBeDefined();
			expect(found).toMatchObject({
				schemaVersion: FLEET_SCHEMA_VERSION,
				cms: 'drupal',
				tier: 'managed',
				health: 'degraded',
				reconcileVersion: 3
			});
		},
		REQUEST_TIMEOUT
	);

	/**
	 * A FLEET MID-ROLLOUT CARRIES TWO SHAPES AT ONCE, which is the case the version field exists
	 * for. The row written by the older Worker is not corrupt and must not read as this Worker's
	 * defaults with no way to tell -- it reads as schema 1, which is what it is.
	 */
	it(
		'reads a row written before these columns existed as schema 1',
		async () => {
			await ensureFleetTable(db());
			// exactly what a schema-1 Worker's INSERT wrote: the columns it knew, and no others
			await db()
				.prepare(
					`INSERT INTO cfw_fleet (site, pack_generation, core_version, worker_version, plan, last_seen_ms, reconcile_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(site) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`
				)
				.bind('schema-legacy', 'pack-0', '11.4.5', 'w0', 'free', 1_600_000_000_000, 1)
				.run();

			const found = (await listSites(db())).find((r) => r.site === 'schema-legacy');
			expect(found?.schemaVersion, 'a legacy row must not claim this schema').toBe(1);
			// and the defaults describe THAT Worker's world rather than guessing at this one
			expect(found?.cms).toBe('drupal');
			expect(found?.tier).toBe('managed');
			expect(found?.health).toBe('ok');
		},
		REQUEST_TIMEOUT
	);

	it(
		'separates a site that is unwell from one nobody has heard from',
		async () => {
			const now = 1_700_000_000_000;
			const summary = fleetSummary(
				[
					row({ site: 'a', health: 'ok', lastSeenMs: now }),
					row({ site: 'b', health: 'degraded', lastSeenMs: now }),
					row({ site: 'c', health: 'quarantined', lastSeenMs: now }),
					// reported two days ago; its health is whatever it was then and is not evidence
					row({ site: 'd', health: 'ok', lastSeenMs: now - 48 * 60 * 60 * 1000 })
				],
				now
			);
			expect(summary.unhealthy).toEqual(['b', 'c']);
			expect(summary.stale).toEqual(['d']);
			// THE CONTROL: the two lists are disjoint here, which is the property that makes
			// "the fleet is healthy" a claim about sites that actually answered
			expect(summary.unhealthy.some((s) => summary.stale.includes(s))).toBe(false);
			expect(summary.byHealth.map((h) => h.version).sort()).toEqual([
				'degraded',
				'ok',
				'quarantined'
			]);
		},
		REQUEST_TIMEOUT
	);

	it(
		'rolls up the shapes a consumer has to reconcile',
		async () => {
			const now = 1_700_000_000_000;
			const summary = fleetSummary(
				[
					row({ site: 'a', schemaVersion: 1, lastSeenMs: now }),
					row({ site: 'b', schemaVersion: 2, lastSeenMs: now }),
					row({ site: 'c', schemaVersion: 2, tier: 'self-hosted', lastSeenMs: now })
				],
				now
			);
			expect(summary.bySchemaVersion).toEqual([
				{ version: '2', sites: 2, fraction: 0.6667 },
				{ version: '1', sites: 1, fraction: 0.3333 }
			]);
			expect(summary.byTier.map((t) => t.version).sort()).toEqual(['managed', 'self-hosted']);
			expect(summary.byCms).toEqual([{ version: 'drupal', sites: 3, fraction: 1 }]);
		},
		REQUEST_TIMEOUT
	);

	/** the object reports the new fields too, or the schema is one the producer does not fill */
	it(
		'is filled by the object rather than only by this test',
		async () => {
			const reported = await inObject(freshSite(), async (site: ServeDo) => {
				markProvisioned(site, 'fleet-schema-gen');
				await site.reportToFleet();
				return (await listSites(db())).find((r) => r.packGeneration === 'fleet-schema-gen');
			});
			expect(reported).toBeDefined();
			expect(reported?.schemaVersion).toBe(FLEET_SCHEMA_VERSION);
			expect(reported?.cms).toBe('drupal');
			expect(reported?.health).toBe('ok');
			expect(reported?.tier).toBe('managed');
		},
		REQUEST_TIMEOUT
	);
});
