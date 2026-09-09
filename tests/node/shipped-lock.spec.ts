import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contribPins } from '../../scripts/fetch-drupal-tree';
import { SHIPPED_CORE_VERSION } from '../../src/ops/shipped-lock';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** `drupal/core`'s version in a lockfile, or null when that lock does not carry it */
function coreIn(lockPath: string): string | null {
	try {
		const lock = JSON.parse(readFileSync(resolve(ROOT, lockPath), 'utf8')) as {
			packages?: { name: string; version: string }[];
		};
		return lock.packages?.find((p) => p.name === 'drupal/core')?.version ?? null;
	} catch {
		return null;
	}
}

const minor = (v: string) => v.split('.').slice(0, 2).join('.');

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
		const [major, min] = SHIPPED_CORE_VERSION.split('.').map(Number) as [number, number];
		expect(major).toBeGreaterThanOrEqual(11);
		if (major === 11) expect(min).toBeGreaterThanOrEqual(3);
	});
});

/**
 * THE ROOT LOCK IS THE SOURCE, AND THE DIRECTION IS THE WHOLE ASSERTION.
 *
 * `bun run gen:lock` read `drupal-src/composer.lock` until 2026-09-09, and
 * `fetch-drupal-tree.ts` materialises that tree at whatever `SHIPPED_CORE_VERSION` names -- so the
 * tree's lock chose the version that populated the tree, and the only thing it could confirm was
 * itself. The root lock sat outside the loop and nothing read it, which is how a `composer update`
 * moved `drupal/core` to 11.4.6 for static analysis while the pack stayed at 11.4.5 with nothing
 * reporting it.
 *
 * `composer.json` now requires `drupal/core-recommended` and the four contrib modules directly, so
 * the root lock names everything the tree needs and `gen:lock` reads it. The chain is acyclic:
 * manifest -> root lock -> baked map -> fetched tree.
 *
 * WHAT THE TREE'S LOCK IS FOR NOW is agreement at MAJOR.MINOR, and only that. It is re-resolved by
 * `composer require` on every fetch, so its transitive patch versions are whatever upstream
 * published that morning -- 19 of them are ahead of the tree on disk right now purely because the
 * tree was resolved weeks earlier. A patch-level assertion would therefore measure the calendar.
 * 11.4 against 11.5 is a real finding, because moving the shipping core needs a pack rebuild rather
 * than a dependency refresh.
 */
describe('the root composer lock is what the shipped map comes from', () => {
	it('carries a core version', () => {
		expect(coreIn('composer.lock')).toMatch(/^\d+\.\d+/);
	});

	it('is the exact core the baked map names, because the map is generated from it', () => {
		expect(coreIn('composer.lock')).toBe(SHIPPED_CORE_VERSION);
	});

	it('requires core and every contrib module the tree needs, so nothing reads the tree for it', () => {
		const manifest = JSON.parse(readFileSync(resolve(ROOT, 'composer.json'), 'utf8')) as {
			require: Record<string, string>;
		};
		// core-recommended rather than core: it pins symfony to the exact set core ships, which is
		// what stopped the root resolving symfony 8.1 while the site ran 7.4
		expect(Object.keys(manifest.require)).toContain('drupal/core-recommended');
		for (const pin of contribPins()) {
			expect(Object.keys(manifest.require)).toContain(pin.slice(0, pin.lastIndexOf(':')));
		}
	});

	/**
	 * `drupal-src` is gitignored, so this is the one assertion here that a clean checkout cannot
	 * make. It is skipped rather than failed for the reason the artifact lane exists.
	 */
	it('agrees with the fetched tree at major.minor when that tree is present', (ctx) => {
		const src = coreIn('drupal-src/composer.lock');
		if (src === null) return ctx.skip();
		expect(minor(src)).toBe(minor(SHIPPED_CORE_VERSION));
	});
});
