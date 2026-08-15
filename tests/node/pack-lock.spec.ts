import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The pack's one-writer rule.
 *
 * Hermetic because the lock is taken BEFORE the first bake step, so a refused run never touches
 * `site.sqlite`, never shells out to composer or php, and costs one process spawn.
 */

const ROOT = join(import.meta.dirname, '../..');
const LOCK = join(ROOT, 'assets/drupal/.pack.lock');
const HELD = JSON.stringify({ pid: 999999, startedAt: '2026-08-12T00:00:00.000Z' });

/** a lock this test planted, distinguishable from a real one so cleanup cannot eat a live bake */
function plantLock(): void {
	writeFileSync(LOCK, HELD);
}

beforeEach(() => {
	if (existsSync(LOCK) && readFileSync(LOCK, 'utf8') !== HELD) {
		throw new Error(`a real bake holds ${LOCK}; refusing to run this test over it`);
	}
});

afterEach(() => {
	if (existsSync(LOCK) && readFileSync(LOCK, 'utf8') === HELD) rmSync(LOCK);
});

describe('two bakes cannot write the pack at once', () => {
	it('refuses a second bake and names who holds the lock', () => {
		plantLock();
		const r = spawnSync('bun', ['scripts/bake-pack.ts'], {
			cwd: ROOT,
			encoding: 'utf8',
			timeout: 60_000
		});
		const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
		expect(r.status).not.toBe(0);
		expect(output).toContain('another bake holds the pack lock');
		// naming the holder matters: the reflex on finding a mystery lock file is to delete it, and
		// this is what makes that an informed decision instead of a guess
		expect(output).toContain('999999');
	});

	it('does NOT delete the holder lock on its way out', () => {
		// the ordering that makes this true is that the exit handler is registered AFTER the acquire
		// succeeds; registering it first would let every refused run release someone else's claim
		plantLock();
		spawnSync('bun', ['scripts/bake-pack.ts'], {
			cwd: ROOT,
			encoding: 'utf8',
			timeout: 60_000
		});
		expect(existsSync(LOCK)).toBe(true);
		expect(readFileSync(LOCK, 'utf8')).toBe(HELD);
	});

	it('refuses before running any bake step, so the pack is untouched', () => {
		plantLock();
		const r = spawnSync('bun', ['scripts/bake-pack.ts'], {
			cwd: ROOT,
			encoding: 'utf8',
			timeout: 60_000
		});
		const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
		// the snapshot step is the first one and it prints its byte count; its absence is the proof
		// that nothing ran rather than that nothing was logged
		expect(output).not.toContain('site.sqlite.bak');
	});
});
