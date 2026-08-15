import { existsSync } from 'node:fs';

/**
 * The reachability gate for specs whose subject is a BUILD ARTIFACT, modelled on
 * `tests/e2e/helpers/endpoint.ts`.
 */

/** every build artifact a spec might depend on, with the command that produces it */
const PRODUCED_BY: Record<string, string> = {
	'assets/driver.json': 'bun run assets:driver',
	'assets/drupal/twig-bake.json': 'bun run assets:twig',
	'assets/drupal-pf/core.pf.json': 'bun run assets:pack',
	'assets/drupal-pf/core.pf.bin': 'bun run assets:pack',
	// structurally equivalent, NOT byte-identical: an install mints a fresh hash salt and UUIDs
	'assets/drupal/site.sqlite':
		'bun run build:site-db <out> (verify with bun run check:site-db <out>)',
	'assets/drupal-sql': 'bun run assets:sql'
};

/**
 * Whether a spec depending on these artifacts should skip.
 *
 * @param paths
 *   Repo-relative artifact paths the spec cannot run without.
 * @returns
 *   `true` to skip. Never returns `true` in a lane that set `REQUIRE_ARTIFACTS` -- it throws instead.
 * @throws
 *   When `REQUIRE_ARTIFACTS` is set and any artifact is missing, naming each one and how to build it.
 */
export function artifactGate(paths: string[]): boolean {
	const missing = paths.filter((p) => !existsSync(p));
	if (missing.length === 0) return false;
	if (process.env.REQUIRE_ARTIFACTS) {
		const how = missing
			.map((p) => `  ${p} <- ${PRODUCED_BY[p] ?? 'unknown producer'}`)
			.join('\n');
		throw new Error(
			`build artifacts missing, and REQUIRE_ARTIFACTS says this lane has them:\n${how}\n` +
				'Hydrate the release payload first (bun run hydrate), build them, or unset ' +
				'REQUIRE_ARTIFACTS to narrow what this lane claims to cover.'
		);
	}
	return true;
}
