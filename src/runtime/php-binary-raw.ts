import PHPFactory from '../../.interp/php8.5-worker.tuned.mjs';
import wasmModule from '../../.interp/php8.5.wasm';

/**
 * PHP 8.5 as a pre-compiled `CompiledWasm` import, with no compression frame at all.
 *
 * THE COMPRESSION EXISTED TO BEAT A METER THAT NO LONGER EXISTS. Cloudflare removed the compressed
 * bundle limit on 2026-09-04: the Worker size limit is now 64 MiB UNCOMPRESSED on both Free and Paid,
 * and their docs say plainly "There is no compressed size limit. Only the uncompressed bundle size
 * counts." The brotli seam packed 12,234,575 raw bytes into 2,485,488 to fit a 3,145,728 gzipped
 * ceiling. Uncompressed, the same binary plus the front worker and tinyimg is 13,580,607 against
 * 67,108,864, which is 20.2%.
 *
 * Three things follow:
 *
 * - `brotliDecompressSync` is gone from the startup path.
 * - `new WebAssembly.Module` is gone with it, so the seam performs no codegen.
 * - **The gate can therefore run the seam that ships.** workerd forbids codegen at request time and a
 *   vitest spec is evaluated inside a fetch handler, so the brotli seam could never be loaded by the
 *   test lane -- `vitest.config.ts` aliased around it to the raw binary, and for the life of the
 *   project the two lanes reached the interpreter by different routes. A `CompiledWasm` import is
 *   compiled by the platform ahead of time and needs no codegen anywhere, so both lanes can use this.
 *
 * `wrangler.jsonc` already carried the `CompiledWasm` rule for `**\/*.wasm`, so the import below
 * resolves to a `WebAssembly.Module` with nothing to decode and nothing to construct.
 *
 * THE GLUE IS STILL THE TUNED ONE. Emscripten emits its heap-growth step into
 * `_emscripten_resize_heap` as a JavaScript literal, and its default of 0.20 takes an authenticated
 * render to 138.31 MiB against a 128 MiB isolate. At 0.05 the worst of three workloads is 116.75 MiB.
 * That is a memory decision and this change does not touch it.
 *
 * **STARTUP MEASURED ON A DEPLOYED FREE WORKER, 2026-09-07: 3, 6, 6, 4 ms (n=4, median 5).** Against
 * the brotli seam's 104/105/107/112 (n=4, median 106) and the zstd-through-wasm path's 233/234/246
 * (n=3), so this is **21x** cheaper than the seam it replaces and spends 0.5% of the 1,000 ms budget
 * rather than 10.6%. The bigger module is the cheaper one, because the platform compiles it ahead of
 * time and the work at startup is what actually cost.
 *
 * A deploy is the only instrument: Cloudflare reports startup on upload and refuses a Worker over the
 * limit, so the upload succeeding is half the measurement. `cfw-startup-raw`, torn down, free account
 * back to 0 workers. The probe imports this seam and nothing else, so nothing else is in the reading.
 *
 * **Startup is not billed to a request**, measured at 0-1 ms of request `cpuTime` across three cold
 * isolates. This is a limit-compliance figure, not a latency one.
 */
export { PHPFactory, wasmModule };
