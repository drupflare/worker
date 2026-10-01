import { XMLWRITER_FIX_PHP } from '../site/generated/assets';

/**
 * A pure-PHP `XMLWriter` for a build without `ext-xmlwriter`.
 *
 * It is a class because `simple_sitemap` and `xmlsitemap` subclass `\XMLWriter`: the parent must
 * exist when the subclass compiles, so it is declared as early as `MB_FIX`. The surface covers
 * what both subclasses call (`openUri`, `writeRaw` included); `writeCdata`, `startAttribute`,
 * `writeDtd` and the namespace variants have no caller and stay absent. `openUri()` makes it a
 * streaming writer, so `flush()` returns bytes rather than the document.
 *
 * Guarded by `if (!class_exists(...))` rather than `eval()`, so the body stays lintable.
 */
export const XMLWRITER_FIX = XMLWRITER_FIX_PHP;
