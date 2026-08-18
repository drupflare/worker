import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	ARTIFACTS,
	classify,
	ensure,
	producerIsRunnable,
	renderReport,
	type Artifact
} from '../../scripts/ensure-artifacts.ts';

/**
 * The preflight that produces what a measuring lane reads, and the producer that used to die.
 *
 * A metrics run on a clean checkout reported 8 of 17 checks skipped and still said PASS. Two causes:
 * `bun run hydrate` was reaching for a release payload that does not exist and falling back to a
 * source build, and that build died in `assets:sql` with `table sqlite_master may not be modified`
 * -- node 24.19 turns `SQLITE_DBCONFIG_DEFENSIVE` on by default and the 24.11 on this machine does
 * not, so it failed only on the runner.
 *
 * Node lane: it runs `node` for the sqlite half and reads the filesystem for the rest.
 */

const ROOT = resolve(import.meta.dirname, '../..');

const temps: string[] = [];
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ensure-spec-'));
	temps.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function artifact(over: Partial<Artifact> = {}): Artifact {
	return {
		name: 'thing',
		path: 'out/thing.json',
		neededBy: 'a metric',
		producer: { script: 'make:thing', needs: ['in/source'], without: 'in/source is absent' },
		otherwise: 'a release payload',
		...over
	};
}

describe('the producer that only failed on the runner', () => {
	it('rewrites the NOCASE_UTF8 collations on whatever node is running', () => {
		// the regression test for `table sqlite_master may not be modified`; it passes or fails
		// purely on the node the lane runs under, which is the thing that differed
		const out = join(fixture(), 'drupal-sql');
		const printed = execFileSync(
			'node',
			['scripts/pack-sql.ts', 'assets/drupal/site.sqlite', out],
			{ cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }
		);
		expect(printed).toMatch(/(\d+) collations rewritten/);
		expect(Number(printed.match(/(\d+) collations rewritten/)![1])).toBeGreaterThan(0);
		expect(existsSync(join(out, 'manifest.json'))).toBe(true);

		const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
			totals: Record<string, number>;
		};
		expect(manifest.totals.rows).toBeGreaterThan(0);
	});
});

describe('what the preflight decides', () => {
	it('reports an artifact already on disk without running anything', () => {
		const root = fixture();
		mkdirSync(join(root, 'out'), { recursive: true });
		writeFileSync(join(root, 'out/thing.json'), '{}');
		expect(classify(root, artifact())).toMatchObject({ state: 'present' });
	});

	it('plans the producer when its inputs are there', () => {
		const root = fixture();
		mkdirSync(join(root, 'in'), { recursive: true });
		writeFileSync(join(root, 'in/source'), 'x');
		expect(classify(root, artifact())).toMatchObject({
			state: 'produced',
			detail: 'bun run make:thing'
		});
	});

	it('names the missing input rather than trying and failing', () => {
		expect(classify(fixture(), artifact())).toMatchObject({
			state: 'unproducible',
			detail: 'in/source is absent'
		});
	});

	it('says where an artifact with no producer comes from', () => {
		expect(classify(fixture(), artifact({ producer: null }))).toMatchObject({
			state: 'unproducible',
			detail: 'a release payload'
		});
	});

	it('treats a producer with no inputs as always runnable', () => {
		expect(producerIsRunnable(fixture(), artifact().producer!)).toBe(false);
		expect(producerIsRunnable(fixture(), { script: 'x', needs: [], without: '' })).toBe(true);
	});
});

describe('the shipped artifact list', () => {
	it('covers every input a collector reads, and names what needs each', () => {
		expect(ARTIFACTS.map((a) => a.name)).toEqual([
			'interpreter',
			'driver',
			'drupal-sql',
			'drupal-pf'
		]);
		for (const a of ARTIFACTS) {
			expect(a.neededBy, `${a.name} does not say what needs it`).not.toBe('');
			expect(a.otherwise, `${a.name} does not say where else it comes from`).not.toBe('');
		}
	});

	it('keeps drupal-sql producible, because site.sqlite is tracked', () => {
		// the one that CI was skipping; its input is in the repository, so a clean checkout can
		// always make it and a skipped indexAudit means something else broke
		const sql = ARTIFACTS.find((a) => a.name === 'drupal-sql')!;
		expect(sql.producer?.script).toBe('assets:sql');
		expect(sql.producer?.needs).toEqual(['assets/drupal/site.sqlite']);
		expect(existsSync(join(ROOT, 'assets/drupal/site.sqlite'))).toBe(true);
	});

	it('leaves drupal-pf without a producer, because nothing here reproduces the trim', () => {
		expect(ARTIFACTS.find((a) => a.name === 'drupal-pf')?.producer).toBeNull();
	});

	it('resolves the real checkout without running a producer under --dry-run', () => {
		const results = ensure(ROOT, { dryRun: true });
		expect(results).toHaveLength(ARTIFACTS.length);
		for (const r of results) expect(r.state).not.toBe('failed');
	});
});

describe('the report a lane appends', () => {
	it('states every artifact and counts what could not be made', () => {
		const report = renderReport([
			{ name: 'interpreter', state: 'present', detail: '.interp/php8.5.wasm' },
			{ name: 'drupal-pf', state: 'unproducible', detail: 'a release payload' }
		]);
		expect(report).toContain('| `interpreter` | present |');
		expect(report).toContain('1 artifact(s) could not be produced here');
		expect(report).toContain('rather than as a zero');
	});

	it('says nothing about missing artifacts when none are', () => {
		const report = renderReport([{ name: 'driver', state: 'produced', detail: 'ok' }]);
		expect(report).not.toContain('could not be produced');
	});
});
