import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The workflow triggers, asserted rather than read.
 *
 * Two mistakes are cheap to make here and invisible once made. A bot branch listed under `push:`
 * runs every gate TWICE per bump, because the pull request's own `synchronize` run already covers
 * it -- and the second copy only appears once the bot pushes with a credential that triggers
 * workflows at all, so it cannot be noticed while the runs are being held. And a `branches:` filter
 * under `pull_request:` matches the BASE branch, not the head, so `interp/*` there reads like it
 * gates the interpreter lane and gates nothing.
 *
 * Node lane: it reads `.github/` off the filesystem.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const DIR = join(ROOT, '.github/workflows');

type Trigger = { branches?: string[]; 'paths-ignore'?: string[] };
type Workflow = {
	name: string;
	on: Record<string, Trigger | null>;
	jobs: Record<
		string,
		{
			steps?: {
				name?: string;
				run?: string;
				uses?: string;
				env?: Record<string, string>;
				with?: Record<string, string>;
			}[];
		}
	>;
};

function workflows(): { file: string; doc: Workflow }[] {
	return readdirSync(DIR)
		.filter((f) => f.endsWith('.yml'))
		.map((file) => ({ file, doc: parse(readFileSync(join(DIR, file), 'utf8')) as Workflow }));
}

/** every `run:` line in a workflow, flattened, so a step's command can be asserted */
function runs(doc: Workflow): string {
	return Object.values(doc.jobs ?? {})
		.flatMap((job) => job.steps ?? [])
		.map((step) => step.run ?? '')
		.join('\n');
}

/** the branches that only ever carry bot-authored pull requests */
const BOT_BRANCHES = ['renovate/*', 'interp/*'];

describe('the trigger filters', () => {
	it('parses every workflow, so none of these assertions is vacuous', () => {
		const all = workflows();
		expect(all.length).toBeGreaterThanOrEqual(8);
		for (const { file, doc } of all) {
			expect(doc.on, `${file} declares no triggers`).toBeDefined();
		}
	});

	it('never builds a bot branch on push, because its pull request already does', () => {
		for (const { file, doc } of workflows()) {
			const push = doc.on?.push;
			if (!push?.branches) continue;
			for (const bot of BOT_BRANCHES) {
				expect(push.branches, `${file} would run twice per bot bump`).not.toContain(bot);
			}
		}
	});

	it('bases every pull_request filter on master, since that is what the filter matches', () => {
		for (const { file, doc } of workflows()) {
			const pr = doc.on?.pull_request;
			if (!pr) continue;
			expect(pr.branches, `${file} filters pull requests by base and omits master`).toContain(
				'master'
			);
		}
	});

	it('leaves the three required checks unfiltered by path, so they always report', () => {
		// master's ruleset requires Gate Suites, test and format; a path filter that skips one
		// leaves a pull request waiting on a check that will never run
		for (const file of ['build.yml', 'coverage.yml', 'prettier.yml']) {
			const doc = parse(readFileSync(join(DIR, file), 'utf8')) as Workflow;
			expect(
				doc.on.pull_request?.['paths-ignore'],
				`${file} filters a required check`
			).toBeUndefined();
		}
	});
});

describe('the metrics lane', () => {
	const doc = () => parse(readFileSync(join(DIR, 'metrics.yml'), 'utf8')) as Workflow;

	it('produces the artifacts before it measures them', () => {
		const text = runs(doc());
		expect(text).toContain('ensure-artifacts.ts');
		expect(text.indexOf('ensure-artifacts.ts')).toBeLessThan(text.indexOf('bun run metrics '));
	});

	it('takes its baseline from an archived run rather than a committed file', () => {
		expect(runs(doc())).toContain('fetch-baseline.ts');
		expect(runs(doc())).toContain('--baseline-metrics=');
	});

	it('can read another run to fetch that baseline', () => {
		const perms = (doc().jobs.collect as unknown as { permissions: Record<string, string> })
			.permissions;
		expect(perms.actions).toBe('read');
		expect(perms['pull-requests']).toBe('write');
	});

	it('does not reach for a release payload unless one was named', () => {
		// the unconditional `bun run hydrate` fell through to a full source build and died in
		// assets:sql, then continue-on-error hid it and 8 of 17 checks reported skipped
		const steps = doc().jobs.collect?.steps ?? [];
		const hydrate = steps.filter((s) => (s.run ?? '').includes('run hydrate'));
		expect(hydrate.length).toBeGreaterThan(0);
		for (const step of hydrate) {
			expect(step.run).toContain('--payload-only');
		}
	});
});

describe('the interpreter lane', () => {
	const doc = () => parse(readFileSync(join(DIR, 'interpreter.yml'), 'utf8')) as Workflow;

	it('reconciles as the bot, so no proposal is attributed to a maintainer', () => {
		const doc_ = doc();
		const reconcile = (doc_.jobs.interpreter?.steps ?? []).find((s) =>
			(s.run ?? '').includes('interp-proposal.ts')
		);
		// running this half under a user PAT was tried: the commit came back correctly as
		// github-actions[bot] and the pull request came back authored by a person
		expect(reconcile?.env?.GH_TOKEN).toBe('${{ github.token }}');
		expect(JSON.stringify(reconcile?.env ?? {})).not.toContain('PHASM_TOKEN');
	});

	it('spends PHASM_TOKEN only on the other repository it exists to reach', () => {
		const steps = doc().jobs.interpreter?.steps ?? [];
		const usingPhasm = steps.filter((s) => JSON.stringify(s.env ?? {}).includes('PHASM_TOKEN'));
		expect(usingPhasm.map((s) => s.name)).toEqual(['Fetch and Pack the New Interpreter']);
	});

	it('checks out with the default credential, since nothing here pushes over git', () => {
		const checkout = (doc().jobs.interpreter?.steps ?? []).find((s) =>
			(s.uses ?? '').startsWith('actions/checkout')
		);
		expect(checkout?.with?.token).toBeUndefined();
	});

	it('reconciles rather than creating a branch per artifact', () => {
		expect(runs(doc())).toContain('interp-proposal.ts');
	});
});
