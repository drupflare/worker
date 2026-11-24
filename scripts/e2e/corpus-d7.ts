/**
 * The Drupal 7 install path of the corpus lane.
 *
 * A fixture whose `install` is `d7-docker` is built the way its packaging builds it (drush make of
 * the core make file, then the contrib make file inside the profile) and installed by Drupal 7's own
 * installer in the `corpus-native-d7` image. That is the control. The target is Drupal 11 on the
 * worker with the profile's modules and themes delivered through anachron: every `.info` gets an
 * `.info.yml`, and the lane uploads and enables the modules the native site had enabled.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoEntry } from './corpus-lane';

/** the `install` value of a corpus entry that is built and installed as Drupal 7 */
export const D7_INSTALL = 'd7-docker';

const IMAGE = 'corpus-native-d7';
const nativeDir = () => join(import.meta.dir, 'corpus-native-d7');

/** what the make files of a Drupal 7 distribution are called and which profile they build */
export type D7Plan = { profile: string; coreMake: string; contribMake: string };

/**
 * Reads the build plan from the top of a checkout: the profile is the file that has a `.profile`
 * and an `.info` of one name, and the make files are the pair every distribution of this kind ships.
 */
export function d7Plan(cloneDir: string): D7Plan {
	const names = readdirSync(cloneDir);
	const profile = names
		.filter((n) => n.endsWith('.profile'))
		.map((n) => n.slice(0, -'.profile'.length))
		.find((n) => names.includes(`${n}.info`));
	if (profile === undefined)
		throw new Error(`no <name>.profile beside <name>.info in ${cloneDir}`);
	const coreMake = names.find((n) => n === 'drupal-org-core.make');
	const contribMake = names.find((n) => n === 'drupal-org.make');
	if (coreMake === undefined || contribMake === undefined)
		throw new Error(`${cloneDir} has no drupal-org-core.make and drupal-org.make pair`);
	return { profile, coreMake, contribMake };
}

/** what the install log says was left out: downloads that failed and patches that did not apply */
export type D7Notes = { downloads: string[]; patches: string[] };

/** the failures `drush make --force-complete` printed and went past */
export function d7Notes(log: string): D7Notes {
	const downloads = new Set<string>();
	for (const m of log.matchAll(/Unable to download (\S+) from/g)) downloads.add(m[1] as string);
	const patches = new Set<string>();
	for (const m of log.matchAll(/Unable to patch (\S+) with\s+(\S+?)\.?\s/g))
		patches.add(`${m[1]}: ${m[2]}`);
	return { downloads: [...downloads].sort(), patches: [...patches].sort() };
}

/** the sentence a record carries when the build went past a failure, or undefined */
export function d7NoteText(notes: D7Notes): string | undefined {
	const parts = [
		notes.downloads.length > 0
			? `not stock: ${notes.downloads.length} make downloads failed and were skipped (${notes.downloads.join(', ')})`
			: '',
		notes.patches.length > 0
			? `${notes.patches.length} make patches did not apply (${notes.patches.join(', ')})`
			: ''
	].filter(Boolean);
	return parts.length > 0 ? parts.join('; ') : undefined;
}

/** the facts a Drupal 7 install leaves in `extensions.json` */
export type D7Extensions = {
	core: string;
	modules: string[];
	themes: string[];
	default_theme?: string;
	front?: string;
};

/** the enabled extensions the native site reported, or undefined when the install left none */
export function d7Extensions(out: string): D7Extensions | undefined {
	const file = join(out, 'extensions.json');
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as D7Extensions;
		return Array.isArray(parsed.modules) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** one extension the info conversion wrote a file for */
export type Converted = {
	name: string;
	path: string;
	type: string;
	dependencies: string[];
	dropped: string[];
};

/** names with every dependency before the extension that needs it; a cycle keeps its listed order */
export function orderByDependencies(
	names: string[],
	dependencies: Record<string, string[]>
): string[] {
	const wanted = new Set(names);
	const done = new Set<string>();
	const out: string[] = [];
	const visit = (name: string, path: Set<string>) => {
		if (done.has(name) || path.has(name)) return;
		path.add(name);
		for (const dep of dependencies[name] ?? []) if (wanted.has(dep)) visit(dep, path);
		done.add(name);
		out.push(name);
	};
	for (const name of names) visit(name, new Set());
	return out;
}

/** the machine names of the modules the Drupal 11 tree ships */
export function coreModuleNames(drupalRoot: string): Set<string> {
	return new Set(readdirSync(join(drupalRoot, 'core', 'modules')));
}

/**
 * The modules to deliver: the enabled ones that were converted, minus the profile itself. A Drupal 7
 * contrib module that shares its machine name with a Drupal 11 core module (views, media, link)
 * would shadow that module, so it is not delivered; the core module answers to the name and the
 * code that depended on the Drupal 7 module's API fails where it calls it.
 */
export function d7Deliverable(
	extensions: D7Extensions,
	converted: Converted[],
	profile: string,
	coreNames: ReadonlySet<string> = new Set()
): { modules: string[]; core: string[]; missing: string[]; shadowed: string[] } {
	const byName = new Map(converted.map((c) => [c.name, c]));
	const modules: string[] = [];
	const core: string[] = [];
	const missing: string[] = [];
	const shadowed: string[] = [];
	for (const name of extensions.modules) {
		const found = byName.get(name);
		if (found === undefined) core.push(name);
		else if (name === profile) continue;
		else if (found.type !== 'module') missing.push(name);
		else if (coreNames.has(name)) shadowed.push(name);
		else modules.push(name);
	}
	return { modules, core, missing, shadowed };
}

/**
 * The delivered modules that need a shadowed module, directly or through another delivered one.
 * They are still delivered, so their own hooks run, but the Drupal 7 API they call on the module
 * that was not delivered (handler classes, plugin registries) has no counterpart in the core
 * module of the same name.
 */
export function dependentsOfShadowed(
	delivered: string[],
	shadowed: string[],
	dependencies: Record<string, string[]>
): string[] {
	const blocked = new Set(shadowed);
	for (let grew = true; grew;) {
		grew = false;
		for (const name of delivered) {
			if (blocked.has(name)) continue;
			if ((dependencies[name] ?? []).some((dep) => blocked.has(dep))) {
				blocked.add(name);
				grew = true;
			}
		}
	}
	return delivered.filter((name) => blocked.has(name));
}

/** what the lane drives for a Drupal 7 fixture: a module-shaped entry over the converted tree */
export type D7Target = {
	/** the corpus entry rewritten as a module delivery of the converted modules */
	entry: RepoEntry;
	/** the converted tree the modules are uploaded from */
	tree: string;
	/** the sentence the install row carries: the control, the conversion and what was left out */
	note: string;
};

/** the control's page reads as one sentence, so a record says what the native site did */
export function controlNote(
	verify: Record<string, { status: number; bytes: number; title: string }> | undefined
): string {
	if (verify === undefined) return 'native control: the installed site was not read';
	const read = Object.entries(verify)
		.map(([page, v]) => `${page} ${v.status}`)
		.join(', ');
	return `native control (Drupal 7 installer, MySQL): ${read}`;
}

/** what a risk report says in one sentence, from the counts `bin/legacy-risk.php` prints */
export function legacyRiskNote(report: { files: number; counts: Record<string, number> }): string {
	const counts = Object.entries(report.counts);
	if (counts.length === 0) return `legacy risk scan of ${report.files} files: nothing counted`;
	return `legacy risk scan of ${report.files} files, for review and not findings: ${counts.map(([k, n]) => `${n} ${k}`).join(', ')}`;
}

/** runs anachron's risk scan over a converted tree; undefined when the checkout has no scanner */
export function d7LegacyRisk(anachron: string, tree: string): string | undefined {
	const script = join(anachron, 'bin', 'legacy-risk.php');
	if (!existsSync(script)) return undefined;
	const run = spawnSync('php', [script, tree], {
		encoding: 'utf8',
		timeout: 300_000,
		maxBuffer: 64 * 1024 * 1024
	});
	if (run.status !== 0) return undefined;
	return legacyRiskNote(JSON.parse(run.stdout) as Parameters<typeof legacyRiskNote>[0]);
}

/**
 * Builds the control, converts the tree and returns what the lane delivers. A failed native install
 * is the fixture's verdict and comes back as `why`.
 */
export function prepareD7(
	repo: RepoEntry,
	work: string,
	native: string,
	anachron: string,
	clone: (repo: RepoEntry, into: string) => void
): { ok: true; target: D7Target } | { ok: false; why: string } {
	const cloneDir = join(work, repo.id);
	clone(repo, cloneDir);
	const out = join(native, repo.id);
	const built = d7NativeInstall(cloneDir, out);
	if (!built.ok) return built;
	const verify = existsSync(join(out, 'verify.json'))
		? (JSON.parse(readFileSync(join(out, 'verify.json'), 'utf8')) as Parameters<
				typeof controlNote
			>[0])
		: d7Verify(cloneDir, out);
	const extensions = d7Extensions(out);
	if (extensions === undefined)
		return { ok: false, why: 'the native install left no extension list' };
	const plan = d7Plan(cloneDir);
	const tree = join(work, `${repo.id}-d7`);
	const { converted } = d7Convert(anachron, out, plan.profile, tree);
	const { modules, core, missing, shadowed } = d7Deliverable(
		extensions,
		converted,
		plan.profile,
		coreModuleNames(join(import.meta.dir, '..', '..', 'drupal-src'))
	);
	const ordered = orderByDependencies(
		modules,
		Object.fromEntries(converted.map((c) => [c.name, c.dependencies]))
	);
	const dropped = converted.flatMap((c) => c.dropped.map((d) => `${c.name} ${d}`));
	const dependents = dependentsOfShadowed(
		ordered,
		shadowed,
		Object.fromEntries(converted.map((c) => [c.name, c.dependencies]))
	);
	const note = [
		controlNote(verify),
		d7NoteText(built.notes),
		`${ordered.length} of ${extensions.modules.length} enabled modules delivered through anachron, ${core.length} core modules left to Drupal 11`,
		shadowed.length > 0
			? `not delivered, a Drupal 11 core module has the name: ${shadowed.join(', ')}`
			: undefined,
		dependents.length > 0
			? `${dependents.length} delivered modules call the Drupal 7 API of those (${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? ', ...' : ''}); pages built on it are refused, not mapped`
			: undefined,
		missing.length > 0 ? `not delivered, not modules: ${missing.join(', ')}` : undefined,
		dropped.length > 0 ? `the info conversion dropped ${dropped.length} entries` : undefined,
		d7LegacyRisk(anachron, tree)
	]
		.filter(Boolean)
		.join('; ');
	return {
		ok: true,
		target: {
			entry: { ...repo, install: 'modify', modules: ordered },
			tree,
			note
		}
	};
}

/** the docker arguments both steps share; the container runs as root for the database and chowns /out back */
function mounts(out: string, cloneDir: string): string[] {
	return [
		'-e',
		`HOST_UID=${process.getuid?.() ?? 1000}`,
		'-e',
		`HOST_GID=${process.getgid?.() ?? 1000}`,
		'-v',
		`${nativeDir()}:/d7:ro`,
		'--memory',
		'4g',
		'--cpus',
		'4',
		'-v',
		`${out}:/out`,
		'-v',
		`${cloneDir}:/clone:ro`
	];
}

/**
 * Builds and installs a Drupal 7 distribution in Docker. The result is `<out>/site` (the tree),
 * `<out>/mysql` (the database), `<out>/site.sql`, `<out>/extensions.json` and the log. A failed install is returned with the
 * line that explains it, because that failure is the repository's row, not the lane's.
 */
export function d7NativeInstall(
	cloneDir: string,
	out: string
): { ok: true; out: string; notes: D7Notes } | { ok: false; why: string } {
	const plan = d7Plan(cloneDir);
	const done = () => ({
		ok: true as const,
		out,
		notes: d7Notes(
			existsSync(join(out, 'install.log'))
				? readFileSync(join(out, 'install.log'), 'utf8')
				: ''
		)
	});
	if (existsSync(join(out, 'extensions.json'))) return done();
	if (existsSync(join(out, 'site')))
		renameSync(join(out, 'site'), join(out, `site.failed-${Date.now()}`));
	mkdirSync(out, { recursive: true });
	spawnSync('docker', ['build', '-q', '-t', IMAGE, nativeDir()], { encoding: 'utf8' });
	const ran = spawnSync(
		'docker',
		[
			'run',
			'--rm',
			...mounts(out, cloneDir),
			'-e',
			`PROFILE=${plan.profile}`,
			'-e',
			`CORE_MAKE=${plan.coreMake}`,
			'-e',
			`CONTRIB_MAKE=${plan.contribMake}`,
			IMAGE,
			'bash',
			'/d7/install.sh'
		],
		{ encoding: 'utf8', timeout: 60 * 60_000, maxBuffer: 64 * 1024 * 1024 }
	);
	if (ran.status === 0 && existsSync(join(out, 'extensions.json'))) return done();
	const log = join(out, 'install.log');
	const lines = (existsSync(log) ? readFileSync(log, 'utf8') : `${ran.stdout}\n${ran.stderr}`)
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	const error = lines.filter((l) => /\[error\]|error|exception|Fatal/i.test(l)).slice(-3);
	return {
		ok: false,
		why: `native install of Drupal 7 ${plan.profile} failed: ${(error.length > 0 ? error : lines.slice(-3)).join(' | ')}`.slice(
			0,
			700
		)
	};
}

/** serves the installed site in the container and reads its front page and admin pages */
export function d7Verify(
	cloneDir: string,
	out: string
): Record<string, { status: number; bytes: number; title: string }> | undefined {
	const ran = spawnSync(
		'docker',
		['run', '--rm', ...mounts(out, cloneDir), IMAGE, 'bash', '/d7/verify.sh'],
		{ encoding: 'utf8', timeout: 10 * 60_000 }
	);
	const file = join(out, 'verify.json');
	if (ran.status !== 0 || !existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Copies the profile's tree with an `.info.yml` beside every `.info`, with anachron's own script.
 * The output directory is replaced, so a run after a failed one starts clean.
 */
export function d7Convert(
	anachron: string,
	out: string,
	profile: string,
	into: string
): { converted: Converted[] } {
	const script = join(anachron, 'bin', 'convert-info.php');
	if (!existsSync(script))
		throw new Error(`${script} is missing; is ${anachron} an anachron checkout?`);
	rmSync(into, { recursive: true, force: true });
	const run = spawnSync('php', [script, join(out, 'site', 'profiles', profile), into], {
		encoding: 'utf8',
		timeout: 300_000,
		maxBuffer: 64 * 1024 * 1024
	});
	if (run.status !== 0)
		throw new Error(
			`info conversion exited ${run.status}: ${(run.stderr || run.stdout).slice(0, 300)}`
		);
	return JSON.parse(run.stdout) as { converted: Converted[] };
}

/** a row that tests the enable step and is scored by the render that follows it */
export function rowAfterEnables(
	rendered: boolean,
	status: number,
	passed: string,
	failedPrefix: string
): { state: 'inline' | 'unsupported'; note: string } {
	return rendered
		? { state: 'inline', note: passed }
		: { state: 'unsupported', note: `${failedPrefix} answered ${status} afterwards` };
}
