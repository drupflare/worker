import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Patches Drupal for the wasm runtime. Idempotent.
 *
 *   node patch-drupal.mjs <drupal-root>
 *
 * These are the concrete "Drupal needs changes to run here" items.
 *
 * Fibers are the big one. Drupal 11 uses `new \Fiber()` in five places to
 * interleave placeholder rendering and contain account switching. PHP builds
 * Fibers on ucontext when configured with --disable-fiber-asm (which php-wasm
 * sets), and emscripten provides no ucontext, so the first Fiber aborts the
 * whole runtime with:
 *
 *   Aborted(missing function: getcontext)
 *
 * Rather than rewrite five call sites by hand, swap the class for a
 * synchronous stand-in with the same surface. Every call site follows the same
 * shape -- construct, start, resume while not terminated, getReturn -- so a
 * stand-in that runs eagerly on start() and reports itself terminated satisfies
 * all of them. Output is identical; only the interleaving is lost, which buys
 * nothing in a single-threaded isolate with no async I/O.
 *
 * PhpWasmSyncFiber is defined by the runtime before Drupal loads (see
 * src/drupal-boot.js), so nothing needs to be autoloadable.
 *
 * The second patch pins the `twig` PHP-code bin to plain `FileStorage`, which is what makes a
 * precompiled Twig cache reachable at all. The default `MTimeProtectedFileStorage` builds the
 * filename from `hmacBase64($key, $hash_salt . filemtime($containing_directory))`
 * (core/lib/Drupal/Component/PhpStorage/MTimeProtectedFastFileStorage.php:135), and a MEMFS
 * directory's mtime is whenever the mount created it -- so no build step can predict the name and
 * every shipped file is invisible. Nothing looks wrong; Drupal just recompiles.
 *
 * The protection this drops guards against an attacker replacing a file on disk. The tree here is
 * a per-isolate MEMFS inflated from an immutable pack with no upload path into it, so there is
 * nothing for it to protect. Drupal documents this exact configuration -- see the note about
 * read-only PHPStorage and generating templates in a build step on
 * `Drupal\Core\Template\TwigEnvironment::renderInline()`.
 */

const root = process.argv[2];
if (!root) {
	console.error('usage: patch-drupal.mjs <drupal-root>');
	process.exit(1);
}

const applied = [];
const skipped = [];

const FIBER_SITES = [
	'core/lib/Drupal/Core/Render/Renderer.php',
	'core/lib/Drupal/Core/Session/AccessPolicyProcessor.php',
	'core/lib/Drupal/Core/Field/Plugin/Field/FieldType/EntityReferenceItemBase.php',
	'core/modules/language/src/ConfigurableLanguageManager.php',
	'core/modules/big_pipe/src/Render/BigPipe.php'
];

for (const rel of FIBER_SITES) {
	const path = join(root, rel);
	let src;
	try {
		src = await readFile(path, 'utf8');
	} catch {
		skipped.push(`${rel} (not present)`);
		continue;
	}

	const before = src;

	// constructor -> sync stand-in
	src = src.replaceAll('new \\Fiber(', 'new \\PhpWasmSyncFiber(');
	// getCurrent() must report "not inside a fiber" so suspend branches are skipped
	src = src.replaceAll('\\Fiber::getCurrent()', '\\PhpWasmSyncFiber::getCurrent()');
	src = src.replaceAll('\\Fiber::suspend(', '\\PhpWasmSyncFiber::suspend(');

	if (src === before) {
		skipped.push(`${rel} (no Fiber usage -- already patched?)`);
		continue;
	}
	await writeFile(path, src);
	applied.push(rel);
}

// #region twig php storage
const SETTINGS = 'sites/default/settings.php';
const TWIG_STORAGE_MARKER = "$settings['php_storage']['twig']";
const TWIG_STORAGE_PATCH = `
// --- appended by scripts/patch-drupal.mjs: reachable precompiled Twig ---
// MTimeProtectedFileStorage names each file after the containing directory's mtime, which in a
// MEMFS mounted from a pack is mount time -- so scripts/bake-twig.php could never predict it and
// every shipped template would be recompiled. FileStorage's path is <dir>/<key> and depends on
// nothing the mount invents. Nothing can overwrite files in this tree, so there is no attacker for
// the mtime check to stop.
$settings['php_storage']['twig']['class'] = 'Drupal\\\\Component\\\\PhpStorage\\\\FileStorage';
`;

{
	const path = join(root, SETTINGS);
	try {
		const src = await readFile(path, 'utf8');
		if (src.includes(TWIG_STORAGE_MARKER)) {
			skipped.push(`${SETTINGS} (twig php_storage already set)`);
		} else {
			// the packed settings.php ships read-only
			await chmod(path, 0o644);
			await writeFile(path, src + TWIG_STORAGE_PATCH);
			applied.push(`${SETTINGS} (twig php_storage -> FileStorage)`);
		}
	} catch {
		skipped.push(`${SETTINGS} (not present)`);
	}
}
// #endregion

// #region the driver library's autoload root
const PSR4_MARKER = 'Drupflare\\\\StreamHttp\\\\';
const PSR4_PATCH = `
// --- appended by scripts/patch-drupal.mjs: the driver library's autoload root ---
// The shipped database has \`drupflare\` in core.extension, and its HttpsStreamWrapper extends the
// packaged Drupflare\\StreamHttp\\HttpsStreamWrapper. Drupal registers a namespace per MODULE and a
// libraries/ directory is not one, so every native kernel booted against this tree fatals on that
// parent class the moment ModuleHandler::loadAll() includes the .module -- bake-twig.php,
// bake-collectors.php and lift-container.ts all did. settings.php is the one place every bootstrap
// reads, which is the same reason the edge registers this root in its own settings override.
// PHP_SAPI === 'cli' GATES THIS TO NATIVE BUILDS, and the gate is the point. This file is PACKED
// and the Durable Object reads it, where the same root is already registered by SETTINGS_OVERRIDE --
// so an unguarded block makes every edge request pay for a workaround only the bake scripts need.
// Every native consumer here is a CLI script; the runtime is not.
if (PHP_SAPI === 'cli') {
	$library = __DIR__ . '/../../libraries/drupflare-stream-http/src/';
	if (is_dir($library)) {
		$loader = require DRUPAL_ROOT . '/autoload.php';
		if (is_object($loader)) {
			$loader->addPsr4('Drupflare\\\\StreamHttp\\\\', $library);
		}
	}
}
`;

{
	const path = join(root, SETTINGS);
	try {
		const src = await readFile(path, 'utf8');
		if (src.includes(PSR4_MARKER)) {
			skipped.push(`${SETTINGS} (stream-http psr4 already registered)`);
		} else {
			await chmod(path, 0o644);
			await writeFile(path, src + PSR4_PATCH);
			applied.push(`${SETTINGS} (stream-http psr4 root)`);
		}
	} catch {
		skipped.push(`${SETTINGS} (not present, psr4)`);
	}
}
// #endregion

console.log(JSON.stringify({ applied, skipped }, null, 2));
