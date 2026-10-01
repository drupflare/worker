/**
 * PHP 8.5, carrying every extension, reached through a brotli frame.
 *
 * Not the shipping seam (`php-binary-raw.ts` imports the binary uncompressed, startup ~5 ms
 * against ~106 ms here); kept as an experiment arm named by `experiments/wrangler/` configs.
 *
 * - The glue is the tuned one: emscripten's heap-growth step is a JS literal and its default 0.20
 *   takes an authenticated render to 138.31 MiB against a 128 MiB isolate (0.05: 116.75 MiB).
 *   `restore-artifacts.ts` emits it from the verified pristine glue.
 * - `opcache.file_cache` is read during PHP's module startup, before the mount sequence creates
 *   its directory, so `src/site-do.ts` points it at `/tmp` (MEMFS always has it). Read that file
 *   before removing any opcache ini line: `file_cache_only=1` makes the file cache the only
 *   backing store.
 * - The inflate is `node:zlib` at module scope, the only place codegen is allowed (request time
 *   refuses it, so a test lane cannot use this seam). Startup cannot be measured locally (the
 *   clock does not advance); deployed on free it read 104-112 ms (n=4) against 1,000.
 * - No `inflatedSize` cross-check: upstream rebuilds change the size (12,218,400 then 12,218,393),
 *   so a hardcoded one would fail closed on every rebuild.
 * - 8.4 is absent: 49,220 more compressed bytes than 8.5, and no package in the lock excludes 8.5.
 * @module
 */

import { brotliDecompressSync } from 'node:zlib';
import PHPFactory from '../../.interp/php8.5-worker.tuned.mjs';
import blob from '../../.interp/php8.5.wasm.br';

// `@cloudflare/workers-types` declares `WebAssembly.Module` abstract, so `new` on it does not
// typecheck (the same alias cartridge's inflate helper used)
const WasmModule = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;

let wasmModule: WebAssembly.Module;
try {
	wasmModule = new WasmModule(brotliDecompressSync(new Uint8Array(blob)));
} catch (cause) {
	const message = cause instanceof Error ? cause.message : String(cause);
	// codegen refusal and bad bytes share a throw site; the test lane hits the first because a
	// spec runs inside a fetch handler, where module scope is request time
	if (/code generation disallowed/i.test(message)) {
		throw new Error(
			'workerd refused wasm codegen, so this ran at request time; it must run at module scope'
		);
	}
	throw new Error(`the inflated interpreter is not a loadable wasm module: ${message}`);
}

export { PHPFactory, wasmModule };
