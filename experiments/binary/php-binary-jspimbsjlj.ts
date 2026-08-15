import PHPFactory from '../../vendor/static-jspimbsjlj/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-jspimbsjlj/php8.3-worker.mjs.wasm';

/**
 * `-O2` half of the -O3 A/B, at BUNDLE level. Same shape as
 * `experiments/binary/php-binary-o3mbsjlj.ts` in every respect except the link-time `-O`
 * level, so the difference between the two dry-run bundles is the optimisation level and
 * nothing else. Selected by a wrangler `alias`; see `src/runtime/php-binary.ts`.
 */
export { PHPFactory, wasmModule };
