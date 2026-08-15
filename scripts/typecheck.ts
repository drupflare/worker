import { spawnSync } from 'node:child_process';

/**
 * Runs the three TypeScript programs and fails on this repo's errors only.
 */

// per-DIRECTORY rather than `tsconfig.<name>.json` at the root, because an editor resolves a file's
// project by walking up from the file. A root-level `tsconfig.tests.json` is invisible to that walk,
// so every file under `tests/` fell back to defaults and `node:` imports stopped resolving in the IDE
// while the CLI stayed green
const PROJECTS = ['tsconfig.json', 'scripts/tsconfig.json', 'tests/tsconfig.json'];

let ours = 0;
let theirs = 0;

for (const project of PROJECTS) {
	const run = spawnSync('bunx', ['tsc', '-p', project, '--noEmit'], { encoding: 'utf8' });
	const lines = `${run.stdout ?? ''}${run.stderr ?? ''}`
		.split('\n')
		.filter((l) => /error TS[0-9]+/.test(l));
	const mine = lines.filter((l) => !l.startsWith('node_modules/'));
	const dependency = lines.filter((l) => l.startsWith('node_modules/'));
	ours += mine.length;
	theirs += dependency.length;
	for (const line of mine) console.log(line);
	for (const line of dependency) console.log(`[dependency, not fatal] ${line}`);
}

console.log(
	`typecheck: ${ours} error${ours === 1 ? '' : 's'} in this repo` +
		(theirs ? `, ${theirs} inside node_modules (not fatal)` : '')
);
process.exit(ours === 0 ? 0 : 1);
