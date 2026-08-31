/**
 * Class A metrics: the numbers a shared CI runner is allowed to produce.
 *
 * ```sh
 * bun scripts/measure/collect-metrics.ts                       # everything, to stdout
 * bun scripts/measure/collect-metrics.ts --out=metrics.json    # and to a file
 * bun scripts/measure/collect-metrics.ts --no-bundle --no-vitest
 * ```
 *
 * EVERY FIGURE HERE IS A COUNT OR A BYTE, and no clock is read. That is a constraint on what may be
 * collected, not a style preference: RULE 0 in `CLAUDE.md` says an absolute CPU figure comes only
 * from `cpuTime` in `wrangler tail` on a deployed worker, in-PHP `microtime()` returns 0 on the edge,
 * and a 400-600 ms bimodality has been reported on the same object. A duration measured on a shared
 * runner would be a plausible wrong number, which is the failure mode this project has paid for five
 * times. `docs/measurement-classes.md` is the four-class split and says which instrument owns what.
 *
 * The document carries no timestamp for the same reason: two runs on one commit must produce
 * identical bytes, so a diff is a real change rather than a clock. Run metadata carries the time.
 *
 * A metric whose inputs are absent is reported as `{ skipped: "<why>" }` -- never omitted, never
 * zero. A zero would be gated against a baseline and pass.
 *
 * @see scripts/measure/metrics-gate.ts for the half that judges these against a baseline
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ceilingVerdict, parseWranglerGzipBytes } from '../release-payload';
import { FREE_CEILING } from './bundle-size';
import { DEFAULT_MIX, envelope, scoreWorkload } from './free-envelope';
import { auditSchema, loadPack } from './index-audit';

/** a metric whose inputs were not present, carrying the reason rather than a zero */
export type Skipped = { skipped: string };

/** every metric is its value or an honest refusal to produce one */
export type Metric<T> = T | Skipped;

export function isSkipped(value: unknown): value is Skipped {
	return typeof value === 'object' && value !== null && 'skipped' in value;
}

export type BundleMetric = {
	/** what `wrangler deploy --dry-run` printed, converted from KiB; the figure to quote */
	gzippedBytes: number;
	ceiling: number;
	headroom: number;
	fits: boolean;
	/** the compressor is wrangler's, so its version is part of the input to the number */
	wrangler: string;
};

export type IndexAuditMetric = {
	tables: number;
	explicitIndexes: number;
	implicitIndexes: number;
	dataRows: number;
	chargedRows: number;
	indexRows: number;
	/** the fraction of every stored row that is index maintenance rather than data */
	indexShare: number;
	minChargePerRow: number;
	heaviest: { table: string; chargePerRow: number; chargedRows: number }[];
};

export type FreeEnvelopeMetric = {
	visitsPerMonth: number;
	dynamicFraction: number;
	servingViewsPerDay: number;
	servingBoundBy: string;
	regenerationsPerDay: number;
	regenerationBoundBy: string;
	windowedRegenerationsPerDay: number;
	verdict: string;
};

export type PackShapeMetric = {
	/** the pack's content hash, so a silent regeneration is visible without diffing 79 chunks */
	generation: string;
	chunks: number;
	statements: number;
	tableDdl: number;
	indexDdl: number;
	rowStatements: number;
	rows: number;
	payloadBytes: number;
	chunkBytes: number;
	sourceBytes: number;
};

export type DriverPackMetric = {
	files: number;
	bytes: number;
	sha256: string;
};

export type TestsMetric = {
	specFiles: { workers: number; node: number; e2e: number };
	/** collected cases, which only the workers lane can produce deterministically */
	cases: Metric<{ workers: number }>;
};

export type MetricsDocument = {
	schema: 1;
	commit: string;
	metrics: {
		bundle: Metric<BundleMetric>;
		indexAudit: Metric<IndexAuditMetric>;
		freeEnvelope: FreeEnvelopeMetric;
		packShape: Metric<PackShapeMetric>;
		driverPack: Metric<DriverPackMetric>;
		tests: TestsMetric;
	};
};

/** the workload the envelope is scored against, matching what RULE 0b tells a reviewer to run */
export const ENVELOPE_WORKLOAD = { visitsPerMonth: 3_000_000, dynamicFraction: 0.01 } as const;

/**
 * Prices the deployed bundle against the free-plan ceiling.
 *
 * Runs the canonical config through `wrangler deploy --dry-run`, which uploads nothing and needs no
 * credential, then reads the figure wrangler PRINTS rather than gzipping the outdir locally --
 * `measureBundle()`'s own docblock says concatenation order and the zlib version move the local one.
 *
 * Deterministic given a pinned toolchain, which is why the wrangler version travels with the number:
 * a bump moves the compressor, and a moved compressor should be attributable rather than mysterious.
 */
export function collectBundle(root: string): Metric<BundleMetric> {
	const interp = join(root, '.interp');
	if (!existsSync(interp)) {
		return { skipped: '.interp/ is absent; run bun run hydrate or bun run build:wasm' };
	}
	const outdir = join(root, 'dist/metrics-dry-run');
	let printed: string;
	try {
		printed = execFileSync(
			'bunx',
			['wrangler', 'deploy', '-c', 'wrangler.jsonc', '--dry-run', '--outdir', outdir],
			{ cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }
		);
	} catch (error) {
		return { skipped: `wrangler dry-run failed: ${(error as Error).message.split('\n')[0]}` };
	}
	const gzippedBytes = parseWranglerGzipBytes(printed);
	if (gzippedBytes === undefined) return { skipped: 'wrangler printed no gzip figure' };

	const { fits, headroom } = ceilingVerdict(gzippedBytes);
	return { gzippedBytes, ceiling: FREE_CEILING, headroom, fits, wrangler: wranglerVersion(root) };
}

function wranglerVersion(root: string): string {
	try {
		const out = execFileSync('bunx', ['wrangler', '--version'], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return (out.match(/\d+\.\d+\.\d+/)?.[0] ?? out.trim()).trim();
	} catch {
		return 'unknown';
	}
}

/** what every index in the shipped schema costs on the meter that binds regeneration */
export async function collectIndexAudit(root: string): Promise<Metric<IndexAuditMetric>> {
	const dir = join(root, 'assets/drupal-sql');
	if (!existsSync(dir)) {
		return {
			skipped: 'assets/drupal-sql is absent; run bun run hydrate or bun run assets:sql'
		};
	}
	const audit = auditSchema(await loadPack(dir));
	return {
		tables: audit.totals.tables,
		explicitIndexes: audit.totals.explicitIndexes,
		implicitIndexes: audit.totals.implicitIndexes,
		dataRows: audit.totals.dataRows,
		chargedRows: audit.totals.chargedRows,
		indexRows: audit.totals.indexRows,
		indexShare: audit.totals.indexRows / audit.totals.chargedRows,
		minChargePerRow: audit.totals.minChargePerRow,
		heaviest: audit.perTable.slice(0, 5).map((t) => ({
			table: t.table,
			chargePerRow: t.chargePerRow,
			chargedRows: t.chargedRows
		}))
	};
}

/**
 * Both free-tier ceilings, from arithmetic over constants.
 *
 * The only metric here that can never skip, and the only one that measures a MODEL rather than an
 * artifact: it moves when someone edits a quota or a rows-per-fill figure, which is exactly the edit
 * that should not pass unnoticed.
 */
export function collectFreeEnvelope(): FreeEnvelopeMetric {
	const scored = scoreWorkload(
		ENVELOPE_WORKLOAD.visitsPerMonth,
		ENVELOPE_WORKLOAD.dynamicFraction
	);
	return {
		visitsPerMonth: ENVELOPE_WORKLOAD.visitsPerMonth,
		dynamicFraction: ENVELOPE_WORKLOAD.dynamicFraction,
		servingViewsPerDay: scored.envelope.servingViewsPerDay,
		servingBoundBy: scored.envelope.servingBoundBy,
		regenerationsPerDay: scored.envelope.regenerationsPerDay,
		regenerationBoundBy: scored.envelope.regenerationBoundBy,
		windowedRegenerationsPerDay: envelope(DEFAULT_MIX, { windowed: true }).regenerationsPerDay,
		verdict: scored.verdict
	};
}

/** the shape of the SQL pack, read off the manifest the packer wrote */
export function collectPackShape(root: string): Metric<PackShapeMetric> {
	const path = join(root, 'assets/drupal-sql/manifest.json');
	if (!existsSync(path)) {
		return { skipped: 'assets/drupal-sql/manifest.json is absent; run bun run assets:sql' };
	}
	// `source` is an absolute path on the packing machine, so it is not carried
	const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
		generation: string;
		sourceBytes: number;
		totals: Record<string, number>;
	};
	const t = manifest.totals;
	return {
		generation: manifest.generation,
		chunks: t.chunks ?? 0,
		statements: t.statements ?? 0,
		tableDdl: t.tableDdl ?? 0,
		indexDdl: t.indexDdl ?? 0,
		rowStatements: t.rowStatements ?? 0,
		rows: t.rows ?? 0,
		payloadBytes: t.payloadBytes ?? 0,
		chunkBytes: t.chunkBytes ?? 0,
		sourceBytes: manifest.sourceBytes
	};
}

/**
 * The packed Drupal modules, which are the copy that executes on the edge.
 *
 * The one artifact-derived metric a clean checkout can produce, because `bun run assets:driver`
 * rebuilds it from `drupal/` with no Docker, no native PHP and no release payload. Without it a CI
 * run with no payload would have nothing but constants left to gate, and a gate that can only skip
 * is worse than no gate.
 */
export function collectDriverPack(root: string): Metric<DriverPackMetric> {
	const path = join(root, 'assets/driver.json');
	if (!existsSync(path)) {
		return { skipped: 'assets/driver.json is absent; run bun run assets:driver' };
	}
	const text = readFileSync(path, 'utf8');
	const pack = JSON.parse(text) as Record<string, string>;
	return {
		files: Object.keys(pack).length,
		bytes: new TextEncoder().encode(text).length,
		sha256: createHash('sha256').update(text).digest('hex')
	};
}

/** `.spec.ts` files under a directory, recursively; 0 when the directory does not exist */
export function countSpecFiles(dir: string): number {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
	return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) =>
		name.endsWith('.spec.ts')
	).length;
}

/**
 * The environment `vitest list` is collected under.
 *
 * Exported so `metrics.spec.ts` can assert the config honours exactly this, rather than asserting
 * a variable name that nothing on the other side has to read.
 */
export const LIST_ENV = { DRUPFLARE_LIST_ALL: '1' } as const;

/**
 * Test counts, and only the ones that survive being asked twice.
 *
 * SPEC FILES are a glob over the repository, so they are deterministic everywhere. CASES come from
 * `vitest list`, which collects without running, and only the **workers** lane is quoted.
 *
 * `LIST_ENV` is load-bearing. The workers lane drops `ARTIFACT_SPECS` on a checkout with no pack,
 * so the count read 204 lower in CI than on a developer's machine, and the day two files joined
 * that list the gate reported 21 deleted tests that still exist. It makes the enumeration cover the
 * repository rather than this machine.
 *
 * `tests/node` is absent from `cases`. `zlib-php.spec.ts` builds its `it.each` table
 * from a live `php` subprocess, so the node lane's case count changes with whether PHP is installed
 * and with what that driver reports -- an environment reading wearing a count's clothes.
 */
export function collectTests(root: string, opts: { vitest: boolean }): TestsMetric {
	const specFiles = {
		workers:
			countSpecFiles(join(root, 'tests/unit')) +
			countSpecFiles(join(root, 'tests/integration')),
		node: countSpecFiles(join(root, 'tests/node')),
		e2e: countSpecFiles(join(root, 'tests/e2e'))
	};
	if (!opts.vitest) {
		return { specFiles, cases: { skipped: 'not collected; --no-vitest was passed' } };
	}
	try {
		const out = execFileSync(
			'bunx',
			['vitest', 'list', '--project=workers', '--json'],
			// vitest writes its own progress to stderr, so only stdout carries the JSON
			{
				cwd: root,
				encoding: 'utf8',
				maxBuffer: 1 << 28,
				stdio: ['ignore', 'pipe', 'ignore'],
				env: { ...process.env, ...LIST_ENV }
			}
		);
		const listed = JSON.parse(out) as unknown[];
		return { specFiles, cases: { workers: listed.length } };
	} catch (error) {
		return {
			specFiles,
			cases: { skipped: `vitest list failed: ${(error as Error).message.split('\n')[0]}` }
		};
	}
}

function gitCommit(root: string): string {
	try {
		return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

/** Runs every enabled collector into one document. */
export async function collect(
	root: string,
	opts: { bundle?: boolean; vitest?: boolean } = {}
): Promise<MetricsDocument> {
	return {
		schema: 1,
		commit: gitCommit(root),
		metrics: {
			bundle:
				opts.bundle === false
					? { skipped: 'not collected; --no-bundle was passed' }
					: collectBundle(root),
			indexAudit: await collectIndexAudit(root),
			freeEnvelope: collectFreeEnvelope(),
			packShape: collectPackShape(root),
			driverPack: collectDriverPack(root),
			tests: collectTests(root, { vitest: opts.vitest !== false })
		}
	};
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, '../..');
	const out = process.argv.find((a: string) => a.startsWith('--out='))?.slice(6);
	const doc = await collect(root, {
		bundle: !process.argv.includes('--no-bundle'),
		vitest: !process.argv.includes('--no-vitest')
	});
	const text = JSON.stringify(doc, null, '\t') + '\n';
	if (out) writeFileSync(resolve(root, out), text);
	process.stdout.write(text);
}
