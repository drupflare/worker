/**
 * The re-entrancy flag that stops a build from hydrating itself.
 *
 * **WITHOUT IT THE BUILD RECURSES, AND IT TOOK THREE CI LANES DOWN.** `wrangler.jsonc` names
 * `bun run hydrate` as its build command, so every `wrangler dev` and every `wrangler deploy` runs it
 * first. `build-local.ts` orders its `container` step before `sql`, so when that step spawns
 * `wrangler dev --local` the tree is still missing `assets/drupal-sql/manifest.json` -- hydrate reads
 * that as an incomplete tree, finds no published release, and falls back to `build-local.ts` again.
 * Each level forks another full Drupal build.
 *
 * Measured 2026-09-12: Pack Suites, Browser Lane and Class A Metrics all ended in *"The runner has
 * received a shutdown signal"* about three minutes in, having printed nothing, because
 * `bake-container.ts` buffered the child's output and a SIGTERM never reaches a `catch`. The run of
 * 2026-09-11 01:37 is the control -- it predates the build command and got as far as a real
 * `migrate answered 401`.
 *
 * The marker check cannot close this on its own. It answers "is the tree finished", and mid-build the
 * answer is no.
 *
 * Its own module rather than a member of `hydrate.ts`, which imports `release-payload.ts`: every
 * script that spawns wrangler needs the flag, and several of them are what `hydrate.ts` reads.
 */
const REENTRY_VAR = 'DRUPFLARE_HYDRATING';

/** Marks this process tree as already building, for every wrangler it goes on to spawn. */
export function markHydrating(env: Record<string, string | undefined> = process.env): void {
	env[REENTRY_VAR] = '1';
}

export function reentered(env: Record<string, string | undefined> = process.env): boolean {
	return env[REENTRY_VAR] === '1';
}

export { REENTRY_VAR };
