/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Types for the vitest `workers` project.
 *
 * The `cloudflare:test` module types ship on a subpath the tsconfig `types` array cannot reach,
 * so the reference above brings them in instead.
 *
 * `ProvidedEnv` is what `import { env } from 'cloudflare:test'` resolves to. It is declared by
 * hand rather than generated because this repo does not run `wrangler types`, and the only
 * binding a spec needs is the Durable Object namespace.
 */
declare module 'cloudflare:test' {
	interface ProvidedEnv extends Cloudflare.Env {}
}

// `env` from `cloudflare:test` is typed as `Cloudflare.Env`, so the bindings are declared on
// that namespace rather than on ProvidedEnv alone
declare namespace Cloudflare {
	interface Env {
		SITE: DurableObjectNamespace;
		ASSETS: Fetcher;
		PW_DIAGNOSTICS?: string;
		RENDER_BUDGET_MS?: string;
		GEN_BUCKET_MS?: string;
		PLAN?: string;
	}
}

/**
 * Vite's `?raw` suffix, used by `tests/unit/runtime/mask.spec.ts` to read a source file as text.
 *
 * The original suite used `node:fs` `readFileSync`, which does not exist in workerd. `?raw` is
 * resolved at transform time so the string travels into the isolate with the code.
 */
declare module '*?raw' {
	const src: string;
	export default src;
}
