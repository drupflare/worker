import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Structural comparison of two `site.sqlite` files, and the acceptance check for the packer recipe.
 *
 *   node scripts/diff-site-db.ts assets/drupal/site.sqlite /tmp/built-site.sqlite
 *
 * Run under NODE, not bun: it needs `node:sqlite`, which bun does not ship. `assets:sql` and
 * `bake:container` are run the same way for the same reason.
 *
 * Structural, not a byte comparison. A Drupal install mints a random hash salt, a UUID per
 * config object, a hashed admin password and per-row timestamps, so two correct runs of
 * `install-site-db.php` differ in thousands of bytes while describing the same site. A byte diff
 * would therefore fail on every run and prove nothing, and "reproducible" for this artifact has to
 * mean the same tables, the same module set, the same config keys and the same rendered output.
 *
 * This is the acceptance check and a render is not. A cache hit and a cache miss render the same
 * 12,304 bytes, which is how the container-cache miss survived a byte-identical render for a whole
 * session. Counting rows catches what a render cannot see.
 *
 * The six cache bins Drupal creates on FIRST REQUEST rather than at install time are expected to be
 * absent from a freshly installed database and present in a baked one. They are named rather than
 * tolerated by a wildcard, so a seventh missing table is a failure instead of a rounding error.
 */

const LAZY_CACHE_BINS = [
	'cache_access_policy',
	'cache_data',
	'cache_dynamic_page_cache',
	'cache_entity',
	'cache_page',
	'cache_render'
];

/**
 * `state` rows a fresh install has not written yet, for the same reason the cache bins above are
 * absent: nothing has served a request.
 *
 * `twig_extension_hash_prefix` is the one that matters. `TwigEnvironment` compares it against the
 * container's `%twig_extension_hash%`, and if they disagree it mints a fresh `uniqid()` prefix and
 * orphans every compiled template WITH NO ERROR. So it is expected to be absent before the Twig bake
 * and expected to be PRESENT after it, which makes it a checkable step in the recipe rather than a
 * silent coupling.
 */
const FIRST_REQUEST_STATE_ROWS = [
	'system.private_key',
	'system.theme.files',
	'twig_extension_hash_prefix'
];

type Db = { path: string; db: DatabaseSync };

export function open(path: string, readOnly = true): Db {
	return { path, db: new DatabaseSync(path, { readOnly }) };
}

function tableNames({ db }: Db): string[] {
	return (
		db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as Array<{
			name: string;
		}>
	).map((r) => r.name);
}

/**
 * Row count, or null when the table cannot be counted from a plain client.
 *
 * `users`, `users_field_data` and friends declare columns `COLLATE NOCASE_UTF8`, a collation the
 * Drupal sqlite driver registers per CONNECTION. Nothing outside a Drupal bootstrap has it, so a
 * count over those tables raises "no such collation sequence" -- a real constraint on every external
 * tool that reads this file, not a defect in it.
 */
function rowCount({ db }: Db, table: string): number | null {
	try {
		const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
		return Number(row.n);
	} catch {
		return null;
	}
}

function configNames({ db }: Db): string[] {
	try {
		return (
			db.prepare('SELECT name FROM config ORDER BY name').all() as Array<{ name: string }>
		)
			.map((r) => r.name)
			.sort();
	} catch {
		return [];
	}
}

/** the serialised `core.extension` module list, which is the module set the site actually runs */
function moduleSet({ db }: Db): string[] {
	try {
		const row = db.prepare("SELECT data FROM config WHERE name='core.extension'").get() as
			{ data: string | Uint8Array } | undefined;
		if (!row) return [];
		const text =
			typeof row.data === 'string' ? row.data : Buffer.from(row.data).toString('binary');
		// the module list is a serialised PHP array; the names are what matter, not the weights, so
		// a targeted match beats pulling in an unserialiser for one field
		const start = text.indexOf('s:6:"module"');
		if (start < 0) return [];
		const themeAt = text.indexOf('s:5:"theme"', start);
		const slice = text.slice(start, themeAt > start ? themeAt : undefined);
		return [...slice.matchAll(/s:\d+:"([a-z0-9_]+)";i:/g)].map((m) => m[1] as string).sort();
	} catch {
		return [];
	}
}

/** whether the `state` collection holds a given key; absent before anything served a request */
function hasStateRow({ db }: Db, name: string): boolean {
	try {
		const row = db
			.prepare("SELECT 1 AS present FROM key_value WHERE collection='state' AND name=?")
			.get(name) as { present: number } | undefined;
		return row?.present === 1;
	} catch {
		return false;
	}
}

/**
 * Compares two open databases and returns the report.
 *
 * Exported and pure so the GATE ITSELF can be tested. This project has moved a free-tier verdict five
 * times and four of those were the instrument rather than the system, so a comparison that reports
 * STRUCTURALLY EQUIVALENT over a diverged database is the single most expensive way this file could
 * be wrong. `tests/node/site-db-diff.spec.ts` builds two fixtures and asserts the verdict flips.
 */
export function compareSiteDbs(left: Db, right: Db) {
	const leftTables = tableNames(left);
	const rightTables = tableNames(right);
	const missingTables = leftTables.filter((t) => !rightTables.includes(t));
	const extraTables = rightTables.filter((t) => !leftTables.includes(t));
	const unexpectedMissing = missingTables.filter((t) => !LAZY_CACHE_BINS.includes(t));

	const leftConfig = configNames(left);
	const rightConfig = configNames(right);
	const missingConfig = leftConfig.filter((c) => !rightConfig.includes(c));
	const extraConfig = rightConfig.filter((c) => !leftConfig.includes(c));

	const leftModules = moduleSet(left);
	const rightModules = moduleSet(right);
	const missingModules = leftModules.filter((m) => !rightModules.includes(m));
	const extraModules = rightModules.filter((m) => !leftModules.includes(m));

	// the tables whose contents are the SITE rather than a cache; a divergence here is a different site,
	// while a divergence in a cache_* count is just a difference in how warm the two are
	const STRUCTURAL_TABLES = ['config', 'router', 'key_value', 'menu_tree', 'users_field_data'];
	const counts = STRUCTURAL_TABLES.map((t) => ({
		table: t,
		reference: rowCount(left, t),
		built: rowCount(right, t)
	}));

	// key_value carries the first-request state rows, so an unbaked build is legitimately short by
	// exactly however many of them the reference has and the build does not
	const stateAbsent = FIRST_REQUEST_STATE_ROWS.filter(
		(k) => hasStateRow(left, k) && !hasStateRow(right, k)
	);
	const kv = counts.find((c) => c.table === 'key_value');
	if (kv && kv.reference !== null) kv.reference -= stateAbsent.length;
	const countMismatches = counts.filter(
		(c) => c.reference !== null && c.built !== null && c.reference !== c.built
	);

	const problems: string[] = [];
	if (unexpectedMissing.length > 0) {
		problems.push(`built database is missing ${unexpectedMissing.length} table(s) that are not
		lazily-created cache bins: ${unexpectedMissing.join(', ')}`);
	}
	if (extraTables.length > 0)
		problems.push(`built database has extra tables: ${extraTables.join(', ')}`);
	if (missingConfig.length > 0)
		problems.push(`built database is missing config: ${missingConfig.join(', ')}`);
	if (extraConfig.length > 0)
		problems.push(`built database has extra config: ${extraConfig.join(', ')}`);
	if (missingModules.length > 0)
		problems.push(`built database is missing modules: ${missingModules.join(', ')}`);
	if (extraModules.length > 0)
		problems.push(`built database enables extra modules: ${extraModules.join(', ')}`);
	for (const c of countMismatches) {
		problems.push(`${c.table}: reference has ${c.reference} rows, built has ${c.built}`);
	}

	const report = {
		reference: left.path,
		built: right.path,
		tables: { reference: leftTables.length, built: rightTables.length },
		lazyBinsAbsentFromBuild: missingTables.filter((t) => LAZY_CACHE_BINS.includes(t)),
		firstRequestStateRowsAbsentFromBuild: stateAbsent,
		config: {
			reference: leftConfig.length,
			built: rightConfig.length,
			identicalNames: missingConfig.length === 0 && extraConfig.length === 0
		},
		modules: {
			reference: leftModules.length,
			built: rightModules.length,
			identical: missingModules.length === 0 && extraModules.length === 0
		},
		structuralRowCounts: counts,
		// a null count is a collation-blocked table, not a zero
		collationBlocked: counts
			.filter((c) => c.reference === null || c.built === null)
			.map((c) => c.table),
		verdict: problems.length === 0 ? 'STRUCTURALLY EQUIVALENT' : 'DIVERGED',
		problems
	};

	return report;
}

// resolve() both sides: argv[1] arrives as typed on the command line, usually relative
if (import.meta.filename === resolve(process.argv[1] ?? '')) {
	const [, , leftPath, rightPath] = process.argv;
	if (!leftPath || !rightPath) {
		console.error('usage: node scripts/diff-site-db.ts <reference.sqlite> <built.sqlite>');
		process.exit(2);
	}
	const report = compareSiteDbs(open(leftPath), open(rightPath));
	console.log(JSON.stringify(report, null, 2));
	if (report.problems.length > 0) process.exit(1);
}
