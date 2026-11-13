import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import {
	assertCoversAssetsIgnore,
	expandPlan,
	sha256 as fileSha256,
	PAYLOAD_ASSETS,
	readJsonc,
	type PayloadFile
} from './release-payload';

/**
 * Packs the Worker a bastion box runs as one archive with the modules at its root.
 *
 * ```sh
 * bunx wrangler deploy --dry-run --outdir=<dir> -c wrangler.jsonc
 * bun scripts/build-box-bundle.ts --outdir=<dir> --out=dist --version=1.1.0 --sums=dist/SHA256SUMS
 * ```
 *
 * WHAT A BOX READS IS FIXED BY `modulesFrom` IN BASTION, and this is written against it. The box
 * unpacks the archive and lists the TOP LEVEL only: a directory is skipped, and a file is a module
 * only when it ends in one of `BOX_SUFFIXES`. The entry is the file `main` names, else `site.js`
 * among a short list of conventional names. So the archive is the flat output of wrangler and
 * nothing else: no `manifest.json` (it would load as a text module), no `.map` or `README.md`
 * (ignored, so dead weight), and no nested folder (silently dropped, which is how a module the
 * entry imports goes missing).
 *
 * THE `assets/` TREE RIDES BESIDE THE MODULES. A box serves static files from the tenant's own state
 * directory, and a drupflare site with none answers 503 `pack not reachable`, so `site add` copies
 * the archive's `assets/` there. `modulesFrom` skips directories, so the tree never reaches workerd
 * as a module. The files are the ones the release payload carries for the edge, taken from the
 * payload plan (which `assertCoversAssetsIgnore` ties to `assets/.assetsignore`) and never from a
 * walk of `assets/`, which holds build inputs the edge does not receive.
 *
 * `assets.manifest` lists every asset with its size and sha-256, in the payload manifest's file
 * format, and the box refuses an unpacked tree that differs from it. It has no loadable ending on
 * purpose: a top-level `manifest.json` would be listed as a text module and embedded in the
 * workerd config, and could not be told from a tenant's own `manifest.json` import.
 *
 * `box.vars` is the Worker's `vars` block as a flat json object, read from `wrangler.jsonc` when
 * the archive is built and never typed here. A bundle carries no config, so without it a box binds
 * none of them and every page that needs PHP answers 503. `wrangler.managed.jsonc` adds vars the
 * managed plane sets for itself (`CACHE_API`, `FILE_STORE`); they are not in the canonical block,
 * so they never reach a box. The name has no loadable ending for the same reason as the manifest.
 *
 * `assets/bootimage/` is left out. `BOOT_IMAGE` is not in the canonical `vars` and reads as off
 * when absent (`bootImageEnabled` in `src/do/boot-image.ts`), and an off site never opens the
 * folder, so a box has no use for 33 MB of it.
 *
 * Every refusal below is a bundle a box would take on `site add` and then fail to start. The check
 * runs here, at release time, because the box-side check can only reject what it is handed.
 */

/** the file endings bastion's `modulesFrom` loads; a module outside this list is silently dropped */
export const BOX_SUFFIXES = ['.js', '.mjs', '.wasm', '.json', '.txt', '.bin', '.lock'] as const;

/** conventional entry names bastion infers, in its order, when the bundle does not state one */
export const BOX_ENTRYPOINTS = [
	'index.js',
	'index.mjs',
	'worker.js',
	'main.js',
	'site.js'
] as const;

/** wrangler writes these beside the modules and the box does not load them */
const IGNORED = new Set(['README.md']);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** the archive name; the version has no `v` and the tag does, as in the other release assets */
export function boxBundleName(version: string): string {
	return `drupflare-box-bundle-${version}.tar.gz`;
}

const isScript = (name: string) => name.endsWith('.js') || name.endsWith('.mjs');
const loadable = (name: string) => BOX_SUFFIXES.some((suffix) => name.endsWith(suffix));

/** the modules wrangler wrote, refusing any the box would not load */
export function readBoxModules(outdir: string): Map<string, Uint8Array> {
	const modules = new Map<string, Uint8Array>();
	for (const entry of readdirSync(outdir, { withFileTypes: true })) {
		if (IGNORED.has(entry.name) || entry.name.endsWith('.map')) continue;
		if (entry.isDirectory()) {
			throw new Error(`${entry.name}/ is nested; the box lists the top level only`);
		}
		if (!loadable(entry.name)) {
			throw new Error(
				`${entry.name} has an ending the box does not load (${BOX_SUFFIXES.join(' ')})`
			);
		}
		modules.set(entry.name, new Uint8Array(readFileSync(join(outdir, entry.name))));
	}
	return modules;
}

/**
 * The relative modules a script imports by name.
 *
 * A read of `from"./x"` and `import"./x"`, which is what wrangler's bundler writes for the wasm and
 * text modules a Worker imports. It is a check and not a parser: a module it misses is one the
 * dry-run output already contains, and a name it reads that is not there is refused.
 */
export function importsOf(source: string): string[] {
	const found = new Set<string>();
	for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
		found.add(match[1] as string);
	}
	return [...found].sort();
}

/** the entry module's name from the config's `main`, built the way wrangler names its output */
export function entryOf(main: string): string {
	return `${posix.basename(main).replace(/\.[cm]?[tj]s$/, '')}.js`;
}

/** what is wrong with this module set as a box bundle; empty when a box can run it */
export function boxProblems(modules: Map<string, Uint8Array>, entry: string): string[] {
	const problems: string[] = [];
	if (!modules.has(entry)) {
		problems.push(`${entry} is not among the modules wrangler wrote`);
	} else if (!isScript(entry)) {
		problems.push(`${entry} is not a script`);
	}
	if (!BOX_ENTRYPOINTS.includes(entry as (typeof BOX_ENTRYPOINTS)[number])) {
		problems.push(`${entry} is not a name the box infers, so a site would have to name it`);
	}
	const source = modules.get(entry);
	if (source !== undefined) {
		for (const specifier of importsOf(new TextDecoder().decode(source))) {
			const name = specifier.replace(/^\.\//, '');
			if (specifier.startsWith('../') || name.includes('/') || !modules.has(name)) {
				problems.push(`${entry} imports ${specifier} and the bundle has no such module`);
			}
		}
	}
	return problems;
}

/** the file the box reads the asset checksums from; not a name `modulesFrom` loads */
export const BOX_ASSETS_MANIFEST = 'assets.manifest';

/** what `assets.manifest` holds; `files` is the payload manifest's entry shape, rooted at `assets/` */
export type BoxAssetManifest = {
	name: 'drupflare-box-bundle';
	version: 1;
	release: string;
	files: PayloadFile[];
	totals: { files: number; bytes: number };
};

/** payload folders a box never reads, because nothing in the canonical config turns them on */
export const BOX_WITHHELD = ['assets/bootimage'] as const;

/** the asset files the release ships, repo-relative and sorted, from the payload plan */
export function boxAssetFiles(root: string): string[] {
	assertCoversAssetsIgnore(readFileSync(join(root, 'assets/.assetsignore'), 'utf8'));
	const assets = PAYLOAD_ASSETS.filter(
		(entry) => !(BOX_WITHHELD as readonly string[]).includes(entry.path)
	);
	return expandPlan(root, { assets, records: [], interpreter: [] }).sort();
}

/** the file the box reads the site's vars from; not a name `modulesFrom` loads */
export const BOX_VARS_FILE = 'box.vars';

/** what `box.vars` holds: the vars as a flat object of strings, numbers and booleans */
export type BoxVars = Record<string, string | number | boolean>;

/** the canonical config's `vars`, refusing a value a box could not bind */
export function boxVars(root: string, config: string): BoxVars {
	const vars = readJsonc(join(root, config))['vars'];
	if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) {
		throw new Error(`${config} has no vars block`);
	}
	const found: BoxVars = {};
	for (const [name, value] of Object.entries(vars)) {
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
			throw new Error(`${config} var ${name} is not a string, number or boolean`);
		}
		found[name] = value;
	}
	return found;
}

/** the manifest for a file list; no timestamp, so the same tree describes the same bundle */
export function boxAssetManifest(root: string, release: string, files: string[]): BoxAssetManifest {
	const entries = files.map((path) => {
		if (/[\\\n\r]/.test(path))
			throw new Error(`${path} has a character a tar list cannot carry`);
		return {
			path,
			bytes: statSync(join(root, path)).size,
			sha256: fileSha256(join(root, path))
		};
	});
	return {
		name: 'drupflare-box-bundle',
		version: 1,
		release,
		files: entries,
		totals: { files: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) }
	};
}

// bsdtar on macOS adds a ._ member for every file with an extended attribute, and GNU tar on a box
// unpacks it as a file the assets manifest does not list
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' };

/**
 * Packs the named modules at the archive root, and returns the archive's digest.
 *
 * With `assets`, the asset files and their manifest ride beside them. They are staged in one
 * folder and listed to tar by name, so the order is sorted and no directory entry is written.
 */
export function packBox(
	outdir: string,
	names: string[],
	archive: string,
	assets?: { root: string; manifest: BoxAssetManifest },
	vars?: BoxVars
): string {
	if (assets === undefined && vars === undefined) {
		execFileSync('tar', ['-czf', archive, '-C', outdir, ...names.sort()], {
			maxBuffer: 1 << 28,
			env: TAR_ENV
		});
		return sha256(readFileSync(archive));
	}
	const scratch = mkdtempSync(join(tmpdir(), 'box-pack-'));
	const stage = join(scratch, 'stage');
	try {
		const put = (from: string, to: string) => {
			mkdirSync(dirname(join(stage, to)), { recursive: true });
			copyFileSync(from, join(stage, to));
		};
		for (const name of names) put(join(outdir, name), name);
		const listed = [...names];
		mkdirSync(stage, { recursive: true });
		if (assets !== undefined) {
			for (const file of assets.manifest.files) put(join(assets.root, file.path), file.path);
			writeFileSync(join(stage, BOX_ASSETS_MANIFEST), JSON.stringify(assets.manifest) + '\n');
			listed.push(...assets.manifest.files.map((file) => file.path), BOX_ASSETS_MANIFEST);
		}
		if (vars !== undefined) {
			writeFileSync(join(stage, BOX_VARS_FILE), JSON.stringify(vars) + '\n');
			listed.push(BOX_VARS_FILE);
		}
		listed.sort();
		const list = join(scratch, 'list');
		writeFileSync(list, listed.join('\n') + '\n');
		execFileSync('tar', ['-czf', archive, '-C', stage, '-T', list], {
			maxBuffer: 1 << 28,
			env: TAR_ENV
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return sha256(readFileSync(archive));
}

/** one `sha256sum` line, which `sha256sum -c` reads back */
export function sumsLine(digest: string, name: string): string {
	return `${digest}  ${name}\n`;
}

function arg(name: string): string | undefined {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
}

function required(name: string): string {
	const value = arg(name);
	if (!value) throw new Error(`--${name}= is required`);
	return value;
}

function main(): void {
	const root = resolve(arg('root') ?? process.cwd());
	const outdir = resolve(required('outdir'));
	const out = resolve(required('out'));
	const version = required('version');
	const config = arg('config') ?? 'wrangler.jsonc';
	const entry = entryOf(String(readJsonc(join(root, config))['main']));

	if (!statSync(outdir).isDirectory()) throw new Error(`${outdir} is not a directory`);
	const modules = readBoxModules(outdir);
	const problems = boxProblems(modules, entry);
	if (problems.length > 0) {
		throw new Error(`not a bundle a box can run:\n  ${problems.join('\n  ')}`);
	}

	const manifest = boxAssetManifest(root, version, boxAssetFiles(root));
	const vars = boxVars(root, config);

	mkdirSync(out, { recursive: true });
	const name = boxBundleName(version);
	const digest = packBox(outdir, [...modules.keys()], join(out, name), { root, manifest }, vars);
	const sums = arg('sums');
	if (sums) appendFileSync(sums, sumsLine(digest, name));
	console.log(
		`${name}: ${modules.size} modules, entry ${entry}, ` +
			`${manifest.totals.files} asset files (${manifest.totals.bytes} bytes), ` +
			`${Object.keys(vars).length} vars, ` +
			`sha256 ${digest}` +
			(sums ? `, appended to ${sums}` : '')
	);
}

if (import.meta.main) main();
