import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	assertKnownSteps,
	LOCAL_STEPS,
	missingTools,
	planLocalBuild,
	resolveSiblings,
	siblingEnv,
	stepSatisfied,
	TOOL_HINTS,
	type LocalStep,
	type StepId,
	type ToolId
} from '../../scripts/build-local.ts';
import { resolvePayloadSource } from '../../scripts/hydrate.ts';
import { PREFILL_PATHS } from '../../scripts/lift-prefill.ts';
import { PAYLOAD_ASSETS, payloadName } from '../../scripts/release-payload.ts';
import { SHIPPED_CORE_VERSION } from '../../src/ops/shipped-lock';

/**
 * A clean checkout can build itself, and the ORDER is the product.
 *
 * The pipeline's failure mode is not a step that errors -- it is a step that succeeds against the
 * wrong inputs. `assets:core` runs under `PACK_INDEX=1` and takes its file set verbatim from
 * `assets/drupal/core.list.json`, which `assets:twig` writes; run in the other order it packs from a
 * stale list, or from none, and nothing reports it. So the ordering assertions here are the point and
 * the plumbing assertions are the support.
 *
 * Node lane: it reads package.json, the docs and `git ls-files` from disk.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const scratches: string[] = [];

afterAll(() => {
	for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'drupflare-build-plan-'));
	scratches.push(dir);
	return dir;
}

/**
 * Rewrites a file and stamps it a second into the future.
 *
 * `newerThan()` compares `mtimeMs` with `>=`, so two writes inside one filesystem tick compare
 * equal and the input reads as older than the output that was meant to be stale. On this machine the
 * clock always advanced between the two writes; on the runner it did not, and the assertion failed
 * as `expected true to be false`. The freshness being tested is "strictly newer", so it is stamped
 * rather than raced for.
 */
function rewriteNewer(root: string, path: string, contents: string): void {
	const target = join(root, path);
	writeFileSync(target, contents);
	const ahead = new Date(statSync(target).mtimeMs + 1000);
	utimesSync(target, ahead, ahead);
}

/** a tree in which every step reports itself already built, so the resume decision can be read */
function satisfiedTree(): string {
	const root = scratch();
	const write = (path: string) => {
		mkdirSync(join(root, dirname(path)), { recursive: true });
		writeFileSync(join(root, path), 'x');
	};
	for (const step of LOCAL_STEPS) for (const path of step.produces) write(path);
	// the rewrites land LAST, which is the order a finished build leaves them in: `core` repacks
	// after the bake, and `pack` runs after that. Writing them in table order would model a tree
	// where the repack never happened
	for (const step of LOCAL_STEPS) {
		for (const path of step.refreshes ?? []) write(path);
	}
	for (const step of LOCAL_STEPS) {
		if (step.freshAgainst && !step.refreshes) for (const path of step.produces) write(path);
	}
	// the two steps whose completion is not a path of their own
	for (const name of ['drupflare', 'rom', 'stream-http']) {
		mkdirSync(join(root, '.siblings', name), { recursive: true });
	}
	// the tree step is satisfied by the VERSION rather than by the file existing, so the stub has to
	// carry one -- a tree at the wrong version is exactly the case that used to skip silently
	writeFileSync(
		join(root, 'drupal-src/core/lib/Drupal.php'),
		`<?php\nclass Drupal { const VERSION = '${SHIPPED_CORE_VERSION}'; }\n`
	);
	const renderer = join(root, 'drupal-src/core/lib/Drupal/Core/Render/Renderer.php');
	mkdirSync(dirname(renderer), { recursive: true });
	writeFileSync(renderer, 'new \\PhpWasmSyncFiber(');
	writeFileSync(
		join(root, 'drupal-src/sites/default/settings.php'),
		"$settings['php_storage']['twig']['class'] = 'x';"
	);
	return root;
}

/** every path the pipeline produces, mapped to the step that produces it */
function producers(): Map<string, StepId> {
	const out = new Map<string, StepId>();
	for (const step of LOCAL_STEPS) {
		for (const path of step.produces) out.set(path, step.id);
	}
	return out;
}

/** paths committed to git, which a step may take as an input without any step producing them */
function tracked(): Set<string> {
	return new Set(
		execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).trim().split('\n')
	);
}

describe('the pipeline order, which is what a from-source build gets wrong', () => {
	it('produces every input before the step that reads it', () => {
		const made = new Set<string>();
		const trackedPaths = tracked();
		const violations: string[] = [];

		for (const step of LOCAL_STEPS) {
			for (const input of step.inputs ?? []) {
				if (!made.has(input) && !trackedPaths.has(input)) {
					violations.push(`${step.id} reads ${input}, which nothing before it produces`);
				}
			}
			for (const path of step.produces) made.add(path);
		}
		expect(violations).toEqual([]);
	});

	it('keeps the five orderings whose failure is silent', () => {
		const at = (id: StepId) => LOCAL_STEPS.findIndex((s) => s.id === id);
		// the installer writes the settings.php the patch appends to
		expect(at('site')).toBeLessThan(at('patch'));
		// the bake boots a kernel that must already resolve PhpWasmSyncFiber and read the storage pin
		expect(at('patch')).toBeLessThan(at('twig'));
		// bake-twig.php builds core.list.json out of an EXISTING core.json, so one has to exist first
		expect(at('bootstrap')).toBeLessThan(at('twig'));
		// assets:twig writes core.list.json, which PACK_INDEX=1 assets:core takes verbatim
		expect(at('twig')).toBeLessThan(at('core'));
		// pack-perfile reuses core.json rather than re-globbing the tree
		expect(at('core')).toBeLessThan(at('pack'));
	});

	it('names one producer per artifact, and declares the one rewrite', () => {
		const seen = new Map<string, StepId>();
		const duplicated: string[] = [];
		for (const step of LOCAL_STEPS) {
			for (const path of step.produces) {
				const first = seen.get(path);
				if (first) duplicated.push(`${path}: ${first} and ${step.id}`);
				seen.set(path, step.id);
			}
		}
		expect(duplicated).toEqual([]);

		// a rewrite is legal and must be declared, and must name a path something else produces
		for (const step of LOCAL_STEPS) {
			for (const path of step.refreshes ?? []) {
				expect(
					seen.get(path),
					`${step.id} refreshes ${path}, which no step produces`
				).toBeDefined();
			}
		}
		expect(LOCAL_STEPS.filter((s) => s.refreshes).map((s) => s.id)).toEqual(['core']);
	});

	it('cannot skip a rewrite just because the earlier step left the file there', () => {
		// core.json exists straight after the bootstrap, so presence alone would skip the list-driven
		// repack and ship a pack missing every template the bake just compiled
		const root = satisfiedTree();
		const core = LOCAL_STEPS.find((s) => s.id === 'core') as LocalStep;
		expect(core.freshAgainst, 'a rewrite needs a freshness key, not a presence key').toBe(
			'assets/drupal/core.list.json'
		);
		expect(stepSatisfied(root, core)).toBe(true);

		rewriteNewer(root, 'assets/drupal/core.list.json', 'a newer bake');
		expect(stepSatisfied(root, core)).toBe(false);
	});

	it('repacks the per-file pack when the index it was built from moves', () => {
		const root = satisfiedTree();
		const pack = LOCAL_STEPS.find((s) => s.id === 'pack') as LocalStep;
		expect(stepSatisfied(root, pack)).toBe(true);
		rewriteNewer(root, 'assets/drupal/core.json', 'a newer index');
		expect(stepSatisfied(root, pack)).toBe(false);
	});

	it('writes only inside the checkout', () => {
		const outside = LOCAL_STEPS.flatMap((s) => [
			...s.produces,
			...(s.refreshes ?? []),
			...(s.inputs ?? [])
		]).filter((p) => p.startsWith('/') || p.split('/').includes('..'));
		expect(outside).toEqual([]);
	});

	it('gives every step a way to report itself done', () => {
		// a step with none of the three is never skippable, so a re-run repeats it forever
		const unresumable = LOCAL_STEPS.filter(
			(s) => s.produces.length === 0 && !s.satisfied && !(s.refreshes ?? []).length
		);
		expect(unresumable.map((s) => s.id)).toEqual([]);
	});
});

describe('the tracked inputs a from-source build depends on', () => {
	it('still tracks assets/drupal/site.sqlite, which nothing regenerates', () => {
		// the whole source route rests on this: it is the one asset under assets/ that is committed,
		// and `sql` and `twig` both read it. If it stopped being tracked, a clean clone could not build
		expect(tracked().has('assets/drupal/site.sqlite')).toBe(true);
	});

	it('reads it from the two steps that need it and from no others', () => {
		const readers = LOCAL_STEPS.filter((s) =>
			(s.inputs ?? []).includes('assets/drupal/site.sqlite')
		).map((s) => s.id);
		expect(readers).toEqual(['twig', 'sql']);
	});
});

describe('planning is pure, so the resume decision is one testable function', () => {
	it('runs every step against a tree with nothing on disk', () => {
		const planned = planLocalBuild(scratch());
		expect(planned.every((p) => p.run)).toBe(true);
		expect(planned.map((p) => p.step.id)).toEqual(LOCAL_STEPS.map((s) => s.id));
	});

	it('skips every step against a tree that already has the artifacts', () => {
		const planned = planLocalBuild(satisfiedTree());
		const running = planned.filter((p) => p.run).map((p) => p.step.id);
		expect(running, JSON.stringify(planned.map((p) => [p.step.id, p.reason]))).toEqual([]);
	});

	it('runs a step whose directory exists and is empty', () => {
		// a half-finished pack leaves the directory behind, and an empty chunk set deploys a site
		// with no database rather than failing
		const root = satisfiedTree();
		rmSync(join(root, 'assets/drupal-sql/manifest.json'));
		const sql = planLocalBuild(root).find((p) => p.step.id === 'sql');
		expect(sql?.run).toBe(true);
	});

	it('rebuilds everything under --force', () => {
		const planned = planLocalBuild(satisfiedTree(), { force: true });
		expect(planned.every((p) => p.run)).toBe(true);
		expect(planned.every((p) => p.reason === 'forced')).toBe(true);
	});

	it('honours --only and --skip', () => {
		const root = scratch();
		expect(
			planLocalBuild(root, { only: ['twig', 'core'] })
				.filter((p) => p.run)
				.map((p) => p.step.id)
		).toEqual(['twig', 'core']);
		expect(
			planLocalBuild(root, { skip: ['decoder'] })
				.filter((p) => !p.run)
				.map((p) => p.step.id)
		).toEqual(['decoder']);
	});

	it('refuses a step name that does not exist rather than silently doing nothing', () => {
		expect(() => assertKnownSteps(['twig', 'twigg'])).toThrow(/no such step: twigg/);
		expect(() => assertKnownSteps(LOCAL_STEPS.map((s) => s.id))).not.toThrow();
	});

	it('reports a step satisfied only when every one of its outputs is there', () => {
		const root = satisfiedTree();
		const pack = LOCAL_STEPS.find((s) => s.id === 'pack') as LocalStep;
		expect(stepSatisfied(root, pack)).toBe(true);
		rmSync(join(root, 'assets/drupal-pf/core.pf.bin'));
		expect(stepSatisfied(root, pack)).toBe(false);
	});

	it('names one producer per artifact, counting a rewrite as its own step', () => {
		const core = LOCAL_STEPS.find((s) => s.id === 'core') as LocalStep;
		expect(core.produces, 'a rewrite declares refreshes, never produces').toEqual([]);
	});
});

describe('the preflight names what is missing before minutes are spent', () => {
	const absent =
		(...missing: ToolId[]) =>
		(tool: ToolId) =>
			!missing.includes(tool);

	it('reports a tool only when a step that will run needs it', () => {
		// a machine with no Docker still builds everything else, and demanding it on a run that skips
		// the decoder is how a preflight teaches people to ignore it
		const planned = planLocalBuild(scratch(), { skip: ['decoder'] });
		expect(missingTools(planned, absent('docker'))).toEqual([]);
	});

	it('names the steps blocked by each missing tool', () => {
		const planned = planLocalBuild(scratch());
		const [docker] = missingTools(planned, absent('docker'));
		expect(docker?.tool).toBe('docker');
		expect(docker?.steps).toEqual(['decoder']);
		expect(docker?.hint).toBe(TOOL_HINTS.docker);
	});

	it('carries a hint for every tool any step names', () => {
		const named = new Set(LOCAL_STEPS.flatMap((s) => s.tools));
		expect([...named].filter((t) => !TOOL_HINTS[t])).toEqual([]);
	});

	it('leaves a fallback out of the preflight, so it stays a fallback', () => {
		// the interpreter falls back from the CDN to phasm's artifacts; demanding the fallback's
		// requirements up front would make them requirements
		const withFallback = LOCAL_STEPS.filter((s) => s.fallback);
		expect(withFallback.map((s) => s.id)).toEqual(['interpreter']);
		const planned = planLocalBuild(scratch(), { only: ['interpreter'] });
		const wanted = new Set(missingTools(planned, () => false).map((m) => m.tool));
		for (const tool of withFallback[0]!.fallback!.tools) {
			// only tools the PRIMARY path also needs may appear
			if (!withFallback[0]!.tools.includes(tool)) expect(wanted.has(tool)).toBe(false);
		}
	});
});

describe('the sibling checkouts the driver pack is built from', () => {
	it('prefers an explicit environment setting over anything on disk', () => {
		const root = scratch();
		const resolved = resolveSiblings(root, { ROM_SRC: '/somewhere/rom' });
		expect(resolved.find((s) => s.name === 'rom')).toMatchObject({
			via: 'env',
			value: '/somewhere/rom'
		});
	});

	it('prefers the developer layout over a private clone', () => {
		const parent = scratch();
		const root = join(parent, 'worker');
		mkdirSync(root);
		mkdirSync(join(parent, 'rom'));
		mkdirSync(join(root, '.siblings/rom'), { recursive: true });
		const rom = resolveSiblings(root, {}).find((s) => s.name === 'rom');
		expect(rom?.via, 'a clone of master must not shadow the tree being edited').toBe('sibling');
		expect(rom?.path).toBe(join(parent, 'rom'));
	});

	it('falls back to a clone target it will create, and reports it absent', () => {
		const root = scratch();
		const rom = resolveSiblings(root, {}).find((s) => s.name === 'rom');
		expect(rom).toMatchObject({ via: 'vendored', present: false });
		expect(rom?.path).toBe(join(root, '.siblings/rom'));
	});

	it('mounts stream-http from its src/, which is what gen-driver-assets reads', () => {
		const root = scratch();
		const http = resolveSiblings(root, {}).find((s) => s.name === 'stream-http');
		expect(http?.value).toMatch(/\/stream-http\/src$/);
	});

	it('does not double the suffix when the override already carries it', () => {
		const env = { STREAM_HTTP_SRC: '.siblings/stream-http/src' };
		expect(siblingEnv(scratch(), env).STREAM_HTTP_SRC).toBe('.siblings/stream-http/src');
	});

	it('sets exactly the three variables gen-driver-assets.ts reads', () => {
		const source = readFileSync(join(ROOT, 'scripts/gen-driver-assets.ts'), 'utf8');
		for (const name of Object.keys(siblingEnv(scratch(), {}))) {
			expect(source, `gen-driver-assets.ts never reads ${name}`).toContain(name);
		}
	});

	it('clones only the siblings that are not already there', () => {
		const root = scratch();
		mkdirSync(join(root, '.siblings/rom'), { recursive: true });
		const siblings = LOCAL_STEPS.find((s) => s.id === 'siblings') as LocalStep;
		const cloning = siblings.commands(root).map((c) => c.join(' '));
		expect(cloning).toHaveLength(2);
		expect(cloning.join(' ')).not.toContain('/rom.git');
	});
});

describe('a source-built tree carries everything the payload does', () => {
	it('produces every asset the payload ships', () => {
		// the gap this closes: prefill.json was the one payload artifact with no local producer, on
		// the reasoning that it needs the runtime. It does -- but a local `wrangler dev` IS the
		// runtime, so "needs a deploy" was never true
		const produced = LOCAL_STEPS.flatMap((s) => [...s.produces, ...(s.refreshes ?? [])]);
		const unproduced = PAYLOAD_ASSETS.filter((asset) =>
			// an OPTIONAL entry has no representative file by definition: `assets/themes` is empty on
			// a checkout with no contrib theme, and demanding one there is what broke `build:local`
			asset.optional
				? false
				: // a payload DIRECTORY entry is covered by a step producing anything inside it: `sql`
					// names `drupal-sql/manifest.json`, because a directory that exists and is empty
					// is not built
					asset.dir
					? !produced.some((p) => p.startsWith(`${asset.path}/`))
					: !produced.includes(asset.path)
		).map((a) => a.path);
		expect(unproduced, 'the payload ships an artifact nothing here builds').toEqual([]);
	});

	it('marks only the port-binding step optional', () => {
		// optional is a real escape hatch and a tempting one; anything else claiming it would be a
		// step quietly allowed to fail
		expect(LOCAL_STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual(['prefill']);
	});

	it('lifts the same five paths the shipped prefill.json carries', () => {
		// a bake of two paths would deploy a site where three pages miss on their first request, and
		// nothing would report it: a miss renders correctly, just slowly
		expect(PREFILL_PATHS).toEqual([
			'/',
			'/node',
			'/user/login',
			'/user/password',
			'/filter/tips'
		]);
	});

	it('waits for everything a render needs before booting the runtime', () => {
		// the prefill step renders through the real worker, so a missing pack or an unmigrated
		// chunk set comes back as a 202 retried twelve times rather than as a named missing input
		const prefill = LOCAL_STEPS.find((s) => s.id === 'prefill') as LocalStep;
		const at = (id: StepId) => LOCAL_STEPS.findIndex((s) => s.id === id);
		expect(at('prefill')).toBe(LOCAL_STEPS.length - 1);
		for (const needed of [
			'assets/driver.json',
			'assets/drupal-pf/core.pf.bin',
			'assets/drupal-sql/manifest.json'
		]) {
			expect(prefill.inputs).toContain(needed);
		}
	});
});

describe('hydrate picks between the payload and the source route', () => {
	const yes = async () => true;
	const no = async () => false;

	it('takes an explicit --from over everything else', async () => {
		const root = scratch();
		const given = join(root, 'handed-over.tar.gz');
		writeFileSync(given, 'x');
		mkdirSync(join(root, 'dist'), { recursive: true });
		writeFileSync(join(root, 'dist', payloadName('1.0.0')), 'x');

		expect(await resolvePayloadSource(root, 'v1.0.0', given, yes)).toEqual({
			kind: 'given',
			path: given
		});
	});

	it('refuses a --from that does not exist rather than falling through to the network', async () => {
		await expect(
			resolvePayloadSource(scratch(), 'v1.0.0', '/no/such.tar.gz', yes)
		).rejects.toThrow(/does not exist/);
	});

	it('takes a local dist/ tarball over a published release', async () => {
		// this is what `bun run release:payload` just built; re-downloading a release to test the
		// build that produced it would test the wrong bytes
		const root = scratch();
		mkdirSync(join(root, 'dist'), { recursive: true });
		const local = join(root, 'dist', payloadName('1.0.0'));
		writeFileSync(local, 'x');
		expect(await resolvePayloadSource(root, 'v1.0.0', undefined, yes)).toEqual({
			kind: 'dist',
			path: local
		});
	});

	it('probes for the release asset rather than trusting a tag', async () => {
		// a shallow clone has no tags, and a tag says nothing about whether the asset was attached
		const source = await resolvePayloadSource(scratch(), 'v1.0.0', undefined, yes);
		expect(source.kind).toBe('release');
		expect(source).toMatchObject({ tag: 'v1.0.0' });
	});

	it('reports no payload, with the reason, when nothing answers', async () => {
		const source = await resolvePayloadSource(scratch(), 'v9.9.9', undefined, no);
		expect(source.kind).toBe('none');
		expect(source).toMatchObject({ reason: expect.stringContaining('v9.9.9') });
	});
});

describe('the commands the docs and package.json promise', () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
		scripts: Record<string, string>;
	};

	it('wires the source route under its own name', () => {
		expect(pkg.scripts['build:local']).toContain('build-local.ts');
		expect(pkg.scripts['build:plan']).toContain('--dry-run');
	});

	it('keeps `build` on the payload route, which is what the deploy button runs', () => {
		// build:local needs Docker, PHP and composer; Workers Builds has none of them
		expect(pkg.scripts.build).toBe('bun run hydrate');
		expect(pkg.scripts.build).not.toContain('build:local');
	});

	it('runs every step through a script package.json actually declares', () => {
		const declared = new Set(Object.keys(pkg.scripts));
		const missing: string[] = [];
		for (const step of LOCAL_STEPS) {
			for (const command of [...step.commands(ROOT), ...(step.fallback?.commands ?? [])]) {
				if (
					command[0] === 'bun' &&
					command[1] === 'run' &&
					!declared.has(command[2] ?? '')
				) {
					missing.push(`${step.id}: bun run ${command[2]}`);
				}
				if (command[0] === 'bun' && command[1]?.startsWith('scripts/')) {
					if (!existsSync(join(ROOT, command[1])))
						missing.push(`${step.id}: ${command[1]}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it('documents every step in docs/building-from-source.md', () => {
		// the doc is the reason someone can follow this by hand, so a step it does not name is a step
		// nobody can run without reading the source
		const doc = readFileSync(join(ROOT, 'docs/building-from-source.md'), 'utf8');
		const undocumented = LOCAL_STEPS.filter((s) => !doc.includes(`\`${s.id}\``)).map(
			(s) => s.id
		);
		expect(undocumented).toEqual([]);
	});

	it('points the README at both routes', () => {
		const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
		expect(readme).toContain('bun run hydrate');
		expect(readme).toContain('bun run build:local');
		expect(readme).toContain('docs/building-from-source.md');
	});
});
