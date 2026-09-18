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

/**
 * The two lanes that publish a payload to the CDN.
 *
 * WHAT THIS EXISTS TO CATCH IS A PREFIX THAT DRIFTS. The resolver in `scripts/hydrate.ts` derives
 * its candidate URLs from `scripts/payload-cdn.ts`; if a workflow ever grows its own
 * `wrangler r2 object put payloads/...` line, the two can disagree and the symptom is a deploy that
 * silently falls through to a source build. So the workflows are asserted to go through the script
 * rather than to spell a key, which is the only form that cannot drift.
 */
describe('the payload publishing lanes', () => {
	const byFile = (file: string) => workflows().find((w) => w.file === file)?.doc as Workflow;

	it('publishes from both lanes through the shared script, never a hand-spelled key', () => {
		for (const file of ['build.yml', 'release.yml']) {
			const text = readFileSync(join(DIR, file), 'utf8');
			expect(text, `${file} should publish`).toContain('publish-payload.ts');
			// a literal key here is the drift this guard exists for
			expect(text, `${file} spells a key`).not.toMatch(/r2 object put/);
		}
	});

	it('gives each lane its own line: a release is versioned, a push is the branch tip', () => {
		expect(runs(byFile('release.yml'))).toContain('publish-payload.ts --release');
		expect(runs(byFile('build.yml'))).toContain('publish-payload.ts --dev');
	});

	it('never publishes a branch payload from a pull request, which has no branch line', () => {
		const job = byFile('build.yml').jobs['dev-payload'] as { if?: string } | undefined;
		expect(job).toBeDefined();
		expect(job?.if).toContain("github.event_name == 'push'");
	});

	it('publishes only after the gate, so a red commit does not become a dev payload', () => {
		const job = byFile('build.yml').jobs['dev-payload'] as { needs?: string } | undefined;
		expect(job?.needs).toBe('gate');
	});

	it('verifies the sums before uploading, in both lanes', () => {
		for (const file of ['build.yml', 'release.yml']) {
			const text = readFileSync(join(DIR, file), 'utf8');
			const check = text.indexOf('sha256sum -c SHA256SUMS');
			const publish = text.indexOf('publish-payload.ts');
			expect(check, `${file} checks sums`).toBeGreaterThanOrEqual(0);
			expect(publish, `${file} publishes after checking`).toBeGreaterThan(check);
		}
	});

	/**
	 * A RELEASE PREFIX OUTRANKS THE GITHUB RELEASE IN `hydrate`, so publishing one before the suites
	 * have passed leaves a resolvable payload for a version that may never be released. The run of
	 * 2026-09-13 is the case: the payload built, the hydrated-tree suites then failed, and nothing
	 * was published. Under the wrong order that failure would have left `payloads/v1.0.0/` behind
	 * for every `bun run hydrate` to prefer.
	 */
	it('publishes a release payload only after the hydrated-tree suites have run', () => {
		const text = readFileSync(join(DIR, 'release.yml'), 'utf8');
		const suites = text.indexOf('Run the Suites Against the Hydrated Tree');
		const publish = text.indexOf('publish-payload.ts');
		expect(suites).toBeGreaterThanOrEqual(0);
		expect(publish).toBeGreaterThan(suites);
	});

	it('hands both lanes the credential the bucket needs', () => {
		for (const file of ['build.yml', 'release.yml']) {
			const step = Object.values(byFile(file).jobs)
				.flatMap((job) => job.steps ?? [])
				.find((s) => (s.run ?? '').includes('publish-payload.ts'));
			expect(step?.env?.['CLOUDFLARE_ACCOUNT_ID'], file).toBeDefined();
			expect(step?.env?.['CLOUDFLARE_API_TOKEN'], file).toBeDefined();
		}
	});
});
