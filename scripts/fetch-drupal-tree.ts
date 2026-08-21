/**
 * Materialises `drupal-src/` from the same tarball `.github/workflows/build.yml` fetches.
 *
 * ```sh
 * bun run fetch:drupal
 * bun scripts/fetch-drupal-tree.ts --force
 * DRUPAL_VERSION=11.5.0 bun scripts/fetch-drupal-tree.ts
 * ```
 *
 * The tree is a build input, gitignored, and 180 MB. CI has always had one -- the gate lane caches
 * it and extracts it before `bun run test:php` -- so this is not a broken CI lane being repaired.
 * What had no producer was the LOCAL copy, which is what phpstan, an IDE and the sibling PHP suites
 * resolve `\Drupal\Core\...` against.
 *
 * The workflow calls this script rather than carrying its own `curl` line, so there is one mechanism
 * and one version. `tests/node/drupal-tree.spec.ts` fails if the workflow grows a second one.
 *
 * The version comes from `SHIPPED_CORE_VERSION`, which is generated from the tree's own
 * `composer.lock` by `bun run gen:lock` and guarded by `tests/node/shipped-lock.spec.ts`. Fetching
 * the version the repo says it ships is what makes the local tree the one every recorded figure was
 * taken against.
 *
 * @see scripts/fetch-interpreter.ts for the other build input with no committed copy
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockVersions } from '../src/ops/packagist';
import { SHIPPED_CORE_VERSION, SHIPPED_LOCK_VERSIONS } from '../src/ops/shipped-lock';

/**
 * Where the tree lands, fixed rather than an argument.
 *
 * `--force` deletes this path, so it must not be something a caller can aim. scripts/README.md's
 * rule is that a script writing an artifact takes its output directory as an argument; the rule
 * above it is that a destructive step never gets one, and that rule wins here.
 */
export const DRUPAL_TREE = 'drupal-src';

/** what one run did, in the shape the CLI prints and the workflow summary reads */
export type FetchTreeResult = {
	version: string;
	root: string;
	action: 'extracted' | 'already-present';
	/** the contrib pins this run had to install; empty when the tree already satisfied them */
	contrib: string[];
	bytes: number;
};

/** the version to fetch: `DRUPAL_VERSION` when set, otherwise what the repo says it ships */
export function drupalVersion(env: NodeJS.ProcessEnv = process.env): string {
	return env.DRUPAL_VERSION || SHIPPED_CORE_VERSION;
}

export function tarballUrl(version: string): string {
	return `https://ftp.drupal.org/files/projects/drupal-${version}.tar.gz`;
}

/**
 * Reads the version out of a tree on disk.
 *
 * From `core/lib/Drupal.php` rather than `composer.lock`, because the constant is what Drupal itself
 * reports and it is present in every packaging of the tree.
 *
 * @returns the version, or null when the path is not a Drupal tree.
 */
export function installedVersion(root = DRUPAL_TREE): string | null {
	const marker = join(root, 'core/lib/Drupal.php');
	if (!existsSync(marker)) return null;
	return /const\s+VERSION\s*=\s*'([^']+)'/.exec(readFileSync(marker, 'utf8'))?.[1] ?? null;
}

/**
 * Downloads the tarball, retrying a failed attempt twice.
 *
 * @param version - a Drupal core version, e.g. `11.4.5`
 * @returns the path it wrote, under the system temp directory rather than the repo.
 */
export async function downloadTarball(version: string, attempts = 3): Promise<string> {
	const out = join(tmpdir(), `drupal-${version}.tar.gz`);
	let last = '';
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(tarballUrl(version));
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
			return out;
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
	}
	throw new Error(`could not fetch ${tarballUrl(version)} in ${attempts} attempts: ${last}`);
}

/**
 * The contributed modules the tarball does NOT carry, pinned to the versions the repo ships.
 *
 * The release tarball is core only, and `SHIPPED_LOCK_VERSIONS` names four contrib packages beyond
 * it. Extracting the tarball alone therefore produces a tree whose `composer.lock` disagrees with
 * the baked map, which `tests/node/shipped-lock.spec.ts` reports as drift -- correctly, because a
 * core-only tree is not the tree the shipped artifacts were built from.
 *
 * @returns `name:version` pins, sorted, ready to hand to `composer require`.
 */
export function contribPins(versions = SHIPPED_LOCK_VERSIONS): string[] {
	return Object.entries(versions)
		.filter(([name]) => name.startsWith('drupal/') && !name.startsWith('drupal/core'))
		.map(([name, version]) => `${name}:${version}`)
		.sort();
}

/** the pins a tree on disk does not already satisfy, so a second run installs nothing */
export function missingContrib(root = DRUPAL_TREE): string[] {
	const lockPath = join(root, 'composer.lock');
	if (!existsSync(lockPath)) return contribPins();
	const have = lockVersions(JSON.parse(readFileSync(lockPath, 'utf8')));
	return contribPins().filter((pin) => {
		const at = pin.lastIndexOf(':');
		return have[pin.slice(0, at)] !== pin.slice(at + 1);
	});
}

function installContrib(pins: string[]): void {
	try {
		// --no-audit: an advisory published against a pinned version would fail the gate lane for a
		// reason that has nothing to do with the change under test
		execFileSync(
			'composer',
			['require', '--no-interaction', '--no-progress', '--no-audit', ...pins],
			{ cwd: DRUPAL_TREE, stdio: 'inherit' }
		);
	} catch (e) {
		throw new Error(
			`composer could not install ${pins.join(' ')} into ${DRUPAL_TREE}. It is required: the ` +
				`release tarball is core only. ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

/**
 * Deletes the tree, having first made every directory writable.
 *
 * `rmSync(recursive, force)` is NOT enough here and the failure is destructive. Drupal's installer
 * leaves `drupal-src/sites/build` at mode 0555, and bun's `rmSync` throws `ENOTEMPTY` on it AFTER
 * it has already deleted `core/` -- so `--force` leaves a tree with no core and 4,253 orphaned
 * entries, and re-running fails at exactly the same place. Measured 2026-08-21 while rehearsing a
 * core upgrade; the documented `--force` rebuild could not complete on a tree that had ever been
 * installed into.
 *
 * `force: true` on rmSync means "do not error if the path is absent". It has nothing to do with
 * permissions, which is the reading that made this look already handled.
 */
function removeTree(path: string): void {
	// chmod before unlink: a directory needs the write bit to have entries removed FROM it
	try {
		execFileSync('chmod', ['-R', 'u+w', path]);
	} catch {
		// a tree that cannot be chmod'd may still be removable; let rmSync report the real reason
	}
	rmSync(path, { recursive: true, force: true });
}

/**
 * Puts the requested version in `drupal-src/`, or explains why it will not.
 *
 * A tree already at the requested version is left alone: it is 180 MB and re-extracting it would
 * rewrite every mtime, which `pack-drupal.ts` records into the index and Drupal's
 * MTimeProtectedFastFileStorage hashes into the compiled-Twig directory name.
 *
 * @param force - replace a tree that is present at a DIFFERENT version; without it that case throws
 *   rather than extracting over the top, because a mixed tree resolves classes from two releases
 */
export async function fetchDrupalTree(
	version = drupalVersion(),
	force = false
): Promise<FetchTreeResult> {
	const present = installedVersion();
	if (present && present !== version && !force) {
		throw new Error(
			`${DRUPAL_TREE} holds Drupal ${present} and ${version} was asked for. Pass --force to ` +
				`replace it, or set DRUPAL_VERSION=${present} to keep what is there.`
		);
	}

	let action: FetchTreeResult['action'] = 'already-present';
	if (present !== version || force) {
		const tarball = await downloadTarball(version);
		if (existsSync(DRUPAL_TREE)) removeTree(DRUPAL_TREE);
		mkdirSync(DRUPAL_TREE, { recursive: true });
		// --strip-components=1 drops the `drupal-<version>/` wrapper the release tarball carries,
		// which is what build.yml did inline before this script existed
		execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', DRUPAL_TREE]);
		rmSync(tarball, { force: true });
		action = 'extracted';

		const got = installedVersion();
		if (got !== version)
			throw new Error(`extracted tree reports Drupal ${got}, not ${version}`);
	}

	const contrib = missingContrib();
	if (contrib.length) installContrib(contrib);

	return {
		version,
		root: DRUPAL_TREE,
		action,
		contrib,
		bytes:
			Number(execFileSync('du', ['-sk', DRUPAL_TREE], { encoding: 'utf8' }).split(/\s/)[0]) *
			1024
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.includes('--print-version')) {
		// the workflow keys its cache on this, so it must be the only thing on stdout
		console.log(drupalVersion());
		process.exit(0);
	}
	if (args.includes('--help')) {
		console.error('usage: bun scripts/fetch-drupal-tree.ts [--force] [--print-version]');
		process.exit(2);
	}
	const result = await fetchDrupalTree(drupalVersion(), args.includes('--force'));
	console.log(
		`${result.root}  Drupal ${result.version} ${result.action}, ` +
			`${result.bytes.toLocaleString()} bytes on disk`
	);
	console.log(
		result.contrib.length
			? `contrib      installed ${result.contrib.join(' ')}`
			: 'contrib      already at the pinned versions'
	);
	console.log('this is what DRUPAL_ROOT points at for the sibling PHP suites and for phpstan');
}
