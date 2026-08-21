import { copyFile, glob, lstat, mkdir, readdir, rm, utimes } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Copies the browser-fetchable half of the Drupal tree into the Workers Assets directory.
 *
 *   bun scripts/pack-static.ts <drupal-root> [out-dir]
 *
 * The three PHP packers all SKIP `css|js|woff2|ttf|eot|ico|png|...` -- correctly, because PHP never
 * opens them and carrying 12 MB into the MEMFS would cost mount time for nothing. But nothing
 * serves a file out of the MEMFS over HTTP either, so `/core/themes/olivero/fonts/*.woff2` 404s and
 * every stylesheet with it. Only the asset layer can answer those, and it reads a directory rather
 * than a pack.
 *
 * So this is a COPY, not a pack: no index, no blob, no compression. Workers Assets content-hashes,
 * caches and compresses what it serves, and a hit never reaches the Worker -- which is why the tree
 * costs nothing against either free-tier ceiling.
 *
 * `out-dir` receives the contents of `<drupal-root>/<subtree>`, so a file lands at the URL Drupal
 * already emits for it: `drupal-src/core/misc/drupal.js` -> `assets/core/misc/drupal.js` ->
 * `/core/misc/drupal.js`. It defaults to `assets/<subtree>`, and a bare name is taken as a name
 * under `assets/`. Run it once per subtree; `bun run assets:static` does both.
 *
 * NO MANIFEST, and scripts/README.md's refusal rule is still honoured: every path this writes
 * matches `SERVED` by construction, so anything in the target that does NOT is a file it did not
 * generate and it stops rather than deleting it. Anything that does match and is no longer in the
 * source is pruned, because a stale asset served under a real URL is worse than a missing one.
 */

/** what a browser fetches and the PHP packers therefore drop */
const SERVED = /\.(css|js|woff2?|ttf|eot|svg|png|jpe?g|gif|ico|webp)$/i;

/**
 * Paths inside `core/` that no page this ships ever fetches.
 *
 * `.pcss.css` is the PostCSS SOURCE Drupal compiles into the sibling `.css`; shipping it doubles
 * the stylesheet count and serves bytes no `<link>` names. `demo_umami` is the QA profile, 2.9 MB
 * of food photography that an installed site never references.
 */
const SKIP = [/\/tests?\//i, /\/node_modules\//, /\.pcss\.css$/i, /profiles\/demo_umami\//];

/**
 * Which subtree to copy, because there are two and they fail differently.
 *
 * `core` was the whole job until a contrib module with its own stylesheet made the gap visible:
 * `assets/core/` cannot answer `/modules/contrib/**`, so the first enabled module shipping css or js
 * 404s on every page that includes it. The URL Drupal emits is rooted at the Drupal root, not at
 * `core`, so the fix is a second subtree rather than a wider glob -- `modules/contrib/token/css/x.css`
 * has to land at `assets/modules/contrib/token/css/x.css`.
 */
const SUBTREES = new Set(['core', 'modules', 'themes']);

const root = process.argv[2];
const flag = process.argv.find((a) => a.startsWith('--subtree='));
const subtree = flag ? flag.slice('--subtree='.length) : 'core';
const outArg = process.argv.slice(3).find((a) => !a.startsWith('--'));
if (!root || !SUBTREES.has(subtree)) {
	console.error(
		`usage: pack-static.ts <drupal-root> [out-dir] [--subtree=${[...SUBTREES].join('|')}]`
	);
	process.exit(1);
}

const outDir = outArg
	? isAbsolute(outArg)
		? outArg
		: resolve(import.meta.dirname, '../assets', outArg.replace(/^assets\//, ''))
	: resolve(import.meta.dirname, `../assets/${subtree}`);

/** the served file set under `<from>/core`, relative to that directory and sorted */
async function servedPaths(from: string): Promise<string[]> {
	const out: string[] = [];
	for await (const p of glob(`${subtree}/**/*`, { cwd: from })) {
		if (!SERVED.test(p)) continue;
		if (SKIP.some((re) => re.test(p))) continue;
		if (!(await lstat(join(from, p))).isFile()) continue;
		out.push(p.slice(subtree.length + 1));
	}
	return out.sort();
}

/** every file already in the target, relative and sorted */
async function existing(dir: string): Promise<string[]> {
	const out: string[] = [];
	for await (const p of glob('**/*', { cwd: dir })) {
		if (!(await lstat(join(dir, p))).isFile()) continue;
		out.push(p);
	}
	return out.sort();
}

/** Removes directories a prune emptied, so the tree does not accumulate skeletons. */
async function pruneEmpty(dir: string, keepRoot: string): Promise<boolean> {
	let empty = true;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			empty = false;
			continue;
		}
		if (!(await pruneEmpty(join(dir, entry.name), keepRoot))) empty = false;
	}
	if (empty && dir !== keepRoot) await rm(dir, { recursive: true, force: true });
	return empty;
}

await mkdir(outDir, { recursive: true });
const wanted = await servedPaths(root);
const have = await existing(outDir);

// a file this packer could not have written means the target is somebody else's directory
const foreign = have.filter((p) => !SERVED.test(p));
if (foreign.length) {
	console.error(
		`${outDir} holds ${foreign.length} file(s) pack-static.ts did not write, starting with ` +
			`${foreign.slice(0, 3).join(', ')}. Point the out-dir at a directory this owns.`
	);
	process.exit(1);
}

const keep = new Set(wanted);
let copied = 0;
let held = 0;
let bytes = 0;

for (const rel of wanted) {
	const src = join(root, subtree, rel);
	const dst = join(outDir, rel);
	const from = await lstat(src);
	bytes += from.size;

	// mtime as well as size, so a re-run is a no-op and a changed tree is not: an equal-size edit is
	// exactly what a patched core file looks like
	const current = await lstat(dst).catch(() => undefined);
	const same =
		current !== undefined &&
		current.size === from.size &&
		Math.floor(current.mtimeMs) === Math.floor(from.mtimeMs);
	if (same) {
		held++;
		continue;
	}

	await mkdir(dirname(dst), { recursive: true });
	await copyFile(src, dst);
	// copyFile does not carry mtime, and without it every run re-copies every file
	await utimes(dst, from.atime, from.mtime);
	copied++;
}

const stale = have.filter((p) => !keep.has(p));
for (const rel of stale) await rm(join(outDir, rel), { force: true });
await pruneEmpty(outDir, outDir);

console.log(
	JSON.stringify(
		{
			files: wanted.length,
			copied,
			unchanged: held,
			pruned: stale.length,
			bytes,
			mb: +(bytes / 1048576).toFixed(2)
		},
		null,
		2
	)
);
