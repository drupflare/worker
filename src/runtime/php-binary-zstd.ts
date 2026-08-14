import { wasmModuleFromZstd, zstdDecoderFromWasm } from '@drupflare/cartridge/inflate';
import blob from '../../.interp/php8.3-worker.mjs.wasm.zst';
import decoder from '../../.interp/zstddec.wasm';
import PHPFactory from '../../vendor/static-o2/php8.3-worker.mjs';

/**
 * The shipping interpreter, delivered pre-compressed.
 *
 * Same binary as `php-binary-o2.ts` -- `vendor/static-o2` -- reached through a zstd frame instead of
 * a `CompiledWasm` import, because the size meter runs after Cloudflare's own gzip and gzip cannot
 * shrink what is already compressed. On this binary that is 2,779,161 -> 2,070,852, freeing 708,309
 * bytes against the 3 MiB free ceiling.
 *
 * The frame is inflated by a zstd decoder that is itself wasm, imported as `CompiledWasm` so the
 * platform compiles it ahead of the isolate. The pure-JS fallback measured ~257 ms of a ~274 ms
 * startup; the wasm decoder decoded the same 9,281,983 bytes to a byte-identical sha256 in 35 ms
 * against fzstd's 361 ms locally.
 *
 * `.interp/` is gitignored; run `bun run pack:wasm` after a clone.
 */
const wasmModule = wasmModuleFromZstd(blob, {
	inflatedSize: 9_281_983,
	decompress: zstdDecoderFromWasm(decoder)
});

export { PHPFactory, wasmModule };
