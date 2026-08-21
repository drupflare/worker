import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
	DRIVER_ASSET_PATH,
	buildDriverAssets,
	serialiseDriverAssets
} from '../../scripts/gen-driver-assets.ts';

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
			'assets/driver.json is stale against drupal/. Run: bun run assets:driver'
		).toBe(true);
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

	it('packs only PHP, YAML and the two PHP files Drupal names differently', async () => {
		// `.module` and `.install` ARE PHP; Drupal just gives them other extensions. This assertion
		// used to read `/\.(php|yml)$/`, which silently excluded them from the pack -- and they are
		// the ONLY place a stream wrapper can be registered early enough, because
		// ModuleHandler::loadAll() includes them from preHandle() three lines before the kernel
		// registers its own wrappers. So the module-owned registration path shipped nowhere while
		// this test stayed green.
		const paths = Object.keys(await buildDriverAssets());
		expect(paths.length).toBeGreaterThan(0);
		for (const p of paths) expect(/\.(php|yml|module|install)$/.test(p), p).toBe(true);
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
