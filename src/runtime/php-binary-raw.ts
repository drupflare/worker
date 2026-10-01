/**
 * PHP 8.5 as a pre-compiled `CompiledWasm` import, with no compression frame.
 *
 * Cloudflare removed the compressed bundle limit on 2026-09-04 (64 MiB uncompressed on both plans),
 * so the brotli frame is gone, and with it `new WebAssembly.Module` and any request-time codegen.
 * That lets the test lane run the seam that ships. The glue is still the tuned one (heap-growth
 * step 0.05: 116.75 MiB worst of three workloads, against 138.31 MiB at emscripten's 0.20).
 *
 * Startup on a deployed free worker is 3-6 ms (n=4, median 5), against 104-112 for the brotli seam
 * (21x), and is not billed to a request (0-1 ms of `cpuTime`). A deploy is the only instrument:
 * Cloudflare reports startup on upload and refuses a Worker over the limit.
 * @module
 */

import PHPFactory from '../../.interp/php8.5-worker.tuned.mjs';
import wasmModule from '../../.interp/php8.5.tuned.wasm';

export { PHPFactory, wasmModule };
