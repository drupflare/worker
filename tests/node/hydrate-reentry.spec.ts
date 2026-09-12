import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_STEPS } from '../../scripts/build-local';
import { markHydrating, reentered, REENTRY_VAR } from '../../scripts/hydrating';
import { readJsonc } from '../../scripts/release-payload';

/**
 * The cycle that took three CI lanes down on 2026-09-12, pinned at each of its three links.
 *
 * `wrangler.jsonc` runs `bun run hydrate` before every `dev` and every `--dry-run`. The container
 * step spawns `wrangler dev --local` while the tree is still missing a marker the LATER `sql` step
 * produces, so hydrate reads it as incomplete, finds no release, and re-enters `build-local.ts`.
 * Each level forked another Drupal build until the runner was reclaimed.
 *
 * Removing `markHydrating()` from `build-local.ts` fails the third case here.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('the flag that stops a build hydrating itself', () => {
	it('reads false on an environment that does not carry it', () => {
		expect(reentered({})).toBe(false);
		expect(reentered({ [REENTRY_VAR]: '0' })).toBe(false);
	});

	it('is set into the environment a child will inherit', () => {
		const env: Record<string, string | undefined> = {};
		markHydrating(env);
		expect(reentered(env)).toBe(true);
	});
});

describe('the three links of the cycle', () => {
	it('wrangler still runs hydrate as its build command, which is the first link', () => {
		const config = readJsonc(resolve(ROOT, 'wrangler.jsonc')) as {
			build?: { command?: string };
		};
		expect(config.build?.command).toContain('hydrate');
	});

	/**
	 * The container step runs BEFORE the step that produces the marker hydrate checks for, so
	 * mid-build the tree is legitimately incomplete and the marker check cannot close this.
	 */
	it('orders the container step before the sql step that satisfies the marker', () => {
		const ids = LOCAL_STEPS.map((s) => s.id);
		expect(ids.indexOf('container')).toBeGreaterThan(-1);
		expect(ids.indexOf('container')).toBeLessThan(ids.indexOf('sql'));
	});

	it('marks the flag in every script that spawns wrangler as part of a build', () => {
		for (const script of [
			'scripts/build-local.ts',
			'scripts/bake-container.ts',
			'scripts/measure/collect-metrics.ts',
			'scripts/release-payload.ts'
		]) {
			expect(readFileSync(resolve(ROOT, script), 'utf8')).toContain('markHydrating(');
		}
	});

	it('declines rather than building when the flag is already set', () => {
		const source = readFileSync(resolve(ROOT, 'scripts/hydrate.ts'), 'utf8');
		// before the marker check, or an incomplete tree reaches the source route first
		expect(source.indexOf('reentered()')).toBeLessThan(source.indexOf('missingMarkers(root)'));
	});
});

/**
 * The same step ordering has a SECOND consequence, and closing the cycle is what exposed it.
 *
 * `sql` running after `container` also means there is no `assets/drupal-sql/` when the container
 * step asks the object to migrate. Measured 2026-09-12 in CI, once wrangler could start at all:
 * `/migrate` answered 200 in 54 ms having replayed nothing, `/fill` drained
 * `{"filled":null,"remaining":0}`, and the read came back
 * `400 no such table: cache_container`. Every dev machine carries the chunks from an earlier build,
 * which is why only a clean checkout could see it.
 */
describe('what bake-container needs before it spawns wrangler', () => {
	const source = readFileSync(resolve(ROOT, 'scripts/bake-container.ts'), 'utf8');

	it('chunks the database itself when nothing else has', () => {
		expect(source).toContain('function ensureChunks');
		expect(source).toContain("'assets', 'drupal-sql', 'manifest.json'");
	});

	it('ensures them BEFORE the spawn, or the object has nothing to replay', () => {
		expect(source.indexOf('ensureChunks()')).toBeLessThan(source.indexOf('spawn('));
	});

	// a fill that renders nothing boots no kernel, and the read then names sqlite rather than the
	// empty queue that caused it
	it('fails on an empty fill instead of deferring to a confusing read error', () => {
		expect(source).toContain('the serve queued nothing');
	});
});
