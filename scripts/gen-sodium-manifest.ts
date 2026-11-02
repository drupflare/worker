/**
 * Runs the sodium conformance gate and writes `src/site/generated/sodium-manifest.ts`.
 *
 *   bun run gen:sodium-manifest
 *
 * The manifest is the set of names of the ext-sodium API that passed, and it is what lets
 * `extension_loaded('sodium')` answer true. It needs a native PHP 8.5 with ext-sodium.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { manifestOf, runConformance } from '../tests/helpers/sodium-conformance';

const TARGET = resolve(import.meta.dirname, '..', 'src', 'site', 'generated', 'sodium-manifest.ts');

const result = await runConformance();
const manifest = manifestOf(result);
writeFileSync(
	TARGET,
	`/** the ext-sodium names that passed the conformance gate; \`bun run gen:sodium-manifest\` writes it */\n` +
		`export const SODIUM_MANIFEST = ${JSON.stringify(manifest, null, '\t')} as const;\n`
);
spawnSync('bunx', ['prettier', '--write', TARGET], { stdio: 'inherit' });
console.log(
	`${result.cases} cases; ${manifest.functions.length} functions, ${manifest.constants.length} constants, ${manifest.classes.length} classes`
);
