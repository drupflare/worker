/**
 * Writes `src/site/generated/gd-manifest.ts` from a run of the drupflare differential.
 *
 *   php tests/gd-differential.php --json=run.json     (in the drupflare module, on PHP 8.3 and 8.4)
 *   bun scripts/gen-gd-manifest.ts run-8.3.json run-8.4.json
 *
 * A function enters the manifest when every run has at least one row for it, none FAIL, and every
 * row is PASS or REFUSED. A refusal is allowed because the shim answers false and records a
 * degradation, which the CMS call sites handle as a failed write.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GD_API } from '../src/site/shims/gd-surface';

type Row = { fn: string; status: string };

const runs = process.argv.slice(2).map((path) => {
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as { results: Row[] };
	return parsed.results;
});
if (runs.length === 0) throw new Error('give the differential JSON of at least one run');

const passes = (rows: Row[], fn: string): boolean => {
	const mine = rows.filter((r) => r.fn === fn);
	return mine.length > 0 && mine.every((r) => r.status === 'PASS' || r.status === 'REFUSED');
};

const functions = GD_API.functions.filter((fn) => runs.every((rows) => passes(rows, fn)));
const list = (names: readonly string[]) => names.map((n) => `\t\t'${n}'`).join(',\n');

writeFileSync(
	new URL('../src/site/generated/gd-manifest.ts', import.meta.url),
	`/** the gd names that passed the differential; \`bun scripts/gen-gd-manifest.ts\` writes it */
export const GD_MANIFEST = {
	functions: [
${list(functions)}
	],
	constants: [
${list(GD_API.constants)}
	],
	classes: ['GdImage']
};
`
);
console.log(`${functions.length} of ${GD_API.functions.length} functions pass`);
