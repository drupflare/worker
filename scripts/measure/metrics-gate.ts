/**
 * Judges a Class A metrics document against a committed baseline, and renders the verdict.
 *
 * ```sh
 * bun scripts/measure/metrics-gate.ts --metrics=metrics.json
 * bun scripts/measure/metrics-gate.ts --metrics=metrics.json --summary=$GITHUB_STEP_SUMMARY
 * bun scripts/measure/metrics-gate.ts --metrics=metrics.json --write-baseline
 * ```
 *
 * Exits 1 when any check fails, and ALSO when no check could be evaluated at all. A run where every
 * metric skipped is indistinguishable from a run where every metric passed, and this project's own
 * rule is that a step which can only skip is worse than no step.
 *
 * Tolerances live here rather than in the baseline file so that a `--write-baseline` refresh moves
 * the recorded values and cannot quietly widen what is allowed. The baseline is data; this is the
 * contract.
 *
 * @see scripts/measure/collect-metrics.ts for the half that produces the document
 * @see docs/measurement-classes.md for why no timing figure is eligible for any of this
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FREE_CEILING } from './bundle-size';
import { isSkipped, type MetricsDocument } from './collect-metrics';

/**
 * One rule over one metric.
 *
 * `ceiling` and `equals` are absolute: they hold whatever the baseline says, so a baseline refresh
 * cannot bless a bundle that does not deploy. `maxIncrease` and `noDecrease` are relative to the
 * baseline, with the tolerance stated per metric rather than shared -- 32 KiB of bundle drift and one
 * new index are not the same size of event.
 */
export type Check =
	| { path: string; kind: 'ceiling'; limit: number; why: string }
	| { path: string; kind: 'equals'; expected: string | number | boolean; why: string }
	| { path: string; kind: 'maxIncrease'; abs?: number; ratio?: number; why: string }
	| { path: string; kind: 'noDecrease'; abs?: number; ratio?: number; why: string };

/**
 * Every gated metric, with the tolerance it earns.
 *
 * `bundle.gzippedBytes` carries two checks on purpose: the ceiling is the hard fail (over 3 MiB the
 * worker cannot be deployed at all, `code: 10027`), and the drift check catches a 200 KB creep that
 * still fits and would otherwise be noticed only on the release that stopped fitting.
 *
 * `indexAudit.explicitIndexes` allows ZERO increase because an index is a write multiplier, not a
 * read optimisation: under this billing model every index on a hot table is another charged row per
 * insert, and rows written is what binds the regeneration ceiling. Adding one should require saying
 * so in the baseline.
 */
export const CHECKS: readonly Check[] = [
	{
		path: 'bundle.gzippedBytes',
		kind: 'ceiling',
		limit: FREE_CEILING,
		why: 'over the free-plan ceiling the worker cannot be uploaded at all'
	},
	{
		path: 'bundle.gzippedBytes',
		kind: 'maxIncrease',
		abs: 32_768,
		why: 'a creep that still fits is only visible before the release that stops fitting'
	},
	{
		path: 'driverPack.bytes',
		kind: 'maxIncrease',
		ratio: 0.1,
		why: 'the packed modules are bundled into the worker, so they spend the same ceiling'
	},
	{
		path: 'driverPack.files',
		kind: 'noDecrease',
		why: 'a file dropped from the pack is a fatal on a missing class, at runtime, on the edge'
	},
	{
		path: 'indexAudit.explicitIndexes',
		kind: 'maxIncrease',
		abs: 0,
		why: 'an index is a write multiplier, and rows written binds the regeneration ceiling'
	},
	{
		path: 'indexAudit.chargedRows',
		kind: 'maxIncrease',
		ratio: 0.02,
		why: 'charged rows are the meter the regeneration ceiling is measured on'
	},
	{
		path: 'indexAudit.indexShare',
		kind: 'maxIncrease',
		abs: 0.01,
		why: 'index maintenance already takes two thirds of every stored row'
	},
	{
		path: 'indexAudit.minChargePerRow',
		kind: 'noDecrease',
		why: 'the floor moving is a schema change worth acknowledging in either direction'
	},
	{
		path: 'packShape.rows',
		kind: 'maxIncrease',
		ratio: 0.05,
		why: 'every shipped row is replayed into the object on migrate'
	},
	{
		path: 'packShape.payloadBytes',
		kind: 'maxIncrease',
		ratio: 0.05,
		why: 'the pack is hand-trimmed from 14.4 MB and nothing in the repo reproduces the trim'
	},
	{
		path: 'packShape.chunks',
		kind: 'maxIncrease',
		abs: 4,
		why: 'a chunk is a migration step, so the count is the length of the migration'
	},
	{
		path: 'freeEnvelope.verdict',
		kind: 'equals',
		expected: 'fits',
		why: 'the target workload failing either ceiling is the product verdict changing'
	},
	{
		path: 'freeEnvelope.servingViewsPerDay',
		kind: 'noDecrease',
		why: 'a model edit that lowers the serving ceiling should be deliberate'
	},
	{
		path: 'freeEnvelope.regenerationsPerDay',
		kind: 'noDecrease',
		why: 'regeneration is the ceiling that decides whether free is a real Drupal host'
	},
	{
		path: 'tests.specFiles.workers',
		kind: 'noDecrease',
		why: 'a deleted spec file is the cheapest way to make a suite green'
	},
	{
		path: 'tests.specFiles.node',
		kind: 'noDecrease',
		why: 'a deleted spec file is the cheapest way to make a suite green'
	},
	{
		path: 'tests.cases.workers',
		kind: 'noDecrease',
		why: 'the workers lane is the only one whose collected case count is reproducible'
	}
];

export type Verdict = 'pass' | 'fail' | 'skipped' | 'no-baseline';

export type CheckResult = {
	path: string;
	kind: Check['kind'];
	/** the rule as a reviewer reads it, e.g. `<= 3145728` or `+2.0% max` */
	rule: string;
	baseline: number | string | boolean | undefined;
	current: number | string | boolean | undefined;
	delta: number | undefined;
	verdict: Verdict;
	detail: string;
};

export type Comparison = {
	results: CheckResult[];
	evaluated: number;
	failed: number;
	skipped: number;
	/** the whole run's verdict; false when anything failed OR when nothing could be checked */
	ok: boolean;
	reason: string;
};

/** a flat `a.b.c` path map; the only thing a baseline file holds */
export type BaselineValues = Record<string, number | string | boolean>;

export type Baseline = { schema: 1; values: BaselineValues };

/**
 * Reads a dotted path out of a metrics document.
 *
 * @returns `undefined` when any segment is missing OR when the branch is a `{ skipped }` metric,
 *   which is the same answer for the gate's purposes and a different one from a zero.
 */
export function readPath(doc: MetricsDocument, path: string): unknown {
	let node: unknown = doc.metrics;
	for (const key of path.split('.')) {
		if (typeof node !== 'object' || node === null) return undefined;
		if (isSkipped(node)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	if (isSkipped(node)) return undefined;
	return node;
}

/** the rule as a reviewer reads it, so the rendered table explains itself */
export function ruleText(check: Check): string {
	switch (check.kind) {
		case 'ceiling':
			return `<= ${check.limit.toLocaleString()}`;
		case 'equals':
			return `== ${String(check.expected)}`;
		case 'maxIncrease':
			return check.ratio !== undefined
				? `+${(check.ratio * 100).toFixed(1)}% max`
				: `+${(check.abs ?? 0).toLocaleString()} max`;
		case 'noDecrease':
			return check.ratio !== undefined
				? `-${(check.ratio * 100).toFixed(1)}% max`
				: check.abs !== undefined
					? `-${check.abs.toLocaleString()} max`
					: 'no decrease';
	}
}

/** the largest value a check permits, given what the baseline recorded */
function allowedCeiling(check: Check, baseline: number): number {
	if (check.kind !== 'maxIncrease') return Infinity;
	if (check.ratio !== undefined) return baseline * (1 + check.ratio);
	return baseline + (check.abs ?? 0);
}

/** the smallest value a check permits, given what the baseline recorded */
function allowedFloor(check: Check, baseline: number): number {
	if (check.kind !== 'noDecrease') return -Infinity;
	if (check.ratio !== undefined) return baseline * (1 - check.ratio);
	return baseline - (check.abs ?? 0);
}

function evaluate(check: Check, current: unknown, baseline: unknown): CheckResult {
	const base: Omit<CheckResult, 'verdict' | 'detail'> = {
		path: check.path,
		kind: check.kind,
		rule: ruleText(check),
		baseline: baseline as CheckResult['baseline'],
		current: current as CheckResult['current'],
		delta:
			typeof current === 'number' && typeof baseline === 'number'
				? current - baseline
				: undefined
	};

	if (current === undefined) {
		return { ...base, verdict: 'skipped', detail: 'the metric was not collected' };
	}

	if (check.kind === 'equals') {
		return current === check.expected
			? { ...base, verdict: 'pass', detail: '' }
			: {
					...base,
					verdict: 'fail',
					detail: `expected ${String(check.expected)}, got ${String(current)}`
				};
	}

	if (typeof current !== 'number' || !Number.isFinite(current)) {
		return { ...base, verdict: 'fail', detail: `${String(current)} is not a number` };
	}

	if (check.kind === 'ceiling') {
		return current <= check.limit
			? { ...base, verdict: 'pass', detail: `${check.limit - current} under` }
			: {
					...base,
					verdict: 'fail',
					detail: `over the ceiling by ${current - check.limit}`
				};
	}

	if (typeof baseline !== 'number') {
		return { ...base, verdict: 'no-baseline', detail: 'no baseline value to compare against' };
	}

	if (check.kind === 'maxIncrease') {
		const limit = allowedCeiling(check, baseline);
		return current <= limit
			? { ...base, verdict: 'pass', detail: '' }
			: {
					...base,
					verdict: 'fail',
					detail: `${current} exceeds the allowed ${limit} (baseline ${baseline})`
				};
	}

	const floor = allowedFloor(check, baseline);
	return current >= floor
		? { ...base, verdict: 'pass', detail: '' }
		: {
				...base,
				verdict: 'fail',
				detail: `${current} is below the allowed ${floor} (baseline ${baseline})`
			};
}

/**
 * Scores a document against a baseline.
 *
 * A check with nothing to compare (`no-baseline`) does not fail: a metric added today has no
 * history, and failing on that would train everyone to pass `--write-baseline` reflexively. It does
 * not count as evaluated either, so it cannot be the thing that keeps a vacuous run green.
 */
export function compare(
	doc: MetricsDocument,
	baseline: BaselineValues,
	checks: readonly Check[] = CHECKS
): Comparison {
	const results = checks.map((check) =>
		evaluate(check, readPath(doc, check.path), baseline[check.path])
	);
	const failed = results.filter((r) => r.verdict === 'fail').length;
	const skipped = results.filter((r) => r.verdict === 'skipped').length;
	const evaluated = results.filter((r) => r.verdict === 'pass' || r.verdict === 'fail').length;

	if (evaluated === 0) {
		return {
			results,
			evaluated,
			failed,
			skipped,
			ok: false,
			reason:
				'no check could be evaluated, so this run proves nothing; hydrate the payload or ' +
				'build the artifacts the collectors name'
		};
	}
	return {
		results,
		evaluated,
		failed,
		skipped,
		ok: failed === 0,
		reason:
			failed === 0
				? `${evaluated} check(s) evaluated, ${skipped} skipped`
				: `${failed} of ${evaluated} evaluated check(s) failed`
	};
}

/** the baseline a document would record, keeping any value it could not re-measure */
export function nextBaseline(doc: MetricsDocument, previous: BaselineValues): BaselineValues {
	const values: BaselineValues = { ...previous };
	for (const check of CHECKS) {
		const current = readPath(doc, check.path);
		// a skipped metric must not erase a recorded value; a refresh on a machine with no payload
		// would otherwise silently drop the bundle and index baselines
		if (typeof current === 'number' || typeof current === 'string')
			values[check.path] = current;
	}
	return values;
}

const ICON: Record<Verdict, string> = {
	pass: 'pass',
	fail: 'FAIL',
	skipped: 'skipped',
	'no-baseline': 'new'
};

function cell(value: number | string | boolean | undefined): string {
	if (value === undefined) return '-';
	if (typeof value === 'number') {
		return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4);
	}
	return `\`${String(value)}\``;
}

function signed(delta: number | undefined): string {
	if (delta === undefined) return '-';
	if (delta === 0) return '0';
	const shown = Number.isInteger(delta)
		? Math.abs(delta).toLocaleString()
		: Math.abs(delta).toFixed(4);
	return `${delta > 0 ? '+' : '-'}${shown}`;
}

/** every `{ skipped }` metric in a document, with the reason it carried */
export function skippedMetrics(doc: MetricsDocument): { metric: string; why: string }[] {
	const out: { metric: string; why: string }[] = [];
	const walk = (node: unknown, prefix: string): void => {
		if (typeof node !== 'object' || node === null) return;
		if (isSkipped(node)) {
			out.push({ metric: prefix, why: node.skipped });
			return;
		}
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			walk(value, prefix ? `${prefix}.${key}` : key);
		}
	};
	walk(doc.metrics, '');
	return out;
}

/** Renders the comparison as a markdown table for a step summary. */
export function renderMarkdown(doc: MetricsDocument, comparison: Comparison): string {
	const lines: string[] = [
		'## Class A Metrics',
		'',
		`Commit \`${doc.commit.slice(0, 7)}\`. Counts and bytes only: no duration is collected here, ` +
			'because an absolute CPU figure comes only from `cpuTime` on a deployed worker. See ' +
			'`docs/measurement-classes.md`.',
		'',
		`**${comparison.ok ? 'PASS' : 'FAIL'}** - ${comparison.reason}`,
		'',
		'| Metric | Baseline | Current | Delta | Rule | Verdict |',
		'| --- | ---: | ---: | ---: | --- | --- |'
	];
	for (const r of comparison.results) {
		lines.push(
			`| \`${r.path}\` | ${cell(r.baseline)} | ${cell(r.current)} | ${signed(r.delta)} | ` +
				`${r.rule} | ${ICON[r.verdict]}${r.detail ? ` - ${r.detail}` : ''} |`
		);
	}

	const skipped = skippedMetrics(doc);
	if (skipped.length > 0) {
		lines.push('', '### Not Collected', '', '| Metric | Reason |', '| --- | --- |');
		for (const s of skipped) lines.push(`| \`${s.metric}\` | ${s.why} |`);
	}
	return lines.join('\n') + '\n';
}

/** the empty baseline, so a first run reports `new` for everything instead of throwing */
export const EMPTY_BASELINE: Baseline = { schema: 1, values: {} };

export function readBaseline(path: string): Baseline {
	if (!existsSync(path)) return EMPTY_BASELINE;
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
	if (parsed.schema !== 1) throw new Error(`baseline schema ${parsed.schema} is not supported`);
	return parsed;
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, '../..');
	const arg = (name: string, fallback: string): string =>
		process.argv.find((a: string) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
		fallback;

	const metricsPath = resolve(root, arg('metrics', 'metrics.json'));
	const baselinePath = resolve(root, arg('baseline', 'metrics/baseline.json'));
	const doc = JSON.parse(readFileSync(metricsPath, 'utf8')) as MetricsDocument;
	const baseline = readBaseline(baselinePath);

	if (process.argv.includes('--write-baseline')) {
		const values = nextBaseline(doc, baseline.values);
		const sorted = Object.fromEntries(
			Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))
		);
		writeFileSync(
			baselinePath,
			JSON.stringify({ schema: 1, values: sorted }, null, '\t') + '\n'
		);
		console.log(`wrote ${Object.keys(sorted).length} baseline value(s) to ${baselinePath}`);
		process.exit(0);
	}

	const comparison = compare(doc, baseline.values);
	const markdown = renderMarkdown(doc, comparison);
	const summary = arg('summary', process.env.GITHUB_STEP_SUMMARY ?? '');
	if (summary) writeFileSync(summary, markdown, { flag: 'a' });
	process.stdout.write(markdown);

	if (!comparison.ok) {
		console.error(`\nmetrics gate FAILED: ${comparison.reason}`);
		process.exit(1);
	}
}
