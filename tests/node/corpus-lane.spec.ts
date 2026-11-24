import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { deployArgs } from '../../scripts/e2e/corpus-deploy';
import {
	accessFileBody,
	agreementFields,
	agreementForm,
	anachronDir,
	cfwHeaders,
	claimOwner,
	composerReplaces,
	composerRequires,
	contentTypeFrom,
	declaredNames,
	deliveredPackages,
	deployedOrigin,
	describeServerErrors,
	emptyNumbers,
	enabledExtensions,
	enabler,
	enableSteps,
	errorFieldNames,
	filledFlags,
	fixtureStatus,
	flushHeaderNote,
	formHtml,
	formValues,
	haltedBeat,
	infoRequires,
	inlineRetry,
	installUrl,
	lostServer,
	mergeResults,
	missingClassModule,
	missingDependency,
	moduleDir,
	nativeCause,
	nativeLibraries,
	pickStats,
	projectEnv,
	readableNote,
	recordDeployed,
	redirectTarget,
	refusalFor,
	remoteServer,
	renderMatrix,
	repeatedAnswer,
	requiredText,
	resultPaths,
	routePaths,
	setAside,
	settleRows,
	stampRun,
	unknownRows,
	unresolvedFailure,
	unsettled,
	updateNote,
	UPLOAD_REQUEST_TIMEOUT_MS,
	waitForTimingLock,
	withAnachronOverride,
	withConfigMismatch,
	withInstallNote,
	withServerErrorNote,
	type AnachronOverride,
	type Compatibility,
	type Corpus,
	type RowState,
	type ServerError
} from '../../scripts/e2e/corpus-lane';
import {
	admitsDrupal11,
	advisoryIds,
	configIdMismatches,
	installPath,
	lockDivergence,
	lockedContrib,
	nativeNotes,
	nativeNoteText,
	nativePlan,
	nativeRoot,
	needsProfileSwitch,
	projectPlan,
	projectRepositories,
	REMOVED_CORE_MODULES,
	skippedPatches,
	upgradeNote,
	withRegistryProfile
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
			expect(['modify', 'project', 'profile', 'd7-docker', 'none'], repo.id).toContain(
				repo.install
			);
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

	it('requires the project of a module the shipped core removed, unless the lock has it', () => {
		const root = build(
			{ require: { 'drupal/token': '^1.13', 'drupal/hal': '^2' } },
			'module:\n  token: 0\n  action: 0\n  hal: 0\n  rdf: 0\n'
		);
		try {
			writeFileSync(
				join(root, 'composer.lock'),
				JSON.stringify({
					packages: [
						{ name: 'drupal/token', version: '1.15.0', type: 'drupal-module' },
						{ name: 'drupal/hal', version: '2.0.5', type: 'drupal-module' }
					]
				})
			);
			const plan = projectPlan(root);
			expect(plan.packages['drupal/action']).toBe('*');
			expect(plan.packages['drupal/rdf']).toBe('*');
			expect(plan.packages['drupal/hal']).toBe('2.0.5');
			expect(plan.packages).not.toHaveProperty('drupal/token', '*');
			expect(REMOVED_CORE_MODULES).toContain('action');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('uploads a module kept inside a theme, and not the theme or a core checkout', () => {
		const root = build({}, 'module:\n  gesso_helper: 0\n');
		try {
			mkdirSync(join(root, 'web/themes/site_theme/gesso_helper'), { recursive: true });
			writeFileSync(
				join(root, 'web/themes/site_theme/site_theme.info.yml'),
				'name: t\ntype: theme\n'
			);
			writeFileSync(
				join(root, 'web/themes/site_theme/gesso_helper/gesso_helper.info.yml'),
				'name: g\ntype: module\n'
			);
			mkdirSync(join(root, 'web/core/modules/system'), { recursive: true });
			writeFileSync(
				join(root, 'web/core/modules/system/system.info.yml'),
				'name: System\ntype: module\n'
			);
			expect(
				projectPlan(root)
					.custom.map((c) => `${c.kind}:${c.name}`)
					.sort()
			).toEqual(['module:gesso_helper', 'module:mine']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("carries the project's minimum-stability, and none when it sets none", () => {
		const dev = build({ 'minimum-stability': 'dev' }, 'module:\n  token: 0\n');
		const stable = build({}, 'module:\n  token: 0\n');
		try {
			expect(projectPlan(dev).stability).toBe('dev');
			expect(projectPlan(stable)).not.toHaveProperty('stability');
		} finally {
			rmSync(dev, { recursive: true, force: true });
			rmSync(stable, { recursive: true, force: true });
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

	it('passes a project environment as the worker vars PHP reads with getenv', () => {
		expect(projectEnv({ WEBCMS_S3_REGION: 'us-east-1' })).toEqual({
			DRUPAL_ENV_WEBCMS_S3_REGION: 'us-east-1'
		});
		expect(projectEnv(undefined)).toEqual({});
	});

	it('names the module whose class a refusal could not find, and none for core', () => {
		expect(
			missingClassModule('Class "Drupal\\samlauth\\Event\\SamlauthEvents" not found')
		).toBe('samlauth');
		expect(missingClassModule('Class "Drupal\\Core\\Entity\\Gone" not found')).toBeNull();
		expect(missingClassModule('Class "Acme\\Thing" not found')).toBeNull();
		expect(
			missingClassModule('The service "a" has a dependency on a non-existent service')
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

	it('starts at a PHP Error line and not at an unrelated download warning above it', () => {
		const cause = nativeCause([
			'Downloading a/b (1.0.0)',
			'curl: could not resolve host cache.example.invalid, retrying',
			'Error: Undefined constant PDO::MYSQL_ATTR_USE_BUFFERED_QUERY in /out/site/web/core/Connection.php on line 140',
			'#0 trace',
			'#1 trace',
			'#2 trace'
		]);
		expect(
			cause.startsWith('Error: Undefined constant PDO::MYSQL_ATTR_USE_BUFFERED_QUERY')
		).toBe(true);
		expect(cause).not.toContain('could not resolve host');
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

describe('the access file a lane run leaves for a later census', () => {
	it('holds the owner token, admin password and session cookie as JSON', () => {
		expect(JSON.parse(accessFileBody('tok', 'pw', 'SESS=1'))).toEqual({
			owner: 'tok',
			pass: 'pw',
			cookie: 'SESS=1'
		});
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

describe('an anachron run', () => {
	const entry = (over: Record<string, unknown>) =>
		({
			id: 'x',
			repo: 'https://example.invalid/x',
			sha: 'abc',
			shape: 'project',
			core: '^10.5',
			install: 'project',
			assessment: 'structural',
			needs: [],
			...over
		}) as Corpus['repos'][number];

	it('keeps the composer plugin refusal and lifts the upgrade note only when asked', () => {
		const old = entry({ core: '^10.5.6' });
		expect(refusalFor(old)).toMatch(/^needs upgrade:/);
		expect(refusalFor(old, {})).toMatch(/^needs upgrade:/);
		expect(refusalFor(old, { anachron: false })).toMatch(/^needs upgrade:/);
		expect(refusalFor(old, { anachron: true })).toBeNull();
		const plugin = entry({ shape: 'composer-plugin', core: 'n/a' });
		expect(refusalFor(plugin, { anachron: true })).toMatch(/^not a site:/);
		expect(refusalFor(entry({ core: '8.x', install: 'none' }), { anachron: true })).toBeNull();
	});

	it('lays an override over the entry, merging notes per row and replacing the rest', () => {
		const base = entry({
			core: '8.x',
			install: 'none',
			notes: { install: 'kept?', 'anon render': 'stays' }
		});
		const got = withAnachronOverride(base, {
			x: { install: 'modify', modules: ['m'], notes: { install: 'override' } }
		});
		expect(got).toMatchObject({
			install: 'modify',
			modules: ['m'],
			core: '8.x',
			notes: { install: 'override', 'anon render': 'stays' }
		});
		expect(base.install).toBe('none');
	});

	it('returns an entry with no override as it is, and refuses a key it does not allow', () => {
		const base = entry({});
		expect(withAnachronOverride(base, { other: { install: 'modify' } })).toBe(base);
		expect(() =>
			withAnachronOverride(base, { x: { sha: 'f'.repeat(40) } as AnachronOverride })
		).toThrow(/x sets sha, which is not overridable/);
	});

	it('reads the checkout from the flag, then ANACHRON_DIR, then the sibling of the worker', () => {
		const root = '/work/worker';
		expect(anachronDir(['--repo=x'], { ANACHRON_DIR: '/a' }, root)).toBeUndefined();
		expect(anachronDir(['--anachron=/given'], { ANACHRON_DIR: '/a' }, root)).toBe('/given');
		expect(anachronDir(['--anachron'], { ANACHRON_DIR: '/env' }, root)).toBe('/env');
		expect(anachronDir(['--anachron='], { ANACHRON_DIR: '/env' }, root)).toBe('/env');
		expect(anachronDir(['--anachron'], {}, root)).toBe('/work/anachron');
		expect(anachronDir(['--anachron=rel'], {}, root)).toBe(resolve('rel'));
	});

	it('writes to its own record and leaves the matrix page alone', () => {
		expect(resultPaths('/w', false)).toEqual({
			json: '/w/docs/compatibility.json',
			matrix: '/w/docs/architecture/compatibility.md'
		});
		expect(resultPaths('/w', true)).toEqual({
			json: '/w/docs/compatibility-anachron.json',
			matrix: undefined
		});
	});

	it('suffixes the run stamp with the checkout, and only then', () => {
		expect(stampRun('local:t', undefined)).toBe('local:t');
		expect(stampRun('local:t', 'abc1234')).toBe('local:t+anachron:abc1234');
	});

	it('adds force to the install path only on request, leaving the rest as it was', () => {
		expect(installUrl('drupal/a', '^1', undefined, false)).toBe(
			'/install?module=drupal%2Fa&version=%5E1&deps=1'
		);
		expect(installUrl('drupal/a', null, 'dev', true)).toBe(
			'/install?module=drupal%2Fa&deps=1&stability=dev&force=1'
		);
		expect(installUrl('drupal/a', null, undefined, true, true)).toBe(
			'/install?module=drupal%2Fa&deps=1&force=1&ignore_core=1'
		);
	});

	it('overrides only the six repositories the verified corpus refuses or records as none', () => {
		const corpus = parse(
			readFileSync(resolve(process.cwd(), 'config/corpus.yml'), 'utf8')
		) as Corpus;
		const overrides = parse(
			readFileSync(resolve(process.cwd(), 'config/corpus-anachron.yml'), 'utf8')
		) as Record<string, AnachronOverride>;
		expect(Object.keys(overrides).sort()).toEqual(['fflch', 'migration_example', 'panopoly']);
		for (const id of Object.keys(overrides)) {
			const base = corpus.repos.find((r) => r.id === id)!;
			expect(base.install, id).toBe('none');
			const merged = withAnachronOverride(base, overrides);
			expect(merged.install, id).not.toBe('none');
			expect(refusalFor(merged, { anachron: true }), id).toBeNull();
			expect(merged.notes?.['install'], id).toMatch(/verified corpus records install none/);
		}
		expect(
			withAnachronOverride(
				corpus.repos.find((r) => r.id === 'migration_example')!,
				overrides
			)
		).toMatchObject({ modules: ['c11n_migrate'] });
		for (const id of ['webcms', 'open_social', 'localgov_microsites', 'essex']) {
			const base = corpus.repos.find((r) => r.id === id)!;
			expect(refusalFor(base), id).toMatch(/^needs upgrade:/);
			expect(refusalFor(base, { anachron: true }), id).toBeNull();
		}
	});
});

describe('the repositories a project lists', () => {
	it('keeps composer and GitHub entries, in an array or an object, and skips the standard hosts', () => {
		const listed = {
			'0': { type: 'composer', url: 'https://packages.drupal.org/8' },
			assets: { type: 'composer', url: 'https://asset-packagist.org' },
			pragmatica: {
				type: 'git',
				url: 'https://github.com/fflch/pragmatica-drupal-module.git'
			},
			local: { type: 'path', url: '../local' },
			plain: { type: 'composer', url: 'http://insecure.test' }
		};
		const expected = [
			{ type: 'composer', url: 'https://asset-packagist.org' },
			{ type: 'vcs', url: 'https://github.com/fflch/pragmatica-drupal-module.git' }
		];
		expect(projectRepositories(listed)).toEqual(expected);
		expect(projectRepositories(Object.values(listed))).toEqual(expected);
		expect(projectRepositories(undefined)).toEqual([]);
	});

	it('goes on the install path as one repository value each', () => {
		const url = installUrl('a/b', null, undefined, false, false, [
			{ type: 'composer', url: 'https://asset-packagist.org' }
		]);
		expect(url).toContain('&repository=composer%7Chttps%3A%2F%2Fasset-packagist.org');
		expect(installUrl('a/b', null, undefined, false)).not.toContain('repository');
	});

	it('names a module whose config files carry an id that differs from their file name', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
		try {
			const install = join(dir, 'config', 'install');
			mkdirSync(install, { recursive: true });
			const name = 'search_api_solr.solr_field_type.dense_vector_field_768_und_9_0_0.yml';
			writeFileSync(join(install, name), 'status: true\nid: dense_vector_field_768_und\n');
			writeFileSync(join(install, 'strawberryfield.settings.yml'), 'mime: true\n');
			writeFileSync(
				join(install, 'search_api_solr.solr_field_type.text_und_9_0_0.yml'),
				'id: text_und_9_0_0\n'
			);
			expect(configIdMismatches(dir)).toEqual([
				{ file: name, id: 'dense_vector_field_768_und' }
			]);
			const refused =
				'enabling strawberryfield was refused: The configuration name "x_9_0_0" does not match the ID "x"';
			expect(withConfigMismatch(refused, dir)).toContain(
				`1 config files carry an id that differs from their file name (${name} has id dense_vector_field_768_und)`
			);
			expect(withConfigMismatch('enabling x was refused: a fatal', dir)).toBe(
				'enabling x was refused: a fatal'
			);
			expect(withConfigMismatch(refused, join(dir, 'config'))).toBe(refused);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reads what a lock records for each required package, and retries a 404 with it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'plan-'));
		try {
			writeFileSync(
				join(dir, 'composer.json'),
				JSON.stringify({
					require: { 'ckeditor-plugin/iframe': '4.15.0', 'drupal/token': '^1.0' }
				})
			);
			writeFileSync(
				join(dir, 'composer.lock'),
				JSON.stringify({
					packages: [
						{
							name: 'ckeditor-plugin/iframe',
							version: '4.15.0',
							type: 'drupal-library',
							dist: {
								url: 'https://download.ckeditor.com/iframe/releases/iframe_4.15.0.zip',
								type: 'zip'
							}
						},
						{
							name: 'drupal/token',
							version: '1.15.0',
							type: 'drupal-module',
							dist: null
						}
					]
				})
			);
			const plan = projectPlan(dir);
			expect(Object.keys(plan.inline ?? {})).toEqual(['ckeditor-plugin/iframe']);
			const fail = 'ckeditor-plugin/iframe: metadata 404 for ckeditor-plugin/iframe';
			const again = inlineRetry(plan, 'ckeditor-plugin/iframe', fail);
			expect(again).toEqual([
				{
					type: 'package',
					name: 'ckeditor-plugin/iframe',
					definition: plan.inline?.['ckeditor-plugin/iframe']
				}
			]);
			const url = installUrl(
				'ckeditor-plugin/iframe',
				'4.15.0',
				undefined,
				false,
				false,
				again
			);
			expect(decodeURIComponent(url)).toContain(
				'&repository=package|{"name":"ckeditor-plugin/iframe"'
			);
			expect(
				inlineRetry(plan, 'ckeditor-plugin/iframe', 'archive 500 from https://x')
			).toBeUndefined();
			expect(inlineRetry(plan, 'drupal/token', fail)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('is read by a project with a lock and a project without one', () => {
		const dir = mkdtempSync(join(tmpdir(), 'plan-'));
		try {
			writeFileSync(
				join(dir, 'composer.json'),
				JSON.stringify({
					require: { 'drupal/localgov_microsites': '^4.0' },
					repositories: [{ type: 'composer', url: 'https://asset-packagist.org' }]
				})
			);
			const plan = projectPlan(dir);
			expect(plan.locked).toBe(false);
			expect(plan.repositories).toEqual([
				{ type: 'composer', url: 'https://asset-packagist.org' }
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the install profile of a project with no lock', () => {
	const plan = {
		profile: null,
		packages: { 'drupal/token': '^1.0', 'drupal/localgov_microsites': '^4.0' },
		custom: [],
		modules: [],
		patches: 0,
		locked: false
	};
	const fetcher = (async (input: RequestInfo | URL) => {
		const url = String(input);
		const name = /p2\/(.+)\.json/.exec(url)?.[1] ?? '';
		return Response.json({
			packages: {
				[name]: [{ type: name.endsWith('microsites') ? 'drupal-profile' : 'drupal-module' }]
			}
		});
	}) as typeof fetch;

	it('reads the profile from the type the registry publishes, so a distribution is migrated', async () => {
		const read = await withRegistryProfile(plan, fetcher);
		expect(read.profile).toBe('localgov_microsites');
		expect(needsProfileSwitch(read)).toBe(true);
		expect(needsProfileSwitch(plan)).toBe(false);
	});

	it('asks nothing of a project that has a lock or already names its profile', async () => {
		const never = (async () => {
			throw new Error('no fetch expected');
		}) as unknown as typeof fetch;
		expect(await withRegistryProfile({ ...plan, locked: true }, never)).toEqual({
			...plan,
			locked: true
		});
		expect(await withRegistryProfile({ ...plan, profile: 'standard' }, never)).toEqual({
			...plan,
			profile: 'standard'
		});
	});
});

describe('where a native install leaves its output', () => {
	it('is the OS temp directory by default, never inside the repository', () => {
		const root = nativeRoot({});
		expect(root.startsWith(tmpdir())).toBe(true);
		expect(root.startsWith(join(import.meta.dirname, '..', '..'))).toBe(false);
	});

	it('takes CORPUS_NATIVE_DIR when it is set', () => {
		expect(nativeRoot({ CORPUS_NATIVE_DIR: '/somewhere/else' })).toBe('/somewhere/else');
	});
});

describe('the upload request timeout', () => {
	it('is well above the 15 second default of drangler, which cancelled a long commit', () => {
		expect(Number(UPLOAD_REQUEST_TIMEOUT_MS)).toBeGreaterThanOrEqual(120_000);
	});
});

describe('a package the lock holds on a dev branch', () => {
	it('is asked for at that branch, not at the newest stable release', () => {
		const dir = mkdtempSync(join(tmpdir(), 'plan-dev-'));
		try {
			writeFileSync(
				join(dir, 'composer.json'),
				JSON.stringify({
					require: { 'drupal/entitygroupfield': '^1.0.x-dev', 'drupal/token': '^1.0' }
				})
			);
			writeFileSync(
				join(dir, 'composer.lock'),
				JSON.stringify({
					packages: [
						{
							name: 'drupal/entitygroupfield',
							version: 'dev-1.0.x',
							type: 'drupal-module'
						},
						{ name: 'drupal/token', version: '1.15.0', type: 'drupal-module' }
					]
				})
			);
			expect(projectPlan(dir).packages).toEqual({
				'drupal/entitygroupfield': 'dev-1.0.x',
				'drupal/token': '1.15.0'
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('a branch the lock holds at a commit', () => {
	it('is asked for at that commit', () => {
		const dir = mkdtempSync(join(tmpdir(), 'plan-pin-'));
		try {
			writeFileSync(
				join(dir, 'composer.json'),
				JSON.stringify({ require: { 'drupal/entitygroupfield': '^1.0.x-dev' } })
			);
			writeFileSync(
				join(dir, 'composer.lock'),
				JSON.stringify({
					packages: [
						{
							name: 'drupal/entitygroupfield',
							version: 'dev-1.0.x',
							type: 'drupal-module',
							source: { reference: '57a1fd42328135560ff1833a9a92d2bc7ab4444d' }
						}
					]
				})
			);
			expect(projectPlan(dir).packages).toEqual({
				'drupal/entitygroupfield': 'dev-1.0.x#57a1fd42328135560ff1833a9a92d2bc7ab4444d'
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('the native install script', () => {
	it('does not let a security advisory against a pinned core stop the install', () => {
		const script = readFileSync(
			join(import.meta.dirname, '../../scripts/e2e/corpus-native/install.sh'),
			'utf8'
		);
		expect(script).toContain('"block-insecure":false');
	});

	it('relaxes the exact core companion pins a project template carries', () => {
		const script = readFileSync(
			join(import.meta.dirname, '../../scripts/e2e/corpus-native/install.sh'),
			'utf8'
		);
		expect(script).toContain('core-(composer-scaffold|project-message|recommended)');
	});

	it('creates a template project without installing it, and keeps a failed patch from stopping the update', () => {
		const script = readFileSync(
			join(import.meta.dirname, '../../scripts/e2e/corpus-native/install.sh'),
			'utf8'
		);
		expect(script).toContain('--stability dev --no-install');
		expect(script).toContain('composer-exit-on-patch-failure');
	});

	it('updates every package, not only the profile, so a template lock can move core', () => {
		const script = readFileSync(
			join(import.meta.dirname, '../../scripts/e2e/corpus-native/install.sh'),
			'utf8'
		);
		expect(script).toContain('composer update --with-all-dependencies');
	});
});

describe('what a native install skipped or went past', () => {
	const log = [
		'  - Applying patches for drupal/inline_entity_form',
		'    https://www.drupal.org/files/issues/2022-09-22/47-8.diff (Issue #3271293: Changes are lost)',
		'   Could not apply patch! Skipping. The error was: Cannot apply patch https://www.drupal.org/files/issues/2022-09-22/47-8.diff',
		'  Cannot apply patch Issue #3271293: Changes are lost when collapsing a parag  ',
		'  /issues/2022-09-22/47-8.diff)!',
		'   Could not apply patch! Skipping. The error was: Cannot apply patch https://www.drupal.org/files/issues/2023-01-01/other.patch'
	].join('\n');

	it('lists each skipped patch once, by its URL', () => {
		expect(skippedPatches(log)).toEqual([
			'https://www.drupal.org/files/issues/2022-09-22/47-8.diff',
			'https://www.drupal.org/files/issues/2023-01-01/other.patch'
		]);
		expect(skippedPatches('  - Installing a/b (1.0.0)')).toEqual([]);
	});

	it('lists the advisory ids a composer audit reports, and none for output it cannot read', () => {
		const audit = JSON.stringify({
			advisories: {
				'drupal/core': [
					{ advisoryId: 'SA-CORE-2026-018' },
					{ advisoryId: 'SA-CORE-2026-017' },
					{ advisoryId: 'SA-CORE-2026-017' }
				]
			}
		});
		expect(advisoryIds(audit)).toEqual(['SA-CORE-2026-017', 'SA-CORE-2026-018']);
		expect(advisoryIds('not json')).toEqual([]);
		expect(advisoryIds('{"advisories":[]}')).toEqual([]);
	});

	it('reads both from an install output directory', () => {
		const dir = mkdtempSync(join(tmpdir(), 'native-notes-'));
		try {
			writeFileSync(join(dir, 'install.log'), log);
			writeFileSync(
				join(dir, 'audit.json'),
				JSON.stringify({ advisories: { x: [{ advisoryId: 'SA-CORE-2026-017' }] } })
			);
			expect(nativeNotes(dir)).toEqual({
				patches: [
					'https://www.drupal.org/files/issues/2022-09-22/47-8.diff',
					'https://www.drupal.org/files/issues/2023-01-01/other.patch'
				],
				advisories: ['SA-CORE-2026-017'],
				relaxed: [],
				changed: []
			});
			expect(nativeNotes(join(dir, 'missing'))).toEqual({
				patches: [],
				advisories: [],
				relaxed: [],
				changed: []
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('writes a note only when something was skipped, and puts it on the install row', () => {
		expect(
			nativeNoteText({ patches: [], advisories: [], relaxed: [], changed: [] })
		).toBeUndefined();
		const note = nativeNoteText({
			patches: ['https://x/1.patch'],
			advisories: ['SA-CORE-2026-017'],
			relaxed: ['drupal/core-composer-scaffold: 11.3.22 -> *'],
			changed: ['drupal/core: 11.3.22 -> 11.4.10']
		});
		expect(note).toContain('not stock: 1 composer patches did not apply');
		expect(note).toContain('SA-CORE-2026-017');
		expect(note).toContain('relaxed constraints (drupal/core-composer-scaffold: 11.3.22 -> *)');
		expect(note).toContain(
			"1 packages resolved off the project's lock (drupal/core: 11.3.22 -> 11.4.10)"
		);
		const rows = withInstallNote({ install: { state: 'inline', note: 'ok' } }, note);
		expect(rows['install']?.note).toContain('ok; not stock');
		expect(withInstallNote({ install: { state: 'inline' } }, undefined)).toEqual({
			install: { state: 'inline' }
		});
	});
});

describe('where a build differs from the lock of the project', () => {
	const lock = (pkgs: Record<string, string>) =>
		JSON.stringify({
			packages: Object.entries(pkgs).map(([name, version]) => ({ name, version }))
		});

	it('lists packages at another version and packages the build dropped, ignoring a leading v', () => {
		const project = lock({ 'a/a': '1.0.0', 'b/b': 'v2.0.0', 'c/c': '3.0.0', 'd/d': '4.0.0' });
		const site = lock({ 'a/a': '1.1.0', 'b/b': '2.0.0', 'c/c': '3.0.0', 'e/e': '1.0.0' });
		expect(lockDivergence(project, site)).toEqual([
			'a/a: 1.0.0 -> 1.1.0',
			'd/d: 4.0.0 -> absent'
		]);
	});

	it('lists nothing for a lock that cannot be read', () => {
		expect(lockDivergence('', lock({ 'a/a': '1' }))).toEqual([]);
	});

	it('reads the relaxed constraints and the lock difference from an install directory', () => {
		const out = mkdtempSync(join(tmpdir(), 'native-div-'));
		const clone = mkdtempSync(join(tmpdir(), 'native-clone-'));
		try {
			mkdirSync(join(out, 'site'));
			writeFileSync(
				join(out, 'relaxed.json'),
				JSON.stringify(['drupal/core-recommended: 11.3.22 -> *'])
			);
			writeFileSync(join(clone, 'composer.lock'), lock({ 'a/a': '1.0.0' }));
			writeFileSync(join(out, 'site', 'composer.lock'), lock({ 'a/a': '1.2.0' }));
			const notes = nativeNotes(out, clone);
			expect(notes.relaxed).toEqual(['drupal/core-recommended: 11.3.22 -> *']);
			expect(notes.changed).toEqual(['a/a: 1.0.0 -> 1.2.0']);
		} finally {
			rmSync(out, { recursive: true, force: true });
			rmSync(clone, { recursive: true, force: true });
		}
	});
});

describe('who refused a request that answered 5xx', () => {
	const err = (over: Partial<ServerError>): ServerError => ({
		path: '/admin',
		status: 503,
		growthRefused: false,
		reset: false,
		...over
	});

	it('says nothing when the run had no 5xx answer', () => {
		expect(describeServerErrors([])).toBeUndefined();
	});

	it('counts the governor header, the object-reset page and neither apart', () => {
		const text = describeServerErrors([
			err({ growthRefused: true }),
			err({ reset: true }),
			err({ reset: true }),
			err({ status: 500 })
		]);
		expect(text).toBe(
			'4 5xx answers in the run: 1 with the growth-refused header, 2 with the object-reset page, 1 neither'
		);
	});

	it('adds the object-reset and rolled-back headers when an answer carried them', () => {
		const text = describeServerErrors([err({ objectResetHeader: true })]);
		expect(text).toContain('1 with the object-reset header, 0 with the rolled-back header');
		expect(describeServerErrors([err({ rolledBack: 'all' })])).toContain(
			'1 with the rolled-back header'
		);
	});

	it('reads the flush answer for the rollback and the repeat, on a 200 as well', () => {
		const answer = (init: Record<string, string>) =>
			new Response(null, { status: 200, headers: init });
		expect(flushHeaderNote(answer({}).headers)).toBe(
			'the flush POST: x-cfw-rolled-back none, x-cfw-retried none'
		);
		expect(flushHeaderNote(answer({ 'x-cfw-rolled-back': 'all' }).headers)).toBe(
			'the flush POST: x-cfw-rolled-back all, x-cfw-retried none'
		);
		expect(flushHeaderNote(answer({ 'x-cfw-retried': 'abort' }).headers)).toContain(
			'x-cfw-retried abort'
		);
		expect(flushHeaderNote(answer({ 'x-cfw-effects': 'none' }).headers)).toContain(
			'x-cfw-effects none'
		);
		expect(flushHeaderNote(answer({}).headers)).not.toContain('x-cfw-effects');
	});

	it('says no header is readable when the answer is the platform reset page', () => {
		expect(flushHeaderNote(new Response(null).headers, true)).toBe(
			'the flush POST: a platform reset page carries no x-cfw header'
		);
	});

	it('notes the rows that did not pass and leaves the passing ones alone', () => {
		const rows = withServerErrorNote(
			{
				install: { state: 'inline' },
				'cache rebuild': { state: 'unsupported', note: 'the clear answered 503' }
			},
			[err({ reset: true })]
		);
		expect(rows['install']).toEqual({ state: 'inline' });
		expect(rows['cache rebuild']?.note).toBe(
			'the clear answered 503; 1 5xx answers in the run: 0 with the growth-refused header, 1 with the object-reset page, 0 neither'
		);
	});
});

describe('the memory readings kept around a failing row', () => {
	it('keeps every x-cfw header and retry-after of an answer verbatim', () => {
		const h = new Headers({
			'x-cfw-effects': 'none',
			'x-cfw-rolled-back': 'all',
			'retry-after': '2',
			'content-type': 'text/html'
		});
		expect(cfwHeaders(h)).toEqual({
			'x-cfw-effects': 'none',
			'x-cfw-rolled-back': 'all',
			'retry-after': '2'
		});
	});

	it('keeps the repeat and effects headers of an answer of any status, and ignores the rest', () => {
		const ok = new Headers({ 'x-cfw-retried': 'abort', 'x-cfw-effects': 'none' });
		expect(repeatedAnswer('/admin/config?x=1', 200, ok)).toEqual({
			path: '/admin/config',
			status: 200,
			headers: { 'x-cfw-retried': 'abort', 'x-cfw-effects': 'none' }
		});
		expect(repeatedAnswer('/a', 503, new Headers({ 'x-cfw-effects': 'some' }))?.status).toBe(
			503
		);
		expect(repeatedAnswer('/a', 200, new Headers({ 'x-cfw-rolled-back': 'all' }))).toBe(
			undefined
		);
		expect(repeatedAnswer('/a', 200, new Headers())).toBe(undefined);
	});

	it('keeps every reply of a stepped enable whole, in order', async () => {
		enableSteps.length = 0;
		const replies = [
			{ status: 202, json: { done: false, step: 1, calls: 4 } },
			{ status: 202, json: { done: false, step: 2, trace: ['a'] } },
			{ status: 200, json: { done: true, ok: true, inflateStats: { n: 3 } } }
		];
		const asked: string[] = [];
		const site = {
			owned: async (path: string) => {
				asked.push(path);
				return replies[asked.length - 1]!;
			}
		};
		const got = await enabler(site, async () => {})('mantle2');
		expect(got.json['ok']).toBe(true);
		expect(asked).toEqual(Array(3).fill('/enable?module=mantle2'));
		expect(enableSteps.map((s) => [s.module, s.status, s.body])).toEqual(
			replies.map((r) => ['mantle2', r.status, r.json])
		);
		expect(enableSteps.every((s) => s.clientMs >= 0)).toBe(true);
		enableSteps.length = 0;
	});

	it('keeps the governor and isolate fields of a serve-stats answer and nothing else', () => {
		const stats = pickStats({
			rowsToday: 5,
			growthRefusals: 2,
			growthRefusalLog: [{ at: 1, from_bytes: 2, to_bytes: 3, cap_bytes: 4 }],
			isolateBytes: { total: 9, ceiling: 134217728 },
			freshFirst: { count: 1 },
			alarmFirings: 3,
			recycles: 0,
			incarnation: { instance: 'a' },
			isolate: { interpreters: 1 },
			demand: [],
			demandByPath: {},
			other: 'x'
		});
		expect(Object.keys(stats).sort()).toEqual([
			'alarmFirings',
			'demand',
			'demandByPath',
			'freshFirst',
			'growthRefusalLog',
			'growthRefusals',
			'incarnation',
			'isolate',
			'isolateBytes',
			'recycles'
		]);
	});
});
