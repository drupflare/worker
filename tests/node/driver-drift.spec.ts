import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	DRIVER_PACKAGES,
	type InstalledPackage,
	drifted,
	driverDrift,
	installedDriverPackages
} from '../../scripts/driver-drift';

/**
 * Whether the driver the pack ships is the driver the lock names.
 *
 * Nothing compared them: `composer.lock` names three sibling packages and `assets/driver.json` is
 * packed from their working trees. The comparison is BYTE-level against what composer installed
 * under `.composer-vendor/`, because a working tree's git tag and a published composer version are
 * different kinds of thing -- and because `../*` is a developer layout that CI does not have.
 *
 * Driven over a temporary installed tree, so no case here depends on what is checked out beside the
 * repo or on which versions happen to be published today.
 */

const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** an installed package on disk, with the files it should hold */
function installed(pkg: string, version: string, files: Record<string, string>): InstalledPackage {
	const root = mkdtempSync(join(tmpdir(), 'drift-'));
	roots.push(root);
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), body);
	}
	return { name: pkg, version, path: root };
}

const MOUNT = {
	drupflare: 'modules/custom/drupflare',
	rom: 'modules/custom/cfw_do_sqlite',
	streamHttp: 'libraries/drupflare-stream-http/src'
};

/** all three installed and matching the packed map, so a case can perturb exactly one thing */
function agreeing(): { packed: Record<string, string>; installedSet: InstalledPackage[] } {
	const packed = {
		[`${MOUNT.drupflare}/drupflare.module`]: '<?php // module',
		[`${MOUNT.drupflare}/src/Host.php`]: '<?php // host',
		[`${MOUNT.rom}/cfw_do_sqlite.info.yml`]: 'name: ROM',
		[`${MOUNT.streamHttp}/HttpsStreamWrapper.php`]: '<?php // wrapper'
	};
	return {
		packed,
		installedSet: [
			installed('drupflare/drupflare', 'v0.2.1', {
				'drupflare.module': '<?php // module',
				'src/Host.php': '<?php // host'
			}),
			installed('drupflare/rom', 'v0.2.0', { 'cfw_do_sqlite.info.yml': 'name: ROM' }),
			// `src/`, because the MOUNT already ends in src and the installed package does not.
			// Getting this wrong reported an identical file as `only-packed` on every run
			installed('drupflare/stream-http', 'v0.1.2', {
				'src/HttpsStreamWrapper.php': '<?php // wrapper'
			})
		]
	};
}

describe('driverDrift', () => {
	it('agrees when every packed file matches the installed copy', () => {
		const { packed, installedSet } = agreeing();
		expect(drifted(driverDrift(packed, '/unused', installedSet))).toEqual([]);
	});

	it('resolves a mount that already ends in src against the package src directory', () => {
		// the false positive this had: stripping the mount and looking at the package root
		const { packed, installedSet } = agreeing();
		const states = driverDrift(packed, '/unused', installedSet);
		const http = states.find((s) => s.pkg === 'drupflare/stream-http');
		expect(http?.agrees, JSON.stringify(http?.files)).toBe(true);
	});

	it('names the file that differs, not just the package', () => {
		const { packed, installedSet } = agreeing();
		packed[`${MOUNT.drupflare}/src/Host.php`] = '<?php // host, edited locally';
		const drift = drifted(driverDrift(packed, '/unused', installedSet));
		expect(drift).toHaveLength(1);
		expect(drift[0]?.files).toEqual([
			{ path: 'modules/custom/drupflare/src/Host.php', state: 'differs' }
		]);
		expect(drift[0]?.why).toBe('1 files differ from the installed v0.2.1');
	});

	it('reports a file the pack ships that the released version does not have', () => {
		const { packed, installedSet } = agreeing();
		packed[`${MOUNT.drupflare}/src/BrandNew.php`] = '<?php // added since the release';
		const drift = drifted(driverDrift(packed, '/unused', installedSet));
		expect(drift[0]?.files[0]?.state).toBe('only-packed');
	});

	it('drifts when composer has not installed a package at all', () => {
		// "nothing to compare against" must not read as agreement; that is the whole failure mode
		const { packed, installedSet } = agreeing();
		const without = installedSet.filter((p) => p.name !== 'drupflare/rom');
		const drift = drifted(driverDrift(packed, '/unused', without));
		expect(drift).toHaveLength(1);
		expect(drift[0]?.pkg).toBe('drupflare/rom');
		expect(drift[0]?.version).toBeNull();
		expect(drift[0]?.why).toContain('composer has not installed this package');
	});

	it('ignores packed paths that belong to no driver package', () => {
		const { packed, installedSet } = agreeing();
		packed['modules/custom/somebody_else/x.php'] = '<?php';
		expect(drifted(driverDrift(packed, '/unused', installedSet))).toEqual([]);
	});

	it('reports the version it compared against, so a result names its own basis', () => {
		const { packed, installedSet } = agreeing();
		const states = driverDrift(packed, '/unused', installedSet);
		expect(states.map((s) => s.version)).toEqual(['v0.2.1', 'v0.2.0', 'v0.1.2']);
	});

	it('covers every package the packer mounts', () => {
		// the check is only as wide as this list; a fourth mounted package would ship uncompared
		expect(DRIVER_PACKAGES.map((d) => d.pkg).sort()).toEqual([
			'drupflare/drupflare',
			'drupflare/rom',
			'drupflare/stream-http'
		]);
	});
});

describe('installedDriverPackages', () => {
	it('is empty when composer has not installed anything, rather than throwing', () => {
		// a clean checkout with no `composer install` is a real state, and the caller reports it as
		// drift rather than crashing the build it is guarding
		expect(installedDriverPackages(mkdtempSync(join(tmpdir(), 'noinstall-')))).toEqual([]);
	});

	it('reads the real installed tree and finds all three', (ctx) => {
		const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
		const found = installedDriverPackages(root);
		// ctx.skip() rather than a bare return: a return prints a PASS, which is the reporting shape
		// that let a check be off on every machine that mattered
		if (found.length === 0) {
			ctx.skip('no .composer-vendor/; run `composer install` to exercise this');
			return;
		}
		expect(found.map((p) => p.name).sort()).toEqual([
			'drupflare/drupflare',
			'drupflare/rom',
			'drupflare/stream-http'
		]);
		for (const p of found) expect(p.version).toMatch(/^v?\d+\.\d+/);
	});
});
