import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appendToList, classify } from '../../scripts/find-artifact-specs.ts';

const root = '/repo';
const file = (name: string, status: string, failures: string[] = []) => ({
	name: `${root}/${name}`,
	status,
	assertionResults: failures.map((m) => ({ status: 'failed', failureMessages: [m] }))
});

describe('finding the specs a clean checkout cannot run', () => {
	it('separates a missing pack from a real failure and ignores passing files', () => {
		const out = classify(
			{
				testResults: [
					file('tests/integration/a.spec.ts', 'failed', [
						'Error: per-file pack not reachable: core.pf.json 404'
					]),
					file('tests/integration/b.spec.ts', 'failed', ['no such table: cache_render']),
					file('tests/integration/c.spec.ts', 'failed', ['expected 2 to be 3']),
					file('tests/integration/d.spec.ts', 'passed')
				]
			},
			root
		);
		expect(out).toEqual({
			pack: ['tests/integration/a.spec.ts', 'tests/integration/b.spec.ts'],
			other: ['tests/integration/c.spec.ts']
		});
	});

	it('appends to the real list so the result still parses and carries every entry', () => {
		const source = readFileSync('tests/artifact-specs.ts', 'utf8');
		const next = appendToList(source, ['tests/integration/x.spec.ts'], '2026-09-26');
		const list = next.slice(next.indexOf('ARTIFACT_SPECS = ['), next.indexOf('\n];'));
		const entries = [...list.matchAll(/'([^']+\.spec\.ts)'/g)].map((m) => m[1]);
		const before = [
			...source
				.slice(source.indexOf('ARTIFACT_SPECS = ['), source.indexOf('\n];'))
				.matchAll(/'([^']+\.spec\.ts)'/g)
		].map((m) => m[1]);
		expect(entries).toEqual([...before, 'tests/integration/x.spec.ts']);
		// every entry but the last ends in a comma, which a missing one would break
		expect(list.trimEnd().endsWith("'tests/integration/x.spec.ts'")).toBe(true);
		expect(list).toContain(`'${before.at(-1)}',`);
	});
});
