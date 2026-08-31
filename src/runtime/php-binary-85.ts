import { brotliDecompressSync } from 'node:zlib';
import PHPFactory from '../../.interp/php8.5-worker.tuned.mjs';
import blob from '../../.interp/php8.5.wasm.br';

/**
 * PHP 8.5, carrying every extension, reached through a brotli frame.
 *
 * 2,485,488 brotli bytes against the 3,145,728 free ceiling, with opcache, pdo, yaml, zlib, simplexml,
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
 * 8.4 is absent: it costs 49,220 MORE compressed bytes than 8.5 while being 357,323
 * smaller raw, because its data section is both larger and less compressible. Zero of the 73 packages
 * in the shipped lock exclude 8.5.
 *
 * The binary lives in `.interp/` rather than `vendor/`, which holds unreproducible hand-built
 * artifacts and is never written to.
 *
 * THE GLUE IS THE TUNED ONE, not the pristine download, and that is a memory decision rather than a
 * packaging one. Emscripten emits its heap-growth step into `_emscripten_resize_heap` as a
 * JavaScript literal, and its default of 0.20 takes an AUTHENTICATED render to 138.31 MiB against a
 * 128 MiB isolate -- measured, three workloads, `scripts/measure/growth-ladder.ts`. At 0.05 the
 * worst of the three is 116.75 MiB. `restore-artifacts.ts` emits this file after verifying the
 * pristine one against `cdn-manifest.json`; `tests/node/growth-glue.spec.ts` asserts the two differ
 * at the growth site and nowhere else.
 */
/**
 * THE INFLATE IS THE RUNTIME'S, not a decoder we ship, and the frame is brotli rather than zstd.
 *
 * Both halves are one change. `node:zlib` carries brotli and zstd, and workerd runs either
 * synchronously at MODULE scope -- which is the only place they could be used, since codegen is
 * forbidden at request time and the `new WebAssembly.Module` below has to happen at startup. Probed
 * on the shipping workerd against both frames of this exact binary: 2,671,745 zstd and 2,485,488
 * brotli, each inflating to the same 12,234,575 bytes, byte for byte identical, 4,118 exports.
 *
 * What that buys, on `wrangler deploy --dry-run` gzip figures:
 *
 * - the packed frame at 2,485,488 rather than 2,671,745, because brotli beats zstd on this binary
 * - `zstddec.wasm` gone, 25,473 bytes that existed only because the pure-JS zstd decoder was slow
 * - `fzstd` and cartridge's inflate helper gone with it
 *
 * A previous note here said the zstd frame header carries the inflated length and the decompressor
 * pre-sizes from it. Brotli has no such field and `brotliDecompressSync` sizes its own output, so
 * nothing is lost; `scripts/pack-wasm-brotli.ts` records why its cache key changed to match.
 *
 * NO `inflatedSize` cross-check, unlike the 8.3 seam. That binary is pinned in
 * `vendor/` and never changes, so a hardcoded size is a real guard there. This one is fetched from
 * phasm's newest artifact by `bun run fetch:interp85`, and two consecutive builds measured 12,218,400
 * and 12,218,393 -- so a hardcoded size turns every upstream rebuild into a code edit that fails
 * closed.
 *
 * **The STARTUP cost cannot be measured locally**, because the wall clock does not advance between
 * I/O and a `Date.now()` delta around the inflate reads zero. Cloudflare reports it on upload, so a
 * deploy is the instrument. Measured on a FREE throwaway carrying this seam and nothing else,
 * 2026-08-30: **104, 105, 107, 112 ms** (n=4, median 106) against a 1,000 ms limit. The
 * zstd-through-wasm path it replaces read 233/234/246 (n=3), so native brotli is about half of it
 * and spends a tenth of the budget.
 */
// `@cloudflare/workers-types` declares `WebAssembly.Module` abstract, so `new` on it does not
// typecheck; the same alias is what cartridge's inflate helper used
const WasmModule = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;

let wasmModule: WebAssembly.Module;
try {
	wasmModule = new WasmModule(brotliDecompressSync(new Uint8Array(blob)));
} catch (cause) {
	const message = cause instanceof Error ? cause.message : String(cause);
	// the embedder refusal and bad bytes are different faults at the same throw site, and reporting
	// the wrong one sends the reader looking for a corrupt binary that is fine. This is not
	// hypothetical: pointing the test lane at this seam produces exactly the first one, because a
	// vitest spec is evaluated inside a fetch handler and module scope there is REQUEST time
	if (/code generation disallowed/i.test(message)) {
		throw new Error(
			'workerd refused wasm codegen, so this ran at request time; it must run at module scope'
		);
	}
	throw new Error(`the inflated interpreter is not a loadable wasm module: ${message}`);
}

export { PHPFactory, wasmModule };
