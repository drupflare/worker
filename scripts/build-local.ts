/**
 * Builds every generated artifact from source, so a clean clone is deployable without a release.
 *
 * ```sh
 * bun run build:local                  # the whole pipeline, skipping what is already on disk
 * bun run build:local -- --dry-run     # the plan and the preflight, running nothing
 * bun run build:local -- --force       # rebuild every step
 * bun run build:local -- --only=twig,core,pack
 * ```
 *
 * THIS IS THE FALLBACK, NOT THE DEFAULT PATH. `bun run hydrate` lands the same bytes from a release
 * payload as a plain HTTPS GET, needing no Docker, no `gh` auth and no PHP -- which is what makes the
 * Deploy to Cloudflare button work. This script exists for the case that button cannot cover: a
 * checkout of a commit no release was cut from, and the window before the first release exists at
 * all. `scripts/hydrate.ts` routes between the two.
 *
 * EVERY STEP IS CACHED, and the cache key is the artifact rather than a stamp file. A step is skipped
 * when the paths it `produces` are on disk, so a re-run after a failure resumes rather than restarting
 * -- which matters because the pipeline is minutes long and three of its steps are downloads.
 *
 * EVERY PAYLOAD ARTIFACT HAS A PRODUCER HERE, including `assets/prefill.json`, which holds the
 * RUNTIME's own rendered bytes -- "needs the runtime" is not "needs a deploy", so
 * `scripts/bake-prefill.ts` boots `wrangler dev` locally. It is the one optional step, because a
 * busy port is not a reason to discard twelve finished ones.
 *
 * @see scripts/hydrate.ts for the payload half
 * @see docs/building-from-source.md for what each step is for and why the order is the order
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { drupalVersion, installedVersion } from './fetch-drupal-tree';

/** an external program a step shells out to, and how to get it */
export type ToolId = 'bun' | 'node' | 'php' | 'composer' | 'docker' | 'zstd' | 'git' | 'tar';

/** where each tool comes from, so a preflight failure is actionable rather than a name */
export const TOOL_HINTS: Record<ToolId, string> = {
	bun: 'https://bun.sh',
	node: 'Node 24+, for node:sqlite and node zlib; bun ships neither compatibly',
	php: 'PHP 8.3+ with pdo_sqlite, sqlite3, mbstring and iconv',
	composer: 'https://getcomposer.org -- the Drupal tarball is core only',
	docker: 'Docker Desktop, STARTED. Only the zstd decoder needs it, and only once',
	zstd: 'brew install zstd (or apt install zstd)',
	git: 'to clone the sibling module repositories',
	tar: 'to extract the Drupal release tarball'
};

export type StepId =
	| 'interpreter'
	| 'frame'
	| 'decoder'
	| 'siblings'
	| 'driver'
	| 'tree'
	| 'site'
	| 'patch'
	| 'bootstrap'
	| 'twig'
	| 'core'
	| 'pack'
	| 'static'
	| 'sql'
	| 'prefill';

/** one step of the from-source build */
export interface LocalStep {
	id: StepId;
	/** one line, printed as the step runs */
	title: string;
	/** repo-relative paths the step writes; their presence is the cache key */
	produces: readonly string[];
	/**
	 * Paths an EARLIER step already produced and this one rewrites.
	 *
	 * One path in this pipeline is legitimately written twice. `bake-twig.php` builds the packer's
	 * file list out of an existing `core.json`, so a checkout with no pack has to bootstrap one before
	 * the bake and then repack from the list the bake wrote. Declaring the second write keeps "one
	 * producer per artifact" a real assertion instead of one with an exception carved out of it.
	 */
	refreshes?: readonly string[];
	/** repo-relative paths that must already exist, checked before the step runs */
	inputs?: readonly string[];
	tools: readonly ToolId[];
	/** argv lists, run in order from the repository root */
	commands(root: string): string[][];
	/** environment for this step's commands; an empty value unsets an inherited one */
	env?: Record<string, string>;
	/**
	 * A second, independent source to try when `commands` fails.
	 *
	 * Only the interpreter has one, and it is not hypothetical: the CDN origin is a `.dev` host, and a
	 * network that treats `.dev` as suspicious refuses the TLS handshake before any byte is served.
	 * Observed here, with `curl` failing identically, so it is the path to the origin rather than the
	 * bucket or the script. The same bytes are in phasm's artifacts behind `gh` auth, over
	 * github.com -- a different host on a different domain, which is what makes it a real fallback and
	 * not a retry. Its tools are deliberately NOT part of the preflight: a fallback whose requirements
	 * are demanded up front is just a requirement.
	 */
	fallback?: { commands: string[][]; tools: readonly ToolId[]; why: string };
	/** in-process work after the commands, for the glue that is not worth a script */
	finish?(root: string): void;
	/** replaces the presence check, for a step whose completion is not a path of its own */
	satisfied?(root: string): boolean;
	/**
	 * An input the step's outputs must be at least as new as.
	 *
	 * Presence is the wrong key for a step that rewrites an artifact an earlier one made: `core.json`
	 * exists straight after the bootstrap, so presence alone skips the list-driven repack and ships a
	 * pack missing every template the bake just compiled. Nothing looks wrong -- the pack is there, it
	 * is just the wrong one.
	 */
	freshAgainst?: string;
	/**
	 * A failure here is reported and the build continues.
	 *
	 * For a step whose output the runtime does not require. Losing twelve steps of work because the
	 * thirteenth could not bind a port is a worse outcome than a tree missing an optional artifact,
	 * and the report names what is missing either way.
	 */
	optional?: boolean;
	/** what to say when the step's tools are missing, beyond the tool names themselves */
	note?: string;
}

/** a sibling repository `bun run assets:driver` packs into `assets/driver.json` */
export interface Sibling {
	/** the directory name, in the sibling layout and under `.siblings/` */
	name: string;
	/** the env var `scripts/gen-driver-assets.ts` reads */
	env: 'DRUPFLARE_SRC' | 'ROM_SRC' | 'STREAM_HTTP_SRC';
	repo: string;
	/** appended to the resolved checkout, because stream-http is mounted from its `src/` */
	suffix: string;
}

/**
 * The three checkouts the driver pack is built from.
 *
 * They are the SOURCE OF TRUTH for the two Drupal modules -- this repository keeps no copy, since the
 * copy under `drupal/` is what drifted. A clone of `worker` alone therefore has none of them, which is
 * why the build resolves and clones rather than assuming the developer layout.
 */
export const SIBLINGS: readonly Sibling[] = [
	{ name: 'drupflare', env: 'DRUPFLARE_SRC', repo: 'drupflare/drupflare', suffix: '' },
	{ name: 'rom', env: 'ROM_SRC', repo: 'drupflare/rom', suffix: '' },
	{ name: 'stream-http', env: 'STREAM_HTTP_SRC', repo: 'drupflare/stream-http', suffix: '/src' }
];

/** where a sibling was found, and whether anything has to be cloned to get it */
export interface ResolvedSibling extends Sibling {
	/** the checkout root, absolute */
	path: string;
	/** what `gen-driver-assets.ts` should be pointed at, suffix applied */
	value: string;
	present: boolean;
	/** how it was found: an env override, the developer layout, or this build's own clone */
	via: 'env' | 'sibling' | 'vendored';
}

/**
 * Finds each sibling, preferring what is already there over cloning.
 *
 * The order is deliberate and matches `.claude`-level convention elsewhere: an explicit environment
 * setting outranks an inference from the layout, and the developer layout outranks a private copy --
 * so somebody with `../rom` checked out builds against the tree they are editing rather than against
 * a clone of master that silently shadows it.
 */
export function resolveSiblings(
	root: string,
	env: NodeJS.ProcessEnv = process.env
): ResolvedSibling[] {
	return SIBLINGS.map((sibling) => {
		const override = env[sibling.env];
		if (override) {
			// an override may already name the suffixed path, which is how CI sets STREAM_HTTP_SRC
			const path = resolve(root, override.replace(new RegExp(`${sibling.suffix}$`), ''));
			return { ...sibling, path, value: override, present: existsSync(path), via: 'env' };
		}
		for (const [dir, via] of [
			[resolve(root, '..', sibling.name), 'sibling'],
			[resolve(root, '.siblings', sibling.name), 'vendored']
		] as const) {
			if (existsSync(dir)) {
				return { ...sibling, path: dir, value: dir + sibling.suffix, present: true, via };
			}
		}
		const path = resolve(root, '.siblings', sibling.name);
		return { ...sibling, path, value: path + sibling.suffix, present: false, via: 'vendored' };
	});
}

/** the environment `assets:driver` needs to find all three checkouts */
export function siblingEnv(
	root: string,
	env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const sibling of resolveSiblings(root, env)) out[sibling.env] = sibling.value;
	return out;
}

/** whether a path is a non-empty directory, so a half-written pack does not read as done */
function populated(path: string): boolean {
	try {
		return statSync(path).isDirectory()
			? readdirSync(path).length > 0
			: statSync(path).size > 0;
	} catch {
		return false;
	}
}

/** whether a file on disk contains a marker, used by the predicates that cannot check a path */
function contains(path: string, needle: string): boolean {
	try {
		return readFileSync(path, 'utf8').includes(needle);
	} catch {
		return false;
	}
}

/**
 * Whether `out` was written after `input`, which is what "already built" means for a REPACK.
 *
 * Presence alone is the wrong key for the two steps that rewrite an artifact an earlier step made:
 * `core.json` exists straight after the bootstrap, so a presence check skips the list-driven repack
 * and the shipped pack never gains the templates the bake just compiled. Nothing looks wrong -- the
 * pack is there, it is just the wrong one.
 */
function newerThan(root: string, out: string, input: string): boolean {
	try {
		return statSync(join(root, out)).mtimeMs >= statSync(join(root, input)).mtimeMs;
	} catch {
		return false;
	}
}

/**
 * The pipeline, in the one order that works.
 *
 * Four orderings here are load-bearing rather than tidy, and each has a recorded failure behind it:
 *
 * - `site` before `patch`, because the settings.php half of the patch appends to a file that does not
 *   exist until an install writes it. A release tarball ships `default.settings.php` and nothing else.
 * - `patch` before `twig`, because `bake-twig.php` boots a kernel that must already resolve
 *   `\PhpWasmSyncFiber`, and reads a `php_storage` pin that decides whether the bake is reachable at
 *   all. Baking first produces files at paths the runtime never asks for, with nothing looking wrong.
 * - `twig` before `core`, because `bake-twig.php` writes `assets/drupal/core.list.json` -- the file
 *   list BOTH packers then read. `assets:core` runs under `PACK_INDEX=1` and takes that list verbatim,
 *   so on a tree with no list it has no file set at all.
 * - `core` before `pack`, because `pack-perfile.ts` reuses `core.json` rather than re-globbing, which
 *   is what keeps a repack a change of format and not a change of which files ship.
 */
export const LOCAL_STEPS: readonly LocalStep[] = [
	{
		id: 'interpreter',
		title: 'restore the PHP 8.5 interpreter from the public CDN',
		produces: ['.interp/php8.5.wasm', '.interp/php8.5-worker.mjs'],
		tools: ['bun'],
		commands: () => [['bun', 'scripts/restore-artifacts.ts', '--strict']],
		fallback: {
			commands: [['bun', 'run', 'fetch:interp85']],
			tools: ['bun'],
			why: "the CDN restore failed; trying phasm's artifacts, which need `gh auth login`"
		},
		note: 'verified by sha256 against cdn-manifest.json and needs no credential'
	},
	{
		id: 'frame',
		title: 'compress the interpreter into the zstd frame the seam imports',
		produces: ['.interp/php8.5.wasm.zst'],
		inputs: ['.interp/php8.5.wasm'],
		tools: ['bun', 'zstd'],
		commands: () => [['bun', 'scripts/pack-wasm-zstd.ts', '.interp/php8.5.wasm']]
	},
	{
		id: 'decoder',
		title: 'build the wasm zstd decoder',
		produces: ['.interp/zstddec.wasm'],
		tools: ['docker'],
		commands: () => [['bash', 'scripts/build-zstd-decoder.sh']],
		note:
			'the only step that needs Docker, and it runs once: the zstd version and the emsdk image ' +
			'are both pinned, so the output is cached and never rebuilt on its own'
	},
	{
		id: 'siblings',
		title: 'check out the Drupal module repositories the driver pack is built from',
		produces: [],
		tools: ['git'],
		satisfied: (root) => resolveSiblings(root).every((s) => s.present),
		commands: (root) =>
			resolveSiblings(root)
				.filter((s) => !s.present)
				.map((s) => [
					'git',
					'clone',
					'--depth',
					'1',
					`https://github.com/${s.repo}.git`,
					s.path
				])
	},
	{
		id: 'driver',
		title: 'pack the modules into assets/driver.json',
		produces: ['assets/driver.json'],
		tools: ['bun'],
		commands: () => [['bun', 'run', 'assets:driver']]
	},
	{
		id: 'tree',
		title: 'fetch the Drupal tree the packers read',
		produces: ['drupal-src/core/lib/Drupal.php'],
		/**
		 * SATISFIED BY THE VERSION, not by the file existing.
		 *
		 * Keyed on presence alone, `DRUPAL_VERSION=11.4.6 bun run build:local` on a tree holding
		 * 11.4.5 skipped this step -- and then skipped every downstream step too, because each
		 * one's own output was still on disk. The command completed in 0.08 s, reported success,
		 * and upgraded nothing. Measured 2026-08-21 while rehearsing a core upgrade.
		 */
		satisfied: (root) => installedVersion(join(root, 'drupal-src')) === drupalVersion(),
		tools: ['bun', 'composer', 'tar'],
		commands: () => [['bun', 'run', 'fetch:drupal']],
		note: '~180 MB: the pinned core tarball plus the four contrib modules it does not carry'
	},
	{
		id: 'site',
		title: 'install a Drupal site so a kernel can boot against the tree',
		produces: ['drupal-src/sites/default/settings.php'],
		inputs: ['drupal-src/core/lib/Drupal.php'],
		tools: ['php'],
		// into sites/build, never sites/default: the installer refuses a site that already exists and
		// sites/default holds the baked Twig cache. The copy is what makes the default site boot
		// against the database the install just made
		commands: () => [
			[
				'php',
				'-d',
				'opcache.enable_cli=0',
				'-d',
				'xdebug.mode=off',
				'scripts/drupal/install-site-db.php',
				'drupal-src',
				'drupal-src/sites/build/files/build-site.sqlite'
			]
		],
		finish: (root) => {
			const built = join(root, 'drupal-src/sites/build/settings.php');
			if (!existsSync(built)) {
				throw new Error(
					`the installer wrote no ${built}; without it sites/default cannot boot and ` +
						'`bun run assets:twig` has no kernel'
				);
			}
			copyFileSync(built, join(root, 'drupal-src/sites/default/settings.php'));
		},
		note:
			'this is NOT how assets/drupal/site.sqlite is produced -- that one is tracked, and the ' +
			'installer refuses to overwrite it. This database exists only so the bake can boot'
	},
	{
		id: 'patch',
		title: 'patch the tree for the wasm runtime',
		produces: [],
		inputs: ['drupal-src/sites/default/settings.php'],
		tools: ['node'],
		// idempotent, and detected by what it wrote rather than by a stamp file: a stamp survives a
		// `fetch:drupal --force` that replaced every patched file underneath it
		satisfied: (root) =>
			contains(
				join(root, 'drupal-src/core/lib/Drupal/Core/Render/Renderer.php'),
				'PhpWasmSyncFiber'
			) &&
			contains(
				join(root, 'drupal-src/sites/default/settings.php'),
				"$settings['php_storage']"
			),
		commands: () => [['node', 'scripts/patch-drupal.mjs', 'drupal-src']]
	},
	{
		id: 'bootstrap',
		title: 'pack a first core index, which the Twig bake reads to build the file list',
		produces: ['assets/drupal/core.json', 'assets/drupal/core.bin.gz'],
		inputs: ['drupal-src/core/lib/Drupal.php'],
		tools: ['node'],
		// FULL=1 rather than the profiled set, and this is the one place a source-built tree differs
		// from a shipped one in CONTENT rather than in presence. The shipping pack's file list came
		// from a traced run, and a trace is a recorded measurement a checkout does not have -- so the
		// bootstrap globs every non-test file instead, which is a superset and therefore correct but
		// larger. The next `assets:core` narrows it to whatever the bake's list says
		commands: () => [
			[
				'node',
				'scripts/pack-drupal.ts',
				'drupal-src',
				'assets/drupal/core.list.json',
				'drupal'
			]
		],
		env: { FULL: '1', PACK_INDEX: '' },
		note: 'only on a checkout with no pack at all; a hydrated tree already has core.json'
	},
	{
		id: 'twig',
		title: 'bake the compiled Twig cache and the packer file list',
		produces: ['assets/drupal/twig-bake.json', 'assets/drupal/core.list.json'],
		inputs: [
			'assets/drupal/site.sqlite',
			'assets/drupal/core.json',
			'drupal-src/sites/default/settings.php'
		],
		tools: ['php'],
		commands: () => [['bun', 'run', 'assets:twig']]
	},
	{
		id: 'core',
		title: 'repack the tree from the list the bake wrote',
		produces: [],
		refreshes: ['assets/drupal/core.json', 'assets/drupal/core.bin.gz'],
		inputs: ['assets/drupal/core.list.json'],
		freshAgainst: 'assets/drupal/core.list.json',
		tools: ['node'],
		commands: () => [['bun', 'run', 'assets:core']]
	},
	{
		id: 'pack',
		title: 'rewrite the pack per file, then scrub the shipped secrets out of it',
		produces: ['assets/drupal-pf/core.pf.json', 'assets/drupal-pf/core.pf.bin'],
		inputs: ['assets/drupal/core.json'],
		freshAgainst: 'assets/drupal/core.json',
		tools: ['bun'],
		// the scrub belongs to this step rather than beside it: core.pf.bin carries settings.php with a
		// real hash_salt, Workers assets serve it publicly, and a pack that is packed but not scrubbed
		// is the state release-payload.ts refuses to publish
		commands: () => [
			['bun', 'run', 'assets:pack'],
			['bun', 'run', 'assets:scrub']
		]
	},
	{
		id: 'static',
		title: 'copy the browser-fetchable core and contrib trees into the Workers Assets directory',
		// one representative file per subtree rather than the directories, so a half-finished copy
		// does not read as done the way a non-empty directory would. BOTH, because `assets/core/`
		// cannot answer `/modules/contrib/**` and an enabled module's css would 404 without it.
		//
		// `assets/themes` is written by the same command and is NOT named here: a checkout with no
		// contrib or custom theme produces an empty one, which is a real outcome rather than a
		// half-finished copy. Naming a representative file broke `build:local` on such a checkout,
		// so the payload carries that entry as optional instead
		produces: ['assets/core/misc/drupal.js', 'assets/modules/contrib/token/css/token.css'],
		inputs: ['drupal-src/core/lib/Drupal.php'],
		tools: ['bun'],
		commands: () => [['bun', 'run', 'assets:static']],
		note:
			'every pack SKIPs these extensions because PHP never opens them, and nothing serves a ' +
			'file out of the MEMFS over HTTP -- so without this step every stylesheet, script and ' +
			'font 404s'
	},
	{
		id: 'sql',
		title: 'chunk the site database into the migration the Durable Object replays',
		produces: ['assets/drupal-sql/manifest.json'],
		inputs: ['assets/drupal/site.sqlite'],
		tools: ['node'],
		commands: () => [['bun', 'run', 'assets:sql']],
		note: 'reads the TRACKED site.sqlite, so this step alone works on a clone with nothing else built'
	},
	{
		id: 'prefill',
		title: 'boot the runtime and lift the pages it renders into assets/prefill.json',
		produces: ['assets/prefill.json'],
		// everything, because it renders through the real worker: the interpreter, the pack, the
		// migration chunks and the driver all have to be in place before a page comes back
		inputs: [
			'assets/driver.json',
			'assets/drupal-pf/core.pf.bin',
			'assets/drupal-sql/manifest.json',
			'.interp/php8.5.wasm.zst',
			'.interp/zstddec.wasm'
		],
		tools: ['bun'],
		// optional because the runtime does not need it: an absent prefill.json means the first
		// request to each path renders instead of hitting. It is worth having anyway -- a prefilled
		// path is a HIT on its first ever request -- but not worth discarding a finished build for
		optional: true,
		commands: () => [['bun', 'scripts/bake-prefill.ts']],
		note:
			'boots `wrangler dev` locally, migrates a throwaway site and renders five paths. No ' +
			'Cloudflare credential; the bytes have to come from the runtime, because native PHP ' +
			'renders a page this site cannot reproduce'
	}
];

/** one step with the decision made about it */
export interface PlannedStep {
	step: LocalStep;
	run: boolean;
	/** why it will or will not run, printed verbatim */
	reason: string;
}

export interface PlanOptions {
	/** rebuild every step, ignoring what is on disk */
	force?: boolean;
	/** run only these steps */
	only?: readonly StepId[];
	/** run everything except these */
	skip?: readonly StepId[];
}

/** whether a step's outputs are all present and, where it matters, not stale */
export function stepSatisfied(root: string, step: LocalStep): boolean {
	if (step.satisfied) return step.satisfied(root);
	const paths = [...step.produces, ...(step.refreshes ?? [])];
	if (paths.length === 0) return false;
	if (!paths.every((path) => populated(join(root, path)))) return false;
	const against = step.freshAgainst;
	return against === undefined || paths.every((path) => newerThan(root, path, against));
}

/**
 * The ordered decision for every step, without touching anything.
 *
 * PURE, so the whole resume story is one testable function: a second run against a finished tree
 * plans every step skipped and executes nothing.
 */
export function planLocalBuild(
	root: string,
	opts: PlanOptions = {},
	steps: readonly LocalStep[] = LOCAL_STEPS
): PlannedStep[] {
	const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
	const skip = new Set(opts.skip ?? []);

	return steps.map((step) => {
		if (only && !only.has(step.id)) {
			return { step, run: false, reason: 'not in --only' };
		}
		if (skip.has(step.id)) return { step, run: false, reason: 'excluded by --skip' };
		if (opts.force) return { step, run: true, reason: 'forced' };
		if (stepSatisfied(root, step)) {
			return {
				step,
				run: false,
				reason: step.produces.length
					? `already built: ${step.produces.join(', ')}`
					: 'already done'
			};
		}
		// "missing" is only true when the path is actually absent. A step with its own `satisfied`
		// can be unsatisfied while every output exists -- the tree at the wrong VERSION is exactly
		// that -- and reporting it as missing sends the reader looking for a file that is right there
		const absent = step.produces.filter((path) => !populated(join(root, path)));
		return {
			step,
			run: true,
			reason: absent.length
				? `missing ${absent.join(', ')}`
				: step.produces.length
					? `out of date: ${step.produces.join(', ')}`
					: 'not done yet'
		};
	});
}

/** a tool a planned step needs and this machine does not have */
export interface MissingTool {
	tool: ToolId;
	hint: string;
	/** the steps that cannot run without it */
	steps: StepId[];
}

/**
 * Tools whose presence on PATH is not the question being asked.
 *
 * Docker on PATH with no daemon is the normal state of a laptop, and it fails five minutes into the
 * run rather than in the preflight -- after the 180 MB tree download, which is precisely the waste a
 * preflight exists to prevent.
 */
const TOOL_PROBES: Partial<Record<ToolId, string[]>> = {
	docker: ['docker', 'info']
};

/** whether a program resolves on PATH and, where it matters, is actually usable */
export function toolPresent(tool: ToolId): boolean {
	try {
		execFileSync('command', ['-v', tool], { shell: '/bin/sh', stdio: 'ignore' });
	} catch {
		return false;
	}
	const probe = TOOL_PROBES[tool];
	if (!probe) return true;
	try {
		const [file, ...args] = probe as [string, ...string[]];
		execFileSync(file, args, { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Every tool the steps that WILL run need and this machine does not have.
 *
 * Checked once, up front, against the planned steps rather than all of them -- a machine with no
 * Docker can still build everything else, and reporting the decoder's requirement on a run that skips
 * the decoder is how a preflight teaches people to ignore it.
 */
export function missingTools(
	planned: readonly PlannedStep[],
	present: (tool: ToolId) => boolean = toolPresent
): MissingTool[] {
	const wanted = new Map<ToolId, StepId[]>();
	for (const { step, run } of planned) {
		if (!run) continue;
		for (const tool of step.tools) {
			wanted.set(tool, [...(wanted.get(tool) ?? []), step.id]);
		}
	}
	return [...wanted]
		.filter(([tool]) => !present(tool))
		.map(([tool, steps]) => ({ tool, hint: TOOL_HINTS[tool], steps }))
		.sort((a, b) => (a.tool < b.tool ? -1 : 1));
}

/** an optional artifact this run did not end up with, and how to get it */
export interface MissingOptional {
	path: string;
	why: string;
	how: string;
}

/** what a run did, in the shape `--json` prints */
export interface LocalBuildReport {
	root: string;
	steps: { id: StepId; run: boolean; reason: string; commands: string[] }[];
	/** true when every step was skipped, which is the resume case */
	resumed: boolean;
	/**
	 * Optional steps that failed, named rather than left as a quietly absent file.
	 *
	 * Every payload artifact has a producer here, so this is normally empty. It fills when an optional
	 * step could not run -- today that is only `prefill`, which needs to bind a port and boot the
	 * runtime, and a busy port is not a reason to fail a build that has finished everything else.
	 */
	missingOptional: MissingOptional[];
}

function runAll(commands: readonly string[][], root: string, env: NodeJS.ProcessEnv): void {
	for (const command of commands) {
		const [file, ...args] = command as [string, ...string[]];
		console.log(`    ${command.join(' ')}`);
		execFileSync(file, args, { cwd: root, env, stdio: 'inherit', maxBuffer: 1 << 28 });
	}
}

/** Runs a plan, stopping at the first failure. */
export function runLocalBuild(root: string, planned: readonly PlannedStep[]): LocalBuildReport {
	const env = { ...process.env, ...siblingEnv(root) };
	const done: LocalBuildReport['steps'] = [];
	const skippedOptional: MissingOptional[] = [];

	for (const { step, run, reason } of planned) {
		const commands = run ? step.commands(root) : [];
		done.push({ id: step.id, run, reason, commands: commands.map((c) => c.join(' ')) });
		if (!run) {
			console.log(`  skip  ${step.id}  ${reason}`);
			continue;
		}

		for (const input of step.inputs ?? []) {
			if (!populated(join(root, input))) {
				throw new Error(
					`${step.id} needs ${input}, which is not on disk. Run the steps before it, or ` +
						'`bun run build:local` with no --only.'
				);
			}
		}

		console.log(`\n==> ${step.id}: ${step.title}`);
		// THE ARTIFACT IS THE ACCEPTANCE CRITERION, NOT THE EXIT CODE, and that distinction was
		// measured rather than reasoned: `restore-artifacts.ts` exits 0 by design when a fetch fails,
		// so the interpreter step reported success, produced nothing, and the failure surfaced two
		// steps later as `frame needs .interp/php8.5.wasm`. A step that trusts an exit code cannot
		// notice that, and cannot know whether its own fallback is still needed
		const stepEnv = { ...env, ...(step.env ?? {}) };
		let failure: unknown;
		try {
			runAll(commands, root, stepEnv);
			step.finish?.(root);
		} catch (cause) {
			failure = cause;
		}

		if (step.fallback && !stepSatisfied(root, step)) {
			console.log(`    ${step.fallback.why}`);
			failure = undefined;
			try {
				runAll(step.fallback.commands, root, stepEnv);
				step.finish?.(root);
			} catch (cause) {
				failure = cause;
			}
		}
		const absent = step.produces.filter((p) => !populated(join(root, p)));
		const problem =
			failure ??
			(stepSatisfied(root, step)
				? null
				: new Error(
						`${step.id} reported success and did not produce ` +
							`${absent.length ? absent.join(', ') : 'what it exists to produce'}`
					));

		if (problem && step.optional) {
			const why = problem instanceof Error ? problem.message : String(problem);
			console.warn(
				`\n!!  ${step.id} did not finish, and is optional; continuing.\n    ${why}`
			);
			skippedOptional.push({
				path: step.produces[0] ?? step.id,
				why: why.split('\n')[0] ?? why,
				how: `bun run build:local -- --only=${step.id}`
			});
			continue;
		}
		if (problem) throw problem;
	}

	return {
		root,
		steps: done,
		resumed: done.every((s) => !s.run),
		missingOptional: skippedOptional
	};
}

function listArg(name: string, argv: string[]): StepId[] {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	if (!hit) return [];
	return hit
		.slice(name.length + 3)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean) as StepId[];
}

/** Names any `--only` / `--skip` value that is not a step, so a typo is not a silent no-op. */
export function assertKnownSteps(ids: readonly string[]): void {
	const known = new Set(LOCAL_STEPS.map((s) => s.id));
	const unknown = ids.filter((id) => !known.has(id as StepId));
	if (unknown.length) {
		throw new Error(
			`no such step: ${unknown.join(', ')}. Known steps, in order: ` +
				LOCAL_STEPS.map((s) => s.id).join(', ')
		);
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const root = resolve(import.meta.dirname, '..');
	const only = listArg('only', argv);
	const skip = listArg('skip', argv);
	assertKnownSteps([...only, ...skip]);

	const planned = planLocalBuild(root, { force: argv.includes('--force'), only, skip });
	const missing = missingTools(planned);
	const willRun = planned.filter((p) => p.run);

	if (argv.includes('--dry-run') || argv.includes('--json')) {
		const report: LocalBuildReport = {
			root,
			steps: planned.map(({ step, run, reason }) => ({
				id: step.id,
				run,
				reason,
				commands: run ? step.commands(root).map((c) => c.join(' ')) : []
			})),
			resumed: willRun.length === 0,
			missingOptional: []
		};
		if (argv.includes('--json')) {
			console.log(JSON.stringify({ ...report, missingTools: missing }, null, 2));
			process.exit(missing.length ? 1 : 0);
		}
		for (const { step, run, reason } of planned) {
			console.log(`${run ? 'run ' : 'skip'}  ${step.id.padEnd(12)}${reason}`);
		}
	}

	if (missing.length) {
		console.error('\nthis machine is missing tools the planned steps need:');
		for (const { tool, hint, steps } of missing) {
			console.error(
				`  ${tool.padEnd(9)} ${hint}\n            needed by: ${steps.join(', ')}`
			);
		}
		console.error(
			'\nEvery one of them is avoidable: `bun run hydrate` lands the same artifacts from a\n' +
				'release payload over plain HTTPS. Use --skip to leave a step out if you know you\n' +
				'do not need what it produces.'
		);
		process.exit(1);
	}

	if (argv.includes('--dry-run')) process.exit(0);

	if (willRun.length === 0) {
		console.log('every artifact is already on disk; nothing to do (--force rebuilds)');
	} else {
		console.log(`building ${willRun.length} of ${planned.length} steps from source`);
	}
	const report = runLocalBuild(root, planned);

	console.log(
		`\n${report.resumed ? 'nothing rebuilt' : 'built from source'}: this tree is deployable`
	);
	for (const { path, why, how } of report.missingOptional) {
		console.log(
			`\n${path} was NOT produced, and is optional at runtime.\n  ${why}\n  retry: ${how}`
		);
	}
	console.log('\nnext: bun run dev, or bunx wrangler deploy -c wrangler.jsonc');
}
