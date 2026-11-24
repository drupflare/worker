/**
 * Records what anachron's PHP rewriter does to each case in `tests/fixtures/return-types/cases.json`.
 *
 *   bun scripts/gen/return-type-goldens.ts          rewrite expected.json
 *   bun scripts/gen/return-type-goldens.ts --check  fail if expected.json disagrees with PHP
 *
 * The checkout is `ANACHRON_DIR`, then `../anachron`. The spec holds the TypeScript rewrite to
 * these answers, so they come from the PHP class and are never edited by hand.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { anachronCheckout } from './return-types';

const FIXTURES = resolve(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'return-types');

/** one input the rewrite is run on */
export type GoldenCase = {
	name: string;
	source: string;
	index?: Record<string, { extends: string | null; implements: string[] }>;
};

/** what the PHP rewriter answered for a case */
export type Golden = {
	name: string;
	expected: string;
	refusals: { class: string; method: string; line: number; reason: string }[];
};

/** runs the PHP rewriter over the cases */
export function phpGoldens(dir: string, cases: readonly GoldenCase[]): Golden[] {
	const script = `<?php
require ${JSON.stringify(join(dir, 'src', 'Php', 'ReturnTypeRewriter.php'))};
require ${JSON.stringify(join(dir, 'src', 'Drupal', 'CoreReturnTypes.php'))};
$cases = json_decode(stream_get_contents(STDIN), true);
$rewriter = Drupflare\\Anachron\\Drupal\\CoreReturnTypes::rewriter();
$out = [];
foreach ($cases as $case) {
	$refusals = [];
	$code = $rewriter->rewrite($case['source'], $case['index'] ?? [], $refusals);
	$out[] = ['name' => $case['name'], 'expected' => $code, 'refusals' => $refusals];
}
echo json_encode($out);`;
	const work = mkdtempSync(join(tmpdir(), 'cfw-rt-goldens-'));
	try {
		const file = join(work, 'run.php');
		writeFileSync(file, script);
		const run = spawnSync('php', [file], { input: JSON.stringify(cases), encoding: 'utf8' });
		if (run.status !== 0)
			throw new Error(`php exited ${run.status}: ${run.stderr.slice(0, 300)}`);
		return JSON.parse(run.stdout) as Golden[];
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** the cases the spec runs */
export function readCases(): GoldenCase[] {
	return JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as GoldenCase[];
}

if (import.meta.main) {
	const dir = anachronCheckout();
	if (dir === undefined) {
		console.error('no anachron checkout; set ANACHRON_DIR or put one beside the worker');
		process.exit(2);
	}
	const text = `${JSON.stringify(phpGoldens(dir, readCases()), null, '\t')}\n`;
	const target = join(FIXTURES, 'expected.json');
	if (process.argv.includes('--check')) {
		if (readFileSync(target, 'utf8') !== text) {
			console.error('expected.json disagrees with the PHP rewriter');
			process.exit(1);
		}
		console.log('expected.json matches the PHP rewriter');
	} else {
		writeFileSync(target, text);
		console.log(`wrote ${target}`);
	}
}
