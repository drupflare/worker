import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FREE_CEILING } from '../../scripts/measure/bundle-size';
import {
	collect,
	collectDriverPack,
	collectFreeEnvelope,
	collectIndexAudit,
	collectPackShape,
	countSpecFiles,
	isSkipped,
	LIST_ENV,
	type BundleMetric,
	type MetricsDocument
} from '../../scripts/measure/collect-metrics';
import {
	CHECKS,
	compare,
	interpret,
	nextBaseline,
	readPath,
	renderMarkdown,
	resolveBaseline,
	type BaselineValues
} from '../../scripts/measure/metrics-gate';

/**
 * The Class A metrics pipeline: collect, compare, fail.
 *
 * Two properties matter more than the individual numbers. The document must be REPRODUCIBLE -- two
 * runs on one checkout produce identical bytes, which is what makes a diff a change rather than a
 * clock -- and the gate must be ABLE TO FAIL, which is asserted here by planting each class of
 * regression and by running the CLI to a non-zero exit.
 *
 * Nothing here asserts a duration, and nothing here may: see `docs/measurement-classes.md`.
 */

const ROOT = resolve(import.meta.dirname, '../..');

const scratch = mkdtempSync(join(tmpdir(), 'cfw-metrics-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** a fully populated document, so every check has something to evaluate */
function fixture(): MetricsDocument {
	return {
		schema: 1,
		commit: 'a'.repeat(40),
		metrics: {
			bundle: {
				gzippedBytes: 2_879_099,
				ceiling: FREE_CEILING,
				headroom: FREE_CEILING - 2_879_099,
				fits: true,
				wrangler: '4.120.0'
			},
			indexAudit: {
				tables: 69,
				explicitIndexes: 177,
				implicitIndexes: 51,
				dataRows: 1342,
				chargedRows: 4447,
				indexRows: 2995,
				indexShare: 0.6734877445468855,
				minChargePerRow: 2,
				heaviest: [{ table: 'router', chargePerRow: 4, chargedRows: 1676 }]
			},
			freeEnvelope: {
				visitsPerMonth: 3_000_000,
				dynamicFraction: 0.01,
				servingViewsPerDay: 100_000,
				servingBoundBy: 'worker',
				regenerationsPerDay: 1052,
				regenerationBoundBy: 'do',
				windowedRegenerationsPerDay: 10869,
				verdict: 'fits'
			},
			packShape: {
				generation: '4b26ff1a3e7401a3',
				chunks: 79,
				statements: 1669,
				tableDdl: 69,
				indexDdl: 177,
				rowStatements: 1423,
				rows: 1342,
				payloadBytes: 3_958_281,
				chunkBytes: 4_890_394,
				sourceBytes: 7_585_792
			},
			driverPack: { files: 52, bytes: 300_677, sha256: 'f'.repeat(64) },
			tests: { specFiles: { workers: 50, node: 19, e2e: 2 }, cases: { workers: 1453 } }
		}
	};
}

/** the baseline the fixture was recorded from, so an unmodified fixture passes every check */
function fixtureBaseline(): BaselineValues {
	return nextBaseline(fixture(), {});
}

describe('the collector produces only reproducible figures', () => {
	it('carries no timestamp, so two runs on one checkout are byte-identical', async () => {
		const first = await collect(ROOT, { bundle: false, vitest: false });
		const second = await collect(ROOT, { bundle: false, vitest: false });
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		// the guard is the property, not the absence of one key spelling
		expect(JSON.stringify(first)).not.toMatch(/generatedAt|timestamp|durationMs|elapsed/i);
	});

	it('names every metric even when it cannot produce one', async () => {
		const doc = await collect(ROOT, { bundle: false, vitest: false });
		expect(Object.keys(doc.metrics).sort()).toEqual([
			'bundle',
			'driverPack',
			'freeEnvelope',
			'indexAudit',
			'packShape',
			'tests'
		]);
		expect(isSkipped(doc.metrics.bundle)).toBe(true);
	});

	it('reports an absent input as a reason rather than a zero', async () => {
		const pack = collectPackShape(scratch);
		const driver = collectDriverPack(scratch);
		const audit = await collectIndexAudit(scratch);
		for (const metric of [pack, driver, audit]) {
			expect(isSkipped(metric)).toBe(true);
			// a zero would be compared against a baseline and pass a noDecrease check
			expect(JSON.stringify(metric)).not.toMatch(/:\s*0/);
		}
		expect(isSkipped(pack) && pack.skipped).toMatch(/bun run assets:sql/);
		expect(isSkipped(driver) && driver.skipped).toMatch(/bun run assets:driver/);
	});

	it('scores the envelope from constants, so it can never skip', () => {
		const env = collectFreeEnvelope();
		expect(env.servingViewsPerDay).toBe(100_000);
		expect(env.servingBoundBy).toBe('worker');
		// the windowed ceiling is the one RULE 0b quotes, and it is ~7x the cold one
		expect(env.windowedRegenerationsPerDay).toBeGreaterThan(env.regenerationsPerDay);
	});

	it('counts spec files off the filesystem rather than off a run', () => {
		expect(countSpecFiles(join(ROOT, 'tests/node'))).toBeGreaterThan(10);
		expect(countSpecFiles(join(scratch, 'nowhere'))).toBe(0);
	});
});

/**
 * The case count must be a property of the repository, not of the machine that ran the collector.
 *
 * `ARTIFACT_SPECS` drops the specs that need the pack, so `vitest list` enumerated 1,862 cases in
 * CI against 2,066 on a checkout that has one. Nothing noticed while the list held still; the day
 * two files joined it the gate read 21 tests as deleted and failed a commit that deleted none.
 *
 * Both cases below evaluate the config from a directory where every artifact path is unreachable,
 * which is the CI condition. The control is what makes the second assertion mean anything: without
 * it, a config that never excluded anything would pass.
 */
describe('the case count does not move with what this machine has on disk', () => {
	const CONFIG = join(ROOT, 'vitest.config.ts');

	function excludeWithNoArtifacts(env: Record<string, string> = {}): string[] {
		const read = `console.log(JSON.stringify((await import(${JSON.stringify(CONFIG)})).default.test.projects[0].test.exclude))`;
		const out = execFileSync('bun', ['-e', read], {
			cwd: scratch,
			encoding: 'utf8',
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return JSON.parse(out) as string[];
	}

	it('CONTROL: a checkout with no artifacts really does drop spec files', () => {
		expect(excludeWithNoArtifacts().length).toBeGreaterThan(15);
	});

	it('collects all of them under exactly the environment the collector runs', () => {
		expect(excludeWithNoArtifacts({ ...LIST_ENV })).toEqual([]);
	});
});

describe('the gate reads a document the way a reviewer would', () => {
	it('resolves every checked path in a fully populated document', () => {
		const doc = fixture();
		for (const check of CHECKS) {
			// a typo in a CHECK path would otherwise report `skipped` forever and gate nothing
			expect(readPath(doc, check.path), `${check.path} resolves to nothing`).toBeDefined();
		}
	});

	it('reads a skipped branch as absent rather than as zero', () => {
		const doc = fixture();
		doc.metrics.bundle = { skipped: '.interp/ is absent' };
		expect(readPath(doc, 'bundle.gzippedBytes')).toBeUndefined();
	});

	it('passes an unmodified document against the baseline it was recorded from', () => {
		const result = compare(fixture(), fixtureBaseline());
		expect(result.ok).toBe(true);
		expect(result.failed).toBe(0);
		expect(result.evaluated).toBe(CHECKS.length);
	});
});

describe('the gate FAILS on a planted regression', () => {
	it('fails hard when the bundle crosses the free ceiling', () => {
		const doc = fixture();
		const bundle = doc.metrics.bundle as { gzippedBytes: number };
		bundle.gzippedBytes = FREE_CEILING + 1;
		const result = compare(doc, fixtureBaseline());
		expect(result.ok).toBe(false);
		const ceiling = result.results.find((r) => r.kind === 'ceiling');
		expect(ceiling?.verdict).toBe('fail');
		expect(ceiling?.detail).toBe('over the ceiling by 1');
	});

	it('fails on bundle drift that still fits, before the release that stops fitting', () => {
		const doc = fixture();
		(doc.metrics.bundle as { gzippedBytes: number }).gzippedBytes = 2_879_099 + 32_769;
		const result = compare(doc, fixtureBaseline());
		expect(result.ok).toBe(false);
		expect(result.results.filter((r) => r.verdict === 'fail')).toHaveLength(1);
		expect(result.results.find((r) => r.verdict === 'fail')?.kind).toBe('maxIncrease');
	});

	it('fails on ONE added index, because an index is a write multiplier', () => {
		const doc = fixture();
		const audit = doc.metrics.indexAudit as { explicitIndexes: number };
		audit.explicitIndexes = 178;
		const result = compare(doc, fixtureBaseline());
		expect(result.ok).toBe(false);
		expect(result.results.find((r) => r.path === 'indexAudit.explicitIndexes')?.verdict).toBe(
			'fail'
		);
	});

	it('fails on a deleted spec file, which is the cheapest way to make a suite green', () => {
		const doc = fixture();
		doc.metrics.tests.specFiles.node = 18;
		const result = compare(doc, fixtureBaseline());
		expect(result.ok).toBe(false);
		expect(result.results.find((r) => r.path === 'tests.specFiles.node')?.detail).toMatch(
			/below the allowed 19/
		);
	});

	it('fails when the product verdict itself changes', () => {
		const doc = fixture();
		doc.metrics.freeEnvelope.verdict = 'regeneration-over';
		const result = compare(doc, fixtureBaseline());
		expect(result.ok).toBe(false);
		expect(result.results.find((r) => r.kind === 'equals')?.detail).toBe(
			'expected fits, got regeneration-over'
		);
	});

	it('stays green inside a tolerance and red one row outside it', () => {
		// 4,447 at +2% allows 4,535.94, so 4,535 is the last passing integer
		const inside = fixture();
		(inside.metrics.indexAudit as { chargedRows: number }).chargedRows = 4535;
		expect(compare(inside, fixtureBaseline()).ok).toBe(true);

		const outside = fixture();
		(outside.metrics.indexAudit as { chargedRows: number }).chargedRows = 4536;
		expect(compare(outside, fixtureBaseline()).ok).toBe(false);
	});

	it('fails a run where every checked metric skipped, which proves nothing', () => {
		const doc = fixture();
		doc.metrics.bundle = { skipped: 'no .interp/' };
		doc.metrics.indexAudit = { skipped: 'no pack' };
		doc.metrics.packShape = { skipped: 'no pack' };
		doc.metrics.driverPack = { skipped: 'no driver.json' };
		// the artifact-derived checks alone, so nothing constant is left to carry the run
		const artifactChecks = CHECKS.filter(
			(c) => !c.path.startsWith('tests.') && !c.path.startsWith('freeEnvelope.')
		);
		const vacuous = compare(doc, fixtureBaseline(), artifactChecks);
		expect(vacuous.evaluated).toBe(0);
		expect(vacuous.skipped).toBe(artifactChecks.length);
		expect(vacuous.ok).toBe(false);
		expect(vacuous.reason).toMatch(/proves nothing/);
	});

	it('does not fail a metric that has no baseline yet', () => {
		const result = compare(fixture(), {});
		expect(result.results.every((r) => r.verdict !== 'fail')).toBe(true);
		// ceiling and equals hold without a baseline, so the run is still worth something
		expect(result.evaluated).toBeGreaterThan(0);
		expect(result.ok).toBe(true);
	});
});

describe('the baseline refresh cannot erase what it could not measure', () => {
	it('keeps a recorded value when the current run skipped that metric', () => {
		const doc = fixture();
		doc.metrics.bundle = { skipped: '.interp/ is absent' };
		const next = nextBaseline(doc, fixtureBaseline());
		expect(next['bundle.gzippedBytes']).toBe(2_879_099);
		expect(next['packShape.rows']).toBe(1342);
	});

	it('records only the paths the checks name', () => {
		const next = nextBaseline(fixture(), {});
		expect(Object.keys(next).sort()).toEqual(
			[...new Set(CHECKS.map((c) => c.path))].sort((a, b) => (a < b ? -1 : 1))
		);
	});
});

describe('the rendered summary', () => {
	it('shows the verdict, the rule and the skipped metrics with their reason', () => {
		const doc = fixture();
		doc.metrics.packShape = { skipped: 'assets/drupal-sql/manifest.json is absent' };
		const markdown = renderMarkdown(doc, compare(doc, fixtureBaseline()));
		expect(markdown).toContain('| Metric | Baseline | Current | Delta | Rule | Verdict |');
		expect(markdown).toContain('`packShape.rows`');
		expect(markdown).toContain('assets/drupal-sql/manifest.json is absent');
		expect(markdown).toContain('<= 3,145,728');
		// the step summary must never carry a timing FIGURE; the header names cpuTime,
		// to say where the one trustworthy absolute comes from
		expect(markdown).not.toMatch(/\d\s*(ms|s|ms\/|seconds)\b/);
	});

	it('says FAIL in the heading line when something failed', () => {
		const doc = fixture();
		(doc.metrics.bundle as { gzippedBytes: number }).gzippedBytes = FREE_CEILING + 1;
		expect(renderMarkdown(doc, compare(doc, fixtureBaseline()))).toContain('**FAIL**');
	});

	it('carries the reading, so a pull request comment states consequences', () => {
		const doc = fixture();
		expect(renderMarkdown(doc, compare(doc, fixtureBaseline()))).toContain('### Reading');
	});
});

describe('the reading a reviewer gets instead of a row', () => {
	it('states the headroom, both ceilings, the index share and the suite counts', () => {
		const doc = fixture();
		const reading = interpret(doc, compare(doc, fixtureBaseline())).join('\n');
		expect(reading).toContain(`leaving ${(FREE_CEILING - 2_879_099).toLocaleString()} under`);
		expect(reading).toContain('100,000 views/day bound by Worker requests');
		expect(reading).toContain('1,052 regenerations/day bound by Durable Object requests');
		expect(reading).toContain('10,869 windowed');
		expect(reading).toContain('67.3% of every stored row is index maintenance');
		expect(reading).toContain('1,342 rows in 79 chunks');
		expect(reading).toContain('50 workers spec files (1,453 cases)');
	});

	it('quotes the delta only where the metric moved', () => {
		const doc = fixture();
		(doc.metrics.bundle as { gzippedBytes: number }).gzippedBytes = 2_879_099 + 4096;
		const reading = interpret(doc, compare(doc, fixtureBaseline())).join('\n');
		expect(reading).toContain('+4,096 against the baseline');
		expect(reading).not.toContain('0 against the baseline');
	});

	it('names the deploy failure rather than a headroom of minus something', () => {
		const doc = fixture();
		Object.assign(doc.metrics.bundle as BundleMetric, {
			gzippedBytes: FREE_CEILING + 1000,
			headroom: -1000,
			fits: false
		});
		const reading = interpret(doc, compare(doc, fixtureBaseline())).join('\n');
		expect(reading).toContain('1,000 OVER the ceiling');
		expect(reading).toContain('code: 10027');
	});

	it('drops the line for a metric that was not collected, rather than reading a zero', () => {
		const doc = fixture();
		doc.metrics.packShape = { skipped: 'assets/drupal-sql/manifest.json is absent' };
		doc.metrics.bundle = { skipped: 'wrangler produced no size line' };
		const reading = interpret(doc, compare(doc, fixtureBaseline())).join('\n');
		expect(reading).not.toContain('**Pack**');
		expect(reading).not.toContain('**Bundle**');
		expect(reading).toContain('**Free envelope**');
	});

	it('carries no duration, because no collected figure could support one', () => {
		const doc = fixture();
		const reading = interpret(doc, compare(doc, fixtureBaseline())).join('\n');
		expect(reading).not.toMatch(/\d\s*(ms|s|ms\/|seconds)\b/);
	});

	it('quotes a meter key it does not have words for, rather than inventing them', () => {
		const doc = fixture();
		(doc.metrics.freeEnvelope as { regenerationBoundBy: string }).regenerationBoundBy = 'kv';
		expect(interpret(doc, compare(doc, fixtureBaseline())).join('\n')).toContain('`kv`');
	});
});

describe('the baseline is another run, not a file anyone maintains', () => {
	it('reduces a master document to exactly the paths the checks name', () => {
		const resolved = resolveBaseline(fixture());
		expect(Object.keys(resolved.values).sort()).toEqual(
			[...new Set(CHECKS.map((c) => c.path))].sort((a, b) => (a < b ? -1 : 1))
		);
		expect(resolved.describe).toContain('aaaaaaa');
	});

	it('carries no value a master run could not measure, rather than a zero', () => {
		const master = fixture();
		master.metrics.bundle = { skipped: 'wrangler produced no size line' };
		const resolved = resolveBaseline(master);
		expect(resolved.values['bundle.gzippedBytes']).toBeUndefined();
		expect(resolved.values['packShape.rows']).toBe(1342);
	});

	it('judges nothing relative when no master run is reachable, and says so', () => {
		const resolved = resolveBaseline(null);
		expect(resolved.values).toEqual({});
		expect(resolved.describe).toContain('unjudged');

		// still not vacuous: the two absolute checks need no baseline at all
		const comparison = compare(fixture(), resolved.values);
		expect(comparison.evaluated).toBeGreaterThan(0);
		expect(
			comparison.results.filter((r) => r.verdict === 'no-baseline').length
		).toBeGreaterThan(0);
	});

	it('names the baseline in the summary, so a delta can be read at all', () => {
		const doc = fixture();
		const markdown = renderMarkdown(doc, compare(doc, {}), resolveBaseline(null).describe);
		expect(markdown).toContain('Baseline: nothing;');
	});
});

describe('the gate CLI', () => {
	/** runs the gate over a document, with another document standing in for the master run */
	function runGate(
		doc: MetricsDocument,
		opts: { master?: MetricsDocument | null; require?: boolean } = {}
	): { status: number; output: string } {
		const metrics = join(scratch, 'metrics.json');
		writeFileSync(metrics, JSON.stringify(doc));
		const args = ['scripts/measure/metrics-gate.ts', `--metrics=${metrics}`, '--summary='];
		if (opts.master !== null) {
			const master = join(scratch, 'master.json');
			writeFileSync(master, JSON.stringify(opts.master ?? fixture()));
			args.push(`--baseline-metrics=${master}`);
		} else {
			args.push(`--baseline-metrics=${join(scratch, 'absent.json')}`);
		}
		if (opts.require) args.push('--require-baseline');
		try {
			// --summary= keeps the subprocess from appending to a real GITHUB_STEP_SUMMARY
			const output = execFileSync('bun', args, {
				cwd: ROOT,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe']
			});
			return { status: 0, output };
		} catch (error) {
			const e = error as { status?: number; stdout?: string; stderr?: string };
			return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
		}
	}

	it('exits 0 on a clean document and 1 on a planted regression', () => {
		const clean = runGate(fixture());
		expect(clean.status, clean.output).toBe(0);

		const planted = fixture();
		(planted.metrics.indexAudit as { chargedRows: number }).chargedRows = 9999;
		const dirty = runGate(planted);
		expect(dirty.status).toBe(1);
		expect(dirty.output).toContain('metrics gate FAILED');
		expect(dirty.output).toContain('indexAudit.chargedRows');
	});

	it('compares against the master document rather than the checkout', () => {
		const master = fixture();
		(master.metrics.driverPack as { bytes: number }).bytes = 1000;
		// +10% of 1000 is 1100, and the fixture reports 300,677
		const over = runGate(fixture(), { master });
		expect(over.status).toBe(1);
		expect(over.output).toContain('driverPack.bytes');
	});

	it('fails when a baseline was required and none arrived', () => {
		const missing = runGate(fixture(), { master: null, require: true });
		expect(missing.status).toBe(1);
		expect(missing.output).toContain('carries no readable document');
	});

	it('passes thinly, and says so, when no baseline was required or found', () => {
		const thin = runGate(fixture(), { master: null });
		expect(thin.status, thin.output).toBe(0);
		expect(thin.output).toContain('Baseline: nothing;');
	});
});
