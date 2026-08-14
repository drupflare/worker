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
 * NOT the default seam, and now for a MEASURED reason rather than a cautious one. Deployed to a
 * throwaway on 2026-08-14 this bundle came to 2,874,859 gzipped -- 270,869 under the ceiling -- with a
 * 155 ms startup, and then every request returned 1101 with
 * `ExitStatus: Program terminated with exit(-2)` on both the stateless and durableObject events. The
 * interpreter aborts during startup, before any route logic. Size, the recompression, the decoder and
 * codegen are all ruled out; the same zstd path renders a real page on 8.3.
 *
 * Untested candidates: opcache is mandatory on 8.5 and this rc still passes `--enable-opcache`; ext/uri
 * and lexbor initialise at module startup and are new since 8.4; the host ini and boot fragments were
 * written against 8.3. Drive the binary under node from `.interp/` to see PHP's stderr -- an edge
 * deploy reports the exit code and swallows the reason.
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
