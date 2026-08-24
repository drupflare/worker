import { inflateSync } from 'fflate';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonc } from '../../scripts/release-payload';
import { artifactGate } from './helpers/artifact-gate';

/**
 * The precompiled Twig cache, and the four ways it silently stops working.
 *
 * A compiled template is only reachable if its FILENAME is the key the runtime will ask for, and
 * that key is built from three things the build has to get right at once: the `twig_cache_prefix`
 * out of State, a class name that hashes the loader cache key together with the RUNTIME's PHP minor
 * version, and a storage class whose path does not depend on a directory mtime the mount invents.
 *
 * Every one of those was wrong before `scripts/bake-twig.php` existed, and none of them looked
 * wrong: the pack shipped 26 compiled files under the correct prefix, the runtime asked for 14
 * different keys, missed all of them, recompiled, and served a byte-identical page. The only
 * visible trace was 14 extra `twig:` rows in `cache_default`.
 *
 * The push gate cannot build `assets/`, so the suite names itself skipped there rather than throwing
 * at import. That is not a hole being hidden: the release lane hydrates the payload and runs with
 * `REQUIRE_ARTIFACTS=1`, so a stale pack fails there, before anything is published.
 */

const MANIFEST = 'assets/drupal/twig-bake.json';
const PACK_INDEX = 'assets/drupal-pf/core.pf.json';
const PACK_BLOB = 'assets/drupal-pf/core.pf.bin';
const TWIG_DIR = 'sites/default/files/php/twig/';
/**
 * The seam `wrangler.jsonc` actually aliases, DERIVED rather than named.
 *
 * This was hardcoded to `src/runtime/php-binary-o2.ts`, which is not the seam that ships. That file
 * imports php8.3, the manifest was baked for 8.3, so the guard compared 8.3 to 8.3 and passed --
 * while `wrangler.jsonc` aliased `php-binary-85.ts` and the edge ran 8.5. Twig folds
 * PHP_MAJOR_VERSION and PHP_MINOR_VERSION into every template class name, so all 23 baked templates
 * were under names the 8.5 runtime never asks for: every one missed, recompiled, and wrote a
 * `twig:` row on a cold render. Exactly the fourth failure mode this suite lists, passing.
 *
 * `interpreterFiles()` reads the alias out of the config, so the guard now cannot check a seam
 * nobody ships.
 */
function shippingSeam(): string {
	const config = readJsonc('wrangler.jsonc');
	const alias = (config.alias ?? {}) as Record<string, string>;
	const seam = Object.values(alias).find((t) => t.includes('php-binary'));
	if (!seam) throw new Error('wrangler.jsonc has no php-binary alias');
	return seam.replace(/^\.\//, '');
}
const SQL_DIR = 'assets/drupal-sql';

interface BakeManifest {
	prefix: string;
	targetPhp: string;
	builtByPhp: string;
	extensionHash: string;
	storageClass: string | null;
	templates: Record<string, { name: string; cacheKey: string; class: string }>;
}

interface PackEntry {
	p: string;
	o: number;
	c: number;
	l: number;
	s?: number;
}

/** Crypt::hashBase64() -- sha256, base64, then made filename-safe the way Drupal does it */
function hashBase64(data: string): string {
	return createHash('sha256')
		.update(data)
		.digest('base64')
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

// skip locally, fail in CI. A run that skipped this file is indistinguishable from one that passed,
// and this project's own rule -- written down about `check:sync` and then broken twice -- is that a
// step which can only skip is worse than no step. `artifactGate` throws under CI and names the
// command that builds each missing artifact.
const skipPack = artifactGate([
	'assets/drupal/twig-bake.json',
	'assets/drupal-pf/core.pf.json',
	'assets/drupal-pf/core.pf.bin'
]);
const built = !skipPack && [MANIFEST, PACK_INDEX, PACK_BLOB, SQL_DIR].every((p) => existsSync(p));

/** runs only where the pack exists, and carries the reason in the title when it does not */
const suite = (name: string, fn: () => void) =>
	built
		? describe(name, fn)
		: describe.skip(`${name} -- assets/ not built, run bun run assets`, fn);

const empty = { prefix: '', templates: {} } as unknown as BakeManifest;
const manifest: BakeManifest = built ? JSON.parse(await readFile(MANIFEST, 'utf8')) : empty;
const index: PackEntry[] = built ? JSON.parse(await readFile(PACK_INDEX, 'utf8')) : [];
const blob = built ? await readFile(PACK_BLOB) : Buffer.alloc(0);
const packed = index.filter((e) => e.p.startsWith(TWIG_DIR));

/** the inflated body of a per-file pack member, which is what PHP would include */
function body(entry: PackEntry): string {
	const member = blob.subarray(entry.o, entry.o + entry.c);
	const bytes = entry.s === 1 ? new Uint8Array(member) : inflateSync(new Uint8Array(member));
	return Buffer.from(bytes).toString('utf8');
}

suite('the pack carries the templates the bake produced', () => {
	it('has an entry for every baked template', () => {
		const keys = Object.keys(manifest.templates);
		expect(keys.length).toBeGreaterThan(0);
		const paths = new Set(packed.map((e) => e.p));
		for (const key of keys) {
			expect(
				paths.has(TWIG_DIR + key),
				`${key} is baked but not packed. Run: bun run assets:twig && bun run assets:core && bun run assets:pack`
			).toBe(true);
		}
	});

	it('packs nothing under that directory that the bake did not produce', () => {
		// a leftover from an older generation is a file the runtime will never ask for, shipped
		for (const entry of packed) {
			expect(manifest.templates[entry.p.slice(TWIG_DIR.length)]).toBeDefined();
		}
	});

	it('keeps the flat FileStorage layout rather than the MTimeProtected one', () => {
		// MTimeProtectedFileStorage puts each file in its own directory, so the giveaway that the
		// unreachable layout came back is a second path segment below php/twig/
		for (const entry of packed) {
			expect(entry.p.slice(TWIG_DIR.length)).not.toContain('/');
		}
	});
});

suite('each filename agrees with the class inside it', () => {
	it('declares the class the manifest recorded', () => {
		for (const [key, meta] of Object.entries(manifest.templates)) {
			const entry = packed.find((e) => e.p === TWIG_DIR + key);
			expect(entry, key).toBeDefined();
			expect(body(entry!)).toContain(`class ${meta.class} extends Template`);
		}
	});

	it('names the file after a hash of that class', () => {
		// this is TwigPhpStorageCache::generateKey(); if the retarget renamed the class without
		// renaming the file (or the reverse) the runtime looks up a key that does not exist
		for (const [key, meta] of Object.entries(manifest.templates)) {
			// the suffix is the LAST 25 characters, not the last `_` group: base64url uses `_`
			// itself, so a class hash can and does contain one
			const suffix = key.slice(-25);
			expect(suffix.length).toBe(25);
			expect(hashBase64(meta.class).startsWith(suffix), `${key} -> ${meta.class}`).toBe(true);
			// and the middle segment is the template's basename, truncated the same way
			const name = key.slice(manifest.prefix.length + 1, -26);
			expect(meta.name.split('/').pop()!.startsWith(name)).toBe(true);
		}
	});

	it('carries no build-machine paths', () => {
		// Twig bakes the source path into getSourceContext() for error reporting, and an
		// unrewritten one both leaks the build host and proves the root rewrite was skipped
		for (const entry of packed) {
			const src = body(entry);
			expect(src).not.toMatch(/\/(?:Users|home)\//);
			expect(src).toContain('/drupal/');
		}
	});
});

suite('the prefix is the one the runtime will compute', () => {
	/** the State row as the migration replays it, which is what the Durable Object ends up holding */
	const stateRow = async (): Promise<string> => {
		for (const name of (await readdir(SQL_DIR)).sort()) {
			const raw = await readFile(join(SQL_DIR, name), 'utf8');
			if (!raw.includes('twig_extension_hash_prefix')) continue;
			const chunk = JSON.parse(raw) as { statements: { s: string; p: unknown[] }[] };
			for (const st of chunk.statements) {
				if (st.p?.[1] === 'twig_extension_hash_prefix') return String(st.p[2]);
			}
		}
		throw new Error(`no twig_extension_hash_prefix row in ${SQL_DIR}`);
	};

	it('matches twig_cache_prefix in the migrated database', async () => {
		const row = await stateRow();
		expect(row).toContain(`s:13:"${manifest.prefix}"`);
		for (const key of Object.keys(manifest.templates)) {
			expect(key.startsWith(manifest.prefix + '_')).toBe(true);
		}
	});

	it('matches twig_extension_hash too, or the runtime discards the prefix', async () => {
		// TwigEnvironment::__construct() regenerates the prefix with uniqid() the moment the
		// container's hash disagrees with the stored one, and takes every baked file with it
		expect(await stateRow()).toContain(`"${manifest.extensionHash}"`);
	});
});

suite('the bake targeted the interpreter that ships', () => {
	it('used the PHP minor in the shipping binary', async () => {
		// Twig\Environment::updateOptionsHash() folds PHP_MAJOR_VERSION and PHP_MINOR_VERSION into
		// the template class name, so a binary bump invalidates the whole cache in one step
		const seamPath = shippingSeam();
		const alias = await readFile(seamPath, 'utf8');
		const found = alias.match(/php(\d+\.\d+)-worker(?:\.tuned)?\.mjs/);
		expect(
			found,
			`no php<major>.<minor>-worker[.tuned].mjs import in ${seamPath}`
		).not.toBeNull();
		expect(
			manifest.targetPhp,
			`the cache was baked for PHP ${manifest.targetPhp} and the binary is ${found?.[1]}. Run: bun run assets:twig`
		).toBe(found?.[1]);
	});

	it('pins the twig code bin to a storage whose path has no mtime in it', async () => {
		expect(manifest.storageClass).toBe('Drupal\\Component\\PhpStorage\\FileStorage');
		// and the tree agrees, so a refetched drupal-src that lost the patch is caught here rather
		// than by 14 silent recompiles at the edge
		// build INPUT, fetched by `bun run vendor` and legitimately absent on a clean clone
		if (!existsSync('drupal-src/sites/default/settings.php')) {
			console.log(
				'  note: drupal-src absent, the settings.php check was SKIPPED (bun run vendor)'
			);
			return;
		}
		const settings = await readFile('drupal-src/sites/default/settings.php', 'utf8');
		expect(settings).toContain("$settings['php_storage']['twig']['class']");
		expect(settings).toContain('Drupal\\\\Component\\\\PhpStorage\\\\FileStorage');
	});
});

suite('the widened bake covers what no baked PATH loads', () => {
	/**
	 * 4.3. The bake used to render `/` only, so `/user/login` (385 ms) and `/filter/tips` (174 ms) each
	 * paid their own Twig compiles on a warm interpreter. Widening the path set fixed most of it and
	 * left two templates that NO anonymous path render loads natively while the wasm runtime loads
	 * both -- measured as `twig:` rows 26 shipped against 28 after a fresh boot.
	 *
	 * They are now forced by THEME HOOK, and the hook-versus-path distinction is the whole assertion
	 * below. Forcing `core/modules/system/templates/menu-local-task.html.twig` compiled a real file at
	 * a path the runtime never looks up, because olivero overrides that hook -- the bake reported
	 * success, the pack grew, and the runtime recompiled anyway. Nothing catches that except comparing
	 * the resolved template path against the active theme.
	 */
	const localTaskHooks = ['menu-local-task.html.twig', 'menu-local-tasks.html.twig'];

	it('carries a compiled template for both local-task hooks', () => {
		for (const template of localTaskHooks) {
			const hit = Object.values(manifest.templates).find((m) => m.name.endsWith(template));
			expect(hit, `${template} is absent from the bake manifest`).toBeTruthy();
		}
	});

	it('resolved them through the ACTIVE THEME, not through core/modules/system', () => {
		for (const template of localTaskHooks) {
			const hit = Object.values(manifest.templates).find((m) => m.name.endsWith(template))!;
			// the exact failure: a system-path template compiles fine and is never loaded
			expect(hit.name, `${template} resolved to ${hit.name}`).not.toContain(
				'core/modules/system/templates/'
			);
			expect(hit.name).toContain('core/themes/');
		}
	});

	it('packs the form templates the login page needs, not just the front page set', () => {
		// the cheap half of the widening: these come from rendering /user/login during the bake
		for (const template of ['form.html.twig', 'input.html.twig', 'form-element.html.twig']) {
			const hit = Object.values(manifest.templates).find((m) => m.name.endsWith(template));
			expect(
				hit,
				`${template} is absent, so /user/login still compiles at runtime`
			).toBeTruthy();
		}
	});

	it('packs filter-tips, which only /filter/tips loads', () => {
		const hit = Object.values(manifest.templates).find((m) =>
			m.name.endsWith('filter-tips.html.twig')
		);
		expect(hit).toBeTruthy();
	});
});
