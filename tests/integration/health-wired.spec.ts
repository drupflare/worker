import { describe, expect, it } from 'vitest';
import { cronUnits, runHealthSelfTest } from '../../src/ops/cron';
import { freshSite, inObject, markProvisioned, type ServeDo } from '../helpers/serve-do';

/** the bridge as PHP receives it: the object installs its callables onto a bag */
function capabilityBag(site: ServeDo): Record<string, (json: string) => string> {
	const bag: Record<string, (json: string) => string> = {};
	site.installCapabilities(bag);
	return bag;
}

/**
 * The PHP health layer, reached from the host.
 *
 * `src/Health/` is twelve files and 988 lines, and nothing outside its own directory referenced
 * any of it. Every finding it produces goes through `HealthLedger::record()`, which opens with
 * `if (!Host::has('cfwHealth')) return false;` -- and the worker installed no such capability. So
 * the tripwires, the boot self test and the circuit breaker were green in the module's own suite
 * and had never run on a site. The same shape as `src/ops/supervisor.ts` before it was wired,
 * which is the JS half of this exact layer.
 */

const TIMEOUT = 900_000;

describe('the health capability exists at all', () => {
	it(
		'installs cfwHealth, which the PHP ledger refuses without',
		async () => {
			const names = await inObject(freshSite(), (site: ServeDo) =>
				Object.keys(capabilityBag(site))
			);
			expect(names, 'HealthLedger::record() returns false without it').toContain('cfwHealth');
		},
		TIMEOUT
	);

	it(
		'writes a finding into the same table the host writes',
		async () => {
			const rows = await inObject(freshSite(), (site: ServeDo) => {
				markProvisioned(site);
				const bag = capabilityBag(site);
				const reply = JSON.parse(
					bag['cfwHealth']!(
						JSON.stringify({
							code: 'cache.anonymous_purity',
							// the ORDINAL, which is what `Finding` declares; the host keys by name
							severity: 3,
							scope: '/about',
							context: 'uid 1 while writing the page cache'
						})
					)
				) as { ok: boolean };
				expect(reply.ok).toBe(true);
				return site.sql
					.exec('SELECT code, severity, scope FROM cfw_health ORDER BY id DESC')
					.toArray() as { code: string; severity: number; scope: string }[];
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.code).toBe('cache.anonymous_purity');
			// 3 is CRITICAL on both sides; a mapping that dropped it would store the wrong ordinal
			expect(rows[0]?.severity).toBe(3);
			expect(rows[0]?.scope).toBe('/about');
		},
		TIMEOUT
	);

	it(
		'refuses a finding with no code rather than storing a blank one',
		async () => {
			const out = await inObject(freshSite(), (site: ServeDo) => {
				markProvisioned(site);
				// the table has to exist for the count below to mean "nothing was written"
				// rather than "nothing has a table yet"
				site.ensureServeTables();
				const bag = capabilityBag(site);
				const reply = JSON.parse(bag['cfwHealth']!(JSON.stringify({ severity: 1 }))) as {
					ok: boolean;
				};
				const n = site.sql.exec('SELECT COUNT(*) AS n FROM cfw_health').toArray()[0] as {
					n: number;
				};
				return { reply, n: n.n };
			});
			expect(out.reply.ok).toBe(false);
			expect(out.n).toBe(0);
		},
		TIMEOUT
	);
});

describe('the host drives the PHP half', () => {
	it('carries a health unit in the cron ring', () => {
		const ids = cronUnits({ hooks: [] }).map((u) => u.id);
		expect(ids, 'nothing would ever call the PHP health layer').toContain('health');
		// a unit rather than a `#[Hook]`, because a hook class added after the bake is not in
		// the container the pack ships and `hasImplementations()` answers false forever
		expect(cronUnits({ hooks: [], includeHealth: false }).map((u) => u.id)).not.toContain(
			'health'
		);
	});

	it(
		'builds an observation out of facts only the host holds',
		async () => {
			const obs = await inObject(freshSite(), (site: ServeDo) => {
				markProvisioned(site);
				return site.healthObservation();
			});
			// the exact keys `BootSelfTest::run()` reads; a rename on either side breaks the layer
			// silently, because a missing key reads as "nothing wrong"
			for (const key of [
				'bridge_installed',
				'missing_capabilities',
				'migrate_chunk',
				'migrate_chunks',
				'updb_phase',
				'pack_generation',
				'db_generation'
			]) {
				expect(Object.keys(obs), `BootSelfTest reads ${key}`).toContain(key);
			}
			expect(obs['bridge_installed']).toBe(1);
			// cfwHealth is installed now, so the self test must not report it absent
			expect(obs['missing_capabilities']).toEqual([]);
		},
		TIMEOUT
	);

	it('emits PHP that parses and names all three health classes', () => {
		const php = runHealthSelfTest({ bridge_installed: 1 });
		expect(php).toContain('Health\\\\BootSelfTest');
		expect(php).toContain('Health\\\\TripwireRegistry');
		expect(php).toContain('Health\\\\HealthLedger');
		// no kernel boot: the observation is supplied, which is what keeps this unit cheap
		expect(php).not.toContain('DrupalKernel');
	});
});
