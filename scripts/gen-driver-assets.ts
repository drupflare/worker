import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

/**
 * Packs the cfw_do_sqlite and drupflare modules into assets/driver.json so the Durable Object
 * can write them into MEMFS. Both are read from their SIBLING repositories, which are the source
 * of truth; this repo keeps no copy.
 *
 *   node scripts/gen-driver-assets.ts
 *
 * The driver is NOT in assets/drupal/core.bin.gz. That pack is
 * generated from the installed site, which uses core's sqlite driver, and
 * regenerating 8 MB of gzip to change one PHP class is the wrong loop. This
 * emits a ~60 KB JSON map instead, keyed by the path the file takes inside the
 * mounted tree.
 */

const repo = new URL('..', import.meta.url).pathname;
const dest = join(repo, 'assets/driver.json');

/**
 * Where `drupflare/stream-http` is checked out, relative to this repo or absolute.
 *
 * A sibling checkout is the default because that is the developer layout. CI cannot check a second
 * repository out beside the workspace -- `actions/checkout` writes inside it -- so the workflow
 * clones to `.siblings/stream-http` and points this at it.
 */
const STREAM_HTTP_SRC = process.env.STREAM_HTTP_SRC ?? '../stream-http/src';

/**
 * Where the two Drupal modules are checked out.
 *
 * THE SIBLING IS THE SOURCE OF TRUTH, and these used to be copies under `drupal/`. That directory
 * was untracked, was what the packer read, and had already drifted: `CircuitBreaker.php` lost a
 * docblock the shipping copy still carried, and the test copies sat 8 assertions behind
 * (`bun run test:health` gave 169 against the sibling's 177) with nothing reporting it --
 * `driver-pack.spec.ts` guards the pack against `drupal/`, never `drupal/` against the siblings.
 *
 * The stream-http entry below already said why: "a fourth copy is what created the drift". The two
 * modules that matter simply had not been moved onto that pattern.
 */
const DRUPFLARE_SRC = process.env.DRUPFLARE_SRC ?? '../drupflare';
const ROM_SRC = process.env.ROM_SRC ?? '../rom';

/**
 * What a module contributes to the mounted tree.
 *
 * An allow-list, because a module REPO carries far more than a module: `tests/`, `node_modules/`,
 * `vendor/`, `composer.json`, phpdoc scripts and a `coverage/` directory. Copying a checkout
 * wholesale would ship all of it into a 3 MiB bundle. `drupal/` happened to hold only the module
 * files, which is exactly what made it look like a safe input.
 */
/**
 * The files a module REPO contributes to the mounted tree.
 *
 * An allow-list rather than a walk, because these are whole repository checkouts: walking one
 * wholesale reaches `node_modules/`, `vendor/` and `coverage/`, every one of which contains `.php`.
 *
 * `.routing.yml` and `.permissions.yml` joined the list when `drupflare` grew an admin route. A
 * route defined in a file the packer does not carry is a 404 on every deployed site while every
 * local test passes, which is the same class of failure as a shim inside a dead guard.
 */
const MODULE_PARTS = [
	'src',
	'.info.yml',
	'.install',
	'.module',
	'.services.yml',
	'.routing.yml',
	'.permissions.yml',
	'.links.menu.yml'
] as const;

/**
 * Every host-side module, and where it lands in the mounted tree.
 *
 * drupflare rides in the same asset as the driver: it mounts
 * through the same mechanism, so adding it here costs no new asset, no new
 * subrequest at boot and no deploy change. The settings.php override in
 * src/site-do.js points a PSR-4 root at each of these paths.
 */
const MODULES: { src: string; mount: string; parts?: readonly string[] }[] = [
	// `parts` because these two are now whole REPOSITORY checkouts rather than the module-shaped
	// copies that used to sit under drupal/. Without it the walk would reach node_modules/, vendor/
	// and coverage/, every one of which contains .php
	{ src: ROM_SRC, mount: 'modules/custom/cfw_do_sqlite', parts: MODULE_PARTS },
	{ src: DRUPFLARE_SRC, mount: 'modules/custom/drupflare', parts: MODULE_PARTS },
	// drupflare/stream-http, read from the SIBLING REPO rather than copied under drupal/.
	//
	// Composer never runs on the edge, so a `require` in drupflare's composer.json ships nothing
	// -- the packed tree IS the vendor directory. Mounting the package here is what turns that
	// dependency from a manifest line into code that loads.
	//
	// Read from ../stream-http. Vendoring a copy under drupal/ would recreate exactly
	// the duplication this replaced: the module's own HttpsStreamWrapper WAS a second copy of
	// this file and drifted from it, so a sibling checkout is the input here.
	{ src: STREAM_HTTP_SRC, mount: 'libraries/drupflare-stream-http/src' }
];

/** the PSR-4 roots the packed tree needs, since composer's autoloader is not there to build them */
export const PACKED_PSR4 = [
	{ prefix: 'Drupal\\cfw_do_sqlite\\', path: 'modules/custom/cfw_do_sqlite/src/' },
	{ prefix: 'Drupal\\drupflare\\', path: 'modules/custom/drupflare/src/' },
	{ prefix: 'Drupflare\\StreamHttp\\', path: 'libraries/drupflare-stream-http/src/' }
] as const;

async function walk(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		// `.module` and `.install` are PHP too, and they are the ONLY place a stream wrapper can be
		// registered early enough -- ModuleHandler::loadAll() includes them from preHandle(), three
		// lines before the kernel registers its own wrappers. Packing only .php/.yml meant the
		// module-owned registration path shipped nowhere.
		else if (/\.(php|yml|module|install)$/.test(entry.name)) out.push(full);
	}
	return out;
}

/**
 * Builds the packed map from the modules on disk, without writing it.
 *
 * Exported so `tests/node/driver-pack.spec.ts` can detect a STALE `assets/driver.json` by
 * rebuilding and comparing. That copy is the one the edge executes, and it had gone silently stale
 * twice: once after a formatting pass, and again when
 * drupflare grew its Health and Ops layers. Sharing this function is what makes the check
 * and the generator unable to disagree.
 *
 * @internal
 */
export async function buildDriverAssets(): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const { src, mount, parts } of MODULES) {
		// resolve, not join: the sibling paths may be absolute
		const from = resolve(repo, src);
		// a suffix like `.info.yml` names `<machine name>.info.yml`, and the machine name comes from
		// the MOUNT rather than the repo directory: `../rom` provides `cfw_do_sqlite`, so deriving it
		// from the checkout would look for `rom.info.yml` and silently pack a module with no info file
		const machineName = basename(mount);
		const roots = parts
			? parts.map((part) =>
					part.startsWith('.') ? join(from, `${machineName}${part}`) : join(from, part)
				)
			: [from];
		const found: string[] = [];
		for (const root of roots) {
			if (!existsSync(root)) continue;
			found.push(...(statSync(root).isDirectory() ? await walk(root) : [root]));
		}
		if (found.length === 0) {
			throw new Error(
				`no module files under ${from}. The siblings are the source of truth for these ` +
					`modules; check out drupflare/drupflare and drupflare/rom beside this repo, or ` +
					`set DRUPFLARE_SRC / ROM_SRC.`
			);
		}
		for (const path of found.sort()) {
			const rel = relative(from, path);
			// the test fixtures and runner are host-side only; the FakeHost would shadow
			// nothing but it has no business in a deployed tree
			if (rel.startsWith('tests/')) continue;
			// stubs/ declares extension functions for static analysis. Packing it would redeclare
			// vrzno_env() against the real extension and fatal during boot, before serving a byte
			if (rel.startsWith('stubs/')) continue;
			files[`${mount}/${rel}`] = await readFile(path, 'utf8');
		}
	}
	return files;
}

/** the exact bytes that belong in assets/driver.json for the current tree */
export function serialiseDriverAssets(files: Record<string, string>): string {
	return JSON.stringify(files);
}

export const DRIVER_ASSET_PATH = dest;

// only write when run as a script, so importing this for the staleness check has no side effect
if (import.meta.main) {
	const files = await buildDriverAssets();
	const body = serialiseDriverAssets(files);
	await mkdir(join(repo, 'assets'), { recursive: true });
	await writeFile(dest, body);
	const bytes = Object.values(files).reduce((n, s) => n + s.length, 0);
	console.log(
		JSON.stringify({ files: Object.keys(files).length, sourceBytes: bytes, dest }, null, 2)
	);
}
