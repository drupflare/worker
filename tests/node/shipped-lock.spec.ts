import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lockVersions } from '../../src/ops/packagist';
import { SHIPPED_CORE_VERSION, SHIPPED_LOCK_VERSIONS } from '../../src/ops/shipped-lock';

/**
 * The staleness gate for the baked lock map.
 *
 * `assets/driver.json` went silently stale TWICE by exactly this mechanism: a generated artifact that
 * nothing compared against its source, so the shipped copy quietly stopped matching what the repo said.
 * The installability check's refusals are computed from this map, so a stale copy would refuse a
 * compatible module or -- worse -- accept an incompatible one, both with a confident named reason.
 *
 * Node lane, because `drupal-src/composer.lock` is a file and workerd cannot read one.
 */

// `drupal-src/` is a build INPUT fetched by `bun run fetch:drupal`, not something the repo carries.
// It is legitimately absent on a clean clone, so this lane SKIPS rather than failing -- a missing
// input is not a code regression, and the same idiom guards the controls in mb-fix-iconv.spec.ts.
const LOCK_PATH = 'drupal-src/composer.lock';
const haveTree = existsSync(LOCK_PATH);
const describeIfTree = haveTree ? describe : describe.skip;
const lock = haveTree ? JSON.parse(readFileSync(LOCK_PATH, 'utf8')) : { packages: [] };
const onDisk = lockVersions(lock);

describeIfTree('the baked lock map matches drupal-src/composer.lock', () => {
	it('has the same package set', () => {
		expect(Object.keys(SHIPPED_LOCK_VERSIONS).sort()).toEqual(Object.keys(onDisk).sort());
	});

	/**
	 * Patch drift in a transitive dependency is NOT staleness, and asserting equality made this a
	 * time bomb rather than a gate.
	 *
	 * `fetch-drupal-tree.ts` runs `composer require`, so the tree is RE-RESOLVED on every CI run
	 * while Drupal core stays pinned. The first push failed here on symfony `v7.4.15` -> `v7.4.16`
	 * across six packages -- upstream cut a patch release, nothing in this repository changed, and
	 * regenerating would only have reset the timer until the next one.
	 *
	 * So the drift is classified rather than compared. A patch move is reported and allowed; a
	 * MAJOR.MINOR move is a real change to what ships and still fails, because that is the level a
	 * composer constraint like `^7.4` actually discriminates on -- which is what E3 asks this map.
	 * The package set and `drupal/core` are asserted exactly, in their own cases above and below.
	 */
	it('has the same major.minor for every package, allowing upstream patch drift', () => {
		// run `bun run gen:lock` when this fails; do NOT hand-edit the generated file
		const minorOf = (v: string) => v.replace(/^v/, '').split('.').slice(0, 2).join('.');
		const moved: string[] = [];
		const drifted: string[] = [];
		for (const [name, shipped] of Object.entries(SHIPPED_LOCK_VERSIONS)) {
			const now = onDisk[name];
			if (now === undefined || now === shipped) continue;
			(minorOf(shipped) === minorOf(now) ? drifted : moved).push(
				`${name} ${shipped} -> ${now}`
			);
		}
		if (drifted.length > 0) {
			console.log(
				`  note: ${drifted.length} package(s) drifted by patch since \`bun run gen:lock\`:\n` +
					drifted.map((d) => `    ${d}`).join('\n')
			);
		}
		expect(moved).toEqual([]);
	});

	it('carries the core version E3 compares every module against', () => {
		expect(SHIPPED_CORE_VERSION).toBe(onDisk['drupal/core']);
		expect(SHIPPED_CORE_VERSION).toMatch(/^\d+\.\d+/);
	});

	it('agrees with the module floor the drupflare module declares', () => {
		// drupflare requires ^11.3 -- measured, because 11.0/11.1/11.2 all fatal. A shipped core below
		// that floor would mean the site cannot run its own driver module.
		const [major, minor] = SHIPPED_CORE_VERSION.split('.').map(Number) as [number, number];
		expect(major).toBeGreaterThanOrEqual(11);
		if (major === 11) expect(minor).toBeGreaterThanOrEqual(3);
	});
});

describe('the vendored Drupal tree', () => {
	it('reports whether the lock-backed assertions actually ran', () => {
		// makes the skip visible, so "green" cannot quietly mean the lock was never compared
		if (!haveTree) {
			console.log(
				`  note: ${LOCK_PATH} absent, the lock comparison was SKIPPED (bun run fetch:drupal)`
			);
		}
		expect(typeof haveTree).toBe('boolean');
	});
});
