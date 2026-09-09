/**
 * Builds immutable CSS and JS aggregates OUTSIDE PHP, at build time.
 *
 * ## Why this is not done in Drupal
 *
 * `css.preprocess` and `js.preprocess` ship at `false`, and turning them on is worth 3.2 ms a
 * render -- 21 ms to 18, n=40 per arm, bracketed in both orders with the ON arm winning both --
 * plus 60 `<link>` and 11 `<script>` collapsing to 9 and 2, and about 5,400 bytes off every stored
 * page row.
 *
 * And it is unshippable in PHP, for a reason that is not about aggregation at all: THE SOURCE FILES
 * DO NOT EXIST THERE. 0 of 12 sampled CSS files are readable in MEMFS, the per-file pack cannot
 * supply them, and the aggregate route answers 69 bytes -- the licence header alone. The page it
 * produces has no CSS and no JavaScript. Every previous attempt tried to put the files back into
 * PHP's filesystem, which costs the pack size and the mount time that made them absent.
 *
 * ## So it happens here
 *
 * `drupal-src` is the build input and the files DO exist in it. This reads the library definitions,
 * concatenates each library's CSS and JS in declaration order, and writes them under `assets/agg/`
 * keyed by a content hash -- so a change to any source file mints a new name and the old one stays
 * addressable. Workers Assets serves them, which is one of exactly two paths that cost ZERO Worker
 * requests.
 *
 * ## What it deliberately does not do
 *
 * No minification and no `@import` inlining. Drupal's own aggregator does neither by default, the
 * bytes are served compressed anyway, and a transform that rewrites CSS is a place for this to
 * produce a page that renders differently from the one the render path expects.
 *
 * Usage: `bun scripts/pack-aggregates.ts [drupal-src] [assets/agg]`
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** one library's assets, in declaration order */
export type Library = {
	/** `<extension>/<name>`, which is how Drupal names it */
	id: string;
	css: string[];
	js: string[];
};

/**
 * Reads every `*.libraries.yml` under `root` into a flat library list.
 *
 * A HAND PARSER rather than a YAML dependency, and the shape is what makes that safe: a libraries
 * file is two levels of mapping whose leaves are file paths with option maps this does not read.
 * Anything it cannot parse is SKIPPED and counted, so a library that changes shape shows up as a
 * dropped count rather than as a silently empty aggregate.
 */
export function readLibraries(root: string): { libraries: Library[]; skipped: number } {
	const libraries: Library[] = [];
	let skipped = 0;
	for (const file of findLibraryFiles(root)) {
		const extension = basename(file).replace(/\.libraries\.yml$/, '');
		const base = dirname(file);
		let current: Library | null = null;
		let section: 'css' | 'js' | null = null;
		for (const raw of readFileSync(file, 'utf8').split('\n')) {
			const line = raw.replace(/\r$/, '');
			if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
			const indent = line.length - line.trimStart().length;
			const text = line.trim();

			if (indent === 0) {
				if (current) libraries.push(current);
				const name = text.replace(/:.*$/, '');
				current = /^[A-Za-z0-9_.-]+$/.test(name)
					? { id: `${extension}/${name}`, css: [], js: [] }
					: null;
				if (current === null) skipped++;
				section = null;
				continue;
			}
			if (current === null) continue;
			if (indent === 2) {
				section = text.startsWith('css:') ? 'css' : text.startsWith('js:') ? 'js' : null;
				continue;
			}
			if (section === null) continue;
			// a leaf is `path/to/file.css: {}` at some deeper indent; a css group header
			// (`theme:`, `base:`) has no extension and is skipped by the same test
			const path = text.replace(/:.*$/, '').replace(/^['"]|['"]$/g, '');
			if (section === 'css' && path.endsWith('.css')) current.css.push(join(base, path));
			if (section === 'js' && path.endsWith('.js')) current.js.push(join(base, path));
		}
		if (current) libraries.push(current);
	}
	return { libraries, skipped };
}

/** every `*.libraries.yml` under `root`, skipping the trees a site never serves from */
export function findLibraryFiles(root: string): string[] {
	const out: string[] = [];
	const skip = new Set(['node_modules', 'vendor', 'tests', 'test', '.git', 'coverage']);
	const walk = (dir: string): void => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (skip.has(name)) continue;
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) walk(full);
			else if (name.endsWith('.libraries.yml')) out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

/** what a `url()` target has to start with to be left alone: a scheme, a root path, or a fragment */
const ABSOLUTE_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * Rewrites a stylesheet's relative `url()` targets to the absolute paths they resolved to before.
 *
 * MANDATORY RATHER THAN A TRANSFORM THIS COULD SKIP. An aggregate is served from `/agg/`, so
 * `url(../../fonts/metropolis/Metropolis-Regular.woff2)` inside Olivero's `fonts.css` resolves to
 * `/fonts/...` instead of `/core/themes/olivero/fonts/...`. Measured on the built set before this
 * existed: 270 targets across 408 CSS aggregates, every one a 404, which is every icon, spinner,
 * required-field marker and webfont on a site running `ASSET_AGGREGATES=1`.
 *
 * @param webPath the URL the SOURCE file was served at, which is what the relative target meant.
 */
export function rebaseCssUrls(css: string, webPath: string): string {
	const dir = webPath.slice(0, webPath.lastIndexOf('/') + 1);
	return css.replace(CSS_URL, (whole: string, quote: string, target: string) => {
		const trimmed = target.trim();
		if (trimmed === '' || ABSOLUTE_TARGET.test(trimmed)) return whole;
		// a throwaway origin, so `../` resolution and any query or fragment come from the URL parser
		const at = new URL(trimmed, `https://agg.invalid${dir}`);
		return `url(${quote}${at.pathname}${at.search}${at.hash}${quote})`;
	});
}

/** one aggregate: the concatenation, its content name, and what went into it */
export type Aggregate = {
	name: string;
	bytes: number;
	sources: number;
	missing: number;
	body: string;
};

/**
 * Concatenates one library's files of a kind.
 *
 * A MISSING FILE IS COUNTED, NOT FATAL. Drupal libraries reference files that a given build may not
 * carry -- an optional dependency, a theme that ships a subset -- and failing the whole pack on one
 * would make this unusable. What matters is that the count is reported, because a library whose
 * files are ALL missing produces an empty aggregate, which is the failure mode that shipped a page
 * with no CSS the last time this was attempted.
 *
 * @param root the docroot, which is what turns a source path into the URL its `url()` targets were
 *   written against. Omitted, the bytes are concatenated as they are and every relative target
 *   silently repoints at `/agg/`.
 */
export function aggregate(files: readonly string[], kind: 'css' | 'js', root?: string): Aggregate {
	let body = '';
	let missing = 0;
	for (const file of files) {
		if (!existsSync(file)) {
			missing++;
			continue;
		}
		let text = readFileSync(file, 'utf8');
		if (kind === 'css' && root !== undefined) {
			const web = webPath(root, file);
			if (web !== null) text = rebaseCssUrls(text, web);
		}
		// a marker per source, which is what makes a wrong aggregate debuggable in a browser
		body +=
			kind === 'css'
				? `/* ${basename(file)} */\n${text}\n`
				: `/* ${basename(file)} */\n${text}\n;\n`;
	}
	const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
	return { name: `${hash}.${kind}`, bytes: body.length, sources: files.length, missing, body };
}

/** the manifest a render reads to turn a library set into aggregate URLs */
export type AggregateManifest = {
	version: 1;
	generatedFrom: string;
	libraries: Record<string, { css?: string; js?: string }>;
	/**
	 * every source file each aggregate replaces, as the WEB path a render emits.
	 *
	 * This is what makes the substitution possible without a PHP change. The render array's library
	 * list is gone by the time a response exists, so the host cannot ask which libraries a page
	 * used -- but the page itself names every file, which is the same information from the other
	 * side.
	 */
	files: Record<string, { css?: string[]; js?: string[] }>;
};

/**
 * A source path as the URL Drupal emits for it.
 *
 * `drupal-src/core/themes/olivero/css/base/base.css` is served as
 * `/core/themes/olivero/css/base/base.css`. Anything outside the docroot answers null, which drops
 * that library from the substitution rather than guessing a URL for it.
 */
export function webPath(root: string, file: string): string | null {
	const prefix = root.endsWith('/') ? root : `${root}/`;
	if (!file.startsWith(prefix)) return null;
	return `/${file.slice(prefix.length)}`;
}

if (import.meta.main) {
	const source = resolve(ROOT, process.argv[2] ?? 'drupal-src');
	const out = resolve(ROOT, process.argv[3] ?? 'assets/agg');
	if (!existsSync(source)) {
		throw new Error(
			`no build input at ${source}. The library sources exist only in the Drupal tree the pack is baked from.`
		);
	}
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });

	const { libraries, skipped } = readLibraries(source);
	const manifest: AggregateManifest = {
		version: 1,
		generatedFrom: source.replace(`${ROOT}/`, ''),
		libraries: {},
		files: {}
	};
	let written = 0;
	let bytes = 0;
	let empty = 0;
	for (const library of libraries) {
		const entry: { css?: string; js?: string } = {};
		for (const kind of ['css', 'js'] as const) {
			const files = library[kind];
			if (files.length === 0) continue;
			const agg = aggregate(files, kind, source);
			if (agg.bytes === 0) {
				empty++;
				continue;
			}
			Bun.write(join(out, agg.name), agg.body);
			entry[kind] = agg.name;
			written++;
			bytes += agg.bytes;
		}
		if (entry.css !== undefined || entry.js !== undefined) {
			manifest.libraries[library.id] = entry;
			const paths: { css?: string[]; js?: string[] } = {};
			for (const kind of ['css', 'js'] as const) {
				if (entry[kind] === undefined) continue;
				const web = library[kind]
					.map((f) => webPath(source, f))
					.filter((p): p is string => p !== null);
				// ALL OR NOTHING per library: a partial list would let the substitution replace some
				// of a library's files and leave the rest, which is a page missing rules rather
				// than a page with fewer requests
				if (web.length === library[kind].length) paths[kind] = web;
			}
			manifest.files[library.id] = paths;
		}
	}
	Bun.write(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);

	console.log(`source          ${source}`);
	console.log(`libraries       ${libraries.length} read, ${skipped} unparseable`);
	console.log(`aggregates      ${written} written, ${empty} empty and dropped`);
	console.log(`bytes           ${bytes.toLocaleString()}`);
	console.log(`out             ${out}`);
}
