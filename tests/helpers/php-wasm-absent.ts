/**
 * Stands in for the compiled `.wasm` module in a lane that has no build artifacts.
 *
 * NOT a real `WebAssembly.Module`, and it cannot be one: constructing one here throws
 * `Wasm code generation disallowed by embedder`. workerd permits codegen at worker STARTUP, but a
 * vitest spec module loads inside a fetch handler, so module scope in this lane is request time. The
 * shipping seam never hits that, because `.wasm` arrives as a `CompiledWasm` module the bundler
 * already produced -- there is no runtime compile at all.
 *
 * Nothing reads it. `site-do.ts` only forwards it to the factory, which throws, so the value has to
 * resolve and never has to work. Anything that does touch it fails loudly by name rather than
 * silently behaving like an empty module.
 *
 * See [[php-binary-absent]] for why the substitution exists at all.
 */
export default new Proxy(
	{},
	{
		get(_target, prop) {
			throw new Error(
				`no PHP wasm module in this lane (read '${String(prop)}'): vendor/ and .interp/ are ` +
					'gitignored build artifacts. Run `bun run build:wasm` or `bun run hydrate`.'
			);
		}
	}
) as WebAssembly.Module;
