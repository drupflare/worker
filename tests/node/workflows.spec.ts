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
				id?: string;
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
	 * A RELEASE PREFIX OUTRANKS THE GITHUB RELEASE IN `hydrate`, so publishing one before the payload
	 * has been checked leaves a resolvable payload for a version that may never be released. The run
	 * of 2026-09-13 is the case: the payload built, verification then failed, and nothing was
	 * published. Under the wrong order that failure would have left `payloads/v1.0.0/` behind for
	 * every `bun run hydrate` to prefer.
	 *
	 * Asserted against the LAST check rather than a step name, because which checks verify the
	 * hydrated tree is free to change; what may not change is that publishing follows all of them.
	 * This lane ran a second full `bun run test` until 2026-09-19 and now runs the bundle pricing and
	 * a render smoke, which is the same claim about a different pair of steps.
	 */
	it('publishes a release payload only after every hydrated-tree check has run', () => {
		const text = readFileSync(join(DIR, 'release.yml'), 'utf8');
		const publish = text.indexOf('publish-payload.ts');
		expect(publish).toBeGreaterThan(0);
		for (const check of ['release:check', 'release:smoke']) {
			const at = text.indexOf(check);
			expect(at, `release.yml runs ${check}`).toBeGreaterThanOrEqual(0);
			expect(publish, `publishes after ${check}`).toBeGreaterThan(at);
		}
	});

	/**
	 * The smoke is what replaced the second full suite, so a lane that lost it would publish a
	 * payload nothing ever booted -- sums and a dry-run both pass on a tree whose interpreter cannot
	 * start.
	 */
	it('boots the hydrated payload before publishing it', () => {
		const step = Object.values(byFile('release.yml').jobs)
			.flatMap((job) => job.steps ?? [])
			.find((s) => (s.run ?? '').includes('release:smoke'));
		expect(step).toBeDefined();
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

/**
 * A cache key interpolating an empty step output does not fail; it becomes the constant prefix
 * before it. `drupal-${{ steps.drupalver.outputs.version }}` with no value is the key `drupal-`,
 * which `actions/cache` restores by prefix, so the job gets whichever tree was cached last under
 * ANY version. Three lanes went red on a tree holding 11.4.6 while the lock asked for 11.4.7, and
 * the renovate pull request that produced the bump was green on the same code because its prefix
 * happened to hit the 11.4.7 entry its own sibling job had just written.
 *
 * `fetch-drupal-tree.ts --print-version` imports `src/ops/shipped-lock.ts`, which postinstall
 * generates, so resolving the version before `bun install` prints nothing and exits non-zero --
 * and a failing command substitution inside `echo` is discarded by the echo that wraps it.
 */
describe('the Drupal tree cache key', () => {
	/** ids whose `outputs.version` some cache key in this job interpolates */
	function keyedOn(steps: { with?: Record<string, string> }[]): Set<string> {
		const ids = new Set<string>();
		for (const step of steps) {
			for (const value of Object.values(step.with ?? {})) {
				for (const match of String(value).matchAll(
					/steps\.([A-Za-z0-9_-]+)\.outputs\.version/g
				)) {
					ids.add(match[1] as string);
				}
			}
		}
		return ids;
	}

	it('finds a job to check, so neither assertion below is vacuous', () => {
		const jobs = workflows().flatMap(({ doc }) =>
			Object.values(doc.jobs ?? {}).filter((job) => keyedOn(job.steps ?? []).size > 0)
		);
		expect(jobs.length).toBeGreaterThanOrEqual(5);
	});

	it('installs before resolving, since the version comes from a generated module', () => {
		for (const { file, doc } of workflows()) {
			for (const [name, job] of Object.entries(doc.jobs ?? {})) {
				const steps = job.steps ?? [];
				const ids = keyedOn(steps);
				if (ids.size === 0) continue;
				const install = steps.findIndex((s) => (s.run ?? '').includes('bun install'));
				expect(
					install,
					`${file}:${name} keys a cache on a version it never installs for`
				).toBeGreaterThanOrEqual(0);
				for (const id of ids) {
					const at = steps.findIndex((s) => s.id === id);
					expect(
						at,
						`${file}:${name} resolves '${id}' before bun install, so the key is a bare prefix`
					).toBeGreaterThan(install);
				}
			}
		}
	});

	it('refuses an empty version rather than emitting a bare prefix', () => {
		for (const { file, doc } of workflows()) {
			for (const [name, job] of Object.entries(doc.jobs ?? {})) {
				for (const step of job.steps ?? []) {
					const run = step.run ?? '';
					if (!run.includes('--print-version')) continue;
					expect(run, `${file}:${name} would emit an empty version`).toMatch(
						/test -n "\$version"/
					);
				}
			}
		}
	});
});
