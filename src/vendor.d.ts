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
 * The emscripten glue a `vendor/` build ships next to its `.wasm`.
 *
 * Declared because the whole directory is gitignored: on a machine that has never run
 * `bun run vendor` -- CI, or this repo with four of the probe builds never rebuilt -- the
 * specifier resolves to nothing and every importer fails to typecheck. The shape is the one
 * emscripten emits for MODULARIZE=1, and it is what `PhpBase` calls.
 */
declare module '*-worker.mjs' {
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
