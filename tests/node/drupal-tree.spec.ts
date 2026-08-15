import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	contribPins,
	drupalVersion,
	installedVersion,
	missingContrib,
	tarballUrl
} from '../../scripts/fetch-drupal-tree';
import { SHIPPED_CORE_VERSION, SHIPPED_LOCK_VERSIONS } from '../../src/ops/shipped-lock';

/**
 * `drupal-src/` has one producer, and the workflow uses it too.
 *
 * The tree is what phpstan, an IDE and the sibling PHP suites resolve `\Drupal\Core\...` against, and
 * what `assets:twig`, `assets:core` and `assets:pack` read. It had no local producer at all: the
 * `.gitignore` comment named `scripts/vendor.ts`, which never touched it, and CI carried its own
 * inline `curl` line. Two descriptions of one artifact, one of them false.
 *
 * So the assertions here are mostly about there being ONE mechanism. A second `curl` reappearing in
 * the workflow is the failure this file exists to catch, because it would drift from the script
 * silently and both would look right in isolation.
 */

const ROOT = join(import.meta.dirname, '../..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/build.yml'), 'utf8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
	scripts: Record<string, string>;
};

const temps: string[] = [];

/** a tree stub carrying only what the two readers look at: the version constant and a lock */
function treeFixture(version: string, packages: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), 'cfw-drupal-tree-'));
	temps.push(dir);
	mkdirSync(join(dir, 'core/lib'), { recursive: true });
	writeFileSync(
		join(dir, 'core/lib/Drupal.php'),
		`<?php\nclass Drupal {\n  const VERSION = '${version}';\n}\n`
	);
	writeFileSync(
		join(dir, 'composer.lock'),
		JSON.stringify({
			packages: Object.entries(packages).map(([name, v]) => ({ name, version: v }))
		})
	);
	return dir;
}

afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('the version comes from what the repo says it ships', () => {
	it('defaults to SHIPPED_CORE_VERSION, which gen:lock writes from the tree itself', () => {
		expect(drupalVersion({})).toBe(SHIPPED_CORE_VERSION);
		expect(SHIPPED_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it('honours DRUPAL_VERSION, so an upgrade can be tried without editing a constant', () => {
		expect(drupalVersion({ DRUPAL_VERSION: '11.5.0' })).toBe('11.5.0');
		// an empty string is not an override; it is an unset variable that CI exported anyway
		expect(drupalVersion({ DRUPAL_VERSION: '' })).toBe(SHIPPED_CORE_VERSION);
	});

	it('builds the ftp.drupal.org URL the workflow used to build inline', () => {
		expect(tarballUrl('11.4.5')).toBe(
			'https://ftp.drupal.org/files/projects/drupal-11.4.5.tar.gz'
		);
	});
});

describe('a tree on disk is identified by Drupal own version constant', () => {
	it('reads it out of core/lib/Drupal.php', () => {
		expect(installedVersion(treeFixture('11.4.5'))).toBe('11.4.5');
	});

	it('returns null for a path that is not a Drupal tree, rather than throwing', () => {
		expect(installedVersion(join(tmpdir(), 'definitely-not-a-drupal-tree'))).toBeNull();
	});
});

describe('the release tarball is core only, so the contrib pins are part of the producer', () => {
	it('pins every contrib package in the shipped lock and no core package', () => {
		expect(contribPins()).toEqual([
			'drupal/admin_toolbar:3.6.3',
			'drupal/ctools:4.1.1',
			'drupal/pathauto:1.15.0',
			'drupal/token:1.17.0'
		]);
		// core ships inside the tarball; requiring it again would fight the extracted tree
		expect(contribPins().some((p) => p.startsWith('drupal/core'))).toBe(false);
	});

	it('reads the versions from SHIPPED_LOCK_VERSIONS rather than a second hardcoded list', () => {
		expect(contribPins({ 'drupal/token': '9.9.9' })).toEqual(['drupal/token:9.9.9']);
		for (const pin of contribPins()) {
			const at = pin.lastIndexOf(':');
			expect(SHIPPED_LOCK_VERSIONS[pin.slice(0, at)]).toBe(pin.slice(at + 1));
		}
	});

	it('asks for nothing when the tree already satisfies every pin', () => {
		const versions = Object.fromEntries(
			contribPins().map((p) => [
				p.slice(0, p.lastIndexOf(':')),
				p.slice(p.lastIndexOf(':') + 1)
			])
		);
		expect(missingContrib(treeFixture('11.4.5', versions))).toEqual([]);
	});

	it('asks for a pin the tree holds at the WRONG version, not just a missing one', () => {
		// the case a plain existence check would wave through, and the one that makes
		// shipped-lock.spec.ts red with nothing else reporting it
		const stale = { 'drupal/admin_toolbar': '3.0.0', 'drupal/ctools': '4.1.1' };
		expect(missingContrib(treeFixture('11.4.5', stale))).toEqual([
			'drupal/admin_toolbar:3.6.3',
			'drupal/pathauto:1.15.0',
			'drupal/token:1.17.0'
		]);
	});

	it('asks for all of them when there is no lock to read', () => {
		const bare = mkdtempSync(join(tmpdir(), 'cfw-drupal-bare-'));
		temps.push(bare);
		expect(missingContrib(bare)).toEqual(contribPins());
	});
});

describe('CI and a developer run the same producer', () => {
	it('is wired into package.json', () => {
		expect(PKG.scripts['fetch:drupal']).toBe('bun scripts/fetch-drupal-tree.ts');
	});

	it('is what the workflow calls, and the workflow keys its cache on the same version', () => {
		expect(WORKFLOW).toContain('bun run fetch:drupal');
		expect(WORKFLOW).toContain('bun scripts/fetch-drupal-tree.ts --print-version');
	});

	it('has no second mechanism hiding in the workflow', () => {
		// the inline curl+tar this replaced; a reappearing copy would drift from the script and
		// both would look correct read on their own
		expect(WORKFLOW).not.toContain('ftp.drupal.org');
		expect(WORKFLOW).not.toContain('--strip-components');
		expect(WORKFLOW).not.toContain('DRUPAL_VERSION:');
	});
});

describe('phpstan resolves against that tree and not a separate copy of Drupal', () => {
	const NEON = readFileSync(join(ROOT, 'phpstan.neon'), 'utf8');

	it('bootstraps the extracted tree own autoloader', () => {
		expect(NEON).toContain('drupal-src/autoload.php');
	});

	it('scans the .inc files that scanDirectories cannot see', () => {
		// procedural code is not autoloadable and phpstan only indexes `.php` when scanning a
		// directory, so install_drupal() and drupal_flush_all_caches() are named one by one
		expect(NEON).toContain('drupal-src/core/includes/common.inc');
		expect(NEON).toContain('drupal-src/core/includes/install.core.inc');
	});

	it('takes pw_bench_* from the real definitions rather than a stub that could drift', () => {
		expect(NEON).toContain('assets/probe/pw-probe.php');
	});
});
