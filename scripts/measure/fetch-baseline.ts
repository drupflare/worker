/**
 * Resolves the metrics document a run archived, addressed by ref rather than by run id.
 *
 * ```sh
 * bun scripts/measure/fetch-baseline.ts --out=baseline-run/metrics.json   # newest master push
 * bun scripts/measure/fetch-baseline.ts --ref=v1.0.1 --out=baseline.json  # a release
 * bun scripts/measure/fetch-baseline.ts --ref=5971f9a --out=baseline.json # a commit
 * ```
 *
 * The gate compares against another document, so "compare against master" and "compare against the
 * v1.0.0 release" are the same operation with a different ref. That is what keeps the CUMULATIVE
 * reading available after the committed baseline file was deleted: creep since a release is a
 * `--ref` away for as long as that run's artifact lives.
 *
 * Retention is the real limit and it is stated rather than assumed: **90 days**, which is the
 * ceiling GitHub allows a PUBLIC repository, so it cannot be raised here. An expired artifact is
 * reported as expired, with the run and its date, because a cumulative question answered against
 * a silently missing baseline is worse than one that is refused.
 *
 * Job summaries outlive artifacts, and the raw-markdown endpoint that would expose them was tried:
 * `GET https://github.com/{owner}/{repo}/actions/runs/{run}/jobs/{job}/summary_raw` answers 404 to a
 * PAT under `Bearer` and `token`, unauthenticated on a public repository, and under the
 * `attempts/{n}` and `api.github.com` spellings. The job page's own `summaryHref` points at the run
 * page rather than a blob. Nothing here is built on it.
 *
 * @see scripts/measure/metrics-gate.ts which consumes what this writes
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** the workflow whose runs archive the document, and the artifact it uploads */
export const WORKFLOW = 'metrics.yml';
export const ARTIFACT = 'metrics';

export type RunRow = {
	databaseId: number;
	headSha: string;
	createdAt: string;
	conclusion: string;
};

export type Resolution =
	| { state: 'found'; run: number; sha: string; createdAt: string }
	| { state: 'no-run'; detail: string }
	| { state: 'expired'; run: number; createdAt: string; detail: string };

function gh(args: string[]): string {
	return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
}

function tryGh(args: string[]): string | null {
	try {
		return execFileSync('gh', args, {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 1 << 26
		});
	} catch {
		return null;
	}
}

/**
 * Picks the run whose archived document answers a question about a ref.
 *
 * A tag or a commit resolves to the run for that exact sha; the default resolves to the newest
 * completed push on master, which is what a pull request is asking about.
 *
 * NOT "the newest PASSING run", and that distinction wedged the gate for a week. The baseline is a
 * record of what master MEASURES, which is a fact whether or not the gate liked it -- but only a
 * successful run could become one, and the gate cannot succeed while the baseline is stale. Master
 * was red for six days, the archived figure froze at the last green commit, and every run after it
 * compared a week of accumulated growth against it: `driverPack.bytes` 362,191 -> 526,056, +45%
 * against a +10% allowance, with no way out that did not involve editing the tolerance.
 *
 * A run that failed BEFORE producing a document is skipped anyway, because the caller requires a
 * live `metrics` artifact and walks on without one. So this widens the search to runs that measured
 * something, not to runs that measured nothing.
 */
export function pickRun(rows: readonly RunRow[], sha?: string): RunRow | undefined {
	// a cancelled run may have uploaded half a document; a failed one uploaded a whole one
	const usable = rows.filter((r) => r.conclusion === 'success' || r.conclusion === 'failure');
	return sha ? usable.find((r) => r.headSha === sha) : usable[0];
}

/** whether the artifact a run uploaded is still downloadable */
export function artifactIsLive(
	artifacts: readonly { name: string; expired: boolean }[],
	name = ARTIFACT
): boolean {
	return artifacts.some((a) => a.name === name && !a.expired);
}

export function resolveRef(ref: string | undefined, repo: string): Resolution {
	const sha = ref
		? tryGh(['api', `/repos/${repo}/commits/${ref}`, '--jq', '.sha'])?.trim()
		: undefined;
	if (ref && !sha) {
		return { state: 'no-run', detail: `${ref} names no commit on ${repo}` };
	}

	const listArgs = [
		'run',
		'list',
		`--workflow=${WORKFLOW}`,
		'--limit=50',
		'--json',
		'databaseId,headSha,createdAt,conclusion'
	];
	if (!ref) listArgs.push('--branch=master', '--event=push');
	const rows = JSON.parse(gh(listArgs)) as RunRow[];

	const run = pickRun(rows, sha);
	if (!run) {
		return {
			state: 'no-run',
			detail: ref
				? `no completed ${WORKFLOW} run for ${ref} (${sha?.slice(0, 7)}) in the last 50`
				: `no completed ${WORKFLOW} push run on master`
		};
	}

	const artifacts = JSON.parse(
		gh([
			'api',
			`/repos/${repo}/actions/runs/${run.databaseId}/artifacts`,
			'--jq',
			'[.artifacts[] | {name, expired}]'
		])
	) as { name: string; expired: boolean }[];
	if (!artifactIsLive(artifacts)) {
		return {
			state: 'expired',
			run: run.databaseId,
			createdAt: run.createdAt,
			detail:
				`run ${run.databaseId} of ${run.createdAt.slice(0, 10)} kept no live ${ARTIFACT} ` +
				'artifact; retention is 90 days and a public repository cannot raise it'
		};
	}
	return {
		state: 'found',
		run: run.databaseId,
		sha: run.headSha,
		createdAt: run.createdAt
	};
}

if (import.meta.main) {
	const arg = (name: string, fallback = ''): string =>
		process.argv.find((a: string) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
		fallback;
	const repo = process.env.GITHUB_REPOSITORY ?? 'drupflare/worker';
	const ref = arg('ref') || undefined;
	const out = resolve(process.cwd(), arg('out', 'baseline-run/metrics.json'));

	const resolution = resolveRef(ref, repo);
	if (resolution.state === 'found') {
		const staging = `${out}.download`;
		rmSync(staging, { recursive: true, force: true });
		gh(['run', 'download', String(resolution.run), '--name', ARTIFACT, '--dir', staging]);
		mkdirSync(dirname(out), { recursive: true });
		renameSync(join(staging, 'metrics.json'), out);
		rmSync(staging, { recursive: true, force: true });

		console.log(
			`found: run ${resolution.run} at ${resolution.sha.slice(0, 7)} ` +
				`(${resolution.createdAt.slice(0, 10)}) -> ${out}`
		);
		const output = process.env.GITHUB_OUTPUT;
		if (output) {
			const { appendFileSync } = await import('node:fs');
			appendFileSync(output, `found=${resolution.run}\nsha=${resolution.sha}\n`);
		}
	} else {
		// not an error: the caller decides whether an unjudged run is acceptable, via
		// metrics-gate's --require-baseline
		console.log(`${resolution.state}: ${resolution.detail}`);
	}
}
