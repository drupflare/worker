/**
 * Resolving a package name to an archive and turning it into files the mount can serve.
 *
 * One pipeline for `composer require`, git-delivered modules and `npm install`; only the source
 * differs. The Worker fetches the archive, PHP only parses intent. `drupal/*` names resolve on
 * `packages.drupal.org`, since packagist answers 404 for Drupal projects.
 *
 * @module
 */
import { parseTar, tarEntryTree } from '@drupflare/untarl';
import { gunzipSync, unzipSync } from 'fflate';
import { satisfies } from './composer-constraint';
import { SHIPPED_CORE_VERSION } from './shipped-lock';

/** where a package's metadata lives */
export type Registry = 'composer' | 'npm';

/** a package version resolved to its archive and its mount */
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
	// packagist does not carry Drupal projects
	return name.startsWith('drupal/')
		? `https://packages.drupal.org/files/packages/8/p2/${name}.json`
		: `https://repo.packagist.org/p2/${name}.json`;
}

/**
 * Points a delivered PHP file's Fibers at `\PhpWasmSyncFiber`: the interpreter has no Fiber
 * backend, so `Fiber::start()` aborts the runtime. `use Fiber;` becomes an alias.
 */
export function portFibers(path: string, source: string): string {
	if (!/\.(php|module|inc|install|theme|profile)$/.test(path) || !source.includes('Fiber')) {
		return source;
	}
	const ported = source
		.replace(/\\Fiber\b/g, '\\PhpWasmSyncFiber')
		.replace(/^(\s*)use\s+Fiber\s*;/gm, '$1use PhpWasmSyncFiber as Fiber;');
	return path.endsWith('canvas/src/Plugin/DisplayVariant/CanvasPageVariant.php')
		? portCanvasVariant(ported)
		: ported;
}

/**
 * Canvas fills its component tree by suspending a fiber; the stand-in cannot suspend, so the loop
 * becomes a handler that answers each suspension inline (else Canvas renders an empty main).
 */
function portCanvasVariant(source: string): string {
	return source.replace(
		/\$fiber = new \\PhpWasmSyncFiber\(fn\(\) => \$component_tree->toRenderable\(\$entity, \$is_preview\)\);[\s\S]*?return \$fiber->getReturn\(\);/,
		`$previous = \\PhpWasmSyncFiber::$handler;
    \\PhpWasmSyncFiber::$handler = function ($instance) use ($title, &$messages_block_displayed, $main_content) {
      if ($instance instanceof TitleBlockPluginInterface) {
        $instance->setTitle($title);
        return NULL;
      }
      if ($instance instanceof MessagesBlockPluginInterface) {
        $messages_block_displayed = TRUE;
        return NULL;
      }
      return $instance instanceof Marker ? $main_content : NULL;
    };
    try {
      return $component_tree->toRenderable($entity, $is_preview);
    }
    finally {
      \\PhpWasmSyncFiber::$handler = $previous;
    }`
	);
}

/**
 * Where a registry lists a package's branches: composer 2 keeps tags in `name.json` and `dev-*`
 * branches in `name~dev.json`, on both registries.
 */
export function devMetadataUrl(url: string): string {
	return url.replace(/\.json$/, '~dev.json');
}

/** whether a constraint names a branch rather than a release */
export function asksForBranch(constraint?: string): boolean {
	return /^dev-|-dev$|@dev$/i.test(String(constraint ?? '').trim());
}

/**
 * The second place to look when drupal.org has no such package: a few `drupal/*` JS libraries
 * (`drupal/rat`, `drupal/klaro_js`) live on Packagist.
 */
export function fallbackMetadataUrl(registry: Registry, name: string): string | undefined {
	return registry !== 'npm' && name.startsWith('drupal/')
		? `https://repo.packagist.org/p2/${name}.json`
		: undefined;
}

/**
 * Where a package's files belong in the mounted tree, by composer `type`; a plain PHP package
 * goes under `vendor/`.
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
		case 'drupal-profile':
		case 'drupal-custom-profile':
			return `profiles/contrib/${short}`;
		default:
			return `vendor/${name}`;
	}
}

/**
 * A composer `p2` version list with `minified: composer/2.0` undone: each entry lists only changed
 * keys, and `__unset` removes one.
 */
export function expandMinified(list: readonly unknown[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	let previous: Record<string, unknown> = {};
	for (const raw of list) {
		const entry = { ...previous };
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (value === '__unset') delete entry[key];
			else entry[key] = value;
		}
		out.push(entry);
		previous = entry;
	}
	return out;
}

/**
 * The package requirements a composer entry declares, without the platform ones (`php`, `ext-*`
 * and the like, which `/installable` judges).
 */
export function packageRequirements(entry: Record<string, unknown>): Record<string, string> {
	const require = (entry['require'] ?? {}) as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const [name, constraint] of Object.entries(require)) {
		if (typeof constraint !== 'string') continue;
		if (!name.includes('/') || name.startsWith('composer-')) continue;
		out[name] = constraint;
	}
	return out;
}

/** one installed package's autoload declaration, as stored beside its files */
export type PackageAutoload = {
	/** composer name and version, registered with `Composer\InstalledVersions` */
	name?: string;
	version?: string;
	mount: string;
	autoload: {
		'psr-4'?: Record<string, string | string[]>;
		'psr-0'?: Record<string, string | string[]>;
		classmap?: string[];
		files?: string[];
	};
	/** class name to path, computed at install for the `classmap` entries */
	classmap?: Record<string, string>;
};

/** a PHP single-quoted literal */
const phpString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * The autoloader registrations composer would have written, as PHP for `settings.php` (where
 * `$class_loader` and `$app_root` exist). `files` go last since they may use the other classes.
 */
export function autoloadPhp(packages: readonly PackageAutoload[]): string {
	const lines: string[] = [];
	const files: string[] = [];
	const dirs = (mount: string, value: string | string[]) =>
		`[${(Array.isArray(value) ? value : [value])
			.map(
				(d) =>
					`$app_root . ${phpString(`/${mount}/${d}`.replace(/\/+$/, '').replace(/\/\/+/g, '/'))}`
			)
			.join(', ')}]`;
	for (const pkg of packages) {
		for (const [prefix, value] of Object.entries(pkg.autoload['psr-4'] ?? {})) {
			lines.push(`$class_loader->addPsr4(${phpString(prefix)}, ${dirs(pkg.mount, value)});`);
		}
		for (const [prefix, value] of Object.entries(pkg.autoload['psr-0'] ?? {})) {
			lines.push(`$class_loader->add(${phpString(prefix)}, ${dirs(pkg.mount, value)});`);
		}
		const map = Object.entries(pkg.classmap ?? {});
		if (map.length > 0) {
			lines.push(
				`$class_loader->addClassMap([${map
					.map(
						([cls, path]) =>
							`${phpString(cls)} => $app_root . ${phpString(`/${pkg.mount}/${path}`)}`
					)
					.join(', ')}]);`
			);
		}
		for (const file of pkg.autoload.files ?? []) files.push(`/${pkg.mount}/${file}`);
	}
	const named = packages.filter((p) => p.name && p.version);
	if (named.length > 0) {
		// a library reading its own version (Drush::getVersion) throws for a package the pack's
		// InstalledVersions has never heard of
		lines.push(
			'$cfw_iv = \\Composer\\InstalledVersions::getAllRawData()[0];',
			...named.map(
				(p) =>
					`$cfw_iv['versions'][${phpString(p.name as string)}] = ['pretty_version' => ${phpString(p.version as string)}, 'version' => ${phpString(composerVersion(p.version as string))}, 'reference' => null, 'type' => 'library', 'install_path' => $app_root . ${phpString(`/${p.mount}`)}, 'aliases' => [], 'dev_requirement' => false];`
			),
			'\\Composer\\InstalledVersions::reload($cfw_iv);'
		);
	}
	for (const file of files) lines.push(`require_once $app_root . ${phpString(file)};`);
	return lines.join('\n');
}

/** composer's normalized form of a release: four numeric parts, then the stability suffix */
export function composerVersion(version: string): string {
	const v = version.replace(/^v/, '');
	const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(-.+)?$/.exec(v);
	if (!m) return v;
	return `${[m[1], m[2] ?? '0', m[3] ?? '0', m[4] ?? '0'].join('.')}${m[5] ?? ''}`;
}

/** a build-delivered vendor package: what to register, and where its files were mounted */
export type AutoloadDeclaration = PackageAutoload & { name: string; version: string };

const strings = (v: unknown): string[] | undefined =>
	Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

const prefixMap = (v: unknown): Record<string, string | string[]> | undefined => {
	if (v === undefined) return {};
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
	const out: Record<string, string | string[]> = {};
	for (const [prefix, dirs] of Object.entries(v)) {
		if (typeof dirs === 'string') out[prefix] = dirs;
		else if (strings(dirs) !== undefined) out[prefix] = dirs as string[];
		else return undefined;
	}
	return out;
};

/**
 * Reads the `autoload` a `/modify` commit may carry; the mount must sit under `vendor/` or
 * `libraries/` and not climb out. `undefined` is "none sent".
 */
export function parseAutoloadDeclaration(
	value: unknown
): AutoloadDeclaration | 'invalid' | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
	const v = value as Record<string, unknown>;
	const raw = (v['autoload'] ?? {}) as Record<string, unknown>;
	const psr4 = prefixMap(raw['psr-4']);
	const psr0 = prefixMap(raw['psr-0']);
	const classmap = raw['classmap'] === undefined ? [] : strings(raw['classmap']);
	const files = raw['files'] === undefined ? [] : strings(raw['files']);
	if (
		typeof v['name'] !== 'string' ||
		!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(v['name']) ||
		typeof v['version'] !== 'string' ||
		typeof v['mount'] !== 'string' ||
		!/^(vendor|libraries)\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(v['mount']) ||
		v['mount'].split('/').includes('..') ||
		psr4 === undefined ||
		psr0 === undefined ||
		classmap === undefined ||
		files === undefined ||
		[...(classmap ?? []), ...(files ?? [])].some((p) => p.split('/').includes('..'))
	) {
		return 'invalid';
	}
	return {
		name: v['name'],
		version: v['version'],
		mount: v['mount'],
		autoload: { 'psr-4': psr4, 'psr-0': psr0, classmap, files }
	};
}

/** class name to mount-relative path for a package's `classmap` roots, over files already read */
export function classmapOf(
	mount: string,
	autoload: PackageAutoload['autoload'],
	files: readonly { path: string; source: string }[]
): Record<string, string> {
	const classmap: Record<string, string> = {};
	for (const root of autoload.classmap ?? []) {
		const prefix = `${mount}/${root}`.replace(/\/+$/, '');
		for (const file of files) {
			if (!file.path.endsWith('.php') || !file.path.startsWith(prefix)) continue;
			for (const cls of declaredClasses(file.source)) {
				classmap[cls] = file.path.slice(mount.length + 1);
			}
		}
	}
	return classmap;
}

/**
 * The classes a PHP source declares, for composer's `classmap` type; a regex is enough since a
 * classmap only needs names.
 */
export function declaredClasses(source: string): string[] {
	const ns = /^\s*namespace\s+([A-Za-z0-9_\\]+)\s*;/m.exec(source)?.[1] ?? '';
	const out: string[] = [];
	const re =
		/(?:^|<\?php)\s*(?:(?:final|abstract|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
	for (let m = re.exec(source); m !== null; m = re.exec(source)) {
		out.push(ns ? `${ns}\\${m[1]}` : (m[1] as string));
	}
	return out;
}

/**
 * Picks a version from a composer `p2` document: newest stable unless the constraint says
 * otherwise. Both registries list newest first, so the first match wins without sorting.
 */
export function pickVersion(
	doc: unknown,
	name: string,
	constraint?: string,
	core: string = SHIPPED_CORE_VERSION,
	stability: string = 'stable'
): Record<string, unknown> | undefined {
	const packages = (doc as { packages?: Record<string, unknown[]> })?.packages;
	const raw = packages?.[name];
	if (!Array.isArray(raw)) return undefined;
	const list = expandMinified(raw);

	// `@alpha` lowers stability per `||` branch; an inline alias (`a as b`) installs `a`
	const RANK = ['dev', 'alpha', 'beta', 'rc', 'stable'];
	const branches = (constraint ?? '')
		.split(/\s*\|\|?\s*/)
		.map((part) => {
			const bare = part.replace(/\s+as\s+\S+$/i, '').trim();
			const flag = /@(dev|alpha|beta|rc|stable)$/i.exec(bare)?.[1]?.toLowerCase();
			return { flag, wanted: bare.replace(/@(dev|alpha|beta|rc|stable)$/i, '').trim() };
		})
		.filter((b) => b.wanted !== '' || b.flag !== undefined);
	const flag = branches.length === 1 ? branches[0]?.flag : undefined;
	const wanted = branches.map((b) => b.wanted).join(' || ');
	const admits = (version: string) =>
		branches.length === 0
			? stableAt(version, 'stable')
			: branches.some(
					(b) =>
						stableAt(version, b.flag ?? 'stable') &&
						(b.wanted === '' ||
							// `^3.0` starts at 3.0.0-dev, so an admitted pre-release
							// counts as its release
							satisfies(
								b.flag
									? version.replace(/-(dev|alpha|beta|rc)[\d.]*$/i, '')
									: version,
								b.wanted
							) === 'yes')
				);
	function stableAt(version: string, floor: string) {
		const found = /-(dev|alpha|beta|rc)/i.exec(version)?.[1]?.toLowerCase() ?? 'stable';
		return RANK.indexOf(found) >= RANK.indexOf(floor);
	}

	// an exact version wins outright, which is how a pre-release is asked for by name
	for (const b of branches) {
		const exact = list.find(
			(entry) =>
				String(entry['version'] ?? '').replace(/^v/i, '') === b.wanted.replace(/^v/i, '')
		);
		if (exact) return exact;
	}
	// a release requiring a Drupal core the site does not run is not installable
	const admitsCore = (entry: Record<string, unknown>) => {
		const need = (entry['require'] as Record<string, unknown> | undefined)?.['drupal/core'];
		return typeof need !== 'string' || satisfies(core, need) !== 'no';
	};
	// newest first, so the earliest admitted entry is composer's pick
	for (const entry of list) {
		const version = String(entry['version'] ?? '');
		if (version !== '' && admitsCore(entry) && admits(version)) return entry;
	}
	// a root whose minimum-stability is below stable (Open Y's is dev) still prefers a stable
	// release, and takes the newest pre-release the range admits only when there is none
	if (stability !== 'stable' && RANK.includes(stability)) {
		for (const entry of list) {
			const version = String(entry['version'] ?? '');
			if (version === '' || version.startsWith('dev-') || !admitsCore(entry)) continue;
			if (!stableAt(version, stability)) continue;
			const judged = version.replace(/-(dev|alpha|beta|rc)[\d.]*$/i, '');
			if (
				branches.length === 0 ||
				branches.some((b) => b.wanted === '' || satisfies(judged, b.wanted) === 'yes')
			)
				return entry;
		}
		// and a branch counts as the highest version its alias names, as composer reads `2.x-dev`
		if (stability === 'dev') {
			for (const entry of list) {
				const version = String(entry['version'] ?? '');
				const extra = entry['extra'] as Record<string, unknown> | undefined;
				const alias = (extra?.['branch-alias'] as Record<string, string> | undefined)?.[
					version
				];
				if (!version.startsWith('dev-') || !alias || !admitsCore(entry)) continue;
				const top = alias.replace(/-dev$/i, '').replace(/x/gi, '9999999');
				if (branches.some((b) => b.wanted !== '' && satisfies(top, b.wanted) === 'yes'))
					return entry;
			}
		}
	}
	// prefer-stable: with no stable release for this core, the newest pre-release that admits it
	if (wanted === '' && flag === undefined) {
		for (const entry of list) {
			const version = String(entry['version'] ?? '');
			if (/-(alpha|beta|rc)/i.test(version) && admitsCore(entry)) return entry;
		}
	}
	// no constraint and nothing stable: a dev-only package still installs
	if (wanted === '') return list[0];
	return undefined;
}

/**
 * A drupal.org submodule, published as an archive-less `metapackage` requiring its parent; nothing
 * to fetch, but its requirements are still walked.
 */
export function isMetapackage(entry: Record<string, unknown>): boolean {
	return entry['type'] === 'metapackage' && !(entry['dist'] as { url?: string } | undefined)?.url;
}

/**
 * An archive URL for a branch published with a git source and no dist, which is how drupal.org
 * lists `dev-2.x`. Both hosts serve a zip of any ref; anything else stays undownloadable.
 */
export function branchArchive(entry: Record<string, unknown>): string | undefined {
	const source = entry['source'] as { url?: string; reference?: string } | undefined;
	const ref = source?.reference;
	if (!source?.url || !ref) return undefined;
	const drupal = /^https:\/\/git\.drupalcode\.org\/project\/([a-z0-9_]+)\.git$/.exec(source.url);
	if (drupal)
		return `https://git.drupalcode.org/project/${drupal[1]}/-/archive/${ref}/${drupal[1]}-${ref}.zip`;
	const github = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(source.url);
	if (github) return `https://codeload.github.com/${github[1]}/zip/${ref}`;
	return undefined;
}

/** reads the archive location out of a resolved composer or npm entry */
export function distOf(entry: Record<string, unknown>, name: string): ResolvedPackage | undefined {
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
	const url = dist?.url || branchArchive(entry);
	if (!url) return undefined;
	return {
		name,
		version,
		url,
		type: dist?.type === 'tar' ? 'tar' : 'zip',
		shasum: dist?.shasum === '' ? undefined : dist?.shasum,
		mount: mountFor(name, typeof entry['type'] === 'string' ? entry['type'] : undefined)
	};
}

/**
 * What a package archive may contribute: an allow-list, so tests and assets never become rows
 * that cost storage and never run.
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
	/\.css$/,
	// data PHP reads at runtime (jquery_ui's library list is a json file)
	/\.json$/
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

/** the record cap in bytes; a larger file is refused rather than truncated */
export const RECORD_CAP = 2_199_995;

/** one kept file, at its mounted path */
export type UnpackedFile = { path: string; bytes: Uint8Array };

/** what an unpack kept and what it skipped */
export type UnpackResult = {
	files: UnpackedFile[];
	/** paths dropped, with why, so a thin install is explainable rather than mysterious */
	skipped: { path: string; why: string }[];
	totalBytes: number;
};

/**
 * Unpacks a zip and keeps only what a mounted tree can use. The wrapping folder (`token-8.x-1.17/`)
 * is stripped, or discovery would never find the files.
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
 * Unpacks a gzipped tarball, which is what npm serves; `tarEntryTree(entries, 1)` strips npm's
 * leading `package/` as {@link commonPrefix} does for a zip.
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

/** the single leading directory a dist archive wraps its contents in, or '' */
export function commonPrefix(paths: readonly string[]): string {
	const first = paths.find((p) => p.includes('/'));
	if (!first) return '';
	const candidate = `${first.split('/')[0]}/`;
	return paths.every((p) => p.startsWith(candidate) || p === candidate.slice(0, -1))
		? candidate
		: '';
}
