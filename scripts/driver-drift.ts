import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDriverAssets } from './gen-driver-assets';

/**
 * Whether the driver the pack SHIPS is the driver `composer.lock` NAMES.
 *
 * THIS CLOSES A HOLE IN "THE LOCK IS AUTHORITATIVE". `composer.lock` names
 * `drupflare/drupflare`, `drupflare/rom` and `drupflare/stream-http`, and `gen-driver-assets.ts`
 * packs `assets/driver.json` from the sibling WORKING TREES beside this repo. Nothing compared the
 * two, so the lock governed Drupal core and said nothing about the driver layer -- a third of the
 * shipping PHP.
 *
 * ## It compares BYTES against what composer installed, not a version string
 *
 * The first version of this ran `git describe --tags` on `../drupflare` and friends. Two things
 * wrong with that, and the second is the one that matters:
 *
 * - `../*` is a developer layout. CI clones to `.siblings/*` with no tags fetched, so
 *   `git describe` fails there and every package reads as drift.
 * - A working tree's git tag and a published composer version are different KINDS of thing. "18
 *   commits past a nightly tag" is not a statement about whether the code differs from v0.2.1; it
 *   is a statement about tags.
 *
 * Composer already installed the locked versions, into `.composer-vendor/` (this repo redirects
 * `vendor-dir`, because `vendor/` holds the php-wasm binaries). So the locked bytes are on disk, and
 * the honest question is whether the files the packer would ship match them. That needs no network,
 * no tags, and no `../` at all.
 *
 * ## What a difference means, and why it is not an error
 *
 * The packer reads the sibling checkout rather than a vendored copy, because a fourth copy is what
 * created the drift that deleting `drupal/` removed. So a sibling ahead of its published release is
 * ordinary development. A difference here says the lock does not describe the driver, which is worth
 * printing and is a refusal only when cutting a release. `bun run refresh -- --strict-driver` is that
 * case, and `.github/workflows/release.yml` runs this check for the same reason.
 */

/**
 * Each driver package: the mount the packer writes it to, and where that mount lives INSIDE the
 * installed package.
 *
 * `within` is not decoration. `stream-http` mounts at `libraries/drupflare-stream-http/src` and
 * composer installs it whole, so the packed `HttpsStreamWrapper.php` sits at `src/` in the installed
 * copy. Stripping the mount and looking at the package root reported it `only-packed` on a file that
 * was present and identical -- a false positive on every run.
 */
export const DRIVER_PACKAGES: { pkg: string; mount: string; within: string }[] = [
	{ pkg: 'drupflare/drupflare', mount: 'modules/custom/drupflare', within: '' },
	{ pkg: 'drupflare/rom', mount: 'modules/custom/cfw_do_sqlite', within: '' },
	{ pkg: 'drupflare/stream-http', mount: 'libraries/drupflare-stream-http/src', within: 'src' }
];

export interface InstalledPackage {
	name: string;
	version: string;
	/** absolute path to the installed copy */
	path: string;
}

/**
 * The driver packages composer installed, from `installed.json`.
 *
 * `installed.json` rather than `composer.lock`, because it records where each package LANDED as
 * well as which version won. `install-path` is relative to `.composer-vendor/composer/`.
 */
export function installedDriverPackages(root: string): InstalledPackage[] {
	const file = join(root, '.composer-vendor/composer/installed.json');
	if (!existsSync(file)) return [];
	const doc = JSON.parse(readFileSync(file, 'utf8')) as {
		packages?: { name: string; version: string; 'install-path'?: string }[];
	};
	const names = new Set(DRIVER_PACKAGES.map((d) => d.pkg));
	return (doc.packages ?? [])
		.filter((p) => names.has(p.name))
		.map((p) => ({
			name: p.name,
			version: p.version,
			path: join(root, '.composer-vendor/composer', p['install-path'] ?? '')
		}));
}

export interface FileDiff {
	/** the path inside the packed tree */
	path: string;
	state: 'differs' | 'only-packed' | 'only-installed';
}

export interface PackageDrift {
	pkg: string;
	/** the version composer installed, or null when it is not installed at all */
	version: string | null;
	/** files that disagree, capped for reporting */
	files: FileDiff[];
	agrees: boolean;
	why: string;
}

/** the packed path with its mount prefix removed, so it can be found in the installed copy */
function withinPackage(mount: string, packedPath: string): string | null {
	return packedPath.startsWith(`${mount}/`) ? packedPath.slice(mount.length + 1) : null;
}

/**
 * Compares the tree the packer would ship against the versions composer installed.
 *
 * @param packed - the packer's own map, so this cannot disagree with what ships
 */
export function driverDrift(
	packed: Record<string, string>,
	root: string,
	installed: InstalledPackage[] = installedDriverPackages(root)
): PackageDrift[] {
	const byName = new Map(installed.map((p) => [p.name, p]));
	return DRIVER_PACKAGES.map(({ pkg, mount, within }) => {
		const have = byName.get(pkg);
		if (have === undefined) {
			return {
				pkg,
				version: null,
				files: [],
				agrees: false,
				why: 'composer has not installed this package, so the lock cannot be checked against it'
			};
		}
		const files: FileDiff[] = [];
		for (const [packedPath, body] of Object.entries(packed)) {
			const rel = withinPackage(mount, packedPath);
			if (rel === null) continue;
			const installedFile = join(have.path, within, rel);
			if (!existsSync(installedFile)) {
				files.push({ path: packedPath, state: 'only-packed' });
				continue;
			}
			if (readFileSync(installedFile, 'utf8') !== body) {
				files.push({ path: packedPath, state: 'differs' });
			}
		}
		const agrees = files.length === 0;
		return {
			pkg,
			version: have.version,
			files,
			agrees,
			why: agrees
				? `matches the installed ${have.version}`
				: `${files.length} files differ from the installed ${have.version}`
		};
	});
}

/** the packages whose shipped bytes are not the locked ones */
export const drifted = (states: PackageDrift[]): PackageDrift[] => states.filter((s) => !s.agrees);

if (import.meta.main) {
	const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
	const states = driverDrift(await buildDriverAssets(), root);
	for (const s of states) {
		console.log(`${s.agrees ? 'ok   ' : 'DRIFT'} ${s.pkg.padEnd(26)} ${s.why}`);
		for (const f of s.files.slice(0, 6)) console.log(`        ${f.state.padEnd(15)} ${f.path}`);
		if (s.files.length > 6) console.log(`        ... ${s.files.length - 6} more`);
	}
	const bad = drifted(states);
	if (bad.length === 0) {
		console.log('\nthe packed driver is byte-identical to the versions the lock names');
		process.exit(0);
	}
	console.log(
		`\n${bad.length} of ${states.length} differ. assets/driver.json ships the sibling CHECKOUTS, ` +
			'so the lock describes the Drupal side of the pack and not the driver side.'
	);
	console.log('Ordinary while a sibling is being worked on. Publish and lock before a release.');
	process.exit(1);
}
