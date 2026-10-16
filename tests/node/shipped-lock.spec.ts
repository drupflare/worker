import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contribPins } from '../../scripts/fetch-drupal-tree';
import { readLock } from '../../scripts/lock';
import { shippedLock } from '../../src/ops/lock-map';
import {
	SHIPPED_CORE_VERSION,
	SHIPPED_LOCK_VERSIONS,
	SHIPPED_PROVIDES
} from '../../src/ops/shipped-lock';

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
 * THE ROOT LOCK IS THE ONLY PLACE THESE FACTS ARE WRITTEN.
 *
 * There used to be a generated TypeScript copy of the lock's map, a script that wrote it and a spec
 * that compared the two, because a copy invites drift. The runtime now bundles `composer.lock`
 * itself and the scripts read it from disk, so a renovate bump of the lock is the whole change and
 * there is nothing left to compare.
 *
 * What stays is what is true of the lock rather than of a copy of it: a core below 11.3 cannot run
 * the driver module at all, and a tree fetched at another minor than the lock names is a pack
 * rebuild rather than a dependency refresh.
 */
describe('the shipped core version', () => {
	it('is a version', () => {
		expect(readLock().core).toMatch(/^\d+\.\d+/);
	});

	it('is at or above the floor the drupflare module declares', () => {
		// ^11.3 -- measured, because 11.0/11.1/11.2 all fatal. A shipped core below that floor
		// means the site cannot run its own driver
		const [major, min] = readLock().core.split('.').map(Number) as [number, number];
		expect(major).toBeGreaterThanOrEqual(11);
		if (major === 11) expect(min).toBeGreaterThanOrEqual(3);
	});
});

describe('shippedLock', () => {
	const lock = {
		packages: [
			{
				name: 'drupal/core',
				version: '11.9.9',
				replace: { 'drupal/core-datetime': 'self.version' }
			},
			{
				name: 'symfony/console',
				version: 'v7.4.1',
				provide: { 'psr/log-implementation': '1.0' }
			}
		]
	};

	it('reads versions, virtual packages and the core from one parsed lock', () => {
		expect(shippedLock(lock)).toEqual({
			versions: { 'drupal/core': '11.9.9', 'symfony/console': 'v7.4.1' },
			provides: { 'drupal/core-datetime': '11.9.9', 'psr/log-implementation': '1.0' },
			core: '11.9.9'
		});
	});

	it('reports an empty core rather than throwing when the lock does not pin one', () => {
		expect(shippedLock({ packages: [] }).core).toBe('');
		expect(shippedLock({}).core).toBe('');
	});

	// bun resolves a bare `.lock` import to a file path, and every workflow resolves the Drupal
	// version through a script that reaches this module, so the import has to say it is text
	it('resolves under bun, which is what the workflows run', () => {
		const out = execFileSync('bun', ['scripts/fetch-drupal-tree.ts', '--print-version'], {
			cwd: ROOT,
			encoding: 'utf8'
		});
		expect(out.trim()).toBe(readLock().core);
	});

	it('is what the bundled module exports, so the runtime and the scripts cannot disagree', () => {
		const disk = readLock();
		expect(SHIPPED_LOCK_VERSIONS).toEqual(disk.versions);
		expect(SHIPPED_PROVIDES).toEqual(disk.provides);
		expect(SHIPPED_CORE_VERSION).toBe(disk.core);
	});

	it('names every package the root lock does, at the version it pins', () => {
		const onDisk = JSON.parse(readFileSync(resolve(ROOT, 'composer.lock'), 'utf8')) as {
			packages: { name: string; version: string }[];
		};
		expect(readLock().versions).toEqual(
			Object.fromEntries(onDisk.packages.map((p) => [p.name, p.version]))
		);
	});
});

describe('the root composer lock', () => {
	it('carries a core version', () => {
		expect(coreIn('composer.lock')).toMatch(/^\d+\.\d+/);
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
		expect(minor(src)).toBe(minor(readLock().core));
	});
});
