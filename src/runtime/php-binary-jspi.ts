import PHPFactory from '../../vendor/static-jspisjlj/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-jspisjlj/php8.3-worker.mjs.wasm';

/**
 * The slicing-capable interpreter: JSPI, `-sSUPPORT_LONGJMP=wasm` and the `zend_interrupt_function`
 * patch exporting `zend_wasm_slice_arm/_mask/_stat`. 2,866,753 gzipped, 10,102 smaller than the
 * shipping build (wasm SjLj drops emscripten's `invoke_*` trampolines). Selected by aliasing
 * the `php-binary` seam to this file.
 */
export { PHPFactory, wasmModule };
