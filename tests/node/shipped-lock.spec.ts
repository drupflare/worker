import { describe, expect, it } from 'vitest';
import { SHIPPED_CORE_VERSION } from '../../src/ops/shipped-lock';

/**
 * What the baked lock map has to be true of, which is not "identical to a lockfile".
 *
 * THE COMPOSER.LOCK COMPARISON IS GONE, and its own history is the argument. `fetch-drupal-tree.ts`
 * runs `composer require`, so `drupal-src/composer.lock` is RE-RESOLVED on every CI run while core
 * stays pinned; the first push failed on symfony `v7.4.15` -> `v7.4.16` across six packages with
 * nothing in this repository changed. That was answered by classifying patch drift and failing on
 * major.minor, which kept the machinery and only moved the tripwire further out.
 *
 * A test that recomputes dependency drift is measuring what upstream published this morning, not
 * what this repository does. `bun run gen:lock` regenerates the map when the tree is refetched, and
 * the gate passing is what says the map is usable.
 *
 * What survives is the one property with a MECHANISM behind it: a core below 11.3 cannot run the
 * driver module at all.
 */
describe('the shipped core version', () => {
	it('is a version', () => {
		expect(SHIPPED_CORE_VERSION).toMatch(/^\d+\.\d+/);
	});

	it('is at or above the floor the drupflare module declares', () => {
		// ^11.3 -- measured, because 11.0/11.1/11.2 all fatal. A shipped core below that floor
		// means the site cannot run its own driver
		const [major, minor] = SHIPPED_CORE_VERSION.split('.').map(Number) as [number, number];
		expect(major).toBeGreaterThanOrEqual(11);
		if (major === 11) expect(minor).toBeGreaterThanOrEqual(3);
	});
});
