/**
 * What a composer project or install profile asks of a site, read from its files and never run.
 *
 * The corpus lane delivers a project registry first: every package the project requires goes through
 * `/install?deps=1` at the version its lock resolved, and the modules the repository carries itself
 * are uploaded. This module decides what to deliver and when the answer is already known.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { satisfies } from '../../src/ops/composer/constraint';
import {
	type InlinePackage,
	type RemoteRepository as Repository
} from '../../src/ops/composer/repositories';

/** core versions a constraint is tried against to see whether it admits any Drupal 11 release */
const ELEVEN = Array.from({ length: 10 }, (_, minor) =>
	Array.from({ length: 40 }, (_, patch) => `11.${minor}.${patch}`)
).flat();

/**
 * Whether a `core` constraint accepts some Drupal 11 release.
 *
 * `n/a` and an empty constraint make no claim about core, so they are admitted. A constraint the
 * parser cannot decide (`unknown`) is admitted as well: refusing a repository on a guess would hide
 * it from the lane.
 */
export function admitsDrupal11(constraint: string): boolean {
	const text = constraint.trim();
	if (text === '' || text === 'n/a') return true;
	return ELEVEN.some((v) => satisfies(v, text) !== 'no');
}

/** the note a repository that needs an upgrade to 11 is recorded with, or null when it runs */
export function upgradeNote(core: string): string | null {
	if (admitsDrupal11(core)) return null;
	const major = Number(core.match(/\d+/)?.[0]);
	const route =
		major === 10
			? 'drangler plans the 10 -> 11 upgrade'
			: `drangler upgrades from Drupal 10 only, so move it from Drupal ${major || 'this version'} to 10 first`;
	return `needs upgrade: core ${core} does not accept Drupal 11; ${route}`;
}

/** where a native install leaves its database and tree: outside the repository, in the OS temp directory unless `CORPUS_NATIVE_DIR` says otherwise */
export const nativeRoot = (env: Record<string, string | undefined> = process.env): string =>
	env['CORPUS_NATIVE_DIR'] ?? join(tmpdir(), 'drupflare-corpus-native');

/** what a native install did not do or did not honour, which a record of it has to carry */
export type NativeNotes = {
	patches: string[];
	advisories: string[];
	/** constraints the install relaxed, as `package: before -> after` */
	relaxed: string[];
	/** packages that resolved to a version other than the project's own lock, as `package: old -> new` */
	changed: string[];
};

/** the packages two lock files hold at different versions, a package the project locked and the build dropped included */
export function lockDivergence(projectLock: string, siteLock: string): string[] {
	const versions = (text: string): Map<string, string> => {
		try {
			const doc = JSON.parse(text) as { packages?: { name: string; version: string }[] };
			return new Map((doc.packages ?? []).map((p) => [p.name, p.version.replace(/^v/, '')]));
		} catch {
			return new Map();
		}
	};
	const wanted = versions(projectLock);
	const got = versions(siteLock);
	return [...wanted]
		.flatMap(([name, version]) => {
			const now = got.get(name);
			return now !== version ? [`${name}: ${version} -> ${now ?? 'absent'}`] : [];
		})
		.sort();
}

/** the patches composer could not apply and went on without, by their URL */
export function skippedPatches(log: string): string[] {
	const urls = new Set<string>();
	for (const m of log.matchAll(
		/Could not apply patch! Skipping\. The error was: Cannot apply patch (\S+)/g
	))
		urls.add(m[1] as string);
	for (const m of log.matchAll(/Cannot apply patch [^()]*\((https?:\/\/[^\s)]+)\)/g))
		urls.add(m[1] as string);
	return [...urls].sort();
}

/** the advisory ids `composer audit --format=json` lists, which a install with blocking off went past */
export function advisoryIds(audit: string): string[] {
	try {
		const doc = JSON.parse(audit) as { advisories?: Record<string, { advisoryId?: string }[]> };
		return [
			...new Set(
				Object.values(doc.advisories ?? {}).flatMap((list) =>
					(Array.isArray(list) ? list : []).flatMap((a) =>
						a.advisoryId ? [a.advisoryId] : []
					)
				)
			)
		].sort();
	} catch {
		return [];
	}
}

/** the notes of one native install, read from the log and audit it left in its output directory */
export function nativeNotes(out: string, cloneDir?: string): NativeNotes {
	const read = (name: string, dir = out) =>
		existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '';
	let relaxed: string[] = [];
	try {
		relaxed = JSON.parse(read('relaxed.json') || '[]') as string[];
	} catch {
		relaxed = [];
	}
	const projectLock = cloneDir === undefined ? '' : read('composer.lock', cloneDir);
	return {
		patches: skippedPatches(read('install.log')),
		advisories: advisoryIds(read('audit.json')),
		relaxed,
		changed:
			projectLock === ''
				? []
				: lockDivergence(projectLock, read('composer.lock', join(out, 'site')))
	};
}

/** the sentence a record carries when an install skipped patches or went past advisories, or undefined */
export function nativeNoteText(notes: NativeNotes): string | undefined {
	const parts = [
		notes.patches.length > 0
			? `not stock: ${notes.patches.length} composer patches did not apply and were skipped (${notes.patches.join(', ')})`
			: '',
		notes.advisories.length > 0
			? `advisory blocking was off for: ${notes.advisories.join(', ')}`
			: '',
		notes.relaxed.length > 0
			? `built with relaxed constraints (${notes.relaxed.join('; ')})`
			: '',
		notes.changed.length > 0
			? `${notes.changed.length} packages resolved off the project's lock (${notes.changed.slice(0, 20).join('; ')}${notes.changed.length > 20 ? '; ...' : ''})`
			: ''
	].filter(Boolean);
	return parts.length > 0 ? parts.join('; ') : undefined;
}

export type CustomCode = { name: string; dir: string; kind: 'module' | 'theme' };

export type ProjectPlan = {
	/** the install profile the project's own config names, or the profile package it requires */
	profile: string | null;
	/** packages to install from the registry, each at the version the lock resolved */
	packages: Record<string, string>;
	/** modules and themes the repository carries under a `custom` directory */
	custom: CustomCode[];
	/** modules `core.extension` enables, without the profile */
	modules: string[];
	/** composer patches the project applies, which the registry path does not */
	patches: number;
	/** the project's `minimum-stability` when it sets one, which every registry install honours */
	stability?: string;
	/** composer and GitHub repositories the project lists beyond Packagist and drupal.org */
	repositories?: Repository[];
	/** whether the project carries a `composer.lock`, which is where a package's type is read */
	locked?: boolean;
	/** what the lock records for each required package, for one no registry serves */
	inline?: Record<string, InlinePackage>;
};

/** install profiles the pack's own site already runs on */
const HOSTED_PROFILES = new Set(['standard', 'minimal']);

/** true when the project cannot be delivered without a fresh install under another profile */
export const needsProfileSwitch = (plan: ProjectPlan): boolean =>
	plan.profile !== null && !HOSTED_PROFILES.has(plan.profile);

/**
 * Modules the shipped core no longer carries, from `DRUPAL_CORE_REMOVED_MODULE_LIST` in its
 * system module. Core's own requirement text sends a site to the project of the same name, so a
 * project that enabled one under an older core has to require it.
 */
export const REMOVED_CORE_MODULES = [
	'action',
	'aggregator',
	'book',
	'ckeditor',
	'color',
	'forum',
	'hal',
	'quickedit',
	'rdf',
	'statistics',
	'tour',
	'tracker'
];

const SKIP_TYPES = new Set(['composer-plugin', 'metapackage', 'drupal-drush', 'drupal-core']);
const SKIP_VENDORS = ['drupal/core', 'composer/', 'cweagans/', 'wikimedia/', 'oomphinc/', 'drush/'];

function readJson<T>(file: string): T | null {
	return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

/**
 * every `*.info.yml` under `custom` directories, plus a module kept anywhere else in the project,
 * which Drupal's discovery finds too (a theme can carry one); vendor, dependencies and a core
 * checkout are not descended into
 */
function customCode(root: string): CustomCode[] {
	const out: CustomCode[] = [];
	const walk = (dir: string, inCustom: boolean) => {
		for (const name of readdirSync(dir)) {
			if (
				name.startsWith('.') ||
				['node_modules', 'vendor', 'tests', 'contrib'].includes(name) ||
				(name === 'core' && !inCustom)
			)
				continue;
			const full = join(dir, name);
			if (!statSync(full).isDirectory()) continue;
			const custom = inCustom || name === 'custom';
			const info = readdirSync(full).find((f) => f.endsWith('.info.yml'));
			if (info) {
				const doc = parse(readFileSync(join(full, info), 'utf8')) as {
					type?: string;
				} | null;
				const kind =
					doc?.type === 'theme' ? 'theme' : doc?.type === 'module' ? 'module' : null;
				if (kind && (custom || kind === 'module'))
					out.push({ name: info.replace(/\.info\.yml$/, ''), dir: full, kind });
				if (custom || kind === 'module') continue;
			}
			walk(full, custom);
		}
	};
	walk(root, false);
	return out;
}

type Lock = {
	packages?: {
		name: string;
		version: string;
		type?: string;
		require?: Record<string, string>;
		source?: { url?: string; reference?: string };
		dist?: { url?: string; type?: string; shasum?: string } | null;
	}[];
};
type Composer = {
	type?: string;
	'minimum-stability'?: string;
	repositories?: unknown;
	require?: Record<string, string>;
	extra?: {
		patches?: Record<string, Record<string, string>>;
		'patches-file'?: string | string[];
	};
};

function patchCount(root: string, composer: Composer): number {
	let count = Object.values(composer.extra?.patches ?? {}).reduce(
		(sum, one) => sum + Object.keys(one).length,
		0
	);
	const files = composer.extra?.['patches-file'];
	const named = files === undefined ? [] : Array.isArray(files) ? files : [files];
	const defaults = ['patches.json', 'composer.patches.json', 'patches.lock.json'];
	const read =
		named.length > 0 ? named : defaults.filter((f) => existsSync(join(root, f))).slice(0, 1);
	for (const name of read) {
		const doc = readJson<{ patches?: Record<string, unknown[] | Record<string, string>> }>(
			join(root, name)
		);
		for (const one of Object.values(doc?.patches ?? {}))
			count += Array.isArray(one) ? one.length : Object.keys(one).length;
	}
	return count;
}

/** the machine name of the install profile a repository carries, breadth-first and shallow */
export function carriedProfile(root: string): string | null {
	const queue: [string, number][] = [[root, 0]];
	while (queue.length > 0) {
		const [dir, depth] = queue.shift() as [string, number];
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (name.endsWith('.info.yml')) {
				const doc = parse(readFileSync(full, 'utf8')) as { type?: string } | null;
				if (doc?.type === 'profile') return name.replace(/\.info\.yml$/, '');
			} else if (
				depth < 3 &&
				!name.startsWith('.') &&
				!['node_modules', 'vendor', 'tests'].includes(name) &&
				statSync(full).isDirectory()
			) {
				queue.push([full, depth + 1]);
			}
		}
	}
	return null;
}

/** config/install files whose `id` differs from the id their file name carries */
export function configIdMismatches(moduleDir: string): { file: string; id: string }[] {
	const dir = join(moduleDir, 'config', 'install');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith('.yml'))
		.flatMap((file) => {
			const named = file
				.replace(/\.yml$/, '')
				.split('.')
				.at(-1);
			try {
				const doc = parse(readFileSync(join(dir, file), 'utf8')) as { id?: unknown } | null;
				return typeof doc?.id === 'string' && doc.id !== named
					? [{ file, id: doc.id }]
					: [];
			} catch {
				return [];
			}
		});
}

/** hosts the registry path already reads, so listing them would only repeat the lookup */
const STANDARD_HOSTS =
	/^https:\/\/(?:packages\.drupal\.org|repo\.packagist\.org|packagist\.org)(?:\/|$)/;

/** the repositories a composer file lists that the resolver can read: composer-type and GitHub */
export function projectRepositories(listed: unknown): Repository[] {
	const entries = Array.isArray(listed) ? listed : Object.values((listed ?? {}) as object);
	return entries.flatMap((entry) => {
		const { type, url } = (entry ?? {}) as { type?: string; url?: string };
		if (typeof url !== 'string' || !url.startsWith('https://') || STANDARD_HOSTS.test(url))
			return [];
		if (type === 'composer') return [{ type: 'composer', url } as Repository];
		return type === 'vcs' || type === 'git' || type === 'github'
			? [{ type: 'vcs', url } as Repository]
			: [];
	});
}

/** whether a registry document says its package is an install profile */
export function isProfileDocument(doc: unknown, name: string): boolean {
	const list = (doc as { packages?: Record<string, { type?: string }[]> } | null)?.packages?.[
		name
	];
	return Array.isArray(list) && list[0]?.type === 'drupal-profile';
}

/**
 * Fills in the install profile of a project with no lock, from the type drupal.org publishes for
 * each of its `drupal/` requirements; a lock is the only other place the type is written.
 */
export async function withRegistryProfile(
	plan: ProjectPlan,
	fetcher: typeof fetch = fetch
): Promise<ProjectPlan> {
	if (plan.locked || plan.profile !== null) return plan;
	for (const name of Object.keys(plan.packages)) {
		if (!name.startsWith('drupal/')) continue;
		const res = await fetcher(`https://packages.drupal.org/files/packages/8/p2/${name}.json`);
		if (res.ok && isProfileDocument(await res.json(), name))
			return { ...plan, profile: name.replace(/^drupal\//, '') };
	}
	return plan;
}

/** reads a project directory's composer files and its configuration sync directory */
export function projectPlan(root: string): ProjectPlan {
	const composer = readJson<Composer>(join(root, 'composer.json')) ?? {};
	const lock = readJson<Lock>(join(root, 'composer.lock'));
	const locked = new Map((lock?.packages ?? []).map((p) => [p.name, p]));

	const packages: Record<string, string> = {};
	const inline: Record<string, InlinePackage> = {};
	let profile: string | null = null;
	for (const [name, wanted] of Object.entries(composer.require ?? {})) {
		if (!name.includes('/') || SKIP_VENDORS.some((v) => name.startsWith(v))) continue;
		const one = locked.get(name);
		if (one?.dist?.url || one?.source?.url)
			inline[name] = {
				version: one.version,
				...(one.type ? { type: one.type } : {}),
				...(one.dist?.url
					? {
							dist: {
								url: one.dist.url,
								...(one.dist.type ? { type: one.dist.type } : {}),
								...(one.dist.shasum ? { shasum: one.dist.shasum } : {})
							}
						}
					: {}),
				...(one.source?.url && one.source.reference
					? { source: { url: one.source.url, reference: one.source.reference } }
					: {})
			};
		if (one?.type === 'drupal-profile') profile = name.replace(/^drupal\//, '');
		if (one && SKIP_TYPES.has(one.type ?? '')) continue;
		const version = one ? one.version.replace(/^v/, '') : wanted;
		// a branch is held at the commit the lock recorded, because the branch has moved since
		const ref = one?.source?.reference;
		packages[name] =
			/^dev-|-dev$/.test(version) && ref && /^[0-9a-f]{7,40}$/.test(ref)
				? `${version}#${ref}`
				: version;
	}
	if (composer.type === 'drupal-profile') profile = carriedProfile(root) ?? 'this repository';

	let modules: string[] = [];
	const sync = ['config/sync', 'config/default', 'config']
		.map((d) => join(root, d, 'core.extension.yml'))
		.find((f) => existsSync(f));
	if (sync) {
		const doc = parse(readFileSync(sync, 'utf8')) as {
			module?: Record<string, number>;
			profile?: string;
		};
		modules = Object.keys(doc.module ?? {}).filter((m) => m !== doc.profile);
		profile = doc.profile ?? profile;
	}
	for (const name of modules) {
		if (REMOVED_CORE_MODULES.includes(name) && !(`drupal/${name}` in packages))
			packages[`drupal/${name}`] = '*';
	}
	return {
		profile,
		packages,
		custom: customCode(root),
		modules,
		patches: patchCount(root, composer),
		repositories: projectRepositories(composer.repositories),
		locked: lock !== null,
		...(Object.keys(inline).length > 0 ? { inline } : {}),
		...(composer['minimum-stability'] ? { stability: composer['minimum-stability'] } : {})
	};
}

export type InstallPath = 'registry' | 'migration';

/**
 * How a repository reaches drupflare. A profile distribution is already installed on a customer's
 * server, so it arrives as a migration (native install, then the database and code are landed);
 * everything else is delivered registry first.
 */
export const installPath = (install: string, plan: ProjectPlan): InstallPath =>
	install === 'profile' || needsProfileSwitch(plan) ? 'migration' : 'registry';

export type NativePlan = {
	/** `project` is installed as it stands; `profile` is a package dropped into a Drupal project */
	kind: 'project' | 'profile';
	profile: string;
	/** the composer name of the profile package, for the `profile` kind */
	pkg: string | null;
	/** the project template the distribution documents for a new site, when it has one */
	template: string | null;
};

/** the `composer create-project` each distribution documents; the pinned profile is copied over it */
export const TEMPLATES: Record<string, string> = {
	thunder: 'thunder/thunder-project',
	openy: 'ycloudyusa/yusaopeny-project',
	farm: 'farmos/project:4.x-dev',
	varbase: 'drupal/varbase_project:~11.0.0'
};

/** what the native install of a repository runs, read from its composer.json */
export function nativePlan(root: string, plan: ProjectPlan): NativePlan {
	const composer = readJson<Composer & { name?: string }>(join(root, 'composer.json')) ?? {};
	const profile = carriedProfile(root) ?? plan.profile ?? 'standard';
	if (composer.type === 'project') return { kind: 'project', profile, pkg: null, template: null };
	return {
		kind: 'profile',
		profile,
		pkg: composer.name ?? null,
		template: TEMPLATES[profile] ?? null
	};
}

/**
 * The packages a migrated site needs delivered, from the lock its native install resolved.
 *
 * Only Drupal modules and themes are listed: their libraries arrive as transitive requirements of
 * `/install?deps=1`, and core, plugins and drush are the pack's or are not run on the edge. `also`
 * names libraries the site's own composer.json requires directly, which its custom code loads by class.
 */
export function lockedContrib(
	siteDir: string,
	profile: string,
	also: readonly string[] = []
): Record<string, string> {
	const lock = readJson<Lock>(join(siteDir, 'composer.lock'));
	const picked = new Map(
		(lock?.packages ?? [])
			.filter(
				(p) =>
					p.type === 'drupal-module' || p.type === 'drupal-theme' || also.includes(p.name)
			)
			.filter((p) => p.name !== `drupal/${profile}` && !p.name.startsWith('drupal/core'))
			.map((p) => [p.name, p])
	);
	// dependencies first: installed alphabetically, term_merge came before term_reference_change and
	// its `deps=1` resolved the dependency afresh at `*`, where only betas exist, instead of at the lock
	const out: Record<string, string> = {};
	const visit = (name: string, path: Set<string>) => {
		const p = picked.get(name);
		if (!p || name in out || path.has(name)) return;
		path.add(name);
		for (const dep of Object.keys(p.require ?? {})) visit(dep, path);
		const version = p.version.replace(/^v/, '');
		out[name] = version.startsWith('dev-') ? '' : version;
	};
	for (const name of picked.keys()) visit(name, new Set());
	return out;
}
