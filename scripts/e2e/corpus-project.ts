/**
 * What a composer project or install profile asks of a site, read from its files and never run.
 *
 * The corpus lane delivers a project registry first: every package the project requires goes through
 * `/install?deps=1` at the version its lock resolved, and the modules the repository carries itself
 * are uploaded. This module decides what to deliver and when the answer is already known.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { satisfies } from '../../src/ops/composer-constraint.js';

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
			: `an upgrade from Drupal ${major || 'this version'} is v1.1 work (drangler migrate upgrade)`;
	return `needs upgrade: core ${core} does not accept Drupal 11; ${route}`;
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
};

/** install profiles the pack's own site already runs on */
const HOSTED_PROFILES = new Set(['standard', 'minimal']);

/** true when the project cannot be delivered without a fresh install under another profile */
export const needsProfileSwitch = (plan: ProjectPlan): boolean =>
	plan.profile !== null && !HOSTED_PROFILES.has(plan.profile);

const SKIP_TYPES = new Set(['composer-plugin', 'metapackage', 'drupal-drush', 'drupal-core']);
const SKIP_VENDORS = ['drupal/core', 'composer/', 'cweagans/', 'wikimedia/', 'oomphinc/', 'drush/'];

function readJson<T>(file: string): T | null {
	return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

/** every `*.info.yml` under `custom` directories, without descending into vendor or dependencies */
function customCode(root: string): CustomCode[] {
	const out: CustomCode[] = [];
	const walk = (dir: string, inCustom: boolean) => {
		for (const name of readdirSync(dir)) {
			if (
				name.startsWith('.') ||
				['node_modules', 'vendor', 'tests', 'contrib'].includes(name)
			)
				continue;
			const full = join(dir, name);
			if (!statSync(full).isDirectory()) continue;
			const custom = inCustom || name === 'custom';
			const info = readdirSync(full).find((f) => f.endsWith('.info.yml'));
			if (custom && info) {
				const doc = parse(readFileSync(join(full, info), 'utf8')) as {
					type?: string;
				} | null;
				const kind =
					doc?.type === 'theme' ? 'theme' : doc?.type === 'module' ? 'module' : null;
				if (kind) out.push({ name: info.replace(/\.info\.yml$/, ''), dir: full, kind });
				continue;
			}
			walk(full, custom);
		}
	};
	walk(root, false);
	return out;
}

type Lock = {
	packages?: { name: string; version: string; type?: string; require?: Record<string, string> }[];
};
type Composer = {
	type?: string;
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

/** reads a project directory's composer files and its configuration sync directory */
export function projectPlan(root: string): ProjectPlan {
	const composer = readJson<Composer>(join(root, 'composer.json')) ?? {};
	const lock = readJson<Lock>(join(root, 'composer.lock'));
	const locked = new Map((lock?.packages ?? []).map((p) => [p.name, p]));

	const packages: Record<string, string> = {};
	let profile: string | null = null;
	for (const [name, wanted] of Object.entries(composer.require ?? {})) {
		if (!name.includes('/') || SKIP_VENDORS.some((v) => name.startsWith(v))) continue;
		const one = locked.get(name);
		if (one?.type === 'drupal-profile') profile = name.replace(/^drupal\//, '');
		if (one && SKIP_TYPES.has(one.type ?? '')) continue;
		const version = one ? one.version.replace(/^v/, '') : wanted;
		packages[name] = version.startsWith('dev-') ? '' : version;
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
	return {
		profile,
		packages,
		custom: customCode(root),
		modules,
		patches: patchCount(root, composer)
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
