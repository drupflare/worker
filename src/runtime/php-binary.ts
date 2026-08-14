import PHPFactory from '../../vendor/static-free-v1/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-free-v1/php8.3-worker.mjs.wasm';

/**
 * The one place the PHP binary is chosen.
 *
 * Extracted so a wrangler config can swap the whole interpreter with a single `alias`
 * entry pointing at a sibling of this file. Aliasing the `.wasm` import directly does
 * NOT work -- wrangler resolves `alias` before the `CompiledWasm` loader rule matches,
 * so the aliased specifier arrives at esbuild with no loader configured. Keeping the
 * `.wasm` import inside a real source file keeps the rule applicable.
 *
 * `static-free-v1` is the default because every recorded per-query, bridge and boot
 * figure in TECHNICAL_REPORT.md was taken on it, and the first driver cost numbers have to stay
 * comparable to them. `src/php-binary-jspi.js` is the same shape over
 * `vendor/static-jspisjlj`, which adds JSPI, wasm SjLj and the VM-interrupt patch.
 */
export { PHPFactory, wasmModule };
