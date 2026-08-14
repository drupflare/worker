import PHPFactory from '../../vendor/static-jspisjlj/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-jspisjlj/php8.3-worker.mjs.wasm';

/**
 * The slicing-capable interpreter: JSPI, `-sSUPPORT_LONGJMP=wasm`, and the
 * `zend_interrupt_function` patch that exports `zend_wasm_slice_arm/_mask/_stat`.
 *
 * 2,866,753 gzipped -- 10,102 SMALLER than the shipping build, because wasm SjLj deletes
 * emscripten's `invoke_*` trampolines. Selected by aliasing `./php-binary.js` to this
 * file; see the docblock there for why the alias cannot target the `.wasm` import.
 */
export { PHPFactory, wasmModule };
