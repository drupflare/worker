/**
 * Stands in for the PHP interpreter glue in a lane that has no build artifacts.
 *
 * `src/site-do.ts` imports the binary at MODULE SCOPE and must -- workerd forbids request-time wasm
 * codegen, so the module has to exist while the graph loads. That makes the import unconditional,
 * so every workers spec transitively needs it to RESOLVE even though almost all of them replace the
 * interpreter with `stubRender()` and never call it.
 *
 * `vendor/` and `.interp/` are both gitignored, so on a clean checkout neither the default seam nor
 * the aliased one exists and 34 spec files failed to load with `Cannot find module`. Vite does not
 * apply wrangler's `alias`, which is why this lane reaches the DEFAULT seam rather than the shipping
 * 8.5 one -- a developer machine has `vendor/static-free-v1`, so it was invisible until the first push.
 *
 * `vitest.config.ts` substitutes this ONLY when the real artifact is absent, so local runs keep
 * loading the real interpreter and nothing about local coverage changes.
 *
 * Default export, because `src/runtime/php-binary.ts` imports the glue as a default.
 */
export default function phpFactoryAbsent(): Promise<never> {
	throw new Error(
		'no PHP interpreter in this lane: vendor/ and .interp/ are gitignored build artifacts. ' +
			'Run `bun run build:wasm` or `bun run hydrate`, or use stubRender() in this spec.'
	);
}
