import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { ASSET_FILE_BYTES_LIMIT, assetUploadProblems } from '../release/payload';

/**
 * Packs the WordPress tree PHP reads into `assets/wordpress/pf/`, in the per-file format the lazy
 * mount reads.
 *
 *   bun scripts/pack/wordpress.ts [wordpress-root] [out-dir]
 *
 * The file list is a rule, not a trace: every `.php` file, plus the non-PHP files WordPress opens
 * from PHP (JSON for themes and blocks, theme templates, a theme's `style.css` for its header, and
 * the stylesheets core inlines). Images, scripts, fonts and the rest of the CSS are browser-only and
 * are served by the asset layer, never mounted. The compression is `pack/perfile.ts`, unchanged.
 */

const ROOT = resolve(import.meta.dirname, '..');

/** extensions PHP never reads, so they stay out of the mount even where a rule below names the directory */
const BROWSER_ONLY = /\.(js|map|png|jpe?g|gif|webp|avif|ico|bmp|svg|woff2?|ttf|otf|eot|md|txt)$/i;

/** whether the packed tree carries this file; `rel` is relative to the WordPress root */
export function isPackedFile(rel: string): boolean {
	if (rel.endsWith('.php')) return true;
	// read by PHP and inlined into the page, unlike every other script
	if (/^wp-includes\/js\/wp-emoji-loader(\.min)?\.js$/.test(rel)) return true;
	if (BROWSER_ONLY.test(rel)) return false;
	if (rel.endsWith('.json')) return !rel.startsWith('wp-includes/js/');
	if (rel.endsWith('.html')) return rel.startsWith('wp-content/themes/');
	if (rel.endsWith('.css')) {
		return (
			/^wp-content\/themes\/[^/]+\/style(\.min)?\.css$/.test(rel) ||
			rel.startsWith('wp-includes/blocks/') ||
			rel.startsWith('wp-includes/css/') ||
			/^wp-admin\/css\/view-transitions(\.min)?\.css$/.test(rel)
		);
	}
	return false;
}

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.isFile()) out.push(full);
	}
}

/** the packed files under a WordPress root, sorted, as `{ p }` entries the packer reads */
export function listPackedFiles(root: string): { p: string }[] {
	const all: string[] = [];
	walk(root, all);
	return all
		.map((f) => relative(root, f).split('\\').join('/'))
		.filter((rel) => rel !== '.fetched.json' && isPackedFile(rel))
		.sort()
		.map((p) => ({ p }));
}

// #region the browser files
/** the themes whose browser files are published by default: the one the baked site activates */
export const PUBLISHED_THEMES: readonly string[] = ['twentytwentyfive'];

/** the directory a WordPress deploy serves its assets from; the Drupal asset directory never lists it */
export const SITE_DIR = 'assets/wordpress-site';

/** extensions a browser fetches; `.map`, `.txt`, `.scss` and the rest are never linked from a page */
const BROWSER_FILE = /\.(css|js|png|jpe?g|gif|webp|avif|ico|bmp|svg|woff2?|ttf|otf|eot|mp4|webm)$/i;

/** the directories whose files get a header rule, with the files under each */
const HEADER_PREFIXES = ['wp-includes', 'wp-admin', 'wp-content/themes'] as const;

/**
 * Whether a browser can fetch this file from a stock site and the asset layer should answer it.
 *
 * Core publishes the `.min` file of every script and stylesheet that has one: WordPress loads the
 * plain file only under `SCRIPT_DEBUG`, which a release sets false. Right-to-left sheets are for
 * locales, and no language pack ships. `files` is every path under the tree, for the sibling check.
 */
export function isPublishedFile(
	rel: string,
	files: ReadonlySet<string>,
	themes: readonly string[] | 'all' = PUBLISHED_THEMES,
	named: ReadonlySet<string> = new Set()
): boolean {
	const core = rel.startsWith('wp-includes/') || rel.startsWith('wp-admin/');
	const theme = /^wp-content\/themes\/([^/]+)\//.exec(rel)?.[1];
	if (!core && !(theme !== undefined && (themes === 'all' || themes.includes(theme)))) {
		return false;
	}
	if (!BROWSER_FILE.test(rel)) return false;
	if (!core) return true;
	if (/-rtl(\.min)?\.css$/.test(rel)) return false;
	const plain = /^(.*)\.(js|css)$/.exec(rel);
	if (
		plain !== null &&
		!/\.min$/.test(plain[1]!) &&
		files.has(`${plain[1]}.min.${plain[2]}`) &&
		!named.has(rel)
	) {
		return false;
	}
	return true;
}

const LITERAL_ASSET = /['"]\/?((?:wp-includes|wp-admin)\/[A-Za-z0-9_./-]+\.(?:js|css))['"]/g;

/** the scripts and stylesheets core PHP names outright, which WordPress loads even when a `.min` file exists */
export function namedAssets(root: string, rels: readonly string[]): Set<string> {
	const out = new Set<string>();
	for (const rel of rels) {
		if (!rel.endsWith('.php') || !/^(wp-includes|wp-admin)\//.test(rel)) continue;
		for (const m of readFileSync(join(root, rel), 'utf8').matchAll(LITERAL_ASSET)) {
			out.add(m[1]!);
		}
	}
	return out;
}

/** the published files under a WordPress root, sorted */
export function listPublishedFiles(
	root: string,
	themes: readonly string[] | 'all' = PUBLISHED_THEMES
): string[] {
	const all: string[] = [];
	walk(root, all);
	const rels = all.map((f) => relative(root, f).split('\\').join('/'));
	const set = new Set(rels);
	const named = namedAssets(root, rels);
	return rels.filter((rel) => isPublishedFile(rel, set, themes, named)).sort();
}

/**
 * The `_headers` file for a published list.
 *
 * Stylesheets and scripts are requested with a `?ver=` query WordPress changes on an update, so they
 * are immutable. Images and fonts are linked from stylesheets with no version, so they get the
 * year without `immutable`, the same as Drupal's core files. A path never matches two rules, because
 * the platform joins the headers of every matching rule.
 */
export function headersFor(files: readonly string[]): string {
	const blocks: string[] = [];
	for (const prefix of HEADER_PREFIXES) {
		const exts = new Set<string>();
		for (const f of files) {
			if (f.startsWith(prefix + '/'))
				exts.add(/\.([^.]+)$/.exec(f)?.[1]?.toLowerCase() ?? '');
		}
		for (const ext of [...exts].sort()) {
			const versioned = ext === 'css' || ext === 'js';
			blocks.push(
				`/${prefix}/*.${ext}\n  Cache-Control: public, max-age=31536000${versioned ? ', immutable' : ''}\n`
			);
		}
	}
	return blocks.join('');
}

/** what a published set weighs, against the per-version and per-file limits */
export function assetFit(sizes: readonly { path: string; bytes: number }[]): {
	files: number;
	bytes: number;
	largest: { path: string; bytes: number };
	problems: string[];
} {
	const largest = sizes.reduce(
		(a, f) => (f.bytes > a.bytes ? f : a),
		sizes[0] ?? { path: '', bytes: 0 }
	);
	const upload = {
		files: sizes.length,
		bytes: sizes.reduce((n, f) => n + f.bytes, 0),
		oversize: sizes.filter((f) => f.bytes > ASSET_FILE_BYTES_LIMIT)
	};
	return { ...upload, largest, problems: assetUploadProblems(upload) };
}

/** the three WordPress pack outputs, relative to `assets/wordpress` */
function packFiles(packDir: string): string[] {
	if (!statSync(packDir, { throwIfNoEntry: false })?.isDirectory()) return [];
	const all: string[] = [];
	walk(packDir, all);
	return all.map((f) => relative(packDir, f).split('\\').join('/')).sort();
}

/** sha256 of a file; compared instead of buffers, whose `equals` the workers types shadow */
export function digest(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** copies `from` to `to` unless the bytes already match */
function copyIfChanged(from: string, to: string): void {
	const a = statSync(from);
	const b = statSync(to, { throwIfNoEntry: false });
	if (b !== undefined && b.size === a.size && digest(from) === digest(to)) return;
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
}

/** removes files under `dir` that are not in `keep`, then the directories that emptied */
function prune(dir: string, base: string, keep: ReadonlySet<string>): void {
	if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			prune(full, base, keep);
			if (readdirSync(full).length === 0) rmdirSync(full);
		} else if (!keep.has(relative(base, full).split('\\').join('/'))) unlinkSync(full);
	}
}

/**
 * Writes the directory a WordPress deploy serves: the browser files, `_headers`, and a copy of the
 * pack the object reads through its asset binding.
 *
 * Everything in `out` is generated here. A top-level entry this does not write is somebody else's
 * file, so it stops rather than deleting it.
 */
export function writeSite(
	root: string,
	out: string,
	packDir: string,
	themes: readonly string[] | 'all' = PUBLISHED_THEMES
): { files: { path: string; bytes: number }[]; packed: number } {
	const known = new Set(['wp-includes', 'wp-admin', 'wp-content', 'wordpress', '_headers']);
	for (const name of statSync(out, { throwIfNoEntry: false }) ? readdirSync(out) : []) {
		if (!known.has(name))
			throw new Error(`${out}/${name} is not a file this writes; remove it`);
	}
	const list = listPublishedFiles(root, themes);
	for (const rel of list) copyIfChanged(join(root, rel), join(out, rel));
	prune(join(out, 'wp-includes'), out, new Set(list));
	prune(join(out, 'wp-admin'), out, new Set(list));
	prune(join(out, 'wp-content'), out, new Set(list));
	const pack = packFiles(packDir);
	for (const rel of pack) copyIfChanged(join(packDir, rel), join(out, 'wordpress', rel));
	prune(join(out, 'wordpress'), out, new Set(pack.map((p) => `wordpress/${p}`)));
	writeFileSync(join(out, '_headers'), headersFor(list));
	return {
		files: list.map((p) => ({ path: p, bytes: statSync(join(root, p)).size })),
		packed: pack.length
	};
}
// #endregion

if (import.meta.main) {
	const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
	const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
	const site = flags.includes('--site');
	const themeFlag = flags.find((f) => f.startsWith('--themes='))?.slice('--themes='.length);
	const themes =
		themeFlag === undefined
			? PUBLISHED_THEMES
			: themeFlag === 'all'
				? 'all'
				: themeFlag.split(',');
	const root = resolve(args[0] ?? join(ROOT, 'wordpress-src'));
	const out = resolve(args[1] ?? join(ROOT, site ? SITE_DIR : 'assets/wordpress/pf'));
	if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
		console.error(`no WordPress tree at ${root}; run bun run fetch:wordpress`);
		process.exit(1);
	}
	if (site) {
		mkdirSync(out, { recursive: true });
		const written = writeSite(root, out, join(ROOT, 'assets/wordpress'), themes);
		const fit = assetFit(written.files);
		console.log(
			`${fit.files} browser files, ${fit.bytes} bytes, largest ${fit.largest.path} ` +
				`(${fit.largest.bytes} bytes), ${written.packed} pack files`
		);
		for (const p of fit.problems) console.error(`over a limit: ${p}`);
		process.exit(fit.problems.length === 0 ? 0 : 1);
	}
	const list = listPackedFiles(root);
	const dir = mkdtempSync(join(tmpdir(), 'cfw-pack-wp-'));
	const listPath = join(dir, 'list.json');
	writeFileSync(listPath, JSON.stringify(list));
	mkdirSync(out, { recursive: true });
	const run = spawnSync(
		process.execPath,
		[join(ROOT, 'scripts/pack/perfile.ts'), root, out, listPath],
		{ stdio: 'inherit' }
	);
	unlinkSync(listPath);
	rmdirSync(dir);
	process.exit(run.status ?? 1);
}
