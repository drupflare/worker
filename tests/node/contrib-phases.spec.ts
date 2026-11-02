import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	composerFailure,
	conflicts,
	mismatches,
	renderSummary,
	requireNoConflicts,
	resolvePhases,
	restoreFiles,
	snapshotFiles,
	subjectOf,
	summarise,
	usageShare,
	type Report
} from '../../scripts/contrib-phases';
import { readModulesConfig, renderModules } from '../../scripts/gen-config';
import { censusPackages } from '../../scripts/install-census';
import { GENERATED_COLLISIONS } from '../../src/ops/generated/modules';

const COLLISIONS = {
	'drupal/b': { collides: ['drupal/a'], plugins: ['vendor/plug'] }
};

describe('collision phases', () => {
	it('keeps the collider in the base build and removes it only in the phase', () => {
		const plan = resolvePhases(['drupal/a', 'drupal/b', 'drupal/c'], COLLISIONS);
		expect(plan.base).toEqual(['drupal/a', 'drupal/c']);
		expect(plan.phases).toEqual([
			{ module: 'drupal/b', remove: ['drupal/a'], plugins: ['vendor/plug'] }
		]);
	});

	it('adds the packages a module sheds to what its phase removes, once each', () => {
		const plan = resolvePhases(['drupal/a', 'drupal/b', 'drupal/c'], {
			'drupal/b': { collides: ['drupal/a'], sheds: ['drupal/c', 'drupal/a'] }
		});
		expect(plan.phases[0]?.remove).toEqual(['drupal/a', 'drupal/c']);
	});

	it('refuses a collision that names a package the base build does not install', () => {
		expect(() => resolvePhases(['drupal/b'], COLLISIONS)).toThrow(
			/drupal\/b collides with drupal\/a, which/
		);
		expect(() => resolvePhases(['drupal/a'], COLLISIONS)).toThrow(/not in the census/);
	});

	it('fails with the conflict named when a declared collision is ignored', () => {
		const everything = ['drupal/a', 'drupal/b'];
		expect(conflicts(everything, COLLISIONS)).toEqual(['drupal/b collides with drupal/a']);
		expect(() => requireNoConflicts(everything, COLLISIONS)).toThrow(
			'drupal/b collides with drupal/a'
		);
		// one lock for the whole census is what the installer did before collisions existed
		expect(() => requireNoConflicts(censusPackages(), GENERATED_COLLISIONS)).toThrow(
			'drupal/simplesamlphp_auth collides with drupal/smtp'
		);
	});

	it('plans the declared collision of the real census with smtp present in the base', () => {
		const plan = resolvePhases(censusPackages(), GENERATED_COLLISIONS);
		expect(plan.base).toContain('drupal/smtp');
		expect(plan.base).not.toContain('drupal/simplesamlphp_auth');
		expect(plan.phases.map((p) => p.module)).toEqual(Object.keys(GENERATED_COLLISIONS));
		for (const [module, c] of Object.entries(GENERATED_COLLISIONS)) {
			for (const gone of c.collides) expect(plan.base, `${module}: ${gone}`).toContain(gone);
		}
	});

	it('reads the collisions from config/modules.yml, not from a second list', () => {
		const declared = readModulesConfig().modules;
		for (const [name, c] of Object.entries(GENERATED_COLLISIONS)) {
			expect(declared[name]?.collides).toEqual([...c.collides]);
		}
		expect(Object.keys(GENERATED_COLLISIONS).sort()).toEqual(
			Object.keys(declared)
				.filter((n) => declared[n]?.collides)
				.sort()
		);
	});
});

describe('a phase that pins a branch', () => {
	const PIN = { 'drupal/b': { collides: [], require: 'drupal/b:^3.0@alpha' } };

	it('keeps the module in the base and has the phase remove it, then require the branch', () => {
		const plan = resolvePhases(['drupal/a', 'drupal/b'], PIN);
		expect(plan.base).toEqual(['drupal/a', 'drupal/b']);
		expect(plan.phases).toEqual([
			{
				module: 'drupal/b',
				remove: ['drupal/b'],
				plugins: [],
				require: 'drupal/b:^3.0@alpha'
			}
		]);
	});

	it('still removes the sheds, after the module', () => {
		const plan = resolvePhases(['drupal/a', 'drupal/b'], {
			'drupal/b': { ...PIN['drupal/b'], sheds: ['drupal/a'] }
		});
		expect(plan.phases[0]?.remove).toEqual(['drupal/b', 'drupal/a']);
	});

	it('refuses a constraint that is not on the module', () => {
		expect(() =>
			resolvePhases(['drupal/b'], { 'drupal/b': { collides: [], require: 'drupal/a:^1' } })
		).toThrow(/drupal\/b requires drupal\/a:\^1, which is not a constraint on it/);
	});

	it('is read from config/modules.yml and carried into the generated registry', () => {
		const declared = readModulesConfig().modules;
		const pinned = Object.entries(GENERATED_COLLISIONS).filter(([, c]) => c.require);
		expect(pinned.map(([name]) => name)).toContain('drupal/openid_connect');
		for (const [name, c] of pinned) expect(declared[name]?.require).toBe(c.require);
		const config = {
			cron: { known: [], policy: {} },
			modules: { 'drupal/x': { collides: [], require: 'drupal/x:^2' } }
		};
		expect(renderModules(config)).toContain('require: "drupal/x:^2"');
		expect(
			renderModules({ ...config, modules: { 'drupal/x': { collides: [] } } })
		).not.toContain('require:');
	});

	it('plans openid_connect on the locked branch in the base and 3.x in its phase', () => {
		const plan = resolvePhases(censusPackages(), GENERATED_COLLISIONS);
		expect(plan.base).toContain('drupal/openid_connect');
		const phase = plan.phases.find((p) => p.module === 'drupal/openid_connect');
		expect(phase?.remove).toEqual(['drupal/openid_connect']);
		expect(phase?.require).toBe('drupal/openid_connect:^3.0@alpha');
	});

	it('puts the composer message in a failure, so a branch that did not resolve is named', () => {
		const error = composerFailure(
			['require', '--dev', 'drupal/b:^9'],
			2,
			'Problem 1\n  - Root composer.json requires drupal/b ^9 -> no matching package found.\n'
		);
		expect(error.message).toContain('composer require --dev drupal/b:^9 exited 2');
		expect(error.message).toContain('no matching package found');
		expect(composerFailure(['install'], 1, '').message).toBe('composer install exited 1');
	});

	it('restores the composer files after a phase that failed to resolve', () => {
		const dir = mkdtempSync(join(tmpdir(), 'contrib-phases-'));
		const files = [join(dir, 'composer.json'), join(dir, 'composer.lock')];
		for (const f of files) writeFileSync(f, 'before\n');
		const snap = join(dir, 'snap');
		try {
			snapshotFiles(files, snap);
			try {
				writeFileSync(files[0] as string, 'removed the module\n');
				throw composerFailure(['require', 'drupal/b:^9'], 2, 'no matching package');
			} catch {
				expect(mismatches(files, snap)).toEqual([files[0]]);
			} finally {
				restoreFiles(files, snap);
			}
			expect(mismatches(files, snap)).toEqual([]);
			expect(readFileSync(files[0] as string, 'utf8')).toBe('before\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the composer snapshot', () => {
	const setup = () => {
		const dir = mkdtempSync(join(tmpdir(), 'contrib-phases-'));
		const files = [join(dir, 'composer.json'), join(dir, 'composer.lock')];
		writeFileSync(files[0] as string, '{"a":1}\n');
		writeFileSync(files[1] as string, '{"b":2}\n');
		return { dir, files, snap: join(dir, 'snap') };
	};

	it('detects a restore that was skipped, and passes once the restore ran', () => {
		const { dir, files, snap } = setup();
		try {
			snapshotFiles(files, snap);
			expect(mismatches(files, snap)).toEqual([]);
			writeFileSync(files[1] as string, '{"b":3}\n');
			expect(mismatches(files, snap)).toEqual([files[1]]);
			restoreFiles(files, snap);
			expect(mismatches(files, snap)).toEqual([]);
			expect(readFileSync(files[1] as string, 'utf8')).toBe('{"b":2}\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reports a file the snapshot does not hold as a mismatch', () => {
		const { dir, files, snap } = setup();
		try {
			snapshotFiles([files[0] as string], snap);
			expect(mismatches(files, snap)).toEqual([files[1]]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

const report = (...rows: [string, string][]): Report => ({
	testResults: [{ assertionResults: rows.map(([title, status]) => ({ title, status })) }]
});

describe('the fixture run summary', () => {
	it('names the module a row belongs to, and nothing for a control', () => {
		expect(subjectOf('gin_toolbar: everything its own files declare is present')).toBe(
			'gin_toolbar'
		);
		expect(subjectOf('covers every contrib module the mounted pack carries')).toBeUndefined();
	});

	it('counts a base-run skip as unreached, which is what "2 passed, 66 skipped" hid', () => {
		const s = summarise(report(['a: x', 'passed'], ['b: x', 'skipped']), {}, true);
		expect(s).toMatchObject({ passed: 1, skipped: 1, failed: 0, unreached: ['b'] });
	});

	it('does not call a skip unreached when another row of the same module passed', () => {
		const s = summarise(report(['a: generated', 'skipped'], ['a: hand', 'passed']), {}, true);
		expect(s.unreached).toEqual([]);
		expect(s.verified).toEqual(['a']);
	});

	it('lets a module that owns a phase skip in the base run, and requires the phase to pass it', () => {
		const base = report(['a: x', 'passed'], ['saml: x', 'skipped']);
		const ok = summarise(
			base,
			{ saml: report(['saml: x', 'passed'], ['a: x', 'skipped']) },
			true
		);
		expect(ok.unreached).toEqual([]);
		expect(ok.passed).toBe(2);
		expect(ok.skipped).toBe(1);
		const idle = summarise(base, { saml: report(['saml: x', 'skipped']) }, true);
		expect(idle.unreached).toEqual(['saml']);
		const absent = summarise(base, { saml: {} }, true);
		expect(absent.unreached).toEqual(['saml']);
	});

	it('counts a pinned module only when each branch row passed in the build that has it', () => {
		const base = report(
			['oidc: generic', 'passed'],
			['oidc: 8.x-1', 'passed'],
			['oidc: 3.x', 'skipped']
		);
		const both = report(
			['oidc: generic', 'passed'],
			['oidc: 8.x-1', 'skipped'],
			['oidc: 3.x', 'passed']
		);
		const ok = summarise(base, { oidc: both }, true, [], [], ['oidc']);
		expect(ok.unreached).toEqual([]);
		expect(ok.verified).toEqual(['oidc']);
		const idle = report(
			['oidc: generic', 'passed'],
			['oidc: 8.x-1', 'skipped'],
			['oidc: 3.x', 'skipped']
		);
		const missed = summarise(base, { oidc: idle }, true, [], [], ['oidc']);
		expect(missed.unreached).toEqual(['oidc: 3.x']);
		expect(summarise(base, { oidc: both }, true, [], [], []).unreached).toEqual([]);
		expect(summarise(base, { oidc: {} }, true, [], [], ['oidc']).unreached).toEqual([
			'oidc',
			'oidc: 3.x'
		]);
	});

	it('names each failing module once and leaves it out of the verified list', () => {
		const s = summarise(
			report(
				['a: x', 'passed'],
				['a: y', 'failed'],
				['b: x', 'failed'],
				['b: y', 'failed'],
				['c: x', 'passed']
			),
			{},
			true
		);
		expect(s.failing).toEqual(['a', 'b']);
		expect(s.verified).toEqual(['c']);
	});

	it('lets a blocked module skip, which a module nothing blocks may not', () => {
		const base = report(['a: x', 'passed'], ['b: x', 'skipped']);
		expect(summarise(base, {}, true, [], ['b']).unreached).toEqual([]);
		expect(summarise(base, {}, true, [], []).unreached).toEqual(['b']);
	});

	it('reports a registry module with no passing row, so a smaller run cannot pass', () => {
		const base = report(['a: x', 'passed'], ['b: x', 'passed']);
		expect(summarise(base, {}, true, ['a', 'b']).missing).toEqual([]);
		expect(summarise(base, {}, true, ['a', 'b', 'c']).missing).toEqual(['c']);
		expect(summarise(base, {}, false, ['c']).missing).toEqual([]);
		expect(summarise(base, {}, true, ['a', 'c']).verified).toEqual(['a', 'b']);
		expect(renderSummary(summarise(base, {}, true, ['c']))).toContain('no passing row: c');
	});

	it('does not call a skip unreached when the caller filtered the base run', () => {
		expect(summarise(report(['b: x', 'skipped']), {}, false).unreached).toEqual([]);
	});

	it('prints the share only when given counts, and weighs by usage', () => {
		const s = summarise(report(['a: x', 'passed'], ['b: x', 'failed']), {}, true);
		expect(renderSummary(s)).not.toContain('Usage-weighted');
		const share = usageShare({ a: 75, b: 25 }, s.verified);
		expect(share).toEqual({ held: 75, total: 100, share: 0.75 });
		expect(renderSummary(s, share)).toContain('75 of 100 weekly installs, 75.00%');
		expect(renderSummary(s)).toContain('Failing: b');
	});
});
