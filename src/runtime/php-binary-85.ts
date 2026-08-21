import { wasmModuleFromZstd, zstdDecoderFromWasm } from '@drupflare/cartridge/inflate';
import PHPFactory from '../../.interp/php8.5-worker.mjs';
import blob from '../../.interp/php8.5.wasm.zst';
import decoder from '../../.interp/zstddec.wasm';

/**
 * PHP 8.5, carrying every extension, reached through a zstd frame.
 *
 * 2,658,002 zstd bytes against the 3,145,728 free ceiling, with opcache, pdo, yaml, zlib, simplexml,
 * xml and the whole of lexbor and DOM intact. Nothing is dropped to make it fit; the recompression is
 * what makes it fit, and the extension-substitution programme it retired recovered only 22.5% of what
 * 8.5 costs over 8.3.
 *
 * THE exit(-2) ABORT DESCRIBED HERE IS FIXED, and this seam is what ships. Deployed to a throwaway on
 * 2026-08-14 every request returned 1101 with `ExitStatus: Program terminated with exit(-2)` on both
 * the stateless and durableObject events, aborting during startup before any route logic. Size, the
 * recompression, the decoder and codegen were all ruled out.
 *
 * The cause was `opcache.file_cache`, which opcache reads during PHP's MODULE STARTUP -- inside the
 * binary's constructor, before the mount sequence creates the directory. It was pointed at
 * `/tmp/opcache`, which did not exist yet. `src/site-do.ts` now passes `/tmp`, which emscripten's
 * MEMFS always creates, and carries the measurement: 1,301 `.bin` files across 425 directories after
 * one render on a deployed 8.5 worker. It was dead config until 8.5 -- the 8.3 build contains zero
 * occurrences of `Zend OPcache`, so every opcache ini line was silently ignored for the life of the
 * project and went live the moment 8.5 made it mandatory.
 *
 * Read `src/site-do.ts` before removing any opcache ini line: `file_cache_only=1` makes the file
 * cache opcache's ONLY backing store, so dropping the path may disable opcache rather than merely
 * stop the writes. Removing opcache ini blind is what produced the abort.
 *
 * 8.4 is deliberately absent: it costs 49,220 MORE compressed bytes than 8.5 while being 357,323
 * smaller raw, because its data section is both larger and less compressible. Zero of the 73 packages
 * in the shipped lock exclude 8.5.
 *
 * The binary lives in `.interp/` rather than `vendor/`, which holds unreproducible hand-built
 * artifacts and is never written to.
 */
// NO `inflatedSize` cross-check here, deliberately, unlike the 8.3 seam. That binary is pinned in
// `vendor/` and never changes, so a hardcoded size is a real guard there. This one is fetched from
// phasm's newest artifact by `bun run fetch:interp85`, and two consecutive builds measured 12,218,400
// and 12,218,393 -- so a hardcoded size turns every upstream rebuild into a code edit that fails
// closed with `inflate.size-mismatch`. The zstd frame header carries the true length and the
// decompressor is pre-sized from it either way.
const wasmModule = wasmModuleFromZstd(blob, { decompress: zstdDecoderFromWasm(decoder) });

export { PHPFactory, wasmModule };
