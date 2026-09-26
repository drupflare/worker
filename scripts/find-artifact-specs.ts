import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { ARTIFACT_SPECS } from '../tests/artifact-specs.ts';

/**
 * Runs the workers gate the way a clean checkout does and names the specs that need the pack.
 *
 *   bun run check:artifact-specs           # report
 *   bun run check:artifact-specs --write   # also append them to tests/artifact-specs.ts
 *
 * A dev machine has `assets/drupal-pf/core.pf.json`, so a spec that reaches a real render passes
 * here and fails on CI with `per-file pack not reachable`. This parks the pack index and `.dev.vars`
 * (CI has neither), runs the lane, restores both whatever happens, and reports every failing file:
 * the pack's signature marks one that belongs in `ARTIFACT_SPECS`, anything else is a real failure.
 */

const ROOT = resolve(import.meta.dirname, '..');
const PARKED = ['assets/drupal-pf/core.pf.json', '.dev.vars'];
const LIST = 'tests/artifact-specs.ts';

/** what a render reports on a checkout with no pack, directly or through the tables it never got */
export const PACK_SIGNATURE = /per-file pack not reachable|no such table: cache_/;

type Report = {
	testResults: {
		name: string;
		status: string;
		message?: string;
		assertionResults?: { status: string; failureMessages?: string[] }[];
	}[];
};

/** failing spec files from a vitest JSON report, split by whether the pack is what they missed */
export function classify(report: Report, root: string): { pack: string[]; other: string[] } {
	const pack: string[] = [];
	const other: string[] = [];
	for (const file of report.testResults) {
		const failed = file.status === 'failed';
		if (!failed) continue;
		const messages = [
			file.message ?? '',
			...(file.assertionResults ?? []).flatMap((a) => a.failureMessages ?? [])
		].join('\n');
		(PACK_SIGNATURE.test(messages) ? pack : other).push(relative(root, file.name));
	}
	return { pack: pack.sort(), other: other.sort() };
}

/** the list's source with the files appended before its closing bracket, under a dated comment */
export function appendToList(source: string, files: readonly string[], date: string): string {
	const start = source.indexOf('export const ARTIFACT_SPECS = [');
	const close = source.indexOf('\n];', start);
	if (start < 0 || close < 0) throw new Error(`${LIST} has no ARTIFACT_SPECS array`);
	const body = source.slice(0, close).replace(/'\s*$/, "',");
	const lines = [
		`\t// joined ${date}, found by \`bun run check:artifact-specs\`: each reaches a real render`,
		...files.map((f, i) => `\t'${f}'${i < files.length - 1 ? ',' : ''}`)
	];
	return `${body}\n${lines.join('\n')}${source.slice(close)}`;
}

if (import.meta.main) {
	const write = process.argv.includes('--write');
	const stash = mkdtempSync(join(tmpdir(), 'artifact-specs-'));
	const out = join(stash, 'report.json');
	const moved: string[] = [];
	const restore = () => {
		for (const p of moved.splice(0))
			renameSync(join(stash, p.replaceAll('/', '_')), join(ROOT, p));
	};
	process.on('SIGINT', () => {
		restore();
		process.exit(130);
	});
	try {
		for (const p of PARKED) {
			if (!existsSync(join(ROOT, p))) continue;
			// a copy first: the pack index arrives only from a release payload, so a lost rename is final
			copyFileSync(join(ROOT, p), join(stash, `${p.replaceAll('/', '_')}.copy`));
			renameSync(join(ROOT, p), join(stash, p.replaceAll('/', '_')));
			moved.push(p);
		}
		spawnSync(
			'bunx',
			['vitest', 'run', '--project=workers', '--reporter=json', `--outputFile=${out}`],
			{ cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }
		);
	} finally {
		restore();
	}
	if (!existsSync(out)) {
		console.error('vitest wrote no report');
		process.exit(1);
	}
	const { pack, other } = classify(JSON.parse(readFileSync(out, 'utf8')) as Report, ROOT);
	const missing = pack.filter((f) => !ARTIFACT_SPECS.includes(f));
	for (const f of missing) console.log(`needs the pack  ${f}`);
	for (const f of other) console.log(`fails anyway    ${f}`);
	if (missing.length && write) {
		const path = join(ROOT, LIST);
		const date = new Date().toISOString().slice(0, 10);
		writeFileSync(path, appendToList(readFileSync(path, 'utf8'), missing, date));
		console.log(`appended ${missing.length} to ${LIST}`);
	}
	console.log(missing.length || other.length ? '' : 'every pack-dependent spec is listed');
	process.exit(other.length || (missing.length && !write) ? 1 : 0);
}
