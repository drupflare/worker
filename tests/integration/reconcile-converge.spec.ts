import { describe, expect, it } from 'vitest';
import { BOOT_KERNEL } from '../../src/drupal/site-php';
import { PACK_VERSION, RECONCILE_STEPS, SHIPPED_PAGE_MAX_AGE } from '../../src/ops/reconcile';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * A site provisioned before a fix, brought up to the pack that ships today.
 *
 * The assertion is the END STATE on both copies of the config object, never that the step ran. The
 * `max_age` fix was made correctly in `config` and stayed inert because `cache_config` held its own
 * serialized 0 and Drupal reads the bin first, so a check that reads only the row it edited passes
 * while every render on every site still answers `no-store`.
 *
 * The site is regressed to the old state first. Without that the steps are all satisfied at
 * provisioning and this file would assert nothing, which is the shape of a green test that cannot
 * fail. The regression is asserted before the reconcile runs.
 */

type Payload = Record<string, unknown>;
const ORIGIN = 'https://do.local';
const TIMEOUT = 900_000;

function rows(site: ServeDo, query: string, ...bindings: unknown[]): Payload[] {
	return site.sql.exec(query, ...bindings).toArray();
}

/** `config.data` is a BLOB, so it arrives as bytes on one path and as text on another */
function asText(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
	return null;
}

/** the max_age a serialized config object carries */
function maxAgeOf(found: Payload[]): number | null {
	const data = asText(found[0]?.data);
	if (data === null) return null;
	const m = /s:7:"max_age";i:(-?\d+);/.exec(data);
	return m ? Number(m[1]) : null;
}

/** puts the site back into the state a pre-fix provisioning left it in */
function regressToOldPack(site: ServeDo): void {
	for (const [table, key] of [
		['config', 'name'],
		['cache_config', 'cid']
	] as const) {
		const data = asText(
			rows(site, `SELECT data FROM ${table} WHERE ${key} = 'system.performance'`)[0]?.data
		);
		if (data === null) continue;
		site.sql.exec(
			`UPDATE ${table} SET data = ? WHERE ${key} = 'system.performance'`,
			data.replace(/(s:7:"max_age";i:)-?\d+;/, '$10;')
		);
	}
	site.sql.exec('DELETE FROM cfw_meta WHERE k = ?', 'reconcile_state');
	site.sql.exec('DELETE FROM cfw_meta WHERE k = ?', 'driver_digest');
}

/** drives steps until nothing is left to run, the way a run of alarm firings would */
async function reconcileToDone(site: ServeDo, passes = 12): Promise<Payload[]> {
	const seen: Payload[] = [];
	for (let i = 0; i < passes; i++) {
		const res = await site.fetch(new Request(`${ORIGIN}/__reconcile`, { method: 'POST' }));
		const body = (await res.json()) as Payload;
		seen.push(body);
		const ran = body.ran as Payload | null;
		const outcome = (ran?.reconcile ?? null) as Payload | null;
		if (outcome === null || outcome.done === true || outcome.waiting !== undefined) break;
	}
	return seen;
}

describe('bringing an already-provisioned site up to the shipping pack', () => {
	it(
		'converges both copies of the config object, not only the row a SQL fix would touch',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				// claimed, so the clock and log steps have a birthday to compare against
				site.sql.exec(
					'INSERT INTO cfw_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
					'first_run_at',
					String(Date.now())
				);
				regressToOldPack(site);

				const readBoth = () => ({
					config: maxAgeOf(
						rows(site, "SELECT data FROM config WHERE name = 'system.performance'")
					),
					cached: maxAgeOf(
						rows(site, "SELECT data FROM cache_config WHERE cid = 'system.performance'")
					)
				});
				const { config: beforeConfig, cached: beforeCached } = readBoth();
				const passes = await reconcileToDone(site);
				const { config: afterConfig, cached: afterCached } = readBoth();
				const status = (await (
					await site.fetch(new Request(`${ORIGIN}/__reconcile`))
				).json()) as Payload;
				return { beforeConfig, beforeCached, afterConfig, afterCached, passes, status };
			});

			// THE CONTROL: without a real regression the assertions below prove nothing
			expect(out.beforeConfig, 'the site was not regressed, so nothing was owed').toBe(0);

			expect(out.afterConfig).toBe(SHIPPED_PAGE_MAX_AGE);
			// the copy the original fix forgot, and the one Drupal reads first
			expect(out.afterCached === null || out.afterCached === SHIPPED_PAGE_MAX_AGE).toBe(true);
			expect(Number((out.status as Payload).version)).toBe(PACK_VERSION);
		},
		TIMEOUT
	);

	/**
	 * A deferred step answers null from `reconcileStepOnce()` exactly as a reconciled site does, and
	 * the first version of `reconcileSkipReason()` reported the reconciled reason for both. So an
	 * unclaimed site parked at version 0 was told it was already at the shipping version.
	 */
	it(
		'names the step it is waiting on rather than claiming it is done',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				// NEVER claimed, so `bake-clock` and `bake-watchdog` both defer forever
				site.sql.exec('DELETE FROM cfw_meta WHERE k = ?', 'first_run_at');
				await reconcileToDone(site);
				return (await (
					await site.fetch(new Request(`${ORIGIN}/__reconcile`, { method: 'POST' }))
				).json()) as Payload;
			});

			// THE CONTROL: at the shipping version there is nothing to defer and this proves nothing
			expect(
				Number(out.version),
				'the site reconciled fully, so no step was deferred'
			).toBeLessThan(PACK_VERSION);
			expect(out.ran).toBeNull();
			expect(String(out.skipped)).toMatch(/^waiting on /);
			expect(String(out.skipped)).not.toContain('already at the shipping version');
		},
		TIMEOUT
	);

	it(
		'reports every step and its standing, so a stuck site says which step is stuck',
		async () => {
			const status = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				return (await (
					await site.fetch(new Request(`${ORIGIN}/__reconcile`))
				).json()) as Payload;
			});
			const steps = status.steps as { id: string; state: string }[];
			expect(steps.map((s) => s.id)).toEqual(RECONCILE_STEPS.map((s) => s.id));
			for (const step of steps) {
				expect(['applied', 'satisfied', 'owed', 'deferred', 'failed'], step.id).toContain(
					step.state
				);
			}
		},
		TIMEOUT
	);

	/**
	 * The general close for a `#[Hook]` class added after the bake.
	 *
	 * `DrupalKernel::getContainerCacheKey()` never moves when a sibling module changes, so the packed
	 * container compiles the hook away and `hasImplementations()` answers false while the class loads
	 * fine. The step drops the row; this asserts the row is gone and that a boot afterwards rebuilds
	 * one rather than serving a site with no container at all.
	 */
	it(
		'drops a compiled container that predates the driver pack, and the next boot rebuilds it',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				site.sql.exec('DELETE FROM cfw_meta WHERE k = ?', 'reconcile_state');
				site.sql.exec(
					'INSERT INTO cfw_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
					'driver_digest',
					'a-pack-from-before'
				);
				const containers = () =>
					Number(rows(site, 'SELECT COUNT(*) AS n FROM cache_container')[0]?.n ?? 0);
				const before = containers();
				// SAMPLED WHEN THE CONTAINER STEP ITSELF RAN, not after the chain. The router step
				// runs later and boots a kernel to rebuild `router`, which recompiles the container
				// the drop just removed -- so an `after` taken at the end of the chain reads 1 and
				// says nothing about whether the drop happened
				let atDrop: number | null = null;
				for (let i = 0; i < 12; i++) {
					const res = await site.fetch(
						new Request(`${ORIGIN}/__reconcile`, { method: 'POST' })
					);
					const body = (await res.json()) as Payload;
					const ran = body.ran as Payload | null;
					const outcome = (ran?.reconcile ?? null) as Payload | null;
					if (outcome?.id === 'container-driver-digest') atDrop = containers();
					if (
						outcome === null ||
						outcome.done === true ||
						outcome.waiting !== undefined
					) {
						break;
					}
				}
				const after = containers();
				// a real kernel boot, which is what has to compile the container it just lost. A
				// `/__serve` would be answered off `cfw_page` on a warm path and boot nothing
				const booted = await site.runJson(BOOT_KERNEL);
				const rebuilt = containers();
				const digest = rows(site, "SELECT v FROM cfw_meta WHERE k = 'driver_digest'")[0]?.v;
				return { before, atDrop, after, rebuilt, booted, digest: digest ?? null };
			});

			// THE CONTROL: a pack with no container row makes the drop unobservable
			expect(
				out.before,
				'the pack shipped no container, so the drop proves nothing'
			).toBeGreaterThan(0);
			expect(out.atDrop, 'the container step never ran').toBe(0);
			// THE DROP IS THE WHOLE FIX, and this file used to assert a container survived the chain.
			// That was INCIDENTAL: a later step booted a kernel for its own reasons and left one
			// behind, and once the 11.4.6 pack stopped owing those steps work it read 0 with the drop
			// still perfectly correct.
			//
			// Recompiling inside the step was tried and reverted: a fresh site has no recorded digest,
			// so it reads as owed and would pay a kernel boot on every provision -- which is what the
			// migration chain is deliberately free of. `serve-migration.spec.ts` is what caught that.
			expect((out.booted as Payload)?.ok, JSON.stringify(out.booted)).toBe(true);
			expect(out.rebuilt).toBeGreaterThan(0);
			expect(out.digest).not.toBe('a-pack-from-before');
		},
		TIMEOUT
	);

	it(
		'costs nothing on a site already at the shipping version',
		async () => {
			const out = await inObject(freshSite(), async (site: ServeDo) => {
				await site.fetch(new Request(`${ORIGIN}/__migrate?all=1&prefill=0`));
				// claimed, or the two bake steps defer forever and the version never rises: an
				// unclaimed site has no birthday to compare a log row or a clock against
				site.sql.exec(
					'INSERT INTO cfw_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
					'first_run_at',
					String(Date.now())
				);
				const passes = await reconcileToDone(site);
				const first = (await (
					await site.fetch(new Request(`${ORIGIN}/__reconcile`, { method: 'POST' }))
				).json()) as Payload;
				return { first, passes };
			});
			const first = out.first as Payload;
			expect(
				Number(first.version),
				JSON.stringify((out.passes as Payload[]).map((p) => p.ran))
			).toBe(PACK_VERSION);
			// `ran` is THIS call's outcome, so a no-op says so rather than replaying an earlier
			// firing's payload; a caller looping on `ran` would otherwise never terminate
			expect(first.ran).toBeNull();
			expect(first.skipped).toBe('already at the shipping version');
		},
		TIMEOUT
	);
});
