/**
 * The `.wasm` import (wrangler's `CompiledWasm` rule); kept out of `src/runtime/`, which is in the
 * coverage include list.
 */
declare module '*.wasm' {
	const wasmModule: WebAssembly.Module;
	export default wasmModule;
}

/**
 * A zstd frame from `scripts/pack-wasm-zstd.ts` (8.3 and experiment arms only); wrangler's `Data`
 * rule gives an `ArrayBuffer`.
 */
declare module '*.zst' {
	const bytes: ArrayBuffer;
	export default bytes;
}

/**
 * The brotli frame `src/runtime/php-binary-85.ts` imports (same `Data` rule as `*.zst`); not the
 * shipping seam.
 */
declare module '*.br' {
	const bytes: ArrayBuffer;
	export default bytes;
}

/**
 * The emscripten glue (`MODULARIZE=1` shape, what `PhpBase` calls) shipped beside a `.wasm`.
 *
 * `vendor/` and `assets/` are gitignored, so on CI the specifier resolves to nothing. Matches every
 * `.mjs` under `src/`, all of which are glue of this shape.
 */
declare module '*.mjs' {
	const factory: (moduleArg?: object) => Promise<any>;
	export default factory;
}

/**
 * JSPI as the probes read it; absent from `lib.dom` and workers-types (flagged proposal), so guard
 * every use with `typeof`.
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
