/**
 * The `.wasm` import in `src/runtime/php-binary*.ts`.
 *
 * wrangler's `CompiledWasm` rule turns the file into a module whose default export is a
 * `WebAssembly.Module`; tsc has no loader concept, so the shape is declared here instead. Kept
 * out of `src/runtime/` -- that directory is in the coverage include list.
 */
declare module '*.wasm' {
	const wasmModule: WebAssembly.Module;
	export default wasmModule;
}

/**
 * The zstd frame `src/runtime/php-binary-zstd.ts` imports.
 *
 * wrangler's `Data` rule turns the file into a module whose default export is an `ArrayBuffer`, so
 * the bytes reach the bundle already compressed and Cloudflare's gzip cannot shrink them further.
 */
declare module '*.zst' {
	const bytes: ArrayBuffer;
	export default bytes;
}

/**
 * The brotli frame `src/runtime/php-binary-85.ts` imports, which is what SHIPS.
 *
 * Same `Data` rule and same reason as `*.zst`; brotli is the better ratio on this binary and its
 * decoder is in `node:zlib`, so nothing has to be bundled to inflate it.
 */
declare module '*.br' {
	const bytes: ArrayBuffer;
	export default bytes;
}

/**
 * The emscripten glue a `vendor/` or `assets/` build ships next to its `.wasm`.
 *
 * Declared because both directories are gitignored: on a machine that has never run
 * `bun run vendor` -- CI, or this repo with four of the probe builds never rebuilt -- the
 * specifier resolves to nothing and every importer fails to typecheck. The shape is the one
 * emscripten emits for MODULARIZE=1, and it is what `PhpBase` calls.
 *
 * **Matches every `.mjs`, not just `*-worker.mjs`.** The narrower pattern was green locally and
 * failed CI on three files it did not cover -- `vendor/php8.3-web.mjs` and the two
 * `assets/sjlj/*sjlj.mjs` -- which broke `typecheck` AND `docs:build`, because typedoc resolves the
 * same specifiers. Every `.mjs` imported anywhere in `src/` is emscripten glue of this shape, so
 * the wildcard is accurate rather than a blanket `any`.
 */
declare module '*.mjs' {
	const factory: (moduleArg?: object) => Promise<any>;
	export default factory;
}

/**
 * JSPI, which `src/probes/jspi-probe.ts`, `jspi-routes.ts` and `sjlj-probe.ts` read.
 *
 * Absent from TypeScript's `lib.dom` and from @cloudflare/workers-types, because the proposal
 * is behind a flag; the probes exist to find out whether the engine has it, so `typeof` guards
 * every use. Declared here rather than cast at each site so the probe bodies stay verbatim.
 */
declare namespace WebAssembly {
	/** wraps a JS function so a wasm call into it suspends the wasm stack */
	class Suspending {
		constructor(fn: (...args: any[]) => unknown);
	}
	/** wraps a wasm export so calling it returns a promise */
	function promising(fn: Function): (...args: any[]) => Promise<any>;
	/** thrown when a suspension is attempted with no promising frame below it */
	const SuspendError: ErrorConstructor;
}
