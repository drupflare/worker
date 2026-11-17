import { spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

/**
 * Packs the WordPress tree PHP reads into `assets/wordpress/pf/`, in the per-file format the lazy
 * mount reads.
 *
 *   bun scripts/pack-wordpress.ts [wordpress-root] [out-dir]
 *
 * The file list is a rule, not a trace: every `.php` file, plus the non-PHP files WordPress opens
 * from PHP (JSON for themes and blocks, theme templates, a theme's `style.css` for its header, and
 * the stylesheets core inlines). Images, scripts, fonts and the rest of the CSS are browser-only and
 * are served by the asset layer, never mounted. The compression is `pack-perfile.ts`, unchanged.
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

if (import.meta.main) {
	const root = resolve(process.argv[2] ?? join(ROOT, 'wordpress-src'));
	const out = resolve(process.argv[3] ?? join(ROOT, 'assets/wordpress/pf'));
	if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
		console.error(`no WordPress tree at ${root}; run bun run fetch:wordpress`);
		process.exit(1);
	}
	const list = listPackedFiles(root);
	const dir = mkdtempSync(join(tmpdir(), 'cfw-pack-wp-'));
	const listPath = join(dir, 'list.json');
	writeFileSync(listPath, JSON.stringify(list));
	mkdirSync(out, { recursive: true });
	const run = spawnSync(
		process.execPath,
		[join(ROOT, 'scripts/pack-perfile.ts'), root, out, listPath],
		{ stdio: 'inherit' }
	);
	unlinkSync(listPath);
	rmdirSync(dir);
	process.exit(run.status ?? 1);
}
