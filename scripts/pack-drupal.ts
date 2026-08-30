import { existsSync } from 'node:fs';
import { glob, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { composerAutoloadFiles, sdcSiblings } from './pack-completion.ts';

/**
 * Packs the real file set a cold Drupal request touches into one blob plus an
 * index, the shape profile-guided packing would ship.
 *
 *   node scripts/pack-drupal.ts <drupal-root> /tmp/drupal-includes.json [out-dir]
 *
 * `node`, not `bun`, and that is load-bearing rather than a leftover. The artifact
 * `core.bin.gz` comes out of `gzipSync(blob, { level: 9 })`, and the two runtimes do
 * not emit the same deflate stream for the same input: measured on one 263,004-byte
 * input, node wrote 99,727 bytes and bun wrote 101,240, different sha256. Running this
 * under bun would silently move a shipped asset, so `assets:core` says `node` for the
 * same class of reason `assets:sql` does.
 *
 * `out-dir` is a name under assets/ or an absolute path, and it defaults to
 * assets/drupal. It used to `rm -rf` that directory first, which put the one
 * unrecoverable artifact in the repo -- the hand-trimmed `assets/drupal/site.sqlite`,
 * which nothing here regenerates -- one argument away from deletion, and broke
 * scripts/README.md's own rule that a packer must refuse a target holding files it
 * did not generate. It now only overwrites the three artifacts it writes.
 *
 * PACK_INDEX=1 takes the input list verbatim as the file set instead of expanding
 * it, which is how a pack gets rebuilt from an existing pack's core.json. Every
 * completion rule below is a glob over the tree, so re-running them against a
 * changed tree changes WHICH files ship; pinning the list makes a rebuild a
 * measurement of the tree rather than of the rules. Same reason
 * scripts/pack-perfile.ts reuses core.json.
 */

/** an input entry, from either accepted shape: a pack index keys `p`, a profile trace `path` */
type ListEntry = { p?: string; path?: string };

/** one `core.json` entry: path, offset into the blob, byte length, and source mtime */
type IndexEntry = { p: string; o: number; l: number; m: number };

const root = process.argv[2];
const listPath = process.argv[3] ?? '/tmp/drupal-includes.json';
const outArg = process.argv[4];
if (!root) {
	console.error('usage: pack-drupal.ts <drupal-root> [includes.json] [out-dir]');
	process.exit(1);
}

const outDir = outArg
	? isAbsolute(outArg)
		? outArg
		: resolve(import.meta.dirname, '../assets', outArg)
	: resolve(import.meta.dirname, '../assets/drupal');
await mkdir(outDir, { recursive: true });

// FULL=1 globs the tree and reads no list, which is the only mode a checkout with no pack can run:
// PACK_INDEX and the profiled mode both take their file set FROM an index, and `bake-twig.php`
// builds that index's successor from the index -- so the first pack has to come from somewhere else.
// Without this the missing file surfaced as a JSON parse error naming neither the file nor the mode
if (!existsSync(listPath) && process.env.FULL !== '1') {
	console.error(
		`no ${listPath}: PACK_INDEX=1 and the profiled mode both take their file set from it.\n` +
			'A checkout with no pack yet bootstraps one with FULL=1, which globs the tree instead:\n' +
			`  FULL=1 node scripts/pack-drupal.ts ${root} ${listPath} drupal`
	);
	process.exit(1);
}

// a pack index keys the path as `p`, a profile trace as `path`; accept either so
// either can seed a rebuild
const list: ListEntry[] = existsSync(listPath)
	? (JSON.parse(await readFile(listPath, 'utf8')) as ListEntry[]).map((x) => ({
			...x,
			path: x.path ?? x.p
		}))
	: [];

// The profiled set is environment-dependent: it was captured on a PHP with
// intl/mbstring/iconv present, so Symfony's polyfills short-circuited and never
// appeared. In wasm those extensions are absent and the polyfills DO load, so
// they must be packed even though the profile never saw them.
//
// This is the sharp edge of profile-guided packing -- profile in the target
// environment, or over-pack the known extension-conditional paths.
/** what a browser fetches from the asset layer, which PHP never opens */
const CONTRIB_SKIP =
	/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|css|js|map|md|txt|po|sql|dist|lock)$/i;

const extra: string[] = [];
for await (const p of glob('vendor/symfony/polyfill-*/**/*.php', { cwd: root })) {
	extra.push(p);
}

// FULL=1 packs every non-test PHP file instead of the profiled set. Slower to
// mount and heavier in memory, but immune to the profile-misses-a-class problem
// that conditionally-loaded drivers cause.
let paths: string[];
if (process.env.PACK_INDEX === '1') {
	const indexed = list
		.map((x) => x.path)
		.filter((p): p is string => Boolean(p) && !p!.startsWith('/'));
	// PACK_CONTRIB=1 adds `modules/contrib` wholesale, and it is OFF by default because those
	// modules are a QA fixture rather than product: the shipping pack carries the four the profile
	// already saw and nothing else.
	//
	// Wholesale rather than profiled when it is on, and that is structural: the index is a list of
	// files a traced run OPENED, so a module installed after the trace is invisible to it entirely
	// -- packed as zero files while being present on disk and discoverable, which then fails at
	// whichever class the trace never reached. Same shape as the doctrine/lexer miss that made
	// vendor wholesale, pointed at `modules/contrib`.
	//
	// `vendor` and `libraries` are swept on the same flag, because a contrib module's composer
	// dependency lands there rather than under `modules/contrib`: address needs
	// commerceguys/addressing, svg_image needs enshrined/svg-sanitize, smtp needs phpmailer. The
	// index predates all of them, so packing the module alone installs it and then fatals on a
	// class -- the doctrine/lexer shape again, one directory over.
	// `themes/contrib` is swept too, because `composer/installers` maps `type: drupal-theme` there
	// and a contrib theme was therefore absent from every fixture pack -- so a theme case could not
	// be written at all, and `uswds_base` sat unverifiable for a reason nothing in the runtime
	// refuses
	const contrib = new Set<string>();
	const fixtureTrees =
		process.env.PACK_CONTRIB === '1'
			? ['modules/contrib/**/*', 'themes/contrib/**/*', 'vendor/**/*', 'libraries/**/*']
			: [];
	for (const tree of fixtureTrees) {
		for await (const p of glob(tree, { cwd: root })) {
			if (p.includes('/tests/') || p.includes('/Tests/')) continue;
			if (p.includes('/node_modules/')) continue;
			if (CONTRIB_SKIP.test(p)) continue;
			contrib.add(p);
		}
	}
	for (const p of indexed) contrib.delete(p);
	paths = [...indexed, ...contrib];
	console.error(
		`index-driven: ${indexed.length} files + ${contrib.size} contrib, no other completion rules`
	);
} else if (process.env.FULL === '1') {
	// Drupal's PHP is not only .php: .inc, .module, .install, .theme, .engine and
	// .profile are all executed, and .yml/.twig are read at runtime by the
	// container builder and template engine. Static web assets are excluded
	// because PHP never opens them -- they are served straight from Assets.
	// .svg is NOT excluded: Drupal's themes inline SVGs through Twig
	// ({% include '@claro/../images/src/hamburger-menu.svg' %}), so PHP reads them
	// as templates rather than the browser fetching them as assets. Excluding them
	// broke every admin page with a Twig LoaderError. 574 files, 382 KB.
	const SKIP = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|css|js|map|md|txt|po|sql)$/i;
	const all: string[] = [];
	for await (const p of glob('**/*', { cwd: root })) {
		if (p.includes('/tests/') || p.includes('/Tests/') || p.startsWith('tests/')) continue;
		if (p.includes('/node_modules/') || p.includes('/.git/')) continue;
		if (SKIP.test(p)) continue;
		all.push(p);
	}
	paths = all;
} else {
	// no emptiness guard here, unlike the PACK_INDEX branch: an entry carrying neither
	// key is a malformed list and throwing beats packing a silently shorter set
	const profiled = list.map((x) => x.path).filter((p): p is string => !p!.startsWith('/'));
	const units = new Set<string>();
	for (const p of profiled) {
		const m = p.match(/^(vendor\/[^/]+\/[^/]+)\//);
		if (m) units.add(m[1]!);
	}
	if (process.env.COMPLETE_CORE === '1') {
		units.add('core/lib');
		for (const p of profiled) {
			const m = p.match(/^(core\/(?:modules|profiles|themes)\/[^/]+)\//);
			if (m) units.add(m[1]!);
		}
	}

	const SKIP = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|css|js|map|md|txt|po|sql|dist|lock)$/i;
	const completed = new Set<string>(profiled);
	for (const unit of units) {
		for await (const p of glob(`${unit}/**/*`, { cwd: root })) {
			if (p.includes('/tests/') || p.includes('/Tests/')) continue;
			if (SKIP.test(p)) continue;
			completed.add(p);
		}
	}

	// Vendor, wholesale. Package-level completion only fires for packages the
	// trace touched, so a package never touched at all is invisible -- exactly
	// what happened to doctrine/lexer (0 files packed), which Drupal's annotation
	// parser needs for /user/1 and /admin/content. 2,731 files / 11.6 MB kills
	// the entire class rather than the instances, and edge validation showed the
	// memory budget can absorb it.
	for await (const p of glob('vendor/**/*.php', { cwd: root })) {
		if (p.includes('/tests/') || p.includes('/Tests/')) continue;
		completed.add(p);
	}

	// core/includes is procedural code loaded conditionally by module_load_include
	// and the installer. 12 files, 330 KB. install.inc was missing and broke
	// /admin/modules.
	for await (const p of glob('core/includes/**/*.{php,inc}', { cwd: root })) {
		completed.add(p);
	}

	// Exception classes are invisible to any trace, by definition: they load only
	// when something fails, and a successful profiling run never fails.
	//
	// This bit three times before the pattern was clear. The third was the worst
	// because it failed SILENTLY: router->match() resolved correctly, then tried
	// to throw CacheableAccessDeniedHttpException / CacheableResourceNotFoundException,
	// the class was missing, and the error was swallowed -- so every route
	// returned the front page with HTTP 200. /robots.txt served 12,304 bytes of
	// HTML and nothing looked wrong.
	//
	// Vendor packages are completed wholesale above; core's are not, because
	// completing all of core/lib costs ~16 MB. Exception classes are tiny, so
	// take them all.
	for await (const p of glob('core/**/Exception/*.php', { cwd: root })) {
		if (p.includes('/tests/') || p.includes('/Tests/')) continue;
		completed.add(p);
	}
	for await (const p of glob('core/**/*Exception.php', { cwd: root })) {
		if (p.includes('/tests/') || p.includes('/Tests/')) continue;
		completed.add(p);
	}

	// *.info.yml is a special case even under a trace: ExtensionDiscovery scans
	// directories rather than opening every candidate, so a module's info file
	// can be required for discovery without ever being opened on the traced
	// path. Cheap and small, so include them all.
	for await (const p of glob('**/*.info.yml', { cwd: root })) {
		if (p.includes('/tests/') || p.includes('/Tests/')) continue;
		completed.add(p);
	}

	// Data files the profile structurally cannot see.
	//
	// get_included_files() only reports files PHP *included*. Drupal reads its
	// service definitions, routing, plugin metadata and templates with
	// file_get_contents through its own storage abstractions, so none of them
	// appear in a profile -- which is why the pack was missing
	// core/core.services.yml even though the run obviously used it.
	//
	// With TRACE=1 the input list already contains every path the runtime
	// actually opened -- yml, twig, .module, .inc, .install included -- so the
	// blanket sweep below is unnecessary and costs ~2,300 files. Without a
	// trace, fall back to including them all.
	if (process.env.TRACE !== '1') {
		for await (const p of glob('**/*.{yml,yaml,twig}', { cwd: root })) {
			if (p.includes('/tests/') || p.includes('/Tests/')) continue;
			if (p.includes('/node_modules/')) continue;
			completed.add(p);
		}
	}

	// Contrib modules, WHOLESALE, for the same structural reason vendor is taken wholesale: a
	// profile captured before a module was installed cannot know which of its files load, and a
	// module that is present-but-partially-packed fails at a class the trace never reached. That is
	// the doctrine/lexer failure again, pointed at `modules/contrib`.
	//
	// Bounded by the same SKIP list, so the images, fonts and stylesheets a browser fetches from the
	// asset layer are not carried into the PHP filesystem.
	for await (const p of glob('modules/contrib/**/*', { cwd: root })) {
		if (p.includes('/tests/') || p.includes('/Tests/')) continue;
		if (p.includes('/node_modules/')) continue;
		if (CONTRIB_SKIP.test(p)) continue;
		completed.add(p);
	}

	const seen = new Set(list.map((x) => x.path));
	for (const p of extra) if (!seen.has(p)) completed.add(p);

	// sites/default/files is runtime-writable state: the database is mounted
	// separately and compiled Twig is regenerated. A trace sees the database
	// being opened and would otherwise pack a duplicate 6.5 MB copy.
	paths = [...completed].filter((p) => !p.startsWith('sites/default/files/')).sort();
	console.error(`profiled ${profiled.length} -> ${units.size} units -> ${paths.length} files`);
}

// A SINGLE-DIRECTORY COMPONENT'S STYLESHEET IS DISCOVERED WITH file_exists(), so the skip lists
// above silently strip it. `ComponentPluginManager::findAsset()` stats `<dir>/<name>.css` and
// returns NULL when it is absent, so the component's auto-generated library carries no CSS and the
// browser is never told to fetch it -- while `assets/core` serves the file correctly the whole time.
// Measured on the admin toolbar: `admin-reset-styles.css` does `all: revert` inside
// `[data-drupal-admin-styles]` and nothing re-dresses it, so every toolbar button rendered as a raw
// `2px outset` UA button and every menu link as blue underlined text.
//
// The bytes are packed rather than stubbed because aggregation READS them; with `css.preprocess`
// on, an empty file would aggregate to nothing and fail the same way one directory further along.
// Keyed off the manifests ALREADY in the pack, so a component ships its stylesheet exactly when it
// ships its definition; a test fixture nothing packed stays unpacked.
const sdcAssets = sdcSiblings(paths, (p) => existsSync(join(root, p)));
if (sdcAssets.length > 0) {
	const before = paths.length;
	paths = [...new Set([...paths, ...sdcAssets])];
	console.error(`sdc: ${sdcAssets.length} component assets, ${paths.length - before} new`);
}

// COMPOSER'S `files` AUTOLOAD IS REQUIRED BEFORE ANY CLASS RESOLVES, so a missing member is not a
// fatal on the path that uses the package -- it is a fatal on every request. A pinned list cannot
// see a dependency added after it was pinned, and two already had been: `halaxa/json-machine` and
// `league/csv` were in `autoload_files.php` and in neither pack, so the next bake would have
// shipped an autoloader that dies opening its own manifest.
const autoloadFiles = join(root, 'vendor/composer/autoload_files.php');
if (existsSync(autoloadFiles)) {
	const required = composerAutoloadFiles(await readFile(autoloadFiles, 'utf8'));
	const known = new Set(paths);
	const add = new Set<string>();
	for (const entry of required) {
		if (known.has(entry) || !existsSync(join(root, entry))) continue;
		// the PACKAGE, not the one file: `league/csv`'s entry is a two-line shim that requires its
		// sibling, so adding the named file alone just moves the fatal one `require` along. A
		// package whose bootstrap the list never saw is a package the list never saw at all --
		// the doctrine/lexer case, which is why vendor is completed wholesale elsewhere
		const unit = entry.match(/^(vendor\/[^/]+\/[^/]+)\//)?.[1];
		if (unit === undefined) {
			add.add(entry);
			continue;
		}
		for await (const p of glob(`${unit}/**/*.php`, { cwd: root })) {
			if (p.includes('/tests/') || p.includes('/Tests/')) continue;
			if (!known.has(p)) add.add(p);
		}
	}
	if (add.size > 0) {
		paths = [...paths, ...add];
		console.error(`composer files: +${add.size} files completing ${required.length} entries`);
	}
}

const parts: Buffer[] = [];
const index: IndexEntry[] = [];
let offset = 0;
let missing = 0;

for (const path of paths) {
	let buf: Buffer;
	let mtime = 0;
	try {
		buf = await readFile(join(root, path));
		// mtime is load-bearing, not metadata: Drupal's
		// MTimeProtectedFastFileStorage hashes filemtime() into the directory
		// name of compiled Twig. If the VFS reports write-time instead of the
		// original, every cold boot misses its own shipped cache and recompiles.
		mtime = Math.floor((await stat(join(root, path))).mtimeMs);
	} catch {
		missing++;
		continue;
	}
	index.push({ p: path, o: offset, l: buf.length, m: mtime });
	parts.push(buf);
	offset += buf.length;
}

const blob = Buffer.concat(parts);
await writeFile(join(outDir, 'core.json'), JSON.stringify(index));

// Ship gzipped: the full tree is 33 MB raw, over the 25 MiB per-asset ceiling,
// and Workers can inflate it with DecompressionStream. Also writes the raw form
// when it is small enough to be useful for comparison.
const gz = gzipSync(blob, { level: 9 });
await writeFile(join(outDir, 'core.bin.gz'), gz);
if (blob.length < 24 * 1024 * 1024) {
	await writeFile(join(outDir, 'core.bin'), blob);
} else {
	await rm(join(outDir, 'core.bin'), { force: true });
}

console.log(
	JSON.stringify(
		{
			files: index.length,
			missing,
			rawBytes: blob.length,
			rawMb: +(blob.length / 1048576).toFixed(2),
			gzipBytes: gz.length,
			gzipMb: +(gz.length / 1048576).toFixed(2),
			indexBytes: (await readFile(join(outDir, 'core.json'))).length
		},
		null,
		2
	)
);
