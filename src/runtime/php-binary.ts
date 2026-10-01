import PHPFactory from '../../vendor/static-free-v1/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-free-v1/php8.3-worker.mjs.wasm';

/**
 * The one place the PHP binary is chosen: a wrangler `alias` swaps the interpreter by pointing at
 * a sibling of this file. Aliasing the `.wasm` import directly fails, because wrangler resolves
 * `alias` before the `CompiledWasm` loader rule matches. Default `static-free-v1` is the binary
 * the recorded per-query, bridge and boot figures were taken on.
 */
export { PHPFactory, wasmModule };
