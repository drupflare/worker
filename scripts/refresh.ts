import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { drifted, driverDrift, installedDriverPackages } from './driver-drift';
import { installedVersion } from './fetch-drupal-tree';
import { buildDriverAssets } from './gen-driver-assets';

/**
 * Takes the whole tree from a Drupal release to a rebuilt pack, in ONE command.
 *
 * ```sh
 * bun run refresh                  # everything
 * bun run refresh -- --dry-run     # the plan, running nothing
 * bun run refresh -- --no-composer # re-run after a failure without moving the lock again
 * ```
 *
 * WHY THIS EXISTS. The chain was seven manual commands with two traps in it: `fetch:drupal --force`
 * deletes `drupal-src` and takes the mounted driver tree with it, and the tree it leaves is
 * unpatched. A sequence that long, run by hand once a quarter, is a sequence that gets a step wrong,
 * and the failure mode is a pack that builds and ships the wrong thing.
 *
 * ## THE VERSION IS READ FROM THE LOCK ON DISK, NEVER FROM THE BAKED CONSTANT
 *
 * `SHIPPED_CORE_VERSION` is a module-scope import, so a process that has just run `composer update`
 * and `gen:lock` still holds the value from before it started. The first version of this planned
 * from that constant: the lock said 11.4.6, the plan said "already at 11.4.5", the tree fetch was
 * skipped, and it built a database from the OLD core while reporting the new version. Nothing
 * failed. {@link lockedCore} re-reads `composer.lock` after every step that can move it, and the
 * fetch is handed `DRUPAL_VERSION` explicitly so the two cannot disagree.
 *
 * ## The diff REPORTS; an acceptance rule decides
 *
 * `diff-site-db.ts` exits 1 on any structural difference, and the expected differences here are
 * exactly the ones a rebuild exists to fix: the shipped file predates the driver's routes and menu
 * links, so a correct rebuild has four more routes and three more menu items. Treating that exit
 * code as fatal aborted the run on success. What has to hold is the MODULE SET and the CONFIG
 * NAMES, which are what a wrong profile, a missing recipe or a failed module install would move.
 *
 * ## It replaces the tracked artifacts, and snapshots first
 *
 * There is no second command to remember. `assets/drupal/site.sqlite` is tracked and carries a
 * `cdn-manifest.json` entry, so replacing it without regenerating the manifest turns the next
 * `bun install` into a silent restore of the old file -- the manifest rewrite is a step here. The
 * previous copy is kept at `.refresh/site.sqlite.replaced`.
 *
 * The repack is `bun run build:local` rather than a second copy of its steps. That script owns the
 * ordering, the caching and the tool preflight; duplicating it is how the two come to disagree.
 */

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SHIPPED_DB = 'assets/drupal/site.sqlite';
const BUILT_DB = '.refresh/site.sqlite';

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(`--${flag}`);
const DRY = has('dry-run');
const STRICT_DRIVER = has('strict-driver');
const NO_COMPOSER = has('no-composer');

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
	console.error(`  $ ${cmd} ${args.join(' ')}`);
	execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
}

/** runs a command that may exit non-zero, handing back its stdout either way */
function capture(cmd: string, args: string[]): { ok: boolean; stdout: string } {
	console.error(`  $ ${cmd} ${args.join(' ')}`);
	try {
		return { ok: true, stdout: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }) };
	} catch (e: any) {
		return { ok: false, stdout: String(e?.stdout ?? '') };
	}
}

/**
 * The core version `composer.lock` names, RE-READ from disk on every call.
 *
 * Not `SHIPPED_CORE_VERSION`, which this process imported before `composer update` ran.
 */
function lockedCore(): string | null {
	try {
		const lock = JSON.parse(readFileSync(join(ROOT, 'composer.lock'), 'utf8')) as {
			packages?: { name: string; version: string }[];
		};
		return lock.packages?.find((p) => p.name === 'drupal/core')?.version ?? null;
	} catch {
		return null;
	}
}

/** what the generated map says, read from the file rather than the import, for the same reason */
function bakedCore(): string | null {
	try {
		const src = readFileSync(join(ROOT, 'src/ops/shipped-lock.ts'), 'utf8');
		return /SHIPPED_CORE_VERSION = ['"]([^'"]+)['"]/.exec(src)?.[1] ?? null;
	} catch {
		return null;
	}
}

function report(label: string): void {
	console.error(`[refresh] ${label}:`);
	console.error(`  lock core        ${lockedCore() ?? '(none)'}`);
	console.error(`  baked core       ${bakedCore() ?? '(none)'}`);
	console.error(`  drupal-src       ${installedVersion() ?? '(absent)'}`);
}

report('before');
for (const p of installedDriverPackages(ROOT)) {
	console.error(`  ${p.name.padEnd(24)} locked ${p.version}`);
}

if (DRY) {
	console.error('\n[refresh] --dry-run. A real run would:');
	console.error(`  1 composer update${NO_COMPOSER ? ' (skipped)' : ''}, then gen:lock`);
	console.error('  2 report driver drift against the packages composer installed');
	console.error(`  3 fetch drupal-src unless it is already at the lock's core`);
	console.error('  4 mount the driver siblings into the tree');
	console.error('  5 patch the tree for the wasm runtime');
	console.error(`  6 build the database into ${BUILT_DB}`);
	console.error('  7 diff it, refusing if the module set or the config names disagree');
	console.error(`  8 snapshot and replace ${SHIPPED_DB}`);
	console.error('  9 rebuild every downstream artifact, then rewrite cdn-manifest.json');
	console.error('\nstep 3 re-reads the lock AFTER step 1, so it sees the updated version');
	process.exit(0);
}

// #region 1, the version chain
if (!NO_COMPOSER) {
	console.error('\n[refresh] composer update, then rebake the map it feeds');
	run('composer', ['update', '--no-interaction', '--no-audit']);
	run('bun', ['run', 'gen:lock']);
}
// #endregion

// #region 2, driver drift, which reports and does not refuse
const drift = drifted(driverDrift(await buildDriverAssets(), ROOT));
if (drift.length > 0) {
	console.error(
		`\n[refresh] NOTE: ${drift.length} driver packages differ from the versions the lock names.`
	);
	for (const d of drift) console.error(`  ${d.pkg}: ${d.why}`);
	console.error(
		'Compared byte for byte against what composer installed. Ordinary while a sibling'
	);
	console.error('is being worked on; `--strict-driver` refuses, which is what a release wants.');
	if (STRICT_DRIVER) {
		console.error('\n[refresh] REFUSING: --strict-driver');
		process.exit(1);
	}
}
// #endregion

// #region 3-5, the tree
const want = lockedCore();
if (want === null) {
	console.error('\n[refresh] composer.lock names no drupal/core; nothing to build against');
	process.exit(1);
}
if (installedVersion() !== want) {
	console.error(`\n[refresh] tree: materialise drupal-src at ${want}`);
	// DRUPAL_VERSION explicitly, because `fetch:drupal` otherwise resolves the BAKED constant and a
	// subprocess started before `gen:lock` would read the previous one
	run('bun', ['run', 'fetch:drupal', '--', '--force'], { DRUPAL_VERSION: want });
	const got = installedVersion();
	if (got !== want) {
		console.error(`[refresh] the tree reports ${got}, not ${want}`);
		process.exit(1);
	}
} else {
	console.error(`\n[refresh] tree: already at ${want}`);
}

// `fetch:drupal --force` deletes drupal-src whole, and the driver mount goes with it
console.error('\n[refresh] mount: the driver siblings, which --force deletes');
run('bun', ['run', 'assets:driver', '--', '--to=drupal-src']);

// #endregion

// #region 6-7, the database and the acceptance rule
console.error(`\n[refresh] site-db: build into ${BUILT_DB}`);
mkdirSync(join(ROOT, '.refresh'), { recursive: true });
run('php', [
	'-d',
	'opcache.enable_cli=0',
	'-d',
	'xdebug.mode=off',
	'scripts/drupal/install-site-db.php',
	'drupal-src',
	BUILT_DB
]);

/**
 * The installer's settings.php, copied into `sites/default` where the bake boots from.
 *
 * ORDER, AND IT WAS WRONG. The installer writes `sites/build/settings.php`; a release tarball ships
 * `default.settings.php` and no `settings.php` at all, so without this copy `sites/default` cannot
 * boot and `twig` refused with "needs drupal-src/sites/default/settings.php". `build-local`'s own
 * `site` step does exactly this, which is why the failure only appeared once refresh built the
 * database itself. The patch has to follow the copy, because it pins `php_storage` INTO this file.
 */
const built = join(ROOT, 'drupal-src/sites/build/settings.php');
if (!existsSync(built)) {
	console.error(`[refresh] the installer wrote no ${built}; the bake would have no kernel`);
	process.exit(1);
}
copyFileSync(built, join(ROOT, 'drupal-src/sites/default/settings.php'));
console.error('  copied sites/build/settings.php -> sites/default/settings.php');

console.error('\n[refresh] patch: the tree for the wasm runtime');
run('node', ['scripts/patch-drupal.mjs', 'drupal-src']);

console.error('\n[refresh] diff: what the rebuild changes');
const diff = capture('node', ['scripts/diff-site-db.ts', SHIPPED_DB, BUILT_DB]);
console.error(diff.stdout);

const parsed = (() => {
	try {
		return JSON.parse(diff.stdout) as {
			modules?: { identical?: boolean; reference?: number; built?: number };
			config?: { identicalNames?: boolean; reference?: number; built?: number };
		};
	} catch {
		return null;
	}
})();
if (parsed === null) {
	console.error('[refresh] the diff produced no readable report; refusing to install');
	process.exit(1);
}
if (parsed.modules?.identical !== true) {
	console.error(
		`[refresh] REFUSING: the module set differs (${parsed.modules?.reference} shipped, ` +
			`${parsed.modules?.built} built). A rebuild has to describe the same site.`
	);
	process.exit(1);
}
if (parsed.config?.identicalNames !== true) {
	console.error(
		`[refresh] REFUSING: the config objects differ (${parsed.config?.reference} shipped, ` +
			`${parsed.config?.built} built).`
	);
	process.exit(1);
}
console.error('[refresh] accepted: same module set, same config objects');
// #endregion

// #region 8-9, install and repack
const backup = join(ROOT, '.refresh/site.sqlite.replaced');
// NEVER OVERWRITE AN EXISTING SNAPSHOT. A second run copies the file this script already replaced,
// which destroys the only rollback to the version that shipped before any of it ran
if (!existsSync(backup)) copyFileSync(join(ROOT, SHIPPED_DB), backup);
else console.error(`[refresh] keeping the existing rollback copy at ${backup}`);
const before = statSync(join(ROOT, SHIPPED_DB)).size;
copyFileSync(join(ROOT, BUILT_DB), join(ROOT, SHIPPED_DB));
const after = statSync(join(ROOT, SHIPPED_DB)).size;
console.error(
	`\n[refresh] install: ${SHIPPED_DB} ${before} -> ${after} bytes ` +
		'(previous copy at .refresh/site.sqlite.replaced)'
);

console.error('\n[refresh] repack: every artifact downstream of the database');
// `--only` with the steps DOWNSTREAM of the database, rather than `--skip` with a guess. The first
// version skipped a step id that does not exist (`decoder`) and `assertKnownSteps` refused the whole
// build -- correctly, since a typo in a skip list is otherwise a silent no-op
//
// `container` MUST be here: a repack moves `VERSIONS_HASH`, and without the rekey the packed
// `cache_container` row is one no site can read
run('bun', [
	'run',
	'build:local',
	'--',
	'--force',
	'--only=driver,twig,core,pack,static,agg,container,sql'
]);

console.error('\n[refresh] manifest: so the next install does not restore the old database');
run('bun', ['run', 'backup:manifest']);
// #endregion

report('after');
if (!existsSync(backup)) console.error('WARNING: no rollback copy was written');
console.error('\nrun `bun run test` before committing; a pack rebuild moves the container cid');
