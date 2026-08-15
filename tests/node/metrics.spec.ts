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
	type MetricsDocument
} from '../../scripts/measure/collect-metrics';
import {
	CHECKS,
	compare,
	nextBaseline,
	readBaseline,
	readPath,
	renderMarkdown,
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
				windowedRegenerationsPerDay: 7575,
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
		// the step summary must never carry a timing FIGURE; the header names cpuTime on purpose,
		// to say where the one trustworthy absolute comes from
		expect(markdown).not.toMatch(/\d\s*(ms|s|ms\/|seconds)\b/);
	});

	it('says FAIL in the heading line when something failed', () => {
		const doc = fixture();
		(doc.metrics.bundle as { gzippedBytes: number }).gzippedBytes = FREE_CEILING + 1;
		expect(renderMarkdown(doc, compare(doc, fixtureBaseline()))).toContain('**FAIL**');
	});
});

describe('the shipped baseline', () => {
	it('records exactly the paths the checks name, so none of it is dead weight', () => {
		const shipped = readBaseline(join(ROOT, 'metrics/baseline.json'));
		expect(Object.keys(shipped.values).sort()).toEqual(
			[...new Set(CHECKS.map((c) => c.path))].sort((a, b) => (a < b ? -1 : 1))
		);
	});

	it('holds a bundle figure that fits the ceiling it is gated against', () => {
		const shipped = readBaseline(join(ROOT, 'metrics/baseline.json'));
		expect(shipped.values['bundle.gzippedBytes']).toBeLessThanOrEqual(FREE_CEILING);
	});
});

describe('the gate CLI', () => {
	/** runs the gate over a document and a baseline written to scratch, so the shipped one is untouched */
	function runGate(doc: MetricsDocument): { status: number; output: string } {
		const metrics = join(scratch, 'metrics.json');
		const baseline = join(scratch, 'baseline.json');
		writeFileSync(metrics, JSON.stringify(doc));
		writeFileSync(baseline, JSON.stringify({ schema: 1, values: fixtureBaseline() }));
		try {
			// --summary= keeps the subprocess from appending to a real GITHUB_STEP_SUMMARY
			const output = execFileSync(
				'bun',
				[
					'scripts/measure/metrics-gate.ts',
					`--metrics=${metrics}`,
					`--baseline=${baseline}`,
					'--summary='
				],
				{ cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
			);
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
});
