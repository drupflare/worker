const SUFFIX = '.component.yml';

/**
 * The stylesheet and script a single-directory component owns, for every component in a file set.
 *
 * `ComponentPluginManager::findAsset()` resolves a component's CSS by stat-ing
 * `<dir>/<name>.css` and returns NULL when it is absent, so a pack that strips stylesheets as
 * "static assets PHP never opens" leaves every SDC with an auto-generated library that carries no
 * CSS at all. Nothing errors: the component renders, the browser is simply never told to fetch a
 * file the asset layer is serving correctly.
 *
 * Keyed off the manifests already in the set rather than a glob over the tree, so a component ships
 * its assets exactly when it ships its definition.
 *
 * @param paths
 *   Every path already in the pack, tree-relative.
 * @param exists
 *   Whether a tree-relative path is a real file.
 *
 * @returns
 *   The sibling assets to add, sorted, without duplicates.
 */
export function sdcSiblings(paths: Iterable<string>, exists: (path: string) => boolean): string[] {
	const found = new Set<string>();
	for (const path of paths) {
		if (!path.endsWith(SUFFIX)) continue;
		const cut = path.lastIndexOf('/');
		// a manifest at the tree root has no component directory and no siblings to find
		if (cut < 0) continue;
		const stem = path.slice(0, -SUFFIX.length);
		for (const ext of ['css', 'js']) {
			const asset = `${stem}.${ext}`;
			if (exists(asset)) found.add(asset);
		}
	}
	return [...found].sort();
}

/**
 * Directories core lists with `scandir()`, keyed on the module whose code does the listing.
 *
 * A listing sees only what the pack carries, and the skip lists strip `.js` as something PHP never
 * opens. `LanguageMapper::getMappings()` lists the CKEditor 5 translations to learn its langcodes,
 * so with none packed it warned on every editor render and mapped no language at all. Its cache
 * cannot stand in: it lives in `cache.discovery`, which a driver update empties.
 */
export const SCANNED_DIRECTORIES: Record<string, string> = {
	'core/modules/ckeditor5/': 'core/assets/vendor/ckeditor5/ckeditor5-dll/translations/'
};

/**
 * The files inside every directory in {@link SCANNED_DIRECTORIES} whose module is in a file set.
 *
 * @param paths
 *   Every path already in the pack, tree-relative.
 * @param list
 *   The tree-relative files directly inside a tree-relative directory.
 *
 * @returns
 *   The files to add, sorted, without duplicates.
 */
export function scannedDirectoryFiles(
	paths: Iterable<string>,
	list: (dir: string) => string[]
): string[] {
	const packed = [...paths];
	const found = new Set<string>();
	for (const [module, dir] of Object.entries(SCANNED_DIRECTORIES)) {
		if (!packed.some((p) => p.startsWith(module))) continue;
		for (const file of list(dir)) found.add(file);
	}
	return [...found].sort();
}

/**
 * Every path composer's autoloader `require`s before any class is resolved.
 *
 * A `files` entry is loaded unconditionally by `autoload_real.php`, so one missing member is a
 * fatal on EVERY request rather than on whichever path uses the package -- and it is invisible to a
 * profile taken before the dependency existed, which is exactly how `halaxa/json-machine` and
 * `league/csv` got into `autoload_files.php` while the pinned pack list carried neither.
 *
 * @param source
 *   The contents of `vendor/composer/autoload_files.php`.
 *
 * @returns
 *   Tree-relative paths, sorted, without duplicates.
 */
export function composerAutoloadFiles(source: string): string[] {
	const found = new Set<string>();
	// composer writes `$vendorDir . '/pkg/file.php'` and, for a path outside vendor, `$baseDir . '/...'`
	for (const [, base, rest] of source.matchAll(/\$(vendorDir|baseDir) \. '([^']+)'/g)) {
		const path = `${base === 'vendorDir' ? 'vendor' : ''}${rest}`.replace(/^\/+/, '');
		if (path !== '') found.add(path);
	}
	return [...found].sort();
}
