import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHIPPING_PACK_CONTRIB, moduleTable } from '../src/ops/module-table';

/**
 * Installs the contributed-module census into `drupal-src`, which had no producer.
 *
 * ```sh
 * bun scripts/install-census.ts            # install everything the table names
 * bun scripts/install-census.ts --check    # report what is missing, install nothing
 * ```
 *
 * WHY THIS EXISTS, AND IT COST A TREE. `src/ops/module-table.ts` records 66 contributed modules with
 * what was asserted about each, and 62 of them are dev-only fixtures rather than shipped content --
 * `pack-drupal.ts` gates `modules/contrib` behind `PACK_CONTRIB=1`. They were installed into
 * `drupal-src` BY HAND. That directory is gitignored and `composer.lock` names only the four in
 * {@link SHIPPING_PACK_CONTRIB}, so nothing in the repository could put them back: a
 * `fetch:drupal --force` on 2026-09-09 deleted 61 modules and every contributed theme, and the gate
 * went from 4,984 passing to 25 failures with no way to restore the inputs.
 *
 * The table is tracked, so it is the authoritative statement of the census. This makes it a producer
 * instead of a record.
 *
 * ## Versions are resolved, not pinned, and that matches what the census claims
 *
 * The table records BEHAVIOUR -- that a module enabled against a real site and registered the
 * services it owns -- not that a particular release did. Pinning 62 versions here would invent
 * precision the evidence does not have, and would go stale against drupal.org on its own schedule.
 * {@link CENSUS_CONSTRAINTS} carries the handful that cannot resolve from a bare name, and each entry
 * says why.
 */

/**
 * DEV STABILITY, PREFERRING STABLE, and that replaces a list of per-package constraints.
 *
 * The tarball's manifest is `minimum-stability: stable`, and a census of 62 contributed modules
 * against a current core does not fit that. Three failure shapes appeared in a row, each needing a
 * different hand-written constraint: `filefield_sources` has never tagged a stable release,
 * `search_gov_results_api` offers only `1.0.x-dev`, and `openid_connect`'s newest STABLE release
 * (1.5.0) requires core `^9.5 || ^10` so it cannot install against 11 at all.
 *
 * Writing sixty constraints by hand would be a second version list to maintain, and a wrong one --
 * the census records BEHAVIOUR, not versions. `prefer-stable` takes the tagged release wherever one
 * exists and falls back to the development branch only where none does, which is exactly the rule
 * those three cases wanted.
 *
 * This is a FIXTURE tree. `pack-drupal.ts` gates `modules/contrib` behind `PACK_CONTRIB=1`, so
 * nothing here reaches a shipped artifact; the four modules that DO ship are pinned exactly in the
 * root `composer.lock` and installed by `fetch-drupal-tree.ts`, not here.
 */
export const CENSUS_STABILITY = { 'minimum-stability': 'dev', 'prefer-stable': true } as const;

/** applies {@link CENSUS_STABILITY} to a tree's manifest, reporting whether it had to change it */
export function relaxStability(root: string): boolean {
	const path = join(root, 'composer.json');
	const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	if (doc['minimum-stability'] === 'dev' && doc['prefer-stable'] === true) return false;
	writeFileSync(path, `${JSON.stringify({ ...doc, ...CENSUS_STABILITY }, null, 4)}\n`);
	return true;
}

/** every package the census names, in the order the table lists them */
export function censusPackages(): string[] {
	return moduleTable().map((r) => r.name);
}

/**
 * The census packages a tree does not already have.
 *
 * Read from the tree's own `composer.json` rather than from `modules/contrib` on disk: a module
 * directory can exist without composer knowing about it, and the next `composer require` would then
 * fight it. The manifest is what composer reconciles against.
 */
export function missingFrom(root: string, wanted = censusPackages()): string[] {
	const manifest = join(root, 'composer.json');
	if (!existsSync(manifest)) return wanted;
	const doc = JSON.parse(readFileSync(manifest, 'utf8')) as {
		require?: Record<string, string>;
		'require-dev'?: Record<string, string>;
	};
	const have = new Set([
		...Object.keys(doc.require ?? {}),
		...Object.keys(doc['require-dev'] ?? {})
	]);
	return wanted.filter((name) => !have.has(name));
}

/** what is on disk, which is what `pack-static.ts` and the contrib lane actually read */
export function onDisk(root: string): { modules: number; themes: number } {
	const count = (dir: string): number => {
		try {
			return readdirSync(join(root, dir), { withFileTypes: true }).filter((e) =>
				e.isDirectory()
			).length;
		} catch {
			return 0;
		}
	};
	return { modules: count('modules/contrib'), themes: count('themes/contrib') };
}

if (import.meta.main) {
	const root = 'drupal-src';
	const check = process.argv.includes('--check');
	if (!existsSync(join(root, 'core/lib/Drupal.php'))) {
		console.error(`${root} is not a Drupal tree; run \`bun run fetch:drupal\` first`);
		process.exit(2);
	}

	const wanted = censusPackages();
	const missing = missingFrom(root, wanted);
	const before = onDisk(root);
	console.error(
		`[census] ${wanted.length} packages named, ${missing.length} not in ${root}/composer.json`
	);
	console.error(`[census] on disk: ${before.modules} modules, ${before.themes} themes`);

	if (check) {
		if (missing.length > 0) {
			console.error(`[census] missing: ${missing.join(' ')}`);
			process.exit(1);
		}
		console.error('[census] the tree declares every package the table names');
		process.exit(0);
	}

	if (missing.length === 0) {
		console.error('[census] nothing to install');
		process.exit(0);
	}

	// ONE `composer require` for the whole set rather than 62 of them. Composer resolves the set
	// together, so installing one at a time can pick a version that a later package then conflicts
	// with -- and it is roughly sixty times slower.
	//
	// `--no-audit`: an advisory published against a census fixture would fail this for a reason that
	// has nothing to do with the census. `--dev` so they land in require-dev, which is what they are.
	if (relaxStability(root)) {
		console.error(
			`[census] set minimum-stability dev / prefer-stable in ${root}/composer.json`
		);
	}
	console.error(`[census] composer require --dev ${missing.length} packages`);
	execFileSync(
		'composer',
		['require', '--dev', '--no-interaction', '--no-progress', '--no-audit', ...missing],
		{ cwd: root, stdio: 'inherit' }
	);

	const after = onDisk(root);
	console.error(
		`[census] on disk: ${after.modules} modules, ${after.themes} themes ` +
			`(+${after.modules - before.modules} / +${after.themes - before.themes})`
	);
	const still = missingFrom(root, wanted);
	if (still.length > 0) {
		console.error(`[census] STILL MISSING: ${still.join(' ')}`);
		process.exit(1);
	}
	console.error('[census] every package the table names is declared and installed');
}
