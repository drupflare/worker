import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { deployArgs } from '../../scripts/e2e/corpus-deploy';
import {
	agreementFields,
	agreementForm,
	claimOwner,
	composerReplaces,
	composerRequires,
	contentTypeFrom,
	declaredNames,
	deliveredPackages,
	deployedOrigin,
	emptyNumbers,
	enabledExtensions,
	errorFieldNames,
	filledFlags,
	fixtureStatus,
	formHtml,
	formValues,
	haltedBeat,
	infoRequires,
	lostServer,
	mergeResults,
	missingDependency,
	moduleDir,
	nativeCause,
	nativeLibraries,
	readableNote,
	recordDeployed,
	redirectTarget,
	refusalFor,
	remoteServer,
	renderMatrix,
	requiredText,
	routePaths,
	setAside,
	settleRows,
	unknownRows,
	unresolvedFailure,
	unsettled,
	updateNote,
	waitForTimingLock,
	type Compatibility,
	type Corpus,
	type RowState
} from '../../scripts/e2e/corpus-lane';
import {
	admitsDrupal11,
	installPath,
	lockedContrib,
	nativePlan,
	needsProfileSwitch,
	projectPlan,
	upgradeNote
} from '../../scripts/e2e/corpus-project';
import { hiddenFields } from '../../scripts/e2e/live-deploy';

/**
 * The compatibility matrix is generated, so what the generator does with a missing or stale result
 * decides whether the published page can claim more than a run asserted.
 */

const corpus: Corpus = {
	rows: ['install', 'anon render'],
	repos: [
		{
			id: 'alpha',
			repo: 'https://example.invalid/alpha',
			sha: 'a'.repeat(40),
			shape: 'module',
			core: '^11',
			install: 'modify',
			assessment: 'runs',
			needs: []
		},
		{
			id: 'beta',
			repo: 'https://example.invalid/beta',
			sha: 'b'.repeat(40),
			shape: 'project',
			core: '^11',
			install: 'project',
			assessment: 'structural',
			needs: ['core-patches']
		}
	]
};

describe('the compatibility matrix', () => {
	it('prints unknown and never for a repository nothing has run against', () => {
		const md = renderMatrix({ rows: corpus.rows, repos: {} }, corpus);
		expect(md).toContain(
			'| [beta](https://example.invalid/beta) | `bbbbbbbb` | pending | never | unknown | unknown |'
		);
	});

	it('prints the date and each row a run asserted, with its note', () => {
		const file: Compatibility = {
			rows: corpus.rows,
			repos: {
				alpha: {
					sha: 'a'.repeat(40),
					lane: 'fixture',
					run: 'local:x',
					date: '2026-09-28',
					rows: {
						install: { state: 'inline' },
						'anon render': { state: 'degraded', note: 'fell back' }
					}
				}
			}
		};
		const md = renderMatrix(file, corpus);
		expect(md).toContain(
			'| [alpha](https://example.invalid/alpha) | `aaaaaaaa` | verified | 2026-09-28 | inline | degraded |'
		);
		expect(md).toContain('- **alpha**\n  - anon render: fell back');
	});

	const allRows = (state: RowState, note?: string) =>
		Object.fromEntries(corpus.rows.map((r) => [r, note ? { state, note } : { state }]));

	it('gives each repository the state the fixtures page shows', () => {
		const sha = 'a'.repeat(40);
		const base = { sha, lane: 'fixture', run: 'r', date: '2026-09-29' };
		expect(fixtureStatus(undefined, sha, 2)).toBe('pending');
		expect(fixtureStatus({ ...base, rows: allRows('inline') }, sha, 2)).toBe('verified');
		expect(fixtureStatus({ ...base, rows: allRows('inline') }, 'b'.repeat(40), 2)).toBe(
			'pending'
		);
		expect(
			fixtureStatus(
				{
					...base,
					rows: allRows('degraded'),
					deployed: {
						sha,
						run: 'd',
						date: '2026-09-30',
						plan: 'paid',
						rows: allRows('parked')
					}
				},
				sha,
				2
			)
		).toBe('deployed');
		expect(
			fixtureStatus(
				{
					...base,
					rows: allRows('inline'),
					deployed: {
						sha,
						run: 'd',
						date: '2026-09-30',
						plan: 'paid',
						rows: {
							install: { state: 'inline' },
							'anon render': { state: 'unsupported' }
						}
					}
				},
				sha,
				2
			)
		).toBe('verified');
		expect(
			fixtureStatus(
				{ ...base, rows: allRows('unsupported', 'needs upgrade: core 8.x') },
				sha,
				2
			)
		).toBe('needs upgrade');
		expect(
			fixtureStatus(
				{
					...base,
					rows: { install: { state: 'inline' }, 'anon render': { state: 'unsupported' } }
				},
				sha,
				2
			)
		).toBe('1 of 2');
		expect(fixtureStatus({ ...base, rows: allRows('unsupported', 'x') }, sha, 2)).toBe(
			'unsupported'
		);
	});

	it('prints a status column, the deployed run, and a note shared by every row once', () => {
		const sha = 'a'.repeat(40);
		const file: Compatibility = {
			rows: corpus.rows,
			repos: {
				alpha: {
					sha,
					lane: 'fixture',
					run: 'r',
					date: '2026-09-29',
					rows: allRows('inline'),
					deployed: {
						sha,
						run: 'd',
						date: '2026-09-30',
						plan: 'paid',
						rows: allRows('inline')
					}
				},
				beta: {
					sha: 'b'.repeat(40),
					lane: 'fixture',
					run: 'r',
					date: '2026-09-29',
					rows: allRows(
						'unsupported',
						'needs upgrade: core 8.x does not accept Drupal 11'
					)
				}
			}
		};
		const md = renderMatrix(file, corpus);
		expect(md).toContain('| [alpha](https://example.invalid/alpha) | `aaaaaaaa` | deployed |');
		expect(md).toContain('1 deployed, 0 verified');
		expect(md).toContain('## Deployed Runs');
		expect(md).toContain(
			'| [alpha](https://example.invalid/alpha) | `aaaaaaaa` | 2026-09-30 | paid | 2 of 2 |'
		);
		expect(md.match(/needs upgrade: core 8\.x/g)).toHaveLength(1);
	});

	it('reads a prepare-and-drain note instead of printing its JSON', () => {
		expect(
			readableNote(
				'prepare {"action":"prepare","ran":{"ok":true,"run":{"id":"rmun7zpqu","schemaVersion":1,"phase":"planning","cursorSeq":0,"maxSeq"; drain {"action":"drain","ran":{"beats":[{"ok":true,"beat":"none","ran":false,"more":false,"runId":"rmun7zpqu","phase":"complet'
			)
		).toBe('prepared run rmun7zpqu; drained to phase complete, with no unit to run');
		expect(
			updateNote(
				{ action: 'prepare', ran: { ok: true, run: { id: 'r1', phase: 'planning' } } },
				{
					action: 'drain',
					ran: { beats: [{ ok: true, beat: 'run', ran: true, phase: 'complete' }] }
				}
			)
		).toBe('prepared run r1; drained to phase complete');
		expect(readableNote('fell back')).toBe('fell back');
	});

	it('does not date a result taken at another commit', () => {
		const file: Compatibility = {
			rows: corpus.rows,
			repos: {
				alpha: {
					sha: 'c'.repeat(40),
					lane: 'fixture',
					run: 'r',
					date: '2026-01-01',
					rows: unknownRows(corpus.rows)
				}
			}
		};
		expect(renderMatrix(file, corpus)).toContain('`aaaaaaaa` | pending | never |');
	});

	it('replaces only the repositories a run covered', () => {
		const old: Compatibility = {
			rows: ['install'],
			repos: {
				alpha: {
					sha: 'a',
					lane: 'l',
					run: 'old',
					date: 'd',
					rows: unknownRows(['install'])
				}
			}
		};
		const ran = {
			beta: {
				sha: 'b',
				lane: 'l',
				run: 'new',
				date: 'd',
				rows: unknownRows(['install'], 'why')
			}
		};
		const merged = mergeResults(old, corpus.rows, ran);
		expect(Object.keys(merged.repos).sort()).toEqual(['alpha', 'beta']);
		expect(merged.rows).toEqual(corpus.rows);
		expect(merged.repos.beta?.rows.install).toEqual({ state: 'unknown', note: 'why' });
	});
});

describe('finding a module inside a clone', () => {
	it('takes the shallowest info file and skips vendor and tests', () => {
		const root = mkdtempSync(join(tmpdir(), 'corpus-'));
		try {
			for (const dir of ['vendor/x/mod', 'tests/fixtures/mod', 'web/modules/custom/mod']) {
				mkdirSync(join(root, dir), { recursive: true });
				writeFileSync(join(root, dir, 'mod.info.yml'), 'name: mod');
			}
			expect(moduleDir(root, 'mod')).toBe(join(root, 'web/modules/custom/mod'));
			expect(moduleDir(root, 'absent')).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('what a repository asks the registry for', () => {
	it('keeps packages and drops the platform, extensions and core', () => {
		const root = mkdtempSync(join(tmpdir(), 'corpus-'));
		try {
			writeFileSync(
				join(root, 'composer.json'),
				JSON.stringify({
					require: {
						php: '>=8.1',
						'ext-json': '*',
						'drupal/core': '^11',
						'drupal/core-recommended': '^11',
						'composer/installers': '^2',
						'open-y-subprojects/openy_custom': '^3.2.0',
						'drupal/token': '^1.13'
					}
				})
			);
			expect(composerRequires(root)).toEqual({
				'open-y-subprojects/openy_custom': '^3.2.0',
				'drupal/token': '^1.13'
			});
			expect(composerRequires(join(root, 'absent'))).toEqual({});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('what the info files ask the registry for', () => {
	it('fetches a contrib dependency the clone lacks, with its range, and never core', () => {
		const root = mkdtempSync(join(tmpdir(), 'corpus-'));
		try {
			mkdirSync(join(root, 'modules', 'sub'), { recursive: true });
			writeFileSync(
				join(root, 'main.info.yml'),
				'name: main\ndependencies:\n  - drupal:user\n  - simple_oauth:simple_oauth (>=6.0.3, <7.0)\n  - main:sub\n  - token:token\n'
			);
			writeFileSync(join(root, 'modules', 'sub', 'sub.info.yml'), 'name: sub');
			expect(infoRequires(root, ['main'])).toEqual({
				'drupal/simple_oauth': '>=6.0.3,<7.0',
				'drupal/token': ''
			});
			expect(infoRequires(root, ['absent'])).toEqual({});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('config/corpus.yml', () => {
	const file = parse(readFileSync(resolve(process.cwd(), 'config/corpus.yml'), 'utf8')) as Corpus;

	it('pins every repository to a full commit and a known install path', () => {
		for (const repo of file.repos) {
			expect(repo.sha, repo.id).toMatch(/^[0-9a-f]{40}$/);
			expect(['modify', 'project', 'profile', 'none'], repo.id).toContain(repo.install);
			expect(Array.isArray(repo.needs), repo.id).toBe(true);
		}
		expect(new Set(file.repos.map((r) => r.id)).size).toBe(file.repos.length);
	});

	it('names a module for every repository the lane installs by upload', () => {
		for (const repo of file.repos.filter(
			(r) => r.install === 'modify' && r.shape !== 'modules'
		)) {
			expect(repo.modules?.length ?? 0, repo.id).toBeGreaterThan(0);
		}
	});
});

describe('a repository that needs the Drupal 10 to 11 upgrade', () => {
	it('is refused by a real constraint check', () => {
		for (const core of ['10.6.15', '^10.5.6', '^10.0', '10.3.13', '8.x', '9.1.0']) {
			expect(admitsDrupal11(core), core).toBe(false);
			expect(upgradeNote(core), core).toMatch(/^needs upgrade: core /);
		}
	});

	it('names the version the upgrade starts from', () => {
		expect(upgradeNote('^10.5.6')).toContain('drangler plans the 10 -> 11 upgrade');
		expect(upgradeNote('8.x')).toContain('from Drupal 8');
		expect(upgradeNote('9.1.0')).toContain('from Drupal 9');
		expect(upgradeNote('8.x')).not.toContain('10 -> 11');
	});

	it('admits anything that accepts an 11.x release, and a repository with no core claim', () => {
		for (const core of [
			'^11',
			'^10 || ^11',
			'~11.4.8',
			'11.3.13',
			'^11.4.7',
			'~11.3.0',
			'n/a'
		]) {
			expect(admitsDrupal11(core), core).toBe(true);
			expect(upgradeNote(core), core).toBeNull();
		}
	});
});

describe("the native build's libraries", () => {
	it('are named by an absolute path, because the path becomes a symlink target', () => {
		// a relative --native left the libraries link dangling and drangler failed the land
		const root = mkdtempSync(join(tmpdir(), 'corpus-libs-'));
		mkdirSync(join(root, 'site', 'web', 'libraries'), { recursive: true });
		const found = nativeLibraries(relative(process.cwd(), root));
		rmSync(root, { recursive: true, force: true });
		expect(found !== null && isAbsolute(found), String(found)).toBe(true);
	});
});

describe('rows a run did not reach', () => {
	it('reads unsupported with the install verdict, and leaves a crash unknown', () => {
		const rows = unknownRows(['install', 'anon render']);
		rows['install'] = { state: 'unsupported', note: 'enabling x was refused' };
		expect(settleRows(rows)['anon render']).toEqual({
			state: 'unsupported',
			note: 'not reached: install enabling x was refused'
		});
		const crashed = unknownRows(['install', 'anon render'], 'the lane failed');
		expect(settleRows(crashed)).toEqual(crashed);
		expect(unsettled(['a', 'b'], 'why').b).toEqual({ state: 'unsupported', note: 'why' });
	});
});

describe('what a project asks of a site', () => {
	const build = (extra: Record<string, unknown>, sync?: string) => {
		const root = mkdtempSync(join(tmpdir(), 'corpus-'));
		writeFileSync(
			join(root, 'composer.json'),
			JSON.stringify({
				require: {
					'drupal/core-recommended': '^11',
					'drupal/token': '^1.13',
					'drush/drush': '^13',
					'cweagans/composer-patches': '^1',
					'acme/lib': '^2'
				},
				extra: { patches: { 'drupal/token': { one: 'a.patch', two: 'b.patch' } } },
				...extra
			})
		);
		writeFileSync(
			join(root, 'composer.lock'),
			JSON.stringify({
				packages: [
					{ name: 'drupal/token', version: '1.15.0', type: 'drupal-module' },
					{ name: 'acme/lib', version: 'v2.1.0', type: 'library' },
					{ name: 'cweagans/composer-patches', version: '1.7.3', type: 'composer-plugin' }
				]
			})
		);
		mkdirSync(join(root, 'web/modules/custom/mine'), { recursive: true });
		writeFileSync(
			join(root, 'web/modules/custom/mine/mine.info.yml'),
			'name: mine\ntype: module\n'
		);
		mkdirSync(join(root, 'web/modules/contrib/other'), { recursive: true });
		writeFileSync(
			join(root, 'web/modules/contrib/other/other.info.yml'),
			'name: other\ntype: module\n'
		);
		if (sync) {
			mkdirSync(join(root, 'config/sync'), { recursive: true });
			writeFileSync(join(root, 'config/sync/core.extension.yml'), sync);
		}
		return root;
	};

	it('installs locked versions from the registry and uploads only the custom code', () => {
		const root = build(
			{},
			'module:\n  token: 0\n  mine: 0\n  minimal: 1000\nprofile: minimal\n'
		);
		try {
			const plan = projectPlan(root);
			expect(plan.packages).toEqual({ 'drupal/token': '1.15.0', 'acme/lib': '2.1.0' });
			expect(plan.custom.map((c) => c.name)).toEqual(['mine']);
			expect(plan.modules).toEqual(['token', 'mine']);
			expect(plan.patches).toBe(2);
			expect(plan.profile).toBe('minimal');
			expect(needsProfileSwitch(plan)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('needs a profile switch for a profile the pack site is not installed on', () => {
		const root = build({}, 'module:\n  token: 0\nprofile: herbie\n');
		try {
			expect(needsProfileSwitch(projectPlan(root))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reads a repository that is itself a profile', () => {
		const root = build({ type: 'drupal-profile' });
		try {
			expect(needsProfileSwitch(projectPlan(root))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('forms sharing a page', () => {
	it('reads the hidden fields of the named form and not its neighbour', () => {
		const body = [
			'<form id="b"><input type="hidden" name="form_id" value="system_clear_cache"/></form>',
			'<form id="a"><input type="hidden" name="form_id" value="system_performance_settings"/></form>'
		].join('\n');
		expect(hiddenFields(formHtml(body, 'system_clear_cache')!)['form_id']).toBe(
			'system_clear_cache'
		);
		// Drupal 11's id; the probe asked for a `_form` suffix that no form carries
		expect(formHtml(body, 'system_clear_cache_form')).toBeNull();
		// the whole page reads the later form, which is how the probe ran Save configuration
		expect(hiddenFields(body)['form_id']).toBe('system_performance_settings');
		expect(formHtml(body, 'absent')).toBeNull();
	});
});

describe('module-shaped repositories', () => {
	const entry = (over: Record<string, string>) =>
		({
			id: 'x',
			repo: 'https://example.invalid/x',
			sha: 'abc',
			shape: 'module',
			core: '^11',
			install: 'modify',
			assessment: 'runs',
			needs: [],
			...over
		}) as Corpus['repos'][number];

	it('refuses a composer plugin and a core below Drupal 10, and runs the rest', () => {
		expect(refusalFor(entry({ shape: 'composer-plugin', core: 'n/a' }))).toMatch(
			/^not a site:/
		);
		expect(refusalFor(entry({ core: '8.x', install: 'none' }))).toMatch(/^needs upgrade:/);
		expect(refusalFor(entry({ core: '^10 || ^11' }))).toBeNull();
	});

	it('reads the static GET paths a routing file declares', () => {
		const yml = [
			'a.report:',
			"  path: '/admin/reports/a'",
			'  defaults:',
			"    _controller: 'Drupal\\a\\C::report'",
			'a.item:',
			"  path: '/a/{id}'",
			'  defaults:',
			"    _controller: 'Drupal\\a\\C::item'",
			'a.post:',
			"  path: '/a/post'",
			'  methods: [POST]',
			'  defaults:',
			"    _controller: 'Drupal\\a\\C::post'",
			'a.json:',
			"  path: '/a/list.json'",
			'  defaults:',
			"    _controller: 'Drupal\\a\\C::list'"
		].join('\n');
		expect(routePaths(yml)).toEqual(['/admin/reports/a']);
		expect(routePaths('')).toEqual([]);
	});

	it('names the dependency an installer refusal is missing', () => {
		expect(
			missingDependency(
				"Unable to install modules: module 'a' is missing its dependency module openy_map."
			)
		).toBe('openy_map');
		expect(
			missingDependency('Unable to install modules a due to missing modules a.')
		).toBeNull();
	});
});

describe('migrating a distribution', () => {
	const tree = (files: Record<string, string>) => {
		const root = mkdtempSync(join(tmpdir(), 'cfw-corpus-mig-'));
		for (const [name, text] of Object.entries(files)) {
			mkdirSync(join(root, name, '..'), { recursive: true });
			writeFileSync(join(root, name), text);
		}
		return root;
	};
	const plan = (profile: string | null) => ({
		profile,
		packages: {},
		custom: [],
		modules: [],
		patches: 0
	});

	it('takes the migration path for a profile install and for a project on another profile', () => {
		expect(installPath('profile', plan(null))).toBe('migration');
		expect(installPath('project', plan('herbie'))).toBe('migration');
	});

	it('keeps registry delivery for a project on a hosted profile', () => {
		expect(installPath('project', plan('standard'))).toBe('registry');
		expect(installPath('project', plan(null))).toBe('registry');
	});

	it('installs a profile package through its documented template, and a project as it stands', () => {
		const profile = tree({
			'composer.json': JSON.stringify({
				name: 'thunder/thunder-distribution',
				type: 'drupal-profile'
			}),
			'thunder.info.yml': 'type: profile\nname: Thunder\n'
		});
		const project = tree({
			'composer.json': JSON.stringify({ name: 'acme/site', type: 'project' }),
			'config/sync/core.extension.yml': 'module:\n  token: 0\nprofile: herbie\n'
		});
		try {
			expect(nativePlan(profile, projectPlan(profile))).toEqual({
				kind: 'profile',
				profile: 'thunder',
				pkg: 'thunder/thunder-distribution',
				template: 'thunder/thunder-project'
			});
			expect(nativePlan(project, projectPlan(project))).toMatchObject({
				kind: 'project',
				profile: 'herbie',
				template: null
			});
		} finally {
			rmSync(profile, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it('lists only the locked modules and themes, at their locked versions, without the profile', () => {
		const site = tree({
			'composer.lock': JSON.stringify({
				packages: [
					{ name: 'drupal/token', version: '1.15.0', type: 'drupal-module' },
					{ name: 'drupal/gin', version: 'v5.0.1', type: 'drupal-theme' },
					{ name: 'drupal/dev', version: 'dev-main', type: 'drupal-module' },
					{ name: 'drupal/thunder', version: '7.0.0', type: 'drupal-module' },
					{ name: 'drupal/core', version: '11.4.7', type: 'drupal-core' },
					{ name: 'symfony/yaml', version: 'v7.4.0', type: 'library' }
				]
			})
		});
		try {
			expect(lockedContrib(site, 'thunder')).toEqual({
				'drupal/token': '1.15.0',
				'drupal/gin': '5.0.1',
				'drupal/dev': ''
			});
		} finally {
			rmSync(site, { recursive: true, force: true });
		}
	});

	it('adds a library the site requires directly, and only that one', () => {
		const site = tree({
			'composer.lock': JSON.stringify({
				packages: [
					{ name: 'drupal/token', version: '1.15.0', type: 'drupal-module' },
					{ name: 'symfony/ai-platform', version: 'v0.12.0', type: 'library' },
					{ name: 'symfony/yaml', version: 'v7.4.0', type: 'library' }
				]
			})
		});
		try {
			expect(lockedContrib(site, 'none', ['symfony/ai-platform'])).toEqual({
				'drupal/token': '1.15.0',
				'symfony/ai-platform': '0.12.0'
			});
		} finally {
			rmSync(site, { recursive: true, force: true });
		}
	});

	it('lists a dependency before the package that needs it', () => {
		const site = tree({
			'composer.lock': JSON.stringify({
				packages: [
					{
						name: 'drupal/term_merge',
						version: '2.0.0',
						type: 'drupal-module',
						require: { 'drupal/term_reference_change': '*' }
					},
					{
						name: 'drupal/term_reference_change',
						version: '2.0.0-beta5',
						type: 'drupal-module'
					},
					{
						name: 'drupal/a_cycle',
						version: '1.0.0',
						type: 'drupal-module',
						require: { 'drupal/b_cycle': '*' }
					},
					{
						name: 'drupal/b_cycle',
						version: '1.0.0',
						type: 'drupal-module',
						require: { 'drupal/a_cycle': '*' }
					}
				]
			})
		});
		try {
			const order = Object.keys(lockedContrib(site, 'none'));
			expect(order.indexOf('drupal/term_reference_change')).toBeLessThan(
				order.indexOf('drupal/term_merge')
			);
			// a cycle still lists both, once each
			expect(order.filter((n) => n.endsWith('_cycle')).sort()).toEqual([
				'drupal/a_cycle',
				'drupal/b_cycle'
			]);
			expect(lockedContrib(site, 'none')['drupal/term_reference_change']).toBe('2.0.0-beta5');
		} finally {
			rmSync(site, { recursive: true, force: true });
		}
	});

	it('does not wait when nobody holds the timing lock', () => {
		const started = Date.now();
		waitForTimingLock(join(tmpdir(), 'cfw-no-such-timing-lock'));
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe('setting the pack aside for a migrated run', () => {
	const tree = () => {
		const root = mkdtempSync(join(tmpdir(), 'cfw-swap-'));
		mkdirSync(join(root, 'assets/drupal'), { recursive: true });
		writeFileSync(join(root, 'assets/drupal/site.sqlite'), 'pack');
		writeFileSync(join(root, 'assets/.assetsignore'), 'ignore');
		return root;
	};

	it('copies the pack aside', () => {
		const root = tree();
		const kept = setAside(root);
		expect(readFileSync(kept('assets/drupal/site.sqlite'), 'utf8')).toBe('pack');
		rmSync(root, { recursive: true });
	});

	it('puts back a copy a killed run left aside instead of setting its database aside', () => {
		const root = tree();
		setAside(root);
		// the killed run landed its own database and never restored
		writeFileSync(join(root, 'assets/drupal/site.sqlite'), 'thunder');
		const kept = setAside(root);
		expect(readFileSync(join(root, 'assets/drupal/site.sqlite'), 'utf8')).toBe('pack');
		expect(readFileSync(kept('assets/drupal/site.sqlite'), 'utf8')).toBe('pack');
		rmSync(root, { recursive: true });
	});
});

describe('telling a gone dev server from a site that answered badly', () => {
	it('restarts for a refused or dropped connection', () => {
		expect(
			lostServer(new Error('Unable to connect. Is the computer able to access the url?'))
		).toBe(true);
		expect(lostServer(new Error('The socket connection was closed unexpectedly.'))).toBe(true);
		expect(lostServer(new Error('drangler: Error: Network connection lost.'))).toBe(true);
		expect(lostServer(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }))).toBe(
			true
		);
	});

	it('does not restart for a timeout or anything that is not an error', () => {
		expect(lostServer(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(
			false
		);
		expect(lostServer('Unable to connect')).toBe(false);
	});
});

describe('choosing a content type for the create probe', () => {
	it('takes page when offered, then article, then the first the site lists', () => {
		const list = (...t: string[]) => t.map((x) => `<a href="/node/add/${x}">${x}</a>`).join('');
		expect(contentTypeFrom(list('article', 'page'))).toBe('page');
		expect(contentTypeFrom(list('blog', 'article'))).toBe('article');
		expect(contentTypeFrom(list('govcms_blog_article', 'govcms_standard_page'))).toBe(
			'govcms_blog_article'
		);
		expect(contentTypeFrom('<p>no types</p>')).toBeNull();
	});
});

describe('filling what a content type requires', () => {
	it('fills empty required text inputs and textareas, and leaves the rest', () => {
		const html = [
			'<input type="text" name="title[0][value]" required="required" value="">',
			'<textarea name="field_description[0][value]" required="required"></textarea>',
			'<input type="email" name="field_mail[0][value]" required="required">',
			'<input type="number" name="weight" required="required">',
			'<input type="text" name="field_optional[0][value]" value="">',
			'<input type="text" name="field_kept[0][value]" required="required" value="set">'
		].join('');
		expect(requiredText(html)).toEqual({
			'title[0][value]': 'corpus',
			'field_description[0][value]': 'corpus',
			'field_mail[0][value]': 'corpus@example.com',
			// farmOS's log categories require a weight
			weight: '0'
		});
	});
});

describe('reading a database update drain', () => {
	it('names the halt a drain that answered 200 ended on', () => {
		const drained = {
			ran: {
				beats: [
					{ ok: true, more: true },
					{
						ok: false,
						more: false,
						reason: 'requirements-error',
						detail: 'php_extensions'
					}
				]
			}
		};
		expect(haltedBeat(drained)).toBe('the run halted: requirements-error: php_extensions');
	});

	it('is null for a clean drain or one with no beats', () => {
		expect(haltedBeat({ ran: { beats: [{ ok: true, more: false }] } })).toBeNull();
		expect(haltedBeat({})).toBeNull();
	});
});

describe('naming what stopped a native install', () => {
	it('skips patch skips and warnings for the error that ended the install', () => {
		expect(
			nativeCause([
				'Could not apply patch! Skipping. The error was: Cannot apply patch x.patch',
				'[warning] Program sqlite3 not found.',
				'[error]  TypeError: ClassLocation::__construct(): Argument #6 must be of type EntityTypeManager',
				'#0 trace',
				'#1 trace',
				'#2 trace'
			])
		).toBe(
			'[error]  TypeError: ClassLocation::__construct(): Argument #6 must be of type EntityTypeManager | #0 trace | #1 trace'
		);
	});

	it('keeps the message under a Symfony In-file header and a composer problem', () => {
		expect(
			nativeCause(['In ViewsData.php line 141:', 'A valid cache entry key is required.', 'x'])
		).toBe('In ViewsData.php line 141: | A valid cache entry key is required. | x');
		expect(
			nativeCause(['Problem 1', '- Root composer.json requires a/b', '- a/b requires c/d'])
		).toContain('Root composer.json requires a/b');
	});
});

describe('reading what a repository replaces', () => {
	it('names each replaced package, and nothing for a repository without composer.json', () => {
		const root = mkdtempSync(join(tmpdir(), 'cfw-replace-'));
		expect(composerReplaces(root).size).toBe(0);
		writeFileSync(
			join(root, 'composer.json'),
			JSON.stringify({ replace: { 'drupal/openy_activity_finder': '*' } })
		);
		expect([...composerReplaces(root)]).toEqual(['drupal/openy_activity_finder']);
		rmSync(root, { recursive: true });
	});
});

describe('recognising a PHP error page', () => {
	it('matches what PHP and Drupal print, not page text that names an exception', async () => {
		const { ERROR_PAGE } = await import('../../scripts/e2e/live-deploy');
		expect(ERROR_PAGE.test('Uncaught Error: Call to undefined function x()')).toBe(true);
		expect(ERROR_PAGE.test('The website encountered an unexpected error.')).toBe(true);
		expect(
			ERROR_PAGE.test('<a href="/x?hash=d88">Uncaught Exception</a> Uncaught Exception')
		).toBe(false);
	});
});

describe('reading what a migrated site enables', () => {
	it('lists every module and theme in core.extension', async () => {
		const { DatabaseSync } = await import('node:sqlite');
		const root = mkdtempSync(join(tmpdir(), 'cfw-ext-'));
		const db = new DatabaseSync(join(root, 'site.sqlite'));
		db.exec('CREATE TABLE config (collection TEXT, name TEXT, data BLOB)');
		db.prepare("INSERT INTO config VALUES ('', 'core.extension', ?)").run(
			new TextEncoder().encode(
				'a:2:{s:6:"module";a:2:{s:5:"block";i:0;s:4:"node";i:0;}s:5:"theme";a:1:{s:4:"olivero";i:0;}}'
			)
		);
		db.close();
		expect([...enabledExtensions(join(root, 'site.sqlite'))].sort()).toEqual([
			'block',
			'node',
			'olivero'
		]);
		rmSync(root, { recursive: true });
	});

	it('reads a WAL database whose -shm file is gone, the shape a native install leaves', async () => {
		// a read-only open of a WAL database has to create the -shm file and cannot: the deployed
		// Thunder lane failed every row on `unable to open database file` after a good claim
		const { DatabaseSync } = await import('node:sqlite');
		const root = mkdtempSync(join(tmpdir(), 'cfw-ext-'));
		const db = new DatabaseSync(join(root, 'site.sqlite'));
		db.exec('PRAGMA journal_mode = WAL');
		db.exec('CREATE TABLE config (collection TEXT, name TEXT, data BLOB)');
		db.prepare("INSERT INTO config VALUES ('', 'core.extension', ?)").run(
			new TextEncoder().encode('a:1:{s:6:"module";a:1:{s:4:"node";i:0;}}')
		);
		db.close();
		// under bun first, which runs the lane and ships its own node:sqlite: node opens this
		// shape fine, and its read leaves an -shm file behind that would hide the defect
		const lane = resolve(import.meta.dirname, '../../scripts/e2e/corpus-lane.ts');
		const underBun = spawnSync(
			'bun',
			[
				'-e',
				`import { enabledExtensions } from ${JSON.stringify(lane)}; console.log([...enabledExtensions(${JSON.stringify(join(root, 'site.sqlite'))})].join(','))`
			],
			{ encoding: 'utf8' }
		);
		expect(underBun.stderr.slice(-300)).not.toMatch(/unable to open/);
		expect(underBun.stdout.trim()).toBe('node');
		expect([...enabledExtensions(join(root, 'site.sqlite'))]).toEqual(['node']);
		rmSync(root, { recursive: true });
	});
});

describe('an interstitial in front of the administration pages', () => {
	const terms = `<form action="/admin/openy/terms-and-conditions" method="post">
<input type="checkbox" name="participant" value="1" class="form-checkbox" />
<input type="checkbox" name="llc" class="form-checkbox" />
<input type="hidden" name="agree_openy_terms" value="" />
<input type="hidden" name="form_build_id" value="form-abc" />
<input type="submit" name="op" value="Accept Terms and Conditions" class="button" />
</form>`;

	it('finds the form that asks for agreement and no other', () => {
		expect(
			agreementForm(
				`<form><input type="text" name="q"><input type="submit" value="Go"></form>${terms}`
			)
		).toBe(terms);
		expect(agreementForm('<form><input type="submit" value="Go"></form>')).toBeNull();
		expect(agreementForm('<p>nothing</p>')).toBeNull();
	});

	it('ticks every box, keeps the hidden tokens and presses the first button', () => {
		expect(agreementFields(terms)).toEqual({
			participant: '1',
			llc: '1',
			agree_openy_terms: '',
			form_build_id: 'form-abc',
			op: 'Accept Terms and Conditions'
		});
	});

	it('follows a redirect only when it stays on the site', () => {
		const at = (status: number, location: string | null) =>
			redirectTarget(
				{ status, headers: new Headers(location === null ? {} : { location }) },
				'http://localhost:8981'
			);
		expect(at(302, '/admin/openy/terms-and-conditions')).toBe(
			'/admin/openy/terms-and-conditions'
		);
		expect(at(303, 'http://localhost:8981/user/1?x=2')).toBe('/user/1?x=2');
		expect(at(302, 'https://elsewhere.example/login')).toBeNull();
		expect(at(200, '/admin')).toBeNull();
		expect(at(302, null)).toBeNull();
	});
});

describe('what the lane delivered', () => {
	it('keeps packages of any vendor and drops core, its bundles and its scaffold', () => {
		expect(
			deliveredPackages([
				'ycloudyusa/yusaopeny_ymca360',
				'drupal/token',
				'drupal/core',
				'drupal/core-recommended',
				'drupal/core-composer-scaffold',
				'drupal/token',
				'farmos/farmos',
				'govcms'
			])
		).toEqual(['drupal/token', 'farmos/farmos', 'ycloudyusa/yusaopeny_ymca360']);
	});

	it('names each module, theme and profile an upload declares and skips test fixtures', () => {
		expect(
			declaredNames([
				'profiles/custom/govcms/govcms.info.yml',
				'modules/custom/a/a.info.yml',
				'modules/custom/a/tests/modules/a_test/a_test.info.yml',
				'themes/custom/t/t.info.yml',
				'modules/custom/a/composer.json'
			])
		).toEqual(['a', 'govcms', 't']);
	});
});

describe('an install failure judged after the whole delivery', () => {
	const line =
		'drupal/lb_cards 3.0.3: drupal/twig_tweak: the dependency graph is larger than one install may take; drupal/colorbutton: no version of drupal/colorbutton matches ^1; acme/lib: metadata 404 for acme/lib';

	it('drops a package delivered later and a module the site never enables, and keeps the rest', () => {
		expect(unresolvedFailure(line, new Set(['drupal/twig_tweak']), new Set(['lb_cards']))).toBe(
			'drupal/lb_cards 3.0.3: acme/lib: metadata 404 for acme/lib'
		);
	});

	it('counts a library as held once its directory is under libraries/', () => {
		expect(
			unresolvedFailure(line, new Set(['drupal/twig_tweak', 'lib:lib']), new Set())
		).toBeNull();
	});

	it('resolves the whole line once nothing it names is missing', () => {
		expect(
			unresolvedFailure(line, new Set(['drupal/twig_tweak', 'acme/lib']), new Set())
		).toBeNull();
	});

	it('keeps a module the site enables, and a line with no package names', () => {
		expect(unresolvedFailure(line, new Set(), new Set(['colorbutton', 'twig_tweak']))).toBe(
			line
		);
		expect(unresolvedFailure('enable x: refused', new Set(), undefined)).toBe(
			'enable x: refused'
		);
	});
});

describe('the claim hands the lane an owner and a password it can log in with', () => {
	const recorder = () => {
		const calls: Array<{ url: string; body: string }> = [];
		const fetcher = (async (url: URL | string, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body ?? '') });
			return new Response('{"ok":true}', { status: 200 });
		}) as typeof fetch;
		return { calls, fetcher };
	};

	it('takes the token from a fresh claim and asks nothing more', async () => {
		const { calls, fetcher } = recorder();
		expect(await claimOwner('https://x.dev', 200, '{"ownerToken":"tok"}', 'p1', fetcher)).toBe(
			'tok'
		);
		expect(calls).toEqual([]);
	});

	it('sets its own password again when an earlier claim already committed', async () => {
		const { calls, fetcher } = recorder();
		const owner = await claimOwner(
			'https://x.dev',
			409,
			'{"ok":false,"error":"already configured"}',
			'p2',
			fetcher
		);
		expect(owner).toBe('pw-diagnostics');
		expect(calls.map((c) => c.url)).toEqual(['https://x.dev/firstrun?force=1']);
		expect(JSON.parse(calls[0]!.body)).toEqual({ adminName: 'admin', adminPass: 'p2' });
	});

	it('hands back nothing for any other refusal', async () => {
		const { calls, fetcher } = recorder();
		expect(await claimOwner('https://x.dev', 503, 'warming', 'p3', fetcher)).toBe('');
		expect(calls).toEqual([]);
	});
});

describe('form fields a probe has to fill', () => {
	it('submits what a browser would, including a prefilled required weight', () => {
		const form = [
			'<input type="number" name="weight[0][value]" value="0" required />',
			'<input type="text" name="name[0][value]" value="" />',
			'<input type="checkbox" name="status[value]" value="1" checked />',
			'<input type="checkbox" name="off" value="1" />',
			'<input type="submit" name="op" value="Save" />',
			'<textarea name="description[0][value]">a &amp; b</textarea>',
			'<select name="parent[]"><option value="0">root</option><option value="4" selected>x</option></select>'
		].join('');
		expect(formValues(form)).toEqual({
			'weight[0][value]': '0',
			'name[0][value]': '',
			'status[value]': '1',
			'description[0][value]': 'a & b',
			'parent[]': '4'
		});
	});

	it('reads an attribute by its own name, not by a data attribute ending in it', () => {
		// thunder's paragraph remove button; reading `data-...-type="text"` as its type submitted
		// the button, so every node save on thunder removed the paragraph and re-rendered the form
		const remove =
			'<input class="button" data-paragraphs-split-text-type="text" data-drupal-selector="x" type="submit" name="field_paragraphs_0_remove" value="Remove" />';
		const text =
			'<input data-default-value="old" data-field-name="decoy" type="text" name="title[0][value]" value="" required="required" />';
		expect(formValues(remove + text)).toEqual({ 'title[0][value]': '' });
		expect(requiredText(remove + text)).toEqual({ 'title[0][value]': 'corpus' });
	});

	it('zeroes empty number inputs and leaves filled ones', () => {
		expect(
			emptyNumbers(
				'<input type="number" name="weight[0][value]" value="" /><input type="number" name="n" value="3" /><input type="text" name="t" />'
			)
		).toEqual({ 'weight[0][value]': '0' });
	});

	it('names the fields Drupal flagged with the error class', () => {
		expect(
			errorFieldNames(
				'<input class="form-text error" name="field_a[0][value]" /><select class="form-select error" name="field_b"></select><input class="form-text" name="ok" />'
			)
		).toEqual(['field_a[0][value]', 'field_b']);
	});
});

describe('filling what a form flagged', () => {
	it('gives links a URL, other fields text, and leaves the upload widget alone', () => {
		const html =
			'<input class="error" name="field_licenses[0][source][source_link]" /><input class="error" name="field_licenses[0][author][author_name]" /><input class="error" name="field_media_image[0][fids]" />';
		expect(filledFlags(html)).toEqual({
			'field_licenses[0][source][source_link]': 'https://example.com',
			'field_licenses[0][author][author_name]': 'corpus'
		});
	});
});

describe('filling a flagged select', () => {
	it('picks the first real option and skips the empty one', () => {
		const html =
			'<select class="form-select error" name="field_licenses[0][license]"><option value="_none">- None -</option><option value="cc0">CC0</option><option value="by">BY</option></select><input class="error" name="name[0][value]" />';
		expect(filledFlags(html)).toEqual({
			'field_licenses[0][license]': 'cc0',
			'name[0][value]': 'corpus'
		});
	});
});

describe('a deployed run', () => {
	const local = (rows: string[]): Compatibility => ({
		rows,
		repos: {
			alpha: {
				sha: 'a',
				lane: 'fixture',
				run: 'local:1',
				date: '2026-09-29',
				rows: { install: { state: 'inline' } }
			}
		}
	});
	const run = { sha: 'a', run: 'local:2', date: '2026-09-30', plan: 'free' };

	it('is recorded beside the local rows and leaves them as they were', () => {
		const file = recordDeployed(local(['install']), ['install'], {
			alpha: { ...run, rows: { install: { state: 'degraded', note: 'x' } } }
		});
		expect(file.repos['alpha']?.rows).toEqual({ install: { state: 'inline' } });
		expect(file.repos['alpha']?.deployed).toEqual({
			...run,
			rows: { install: { state: 'degraded', note: 'x' } }
		});
	});

	it('refuses a repository with no local record to sit beside', () => {
		expect(() =>
			recordDeployed(local(['install']), ['install'], { beta: { ...run, rows: {} } })
		).toThrow(/no local record of beta/);
	});

	it('survives a later local run of the same repository', () => {
		const file = recordDeployed(local(['install']), ['install'], {
			alpha: { ...run, rows: { install: { state: 'inline' } } }
		});
		const again = mergeResults(file, ['install'], {
			alpha: {
				sha: 'a',
				lane: 'fixture',
				run: 'local:3',
				date: '2026-10-01',
				rows: { install: { state: 'inline' } }
			}
		});
		expect(again.repos['alpha']?.run).toBe('local:3');
		expect(again.repos['alpha']?.deployed?.run).toBe('local:2');
	});

	it('takes its origin only under --deployed, and only an https worker address', () => {
		const env = { CORPUS_ORIGIN: 'https://cfw-e2e-x.example.workers.dev/' };
		expect(deployedOrigin(['--repo=x'], env)).toBeUndefined();
		expect(deployedOrigin(['--deployed'], env)).toBe('https://cfw-e2e-x.example.workers.dev');
		expect(() => deployedOrigin(['--deployed'], {})).toThrow(/CORPUS_ORIGIN/);
		expect(() =>
			deployedOrigin(['--deployed'], { CORPUS_ORIGIN: 'http://localhost:8840' })
		).toThrow(/CORPUS_ORIGIN/);
	});

	it('gives the lane a server with nothing to start, stop or read', () => {
		const server = remoteServer('https://w.example.workers.dev');
		expect(server).toMatchObject({ origin: 'https://w.example.workers.dev', logFile: '' });
		expect(() => server.stop()).not.toThrow();
	});

	it('deploys only cfw-e2e names, unclaimed, with the diagnostics var the delivery needs', () => {
		const args = deployArgs('cfw-e2e-farmos');
		expect(args).toEqual(
			expect.arrayContaining([
				'--deploy-only',
				'--no-provision',
				'--name=cfw-e2e-farmos',
				'--var=PW_DIAGNOSTICS=1'
			])
		);
		expect(() => deployArgs('drupflare-test')).toThrow(/refusing/);
	});

	it('passes a paid account, a CPU ceiling and extra vars on to the deploy', () => {
		expect(deployArgs('cfw-e2e-x', { paid: true, cpuMs: 300000, vars: ['PLAN=paid'] })).toEqual(
			expect.arrayContaining(['--paid', '--cpu-ms=300000', '--var=PLAN=paid'])
		);
		expect(deployArgs('cfw-e2e-x')).not.toContain('--paid');
	});
});
