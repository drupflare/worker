import { ICONV_FIX_PHP, ICONV_STRRPOS_PHP } from '../site/generated/assets';
import { hoistUses } from '../util/php';
import { renderTemplate } from '../util/template';

/**
 * Corrects `iconv_strrpos()` in symfony/polyfill-iconv, which returns `strlen()` instead of 0
 * when the last match is at index 0 (`$pos ? substr(...) : $haystack` treats offset 0 as falsy;
 * `iconv_strrpos('a', 'a')` is 1, native 0). It reaches this build because it has neither
 * extension and polyfill-mbstring's `mb_strrpos()` family wraps it.
 *
 * Kept outside the extension guard so a gate test and `scripts/measure/mb-parity.ts` can drive it
 * on a build that has iconv. Injected before composer's autoloader exists; the `use` alias resolves
 * at compile time and the class at call time, so nothing loads until a caller runs it.
 */
export const ICONV_STRRPOS = ICONV_STRRPOS_PHP;

/**
 * Claims the global name before polyfill-iconv's bootstrap can, as `MB_FIX` does for `mb_*`.
 *
 * No `eval()` (as `ZLIB_FIX`): a conditional declaration colliding with an internal function binds
 * at runtime, so it compiles clean on a build with iconv and `php-fragments.spec.ts` can lint it.
 */
export const ICONV_FIX = hoistUses(renderTemplate(ICONV_FIX_PHP, { ICONV_STRRPOS }));
