import { FIBER_SHIM_PHP } from '../site/generated/assets';
import { phpWhen } from '../util/php';

/**
 * The synchronous stand-in for `\Fiber` that the patched tree expects. A real Fiber aborts the
 * runtime ("missing function: getcontext": emscripten has no ucontext), so
 * `scripts/patch-drupal.mjs` rewrites core's five call sites to this class, which must exist before
 * Drupal loads. One definition for every fragment: the `class_exists` guard lets whichever runs
 * first declare it.
 */
export const FIBER_SHIM = `\n${phpWhen("!class_exists('PhpWasmSyncFiber', false)", FIBER_SHIM_PHP)}\n`;
