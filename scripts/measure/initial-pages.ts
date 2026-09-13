/**
 * The interpreter's INITIAL_MEMORY, as a number and nothing else.
 *
 * Its own module because the specs that assert heap figures run INSIDE workerd, and
 * `initial-memory.ts` reaches for `node:fs` to do the patching. A spec that pins 96 MiB as a literal
 * is what made five of them fail the moment the binary was tuned, so the figure has one home.
 *
 * The measurement and the reasoning for this value are in `initial-memory.ts`.
 */
export const INITIAL_PAGES = 1280;

/** the WebAssembly page size, which is what a module's memory section counts in */
export const WASM_PAGE = 65536;

/** where a freshly booted interpreter's linear memory starts */
export const INITIAL_BYTES = INITIAL_PAGES * WASM_PAGE;

/** what the published binary declares before the build step rewrites it */
export const PRISTINE_PAGES = 1536;
