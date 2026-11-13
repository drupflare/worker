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
				if?: string;
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

describe('a step that pipes through tee', () => {
	// the default shell has no pipefail, so the step reports tee's status and a failed command
	// upstream of it passes; the interpreter fetch died on its seam check and the run went green
	it('sets pipefail, or the step reports the status of tee', () => {
		const bare: string[] = [];
		for (const { file, doc } of workflows()) {
			for (const job of Object.values(doc.jobs ?? {})) {
				for (const step of job.steps ?? []) {
					const run = step.run ?? '';
					if (/\|\s*tee\b/.test(run) && !/pipefail/.test(run)) {
						bare.push(`${file}: ${step.name ?? run.slice(0, 40)}`);
					}
				}
			}
		}
		expect(bare).toEqual([]);
	});
});

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

	// the pin is only worth reading if the bytes under it came from phasm's own build workflow
	it('verifies the fetched interpreter against phasm provenance before anything prices or proposes it', () => {
		const steps = doc().jobs.interpreter?.steps ?? [];
		const at = (name: string) => steps.findIndex((s) => s.name === name);
		const verify = at('Verify the Interpreter Attestation');
		expect(verify).toBeGreaterThan(at('Fetch and Pack the New Interpreter'));
		for (const later of [
			'Price the New Bundle Against the Free Ceiling',
			'Build the Deploy Payload',
			'Upload the Payload',
			'Reconcile the Pin into One Pull Request'
		]) {
			expect(verify, later).toBeLessThan(at(later));
		}
		const run = steps[verify]?.run ?? '';
		expect(run).toContain('gh attestation verify');
		expect(run).toContain('--signer-workflow drupflare/phasm/.github/workflows/build.yml');
		expect(run).toContain('set -euo pipefail');
		expect(run).toContain('exit 1');
		expect(steps[verify]?.if).toContain('SKIPPED');
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

	/**
	 * The managed bundle is built from the hydrated tree and its checksum joins `SHA256SUMS` below
	 * the payload line, the one `hydrate` reads. Published after the payload, from the same lane.
	 */
	it('builds the managed bundle from the hydrated tree and publishes it after the payload', () => {
		const text = readFileSync(join(DIR, 'release.yml'), 'utf8');
		const smoke = text.indexOf('release:smoke');
		const build = text.indexOf('build-managed-bundle.ts');
		const payload = text.indexOf('publish-payload.ts');
		const bundle = text.indexOf('publish-bundle.ts');
		expect(build, 'builds after the smoke').toBeGreaterThan(smoke);
		expect(payload, 'the payload publishes after the bundle is summed').toBeGreaterThan(build);
		expect(bundle, 'the bundle publishes after the payload').toBeGreaterThan(payload);
		const step = Object.values(byFile('release.yml').jobs)
			.flatMap((job) => job.steps ?? [])
			.find((s) => (s.run ?? '').includes('publish-bundle.ts'));
		expect(step?.env?.['CLOUDFLARE_ACCOUNT_ID']).toBeDefined();
		expect(step?.env?.['CLOUDFLARE_R2_KEY_ID']).toBeDefined();
		expect(step?.env?.['CLOUDFLARE_R2_SECRET_ACCESS_KEY']).toBeDefined();
	});

	it('puts the bundle tarball on the release beside the payload', () => {
		const text = readFileSync(join(DIR, 'release.yml'), 'utf8');
		expect(text).toContain('dist/drupflare-managed-bundle-${{ env.VERSION }}.tar.gz');
	});
});

/**
 * The box bundle is the canonical dry-run `release:check` already runs, packed before the release
 * is cut.
 *
 * It cannot be packed after: a published release takes no new assets (the managed bundle's own
 * section in the build docs says so), so a pack step in the job that follows publishing would fail on
 * its upload and leave a release that never gets the file. And a second `wrangler deploy --dry-run`
 * of the same config would be a second build, whose bytes could differ from the ones the job
 * measured. So `release:check` keeps the canonical output where the packer reads it, the archive
 * rides the same artifact and release as the payload, and the last job fetches it back.
 */
describe('the box bundle on the release', () => {
	const byFile = (file: string) => workflows().find((w) => w.file === file)?.doc as Workflow;
	type Steps = NonNullable<Workflow['jobs'][string]['steps']>;
	const steps = (name: string) => byFile('release.yml').jobs[name]?.steps as Steps;
	const at = (list: Steps, name: string) => list.findIndex((s) => s.name === name);
	const text = () => readFileSync(join(DIR, 'release.yml'), 'utf8');

	it('packs the canonical dry-run that release:check keeps, with no wrangler build of its own', () => {
		const payload = steps('payload');
		const pack = payload[at(payload, 'Pack the Box Bundle')]?.run ?? '';
		expect(pack).toContain('scripts/build-box-bundle.ts');
		expect(pack).toContain('--outdir=dist/dry-run/wrangler');
		expect(pack).not.toContain('wrangler deploy');
		expect(at(payload, 'Pack the Box Bundle')).toBeGreaterThan(
			payload.findIndex((s) => (s.run ?? '').includes('release:check'))
		);
		const release = readFileSync(join(ROOT, 'scripts/release-payload.ts'), 'utf8');
		expect(release).toContain("join(root, 'dist/dry-run', config.replace(/\\.jsonc$/, ''))");
	});

	it('appends its sum below the managed bundle, the payload line staying first', () => {
		const payload = steps('payload');
		const sums = (name: string) => payload[at(payload, name)]?.run ?? '';
		expect(sums('Build the Managed Bundle')).toContain('>> SHA256SUMS');
		expect(sums('Pack the Box Bundle')).toContain('--sums=dist/SHA256SUMS');
		expect(sums('Pack the Box Bundle')).toContain('sha256sum -c SHA256SUMS');
		expect(at(payload, 'Pack the Box Bundle')).toBeGreaterThan(
			at(payload, 'Build the Managed Bundle')
		);
	});

	it('packs before anything is published, so a refused bundle stops the release', () => {
		const payload = steps('payload');
		const pack = at(payload, 'Pack the Box Bundle');
		const publish = payload.findIndex((s) => (s.run ?? '').includes('publish-payload.ts'));
		expect(pack).toBeGreaterThan(0);
		expect(publish).toBeGreaterThan(pack);
	});

	it('hands the archive to the publish job and puts it on the release', () => {
		expect(text()).toContain('dist/${{ env.BOX }}');
		expect(text()).toContain('dist/drupflare-box-bundle-${{ env.VERSION }}.tar.gz');
		const read = steps('payload').find((s) => s.name === 'Read the Version')?.run ?? '';
		expect(read).toContain('BOX=drupflare-box-bundle-${VERSION}.tar.gz');
	});

	it('builds each deploy config once in the last job, and adds no third dry-run', () => {
		const last = steps('deploy-path');
		const dryRuns = last.filter((s) => (s.run ?? '').includes('deploy --dry-run'));
		expect(dryRuns.map((s) => s.name)).toEqual([
			'Bundle the Canonical Config',
			'Bundle the Managed Config'
		]);
	});

	it('fetches the published asset and checks its sum and its root, with no write access', () => {
		const last = steps('deploy-path');
		const check = last[at(last, 'Check the Box Bundle as a Box Would Fetch It')]?.run ?? '';
		expect(check).toContain('https://github.com/${GITHUB_REPOSITORY}/releases/download/${TAG}');
		expect(check).toContain('"$BASE/SHA256SUMS"');
		expect(check).toContain('sha256sum /tmp/box.tar.gz');
		expect(check).toContain("grep -qx 'site.js'");
		expect(check).toContain("grep -qx 'assets.manifest'");
		expect(check).toContain("grep -qx 'assets/drupal-pf/core.pf.bin'");
		expect(check).toContain("grep -qx 'box.vars'");
		expect(check).toContain("grep -q '^assets/bootimage/'");
		const permissions = (
			byFile('release.yml').jobs['deploy-path'] as unknown as {
				permissions: Record<string, string>;
			}
		).permissions;
		expect(permissions.contents).toBe('read');
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
 * A failing command substitution inside `echo` is discarded by the echo that wraps it, so a step
 * that resolves the version has to be checked on its own output.
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

/**
 * Development builds follow the siblings and a release pins them.
 *
 * "Build from source" means the latest pushed code of the module, the driver and the stream client,
 * so a push to any of them reaches the worker's own lanes without anyone cutting a tag. Only the
 * release lane builds from the tags `composer.lock` names, because what it ships has to be
 * reproducible from a version.
 */
describe('the sibling checkouts', () => {
	const SIBLINGS = './.github/actions/siblings';

	it('are pinned to composer.lock by the release workflow and by nothing else', () => {
		for (const { file, doc } of workflows()) {
			for (const [name, job] of Object.entries(doc.jobs ?? {})) {
				for (const step of job.steps ?? []) {
					if (step.uses !== SIBLINGS) continue;
					const pinned = step.with?.pin === 'true';
					expect(pinned, `${file}:${name} pin`).toBe(file === 'release.yml');
				}
			}
		}
	});
});

/**
 * The contrib job installs the census into `drupal-src` and swaps a fixture pack in, so it may only
 * read the caches other jobs write: a save from here would store that tree under the key the gate
 * restores a stock tree from. It skips on a marker, and a marker written before the lane passed
 * would turn a red run into a green one on the next push.
 */
describe('the contrib job', () => {
	const job = () =>
		(parse(readFileSync(join(DIR, 'build.yml'), 'utf8')) as Workflow).jobs
			.contrib as unknown as {
			needs?: string;
			'timeout-minutes'?: number;
			steps: NonNullable<Workflow['jobs'][string]['steps']>;
		};
	const at = (name: string) => job().steps.findIndex((s) => s.name === name);

	it('waits for the gate and carries no schedule of its own', () => {
		const doc = parse(readFileSync(join(DIR, 'build.yml'), 'utf8')) as Workflow;
		expect(job().needs).toBe('gate');
		expect(doc.on.schedule).toBeUndefined();
		expect(job()['timeout-minutes']).toBe(60);
	});

	it('restores the drupal tree and the pack without ever saving them', () => {
		for (const name of ['Restore Drupal Tree', 'Restore the Built Pack']) {
			expect(job().steps[at(name)]?.uses, name).toContain('actions/cache/restore@');
		}
	});

	it('keys the marker on the siblings, the week and the registry', () => {
		const key = job().steps[at('Restore the Pass Marker')]?.with?.key ?? '';
		for (const part of [
			'steps.key.outputs.week',
			'steps.key.outputs.siblings',
			'config/modules.yml',
			'tests/integration/contrib-*.spec.ts'
		]) {
			expect(key, part).toContain(part);
		}
		expect(runs({ jobs: { contrib: job() } } as unknown as Workflow)).toContain(
			'git -C ".siblings/$s" rev-parse HEAD'
		);
	});

	it('skips every later step on a marker hit except the summary', () => {
		const first = at('Restore the Pass Marker');
		for (const step of job().steps.slice(first + 1)) {
			if (
				step.name === 'Contrib Lane to Job Summary' ||
				step.name === 'Upload the Contrib Logs'
			)
				continue;
			expect(step.if, step.name).toContain("steps.marker.outputs.cache-hit != 'true'");
		}
	});

	it('writes the marker after the lane and before nothing that can fail', () => {
		expect(at('Write the Pass Marker')).toBe(at('Run the Contrib Lane') + 1);
		const lane = job().steps[at('Run the Contrib Lane')]?.run ?? '';
		expect(lane).toContain('pipefail');
		expect(lane).toContain('test:contrib');
		expect(at('Install the Census')).toBeLessThan(at('Run the Contrib Lane'));
	});

	it('uploads logs on failure only, for seven days, and never the pack', () => {
		const step = job().steps[at('Upload the Contrib Logs')] as {
			if?: string;
			with?: Record<string, string | number>;
		};
		expect(step.if).toContain('failure()');
		expect(step.with?.['retention-days']).toBe(7);
		expect(String(step.with?.path)).not.toContain('assets');
		expect(String(step.with?.path)).not.toContain('shipping');
	});
});

describe('the pack suites lane', () => {
	type Job = {
		needs?: string[];
		strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } };
		steps: NonNullable<Workflow['jobs'][string]['steps']>;
	};
	const jobs = () =>
		(parse(readFileSync(join(DIR, 'e2e.yml'), 'utf8')) as { jobs: Record<string, Job> }).jobs;
	const step = (job: Job | undefined, name: string) => job?.steps.find((s) => s.name === name);

	it('shards the gate over a matrix and never stops the other shards on a failure', () => {
		const gate = jobs().gate;
		expect(gate?.strategy?.['fail-fast']).toBe(false);
		expect(gate?.strategy?.matrix?.shard).toEqual([1, 2, 3, 4]);
		const run = step(gate, 'Run the Gate Shard With the Pack Asserted')?.run ?? '';
		expect(run).toContain('--shard=${{ matrix.shard }}/${{ strategy.job-total }}');
		expect(run).toContain('--reporter=blob');
	});

	it('zeroes the thresholds in a shard, since each one sees a fraction of the coverage', () => {
		const run = step(jobs().gate, 'Run the Gate Shard With the Pack Asserted')?.run ?? '';
		for (const metric of ['lines', 'functions', 'branches', 'statements']) {
			expect(run, `${metric} would fail every shard`).toContain(
				`--coverage.thresholds.${metric}=0`
			);
		}
	});

	it('asserts the thresholds once, on the merged reports, and waits for every other job', () => {
		const merge = jobs()['pack-suites'];
		expect(merge?.needs).toEqual(['gate', 'lane']);
		const run = step(merge, 'Merge the Shards and Assert the Coverage Gate')?.run ?? '';
		expect(run).toContain('--merge-reports --coverage');
		expect(run).not.toContain('thresholds');
		expect(step(merge, 'Fail When a Shard or the e2e Lane Failed')).toBeDefined();
	});

	it('runs the e2e lane as its own job rather than after the gate', () => {
		const lane = jobs().lane;
		expect(lane?.needs).toBeUndefined();
		expect(step(lane, 'Run the e2e Lane')?.run).toContain('test:e2e');
		expect(step(jobs().gate, 'Run the e2e Lane')).toBeUndefined();
	});
});
