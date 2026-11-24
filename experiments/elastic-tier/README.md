# Elastic Tier

Closed work on running a refused request on a translated interpreter whose memory is paged into the object's SQLite. Nothing here is imported by the worker. The findings and the reason it was closed are in [notes/elastic-interpreter.md](../../notes/elastic-interpreter.md).

| file                           | what it was                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `build-elastic.ts`             | translates `.interp/php8.5.tuned.wasm` with folio's translator and writes the module, layout and glue   |
| `matrix.mjs`                   | builds each translator option set and prints module and code section sizes                               |
| `compress.mjs`                 | brotli and zstd size, inflate time and compile time for a module                                         |
| `probe.ts`                     | the workers-project spec that timed native against elastic renders at several frame counts               |
| `elastic-run.ts`               | session and executor over the page store; lived in `src/do/`                                             |
| `elastic-binary.ts`            | the static import of the module, glue and layout; lived in `src/runtime/`                                |
| `elastic-pager.ts`, `elastic-translate-host.ts` | copies of folio's research pager and host, trimmed; lived in `src/runtime/`                |

Restoring it means putting those four files back, adding the `elastic` seam option to `PhpSeam` in `src/do/boot/php.ts` (heap hook arguments, the pager imports and an `emscripten_resize_heap` override in `instantiateWasm`, the pager's memory in `bootPhp`), a `seamOverride` field read by `ensurePhp()` in `src/site-do.ts`, and `elasticExecutorFor(site)` in place of the stub in `src/do/fetch.ts`.
