import PHPFactory from '../../vendor/static-o3mbsjlj/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-o3mbsjlj/php8.3-worker.mjs.wasm';

/**
 * `-O3` half of the -O3 A/B, at BUNDLE level. Built by relinking the tree that produced
 * `vendor/static-jspimbsjlj` with `MAKE_EXTRA=OPTIMIZE=3` and nothing else changed, so the
 * pair isolates the link-time `-O` level. Selected by a wrangler `alias`; see
 * `src/runtime/php-binary.ts`.
 */
export { PHPFactory, wasmModule };
