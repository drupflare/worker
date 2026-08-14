import PHPFactory from '../../vendor/static-o2/php8.3-worker.mjs';
import wasmModule from '../../vendor/static-o2/php8.3-worker.mjs.wasm';

/**
 * The shipping interpreter, and the one nothing in this document was measured on.
 *
 * 2,876,855 gzipped -- 268,873 UNDER the 3 MB free ceiling, where `static-free-v1` is
 * 586,923 OVER it. It differs from the measured binary on three axes at once (RULE 0b-iii):
 *
 * | | `static-free-v1` (measured on) | `static-o2` (here) |
 * | --- | --- | --- |
 * | optimisation | `-Oz` | `-O2`, separately measured 3.9% faster |
 * | SQLite | compiled in, ~614 KB | absent |
 * | ext-yaml | absent | present, worth 241 ms of boot |
 *
 * It could not run Drupal until now: `MIGRATE_DB` reached for `new \PDO('sqlite:...')`
 * once, at first run, and `pdo_sqlite` is not in this build. `src/migrate-sql.js` replays
 * the site in JavaScript instead, so that last consumer is gone and this binary can run
 * the real workload. Base ext-pdo IS present, so the class constants core's sqlite
 * `Connection` references still resolve.
 *
 * Selected by aliasing `./php-binary.js` to this file; see the docblock there for why the
 * alias cannot target the `.wasm` import directly.
 */
export { PHPFactory, wasmModule };
