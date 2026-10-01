import { UNICODE_TABLES_PHP } from '../site/generated/assets';

/**
 * PHP that reads the Unicode delta table the `drupflare` module ships, degrading to the
 * polyfill's own answers when it is not mounted.
 *
 * The data is `../drupflare/src/unicode-tables.php`, packed into `assets/driver.json` and mounted
 * by `mountDriver()` before `MB_FIX` runs, which is what makes a `require` legal. It is generated
 * (`bun run measure:unicode --write` writes the PHP file, never this one). Inert on a build with
 * native mbstring, which is the shipping one.
 */
export const UNICODE_TABLES = UNICODE_TABLES_PHP;
