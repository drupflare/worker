import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readModulesConfig, readQuotasConfig, renderModules } from '../../scripts/gen-config.js';
import { censusPackages } from '../../scripts/install-census.js';
import { PREFILL_PATHS } from '../../scripts/lift-prefill.js';
import { FREE_QUOTAS } from '../../scripts/measure/free-envelope.js';
import { TRAFFIC_MIX } from '../../scripts/measure/verdict-math.js';
import { CRON_HOOKS, KNOWN_CRON_HOOKS } from '../../src/ops/cron.js';
import { SHIPPING_PACK_CONTRIB, moduleTable } from '../../src/ops/module-table.js';
import { MODULE_TIER_NOTES } from '../../src/ops/module-tiers.js';

/**
 * `config/modules.yml` is the declaration; `src/ops/generated/modules.ts` is what the edge reads.
 *
 * A Worker has no filesystem, so the YAML cannot be read at runtime and has to be compiled in. That
 * makes the generated file a second copy, and a second copy is the shape this repository has been
 * bitten by more than any other -- the packed driver, the `drupal/` module tree, the `cache_config`
 * row shadowing its own config. The answer each time is the same: keep the copy, and fail the gate
 * when it disagrees with its source.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const GENERATED = resolve(ROOT, 'src', 'ops', 'generated', 'modules.ts');

describe('the generated module config', () => {
	it('is what config/modules.yml renders to', () => {
		expect(
			readFileSync(GENERATED, 'utf8'),
			'src/ops/generated/modules.ts is stale; run `bun run gen:config`'
		).toBe(renderModules(readModulesConfig()));
	});

	it('reaches the edge through the consumers rather than only existing', () => {
		// the generated file being correct says nothing about anything importing it, which is the
		// tested-but-never-called shape. Each of these is the exported name the rest of src/ uses
		const config = readModulesConfig();
		const declared = Object.keys(config.modules);

		expect(Object.keys(MODULE_TIER_NOTES).sort()).toEqual(
			declared.filter((n) => config.modules[n]?.why !== undefined).sort()
		);
		expect([...SHIPPING_PACK_CONTRIB].sort()).toEqual(
			declared.filter((n) => config.modules[n]?.shipping).sort()
		);
		expect(Object.keys(CRON_HOOKS).sort()).toEqual(Object.keys(config.cron.policy).sort());
		expect([...KNOWN_CRON_HOOKS].sort()).toEqual([...config.cron.known].sort());
	});

	it('puts every declared module in the table, which is what makes one YAML entry enough', () => {
		// the property the refactor exists for: a module is added by declaring it, and the table --
		// which README.md is compared against -- picks it up with no second edit
		const config = readModulesConfig();
		const rows = new Set(moduleTable().map((r) => r.name));
		const missing = Object.keys(config.modules).filter((n) => !rows.has(n));
		expect(missing, 'declared in config/modules.yml but absent from the table').toEqual([]);
	});

	it('renders a module that is only in the YAML, so the generator is not echoing the TS', () => {
		// the control for the test above: if `renderModules` read the existing constants instead of
		// its argument, every assertion here would pass on a generator that ignores the YAML
		const config = readModulesConfig();
		expect(Object.keys(config.modules)).not.toContain('drupal/probe_only');
		const rendered = renderModules({
			...config,
			modules: {
				...config.modules,
				'drupal/probe_only': { needs: [], why: 'a declaration made by this test' }
			}
		});
		expect(rendered).toContain('drupal/probe_only');
		expect(rendered).toContain('a declaration made by this test');
	});

	it('reaches the installer, which is what closes the loop to the gate', () => {
		// a declared module has to reach `drupal-src`, or the contrib lane has no fixture for it and
		// `contrib-verify.spec.ts` answers with a skip. `install-census.ts` reads the same table.
		//
		// no version enters that chain: the installer names packages without constraints, so
		// composer.lock decides what each resolves to
		const declared = Object.keys(readModulesConfig().modules).sort();
		expect([...censusPackages()].sort()).toEqual(declared);
	});

	it('reaches the meter through FREE_QUOTAS, not only through the generated file', () => {
		const declared = readQuotasConfig();
		for (const [key, entry] of Object.entries(declared)) {
			expect(FREE_QUOTAS[key as keyof typeof FREE_QUOTAS], key).toBe(entry.value);
		}
		expect(Object.keys(FREE_QUOTAS).sort()).toEqual(Object.keys(declared).sort());
	});

	it('weights a traffic mix that sums to one, and refuses one that does not', () => {
		const total = Object.values(TRAFFIC_MIX).reduce((n, e) => n + e.weight, 0);
		expect(total).toBeCloseTo(1, 9);
		// every weight carries its reason, which is what stops a number moving without one
		for (const [name, entry] of Object.entries(TRAFFIC_MIX)) {
			expect(entry.why, `${name} has no why`).toBeTruthy();
		}
	});

	it('declares the prefill paths, all rooted', () => {
		expect(PREFILL_PATHS.length).toBeGreaterThan(0);
		for (const p of PREFILL_PATHS) expect(p.startsWith('/'), p).toBe(true);
	});

	it('refuses a cron policy that names a hook the fallback list does not', () => {
		// the two halves are one declaration: a policy for a hook that is not in `known` schedules
		// against a site with no such implementation
		const config = readModulesConfig();
		const path = resolve(ROOT, 'config', 'modules.yml');
		expect(() => readModulesConfig(path)).not.toThrow();
		for (const name of Object.keys(config.cron.policy)) {
			expect(config.cron.known, `${name} has a policy but is not in cron.known`).toContain(
				name
			);
		}
	});
});
