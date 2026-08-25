import { parseTar, tarEntryTree } from '@drupflare/untarl';
import { gunzipSync, unzipSync } from 'fflate';

/**
 * Resolving a package name to source, and turning that source into files the mount can serve.
 *
 * ## One pipeline, three callers
 *
 * `composer require`, a git-delivered custom module and `npm install` all want the same
 * four steps: resolve a name to an archive URL, fetch it, filter what comes out, and write the files
 * where the boot mount reads them. Building three of those would produce three sets of bugs, so this
 * is the one, and the SOURCE is the only thing that differs.
 *
 * ## Why the host does this and not PHP
 *
 * PHP here cannot block on a socket, so a composer-shaped resolve-then-download is impossible inside
 * one render. It is also unnecessary: the archive is an ordinary HTTPS GET, which the Worker does
 * natively. The terminal parses intent in PHP and hands it over.
 *
 * ## The two repositories, which are not interchangeable
 *
 * Drupal modules are NOT on packagist. `repo.packagist.org/p2/drupal/token.json` answers
 * "404 not found, no packages here"; the metadata lives on `packages.drupal.org`, which is the
 * composer repository every Drupal site already has in its `composer.json`. Everything else resolves
 * against packagist. Sending a `drupal/*` name to packagist is a silent "package does not exist",
 * which reads as a typo.
 */

/** where a package's metadata lives */
export type Registry = 'composer' | 'npm';

export type ResolvedPackage = {
	name: string;
	version: string;
	/** the archive to fetch */
	url: string;
	type: 'zip' | 'tar';
	/** the vendor's own digest, when the repository publishes one */
	shasum?: string;
	/** where the files land under the mounted tree */
	mount: string;
};

/** the metadata URL for one package */
export function metadataUrl(registry: Registry, name: string): string {
	if (registry === 'npm') return `https://registry.npmjs.org/${name}`;
	// packages.drupal.org for drupal/*, packagist for the rest. This is not a preference: packagist
	// does not carry Drupal projects at all
	return name.startsWith('drupal/')
		? `https://packages.drupal.org/files/packages/8/p2/${name}.json`
		: `https://repo.packagist.org/p2/${name}.json`;
}

/**
 * Where a package's files belong in the mounted tree.
 *
 * Driven by composer's own `type`, which is what a real install uses. A `drupal-module` goes to
 * `modules/contrib`, a library to `libraries`, and a plain PHP package to the vendor path the
 * autoloader already has a PSR-4 root for.
 */
export function mountFor(name: string, composerType?: string): string {
	const short = name.split('/')[1] ?? name;
	switch (composerType) {
		case 'drupal-module':
		case 'drupal-custom-module':
			return `modules/contrib/${short}`;
		case 'drupal-theme':
		case 'drupal-custom-theme':
			return `themes/contrib/${short}`;
		case 'drupal-library':
			return `libraries/${short}`;
		default:
			return `vendor/${name}`;
	}
}

/**
 * Picks a version from a composer `p2` document.
 *
 * NEWEST STABLE unless a constraint names otherwise, and stable means no `-dev`, `-alpha`, `-beta`
 * or `-RC` suffix. Both repositories list newest first, so this takes the first match rather than
 * sorting -- a real version sort is `composer/semver`'s job and importing that reasoning here would
 * be a second, worse copy of it.
 *
 * The constraint match is deliberately EXACT-OR-PREFIX rather than a range solver. A caret range
 * needs a real semver implementation, and answering one wrongly would install a version the site
 * cannot run. An unmatched constraint returns null, which the caller reports.
 */
export function pickVersion(
	doc: unknown,
	name: string,
	constraint?: string | null
): Record<string, unknown> | null {
	const packages = (doc as { packages?: Record<string, unknown[]> })?.packages;
	const list = packages?.[name];
	if (!Array.isArray(list)) return null;

	const stable = (v: string) => !/-(dev|alpha|beta|rc)/i.test(v);
	const wanted = (constraint ?? '').replace(/^[\^~v>=<\s]+/, '');

	for (const raw of list) {
		const entry = raw as Record<string, unknown>;
		const version = String(entry['version'] ?? '');
		if (version === '') continue;
		if (wanted === '') {
			if (stable(version)) return entry;
			continue;
		}
		if (version === wanted || version.startsWith(`${wanted}.`)) return entry;
	}
	// nothing stable at all: a package that only ever published a dev branch is a real case, and
	// refusing it outright would be wrong. Only reached when no constraint was given
	if (wanted === '') return (list[0] as Record<string, unknown>) ?? null;
	return null;
}

/** reads the archive location out of a resolved composer or npm entry */
export function distOf(entry: Record<string, unknown>, name: string): ResolvedPackage | null {
	const version = String(entry['version'] ?? '');

	// npm shape
	const npmDist = (entry as { dist?: { tarball?: string; shasum?: string } })['dist'];
	if (npmDist?.tarball) {
		return {
			name,
			version,
			url: npmDist.tarball,
			type: 'tar',
			shasum: npmDist.shasum,
			mount: `libraries/${name.replace(/^@/, '').replace('/', '-')}`
		};
	}

	// composer shape
	const dist = entry['dist'] as { url?: string; type?: string; shasum?: string } | undefined;
	if (!dist?.url) return null;
	return {
		name,
		version,
		url: dist.url,
		type: dist.type === 'tar' ? 'tar' : 'zip',
		shasum: dist.shasum === '' ? undefined : dist.shasum,
		mount: mountFor(name, typeof entry['type'] === 'string' ? entry['type'] : undefined)
	};
}

/**
 * What a package archive may contribute.
 *
 * An allow-list, for the reason `gen-driver-assets.ts` gives about repository checkouts: an archive
 * is not a module, and unpacking one wholesale pulls `tests/`, `node_modules/` and every dotfile
 * into rows that cost storage and can never be executed.
 */
export const KEEP = [
	/\.php$/,
	/\.inc$/,
	/\.module$/,
	/\.install$/,
	/\.theme$/,
	/\.profile$/,
	/\.engine$/,
	/\.yml$/,
	/\.twig$/,
	/\.js$/,
	/\.css$/
] as const;

/** paths that never belong in a mounted tree even when their extension passes */
export const DROP = [
	/(^|\/)tests?\//i,
	/(^|\/)node_modules\//,
	/(^|\/)vendor\//,
	/(^|\/)\.github\//,
	/(^|\/)\./,
	/(^|\/)coverage\//i
] as const;

/** the record cap; a file above it cannot be one row and is refused rather than silently truncated */
export const RECORD_CAP = 2_199_995;

export type UnpackedFile = { path: string; bytes: Uint8Array };

export type UnpackResult = {
	files: UnpackedFile[];
	/** paths dropped, with why, so a thin install is explainable rather than mysterious */
	skipped: { path: string; why: string }[];
	totalBytes: number;
};

/**
 * Unpacks a zip and keeps only what a mounted tree can use.
 *
 * THE LEADING DIRECTORY IS STRIPPED. Every archive from both repositories wraps its contents in one
 * top-level folder named for the project and version (`token-8.x-1.17/`), and keeping it would mount
 * every file one level too deep, where the extension discovery never looks.
 */
export function unpackZip(archive: Uint8Array, mount: string): UnpackResult {
	const entries = unzipSync(archive);
	const paths = Object.keys(entries);
	const prefix = commonPrefix(paths);
	return collect(
		paths.map((raw) => {
			const rel = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
			return [rel, entries[raw] as Uint8Array] as const;
		}),
		mount
	);
}

/**
 * Unpacks a gzipped tarball, which is what npm serves.
 *
 * `@drupflare/untarl` is a sibling package and already a dependency, so there is no reason for the
 * tar path to be a refusal. `tarEntryTree(entries, 1)` strips the single leading directory for the
 * same reason {@link commonPrefix} does on the zip side, and npm's is always `package/`.
 */
export function unpackTar(archive: Uint8Array, mount: string): UnpackResult {
	// npm serves `.tgz`; a bare `.tar` would already start with the ustar header rather than 0x1f8b
	const raw = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive) : archive;
	return collect([...tarEntryTree(parseTar(raw), 1).entries()], mount);
}

/** the filter both unpackers share, so a zip and a tarball cannot diverge on what they keep */
function collect(entries: readonly (readonly [string, Uint8Array])[], mount: string): UnpackResult {
	const files: UnpackedFile[] = [];
	const skipped: { path: string; why: string }[] = [];
	let totalBytes = 0;

	for (const [rel, bytes] of entries) {
		if (rel === '' || rel.endsWith('/')) continue;
		if (DROP.some((re) => re.test(rel))) {
			skipped.push({ path: rel, why: 'not part of a mountable tree' });
			continue;
		}
		if (!KEEP.some((re) => re.test(rel))) {
			skipped.push({ path: rel, why: 'extension is not executable or readable here' });
			continue;
		}
		if (bytes.length > RECORD_CAP) {
			skipped.push({ path: rel, why: `${bytes.length} bytes exceeds the record cap` });
			continue;
		}
		files.push({ path: `${mount}/${rel}`, bytes });
		totalBytes += bytes.length;
	}
	return { files, skipped, totalBytes };
}

/** the single leading directory every dist archive wraps its contents in, or '' when there is none */
export function commonPrefix(paths: readonly string[]): string {
	const first = paths.find((p) => p.includes('/'));
	if (!first) return '';
	const candidate = `${first.split('/')[0]}/`;
	return paths.every((p) => p.startsWith(candidate) || p === candidate.slice(0, -1))
		? candidate
		: '';
}
