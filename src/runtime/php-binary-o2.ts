/**
 * The PHP 8.3 `static-o2` build: `-O2` (3.9% faster than `-Oz`), no SQLite, ext-yaml present
 * (241 ms of boot). Not the shipping interpreter; an experiment arm selected by aliasing
 * `./php-binary.js` to this file (the alias cannot target the `.wasm` import directly).
 *
 * It has no `pdo_sqlite`, so the site is replayed in JavaScript (`src/db/migrate-sql.ts`); base
 * ext-pdo is present, so the class constants core's sqlite `Connection` references resolve.
 * @module
 */

import PHPFactory from '../../vendor/static-o2/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-o2/php8.3-worker.mjs.wasm';
export { PHPFactory, wasmModule };
