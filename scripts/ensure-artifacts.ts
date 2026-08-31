/**
 * Produces every build artifact a measuring lane reads, or says why it cannot.
 *
 * ```sh
 * bun scripts/ensure-artifacts.ts              # produce what is missing and producible
 * bun scripts/ensure-artifacts.ts --dry-run    # report only
 * bun scripts/ensure-artifacts.ts --require=drupal-sql,driver
 * ```
 *
 * A metrics run on a clean checkout reported 8 of 17 checks as `skipped` and still said PASS,
 * because `bun run hydrate` was wired in with `continue-on-error: true` and its failure scrolled
 * past. It was reaching for a release payload that does not exist yet and falling back to a full
 * source build -- which needs a Drupal tree, native PHP and a Twig bake for artifacts that were
 * never the ones the collectors read.
 *
 * Three of the four are producible from inputs a clean checkout already has, and none of them needs
 * a payload: `site.sqlite` is tracked, the modules come from the sibling checkouts, and the
 * interpreter comes from the public CDN with no credential. This runs those producers and reports
 * the fourth honestly rather than degrading into a vacuous pass.
 *
 * @see scripts/measure/collect-metrics.ts for the collectors these inputs feed
 * @see scripts/hydrate.ts for the payload route, which this does not take
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Producer = {
	/** the `package.json` script that writes the artifact */
	script: string;
	/** paths that must exist for that script to work at all */
	needs: string[];
	/** what the missing input means, when `needs` is not satisfied */
	without: string;
};

export type Artifact = {
	name: string;
	/** the path whose existence proves the artifact is present */
	path: string;
	neededBy: string;
	/** null when nothing in this repository can produce it */
	producer: Producer | null;
	/** how it arrives when no producer can run */
	otherwise: string;
};

/**
 * Every artifact a lane measures, and the cheapest thing that produces it.
 *
 * `drupal-pf` is the only one with no producer here, and that is a lane boundary rather than an
 * omission: `assets:pack` reads a baked `drupal-src`, which needs native PHP and a Twig bake, and
 * the pack it produces is derived from `assets/drupal/site.sqlite` by a trim nothing reproduces.
 */
export const ARTIFACTS: readonly Artifact[] = [
	{
		name: 'interpreter',
		path: '.interp/php8.5.wasm',
		neededBy: 'bundle.gzippedBytes, and every workers spec that boots PHP',
		producer: {
			script: 'restore:artifacts',
			needs: ['cdn-manifest.json'],
			without: 'cdn-manifest.json is absent, so nothing names the bytes to verify'
		},
		otherwise: 'bun run build:wasm, which needs Docker and a phasm token'
	},
	{
		name: 'driver',
		path: 'assets/driver.json',
		neededBy: 'driverPack.files, driverPack.bytes',
		producer: {
			script: 'assets:driver',
			needs: [],
			without: ''
		},
		otherwise: 'the sibling checkouts, via DRUPFLARE_SRC / ROM_SRC / STREAM_HTTP_SRC'
	},
	{
		name: 'drupal-sql',
		path: 'assets/drupal-sql/manifest.json',
		neededBy: 'indexAudit.*, packShape.*',
		producer: {
			script: 'assets:sql',
			needs: ['assets/drupal/site.sqlite'],
			without: 'assets/drupal/site.sqlite is absent, and nothing in this repository writes it'
		},
		otherwise: 'a release payload, via bun run hydrate'
	},
	{
		name: 'drupal-pf',
		path: 'assets/drupal-pf/core.pf.json',
		neededBy: '15 specs that mount the tree or replay a migration',
		producer: null,
		otherwise: 'a release payload, via bun run hydrate'
	}
];

export type State = 'present' | 'produced' | 'unproducible' | 'failed';

export type Result = {
	name: string;
	state: State;
	detail: string;
};

/** whether every input a producer names is on disk */
export function producerIsRunnable(root: string, producer: Producer): boolean {
	return producer.needs.every((path) => existsSync(join(root, path)));
}

/**
 * Classifies one artifact without running anything.
 *
 * Split from the runner so the decision is testable on a fixture directory; `--dry-run` reports
 * exactly this.
 */
export function classify(root: string, artifact: Artifact): Result {
	if (existsSync(join(root, artifact.path))) {
		return { name: artifact.name, state: 'present', detail: artifact.path };
	}
	if (!artifact.producer) {
		return { name: artifact.name, state: 'unproducible', detail: artifact.otherwise };
	}
	if (!producerIsRunnable(root, artifact.producer)) {
		return { name: artifact.name, state: 'unproducible', detail: artifact.producer.without };
	}
	return {
		name: artifact.name,
		state: 'produced',
		detail: `bun run ${artifact.producer.script}`
	};
}

/** the markdown a lane appends to its step summary, so a skipped metric names its cause */
export function renderReport(results: readonly Result[]): string {
	const lines = [
		'### Build Artifacts',
		'',
		'| Artifact | State | Detail |',
		'| --- | --- | --- |'
	];
	for (const r of results) lines.push(`| \`${r.name}\` | ${r.state} | ${r.detail} |`);
	const missing = results.filter((r) => r.state !== 'present' && r.state !== 'produced');
	if (missing.length > 0) {
		lines.push(
			'',
			`${missing.length} artifact(s) could not be produced here, so every metric that reads ` +
				'them reports itself as not collected rather than as a zero.'
		);
	}
	return lines.join('\n') + '\n';
}

/** Produces everything missing and producible; never throws for an artifact it cannot make. */
export function ensure(root: string, opts: { dryRun?: boolean } = {}): Result[] {
	return ARTIFACTS.map((artifact) => {
		const planned = classify(root, artifact);
		if (planned.state !== 'produced' || opts.dryRun) return planned;
		try {
			execFileSync('bun', ['run', artifact.producer!.script], {
				cwd: root,
				stdio: ['ignore', 'inherit', 'inherit']
			});
		} catch (error) {
			return {
				name: artifact.name,
				state: 'failed',
				detail: `bun run ${artifact.producer!.script}: ${(error as Error).message.split('\n')[0]}`
			};
		}
		return existsSync(join(root, artifact.path))
			? planned
			: {
					name: artifact.name,
					state: 'failed',
					detail: `bun run ${artifact.producer!.script} exited 0 and wrote no ${artifact.path}`
				};
	});
}

if (import.meta.main) {
	const root = resolve(import.meta.dirname, '..');
	const dryRun = process.argv.includes('--dry-run');
	const required = (process.argv.find((a: string) => a.startsWith('--require='))?.slice(10) ?? '')
		.split(',')
		.filter(Boolean);

	const results = ensure(root, { dryRun });
	for (const r of results) console.log(`  ${r.state.padEnd(12)} ${r.name}  ${r.detail}`);

	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) {
		const { appendFileSync } = await import('node:fs');
		appendFileSync(summary, renderReport(results));
	}

	const short = required.filter(
		(name: string) =>
			!results.some(
				(r) => r.name === name && (r.state === 'present' || r.state === 'produced')
			)
	);
	if (short.length > 0) {
		console.error(`\nrequired artifact(s) absent: ${short.join(', ')}`);
		process.exit(1);
	}
}
