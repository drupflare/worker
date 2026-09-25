import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cmsSelection } from '../../scripts/cms.ts';
import {
	DRIVER_ASSET_PATH,
	buildCms,
	buildDriverAssets,
	driverDigest,
	serialiseDriverAssets,
	serialiseDriverDigest
} from '../../scripts/gen-driver-assets.ts';
import {
	DRIVER_DIGEST,
	DRIVER_ROUTES,
	DRIVER_ROUTE_PERMISSIONS
} from '../../src/ops/driver-digest.ts';

/**
 * `assets/driver.json` is the copy of the Drupal modules that ACTUALLY EXECUTES on the edge, and
 * it is generated rather than copied, so this is the ONLY thing that ties it to its inputs.
 *
 * It has gone silently stale twice: once after a PHP formatting pass, and again when
 * `drupflare` gained its Health and Ops layers, where it sat 38,004 bytes short of the tree it
 * claimed to pack. A stale pack means the deployed PHP is not the PHP in the repo, and the sibling
 * repos' own suites are then testing code that does not ship.
 *
 * There used to be a second check comparing three copies of each module file by mtime. It was
 * deleted, correctly: after a formatting pass in this repo it declared the stale local copy newer
 * than the sibling holding the real fix. The packer now reads `../drupflare` and `../rom` directly,
 * so there is no third copy to drift and nothing left for such a check to compare.
 *
 * These run in the `node` project because they touch the real filesystem and import a build
 * script; `node:fs` is not available in workerd.
 *
 * `assets/` is gitignored and no workflow builds it. The staleness check therefore uses
 * `artifactGate`, which **skips locally and FAILS in CI** -- the same asymmetry `tests/e2e/` uses. An
 * unconditional skip was tried first and was wrong: it left this project's biggest wins decorative in
 * CI, which is the exact failure the `check:sync` rule warns about.
 *
 * The content assertions below need no pack: they read `drupal/` off disk through the generator, so
 * they run everywhere.
 */

import { artifactGate } from './helpers/artifact-gate';

/** repo root, so the wiring guard below reads the real sources rather than a copy */
const ROOT = new URL('../../', import.meta.url).pathname;

/** skip locally when unbuilt, FAIL in CI; a skipped acceptance test is indistinguishable from a pass */
const skipPack = artifactGate(['assets/driver.json']);

describe.skipIf(skipPack)('the packed driver asset is current', () => {
	it('matches the modules on disk byte for byte', async () => {
		// the regression test: the assertion that was missing both times it went stale
		const expected = serialiseDriverAssets(await buildDriverAssets());
		const actual = await readFile(DRIVER_ASSET_PATH, 'utf8');
		expect(
			actual === expected,
			'assets/driver.json is stale against the sibling checkouts. Run: bun run assets:driver'
		).toBe(true);
	});

	/**
	 * The digest is what the reconciliation step compares a site against, so a stale one means an
	 * existing site never rebuilds its container and a hook class added to a sibling stays invisible
	 * on it forever. That failure is silent: `hasImplementations()` answers false and the class loads
	 * fine, which is exactly how `DeferredCron` came to have never run anywhere.
	 */
	it('carries a digest matching the pack it identifies', async () => {
		const body = await readFile(DRIVER_ASSET_PATH, 'utf8');
		expect(
			DRIVER_DIGEST,
			'src/ops/driver-digest.ts is stale against assets/driver.json. Run: bun run assets:driver'
		).toBe(driverDigest(body));
	});

	it('writes the digest module in exactly the form the generator emits', () => {
		const emitted = serialiseDriverDigest(DRIVER_DIGEST);
		expect(emitted).toContain(`export const DRIVER_DIGEST = '${DRIVER_DIGEST}';`);
		expect(DRIVER_DIGEST).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe('what the pack contains, and what it must never contain', () => {
	it('packs both modules under the path Drupal will look them up by', async () => {
		const files = await buildDriverAssets();
		const paths = Object.keys(files);
		expect(paths.some((p) => p.startsWith('modules/custom/cfw_do_sqlite/'))).toBe(true);
		expect(paths.some((p) => p.startsWith('modules/custom/drupflare/'))).toBe(true);
		// every key is relative and mounted; an absolute path would escape the mount root
		for (const p of paths) expect(p.startsWith('/')).toBe(false);
	});

	it('excludes the host-side test harness', async () => {
		// the FakeHost double and the suite runner have no business in a deployed tree
		const paths = Object.keys(await buildDriverAssets());
		expect(paths.filter((p) => p.includes('/tests/'))).toEqual([]);
	});

	it('packs only PHP, YAML, the two PHP files Drupal names differently, and help topics', async () => {
		// `.module` and `.install` ARE PHP; Drupal just gives them other extensions. This assertion
		// used to read `/\.(php|yml)$/`, which silently excluded them from the pack -- and they are
		// the ONLY place a stream wrapper can be registered early enough, because
		// ModuleHandler::loadAll() includes them from preHandle() three lines before the kernel
		// registers its own wrappers. So the module-owned registration path shipped nowhere while
		// this test stayed green.
		const paths = Object.keys(await buildDriverAssets());
		expect(paths.length).toBeGreaterThan(0);
		// `.twig` is `help_topics/`, whose topics are Twig with YAML front matter
		for (const p of paths) expect(/\.(php|yml|module|install|twig)$/.test(p), p).toBe(true);
	});

	it('carries the help topic, so /admin/help is not empty on a deployed site', async () => {
		const paths = Object.keys(await buildDriverAssets());
		expect(paths).toContain(
			'modules/custom/drupflare/help_topics/drupflare.running_on_workers.html.twig'
		);
	});

	it('actually carries the module and install files, not just permits them', async () => {
		// the permissive assertion above passes on a pack containing neither, so name them
		const paths = Object.keys(await buildDriverAssets());
		expect(paths).toContain('modules/custom/drupflare/drupflare.module');
		expect(paths).toContain('modules/custom/drupflare/drupflare.install');
	});

	it('carries the Health and Ops layers that the stale pack was missing', async () => {
		// naming the specific files makes the second staleness incident unrepeatable
		const paths = Object.keys(await buildDriverAssets());
		expect(paths).toContain('modules/custom/drupflare/src/Health/HealthLedger.php');
		expect(paths).toContain('modules/custom/drupflare/src/Health/RepairLadder.php');
		expect(paths).toContain('modules/custom/drupflare/src/Ops/OpsRegistry.php');
	});

	it('is deterministic, so a regenerate with no source change is a no-op diff', async () => {
		// determinism comes from sorted readdir per module plus the fixed MODULES order; without it
		// check:sync reports drift that is not real
		const a = serialiseDriverAssets(await buildDriverAssets());
		const b = serialiseDriverAssets(await buildDriverAssets());
		expect(a).toBe(b);
	});

	it('sorts within each module, but does not claim a globally sorted key list', async () => {
		// the invariant is MODULES order, not sortedness (the rename made them coincide by luck,
		// so a global-sort check would pass today and break on the next module)
		const paths = Object.keys(await buildDriverAssets());
		for (const prefix of ['modules/custom/cfw_do_sqlite/', 'modules/custom/drupflare/']) {
			const group = paths.filter((p) => p.startsWith(prefix));
			expect(group.length).toBeGreaterThan(0);
			expect(group).toEqual([...group].sort());
		}
		// and each module occupies one contiguous run, which is what makes the whole list stable
		const firstCap = paths.findIndex((p) => p.includes('drupflare'));
		const lastSql = paths.reduce((n, p, i) => (p.includes('cfw_do_sqlite') ? i : n), -1);
		expect(firstCap).toBeGreaterThan(lastSql);
	});

	it('serialises to something that parses back to the same map', async () => {
		const files = await buildDriverAssets();
		expect(JSON.parse(serialiseDriverAssets(files))).toEqual(files);
	});

	it('reads file contents rather than paths', async () => {
		const files = await buildDriverAssets();
		const ledger = files['modules/custom/drupflare/src/Health/HealthLedger.php'];
		expect(ledger).toBeDefined();
		expect(ledger).toContain('<?php');
		expect(ledger).toContain('class HealthLedger');
	});
});

/**
 * The userland PDO is the one packed file no autoloader can reach.
 *
 * PDO, PDOException and PDOStatement are GLOBAL classes, so neither PSR-4 root registered for
 * this module can ever resolve them: an explicit `require_once` is the only mechanism, and it
 * has to run before the first statement object is constructed. That makes the wiring the whole
 * risk -- the file can ship, parse and pass its own suite in `../rom` while nothing on the edge
 * ever loads it, which is the failure this repo has already paid for twice with a stale pack and
 * once with a composer `require` that shipped nothing.
 *
 * `../rom/tests/pdo-shim.php` owns whether the shim is CORRECT. These own whether it ARRIVES.
 */
describe('the userland PDO reaches the mounted tree and is required from it', () => {
	/** the one path the two load sites and the pack all have to agree on */
	const MOUNTED = 'modules/custom/cfw_do_sqlite/src/pdo-shim.php';

	it('is packed, and carries all three classes ext-pdo would declare', async () => {
		const shim = (await buildDriverAssets())[MOUNTED];
		expect(shim).toBeDefined();
		expect(shim).toContain('class PDO');
		expect(shim).toContain('class PDOException extends RuntimeException');
		expect(shim).toContain('class PDOStatement implements Traversable, IteratorAggregate');
		// the guard is what keeps it inert on a build that has the real extension
		expect(shim).toContain("class_exists('PDO', false)");
	});

	it('is required from settings.php, which is the earliest point in a served request', async () => {
		// Settings::initialize() runs long before any connection is opened; a later hook would be
		// after the first `new Statement` and the fatal it is there to prevent
		const source = await readFile(`${ROOT}src/site-do.ts`, 'utf8');
		expect(source).toContain(`require_once $app_root . '/${MOUNTED}'`);
	});

	it('is required by the live driver suite, which bypasses settings.php entirely', async () => {
		// DRIVER_LIVE_SUITE constructs the Connection directly, so it inherits nothing from the
		// served path and needs its own require
		const source = await readFile(`${ROOT}src/drupal/site-php.ts`, 'utf8');
		expect(source).toContain(`require_once '/drupal/${MOUNTED}'`);
	});
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the packer carries every declaration file a sibling module has', () => {
	/**
	 * A hand-kept allow-list drifts from the modules it is meant to describe, silently.
	 *
	 * `.links.menu.yml` was on the list and `.links.task.yml` was not, so the Settings and Code
	 * Delivery ROUTES packed and resolved while the TABS leading to them were absent from every
	 * deployed site. Nothing failed: the module loaded, the paths answered, and the modules page
	 * rendered the two tabs it always had. The allow-list's own docblock predicted this class and
	 * the list still missed a member of it.
	 *
	 * So the guard is the general one rather than a line per suffix: every `*.yml` a sibling module
	 * declares at its root must reach the pack. A file the packer should genuinely skip has to be
	 * named here, which makes the omission a decision somebody wrote down.
	 */
	const SKIPPABLE = new Set(['drupflare.libraries.yml']);

	it('packs every root-level yml declaration the drupflare module ships', () => {
		const src = process.env.DRUPFLARE_SRC ?? join(root, '..', 'drupflare');
		if (!existsSync(src)) return;
		// `<machine name>.*.yml` at the root is what Drupal reads as a module declaration; a
		// `codecov.yml` beside it is repository config and has no business on a deployed site
		const declared = readdirSync(src).filter(
			(f) => f.startsWith('drupflare.') && f.endsWith('.yml') && !SKIPPABLE.has(f)
		);
		expect(declared.length).toBeGreaterThan(0);

		const packed = JSON.stringify(readFileSync(join(root, 'assets', 'driver.json'), 'utf8'));
		const missing = declared.filter((f) => !packed.includes(f));
		expect(
			missing,
			`these declarations never reach a deployed site: ${missing.join(', ')}`
		).toEqual([]);
	});
});

describe('the build packs the CMS the shipping config selects', () => {
	it('reads CMS from wrangler.jsonc, which sets it explicitly', () => {
		const vars = JSON.parse(
			readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '')
		).vars as Record<string, unknown>;
		expect(vars['CMS']).toBe('drupal');
		expect(buildCms(undefined)).toBe('drupal');
	});

	it('fails on a value it cannot pack, and on a missing one', async () => {
		expect(() => cmsSelection('wordpress')).toThrow(/not a CMS this build can pack/);
		expect(() => cmsSelection(undefined)).toThrow(/not a CMS this build can pack/);
		expect(() => cmsSelection('Drupal')).toThrow();
		await expect(buildDriverAssets('wordpress' as 'drupal')).rejects.toThrow(
			/not a CMS this build can pack/
		);
		expect(() => buildCms('wordpress')).toThrow(/wordpress/);
	});

	it('packs the same bytes whether the selection is explicit or read from the config', async () => {
		expect(serialiseDriverAssets(await buildDriverAssets('drupal'))).toBe(
			serialiseDriverAssets(await buildDriverAssets())
		);
	});
});

/**
 * The pack's router has to be the router the packed driver declares.
 *
 * Reconciliation's router step rebuilds any site whose table lacks a driver route or carries an old
 * permission, and a fresh site is provisioned from this database. So a router that lags the driver
 * made EVERY new site run a PHP router rebuild on its first cold alarm, and on deployed throwaways
 * that invocation was reset for the isolate's memory with the first visitor waiting, 8 of 8 times.
 * `bun run build:site-db` after `assets:driver -- --to=drupal-src` is the repair.
 */
describe('the packed router', () => {
	it('carries every driver route with the permission the driver declares', () => {
		const sqlite = join(
			dirname(fileURLToPath(import.meta.url)),
			'../../assets/drupal/site.sqlite'
		);
		// PDO rather than node:sqlite: a serialized Route carries NULs, which node:sqlite truncates at
		const rows = JSON.parse(
			execFileSync(
				'php',
				[
					'-r',
					`$d = new PDO("sqlite:" . $argv[1]);
					 $out = [];
					 foreach ($d->query("SELECT name, route FROM router WHERE name LIKE 'drupflare.%'") as $r) {
						 preg_match('/"_permission";s:\\d+:"([^"]*)"/', $r['route'], $m);
						 $out[$r['name']] = $m[1] ?? null;
					 }
					 echo json_encode($out);`,
					'--',
					sqlite
				],
				{ encoding: 'utf8' }
			)
		) as Record<string, string | null>;
		for (const route of DRIVER_ROUTES) expect(Object.keys(rows), route).toContain(route);
		for (const [route, permission] of Object.entries(DRIVER_ROUTE_PERMISSIONS)) {
			expect(rows[route], route).toBe(permission);
		}
	});
});
