import { describe, expect, it } from 'vitest';
import type { WorkingFile } from '../../../src/ops/git-smart';
import {
	DEFAULT_POLL_MINUTES,
	MIN_POLL_MINUTES,
	backoffMs,
	clampInterval,
	detectConflicts,
	duePolls,
	lineDelta,
	moduleRoots,
	mountFor,
	mountPlan,
	planSync,
	safeName,
	selectFiles,
	type SelectedFile
} from '../../../src/ops/git-sync';

/**
 * The decisions a sync makes about paths, cadence and ownership.
 *
 * `tests/node/git-smart.spec.ts` drives these over trees real git produced; this is the edge-case
 * half, where the input is chosen rather than observed.
 */

const file = (path: string, body: string): WorkingFile => ({
	path,
	bytes: new TextEncoder().encode(body),
	mode: '100644'
});

const sel = (path: string, source: string): SelectedFile => ({
	path,
	source,
	bytes: source.length
});

describe('finding the modules in a repository', () => {
	it('takes the machine name from the info file, never from the directory', () => {
		// the exact case that made this a rule: `../rom` is checked out as rom and provides
		// cfw_do_sqlite, so a directory-derived name looks for a module that does not exist
		const roots = moduleRoots(['cfw_do_sqlite.info.yml', 'src/Driver.php']);
		expect(roots).toEqual([{ name: 'cfw_do_sqlite', root: '', type: 'module' }]);
	});

	it('reads the declared type so a theme does not land in modules/', () => {
		const sources = new Map([['gamma.info.yml', 'name: Gamma\ntype: theme\n']]);
		expect(moduleRoots(['gamma.info.yml'], sources)[0]?.type).toBe('theme');
		expect(mountPlan(moduleRoots(['gamma.info.yml'], sources), 'x').get('')).toBe(
			'themes/custom/gamma'
		);
	});

	it('treats an install profile as its own destination', () => {
		const sources = new Map([['govcms.info.yml', 'name: GovCMS\ntype: profile\n']]);
		const roots = moduleRoots(['govcms.info.yml'], sources);
		expect(mountPlan(roots, 'x').get('')).toBe('profiles/custom/govcms');
	});

	it('leaves a submodule inside its parent rather than mounting it twice', () => {
		const roots = moduleRoots([
			'alpha.info.yml',
			'modules/alpha_sub/alpha_sub.info.yml',
			'modules/alpha_sub/alpha_sub.module'
		]);
		expect(roots.map((r) => r.name)).toEqual(['alpha']);
	});

	it('mounts siblings separately when neither contains the other', () => {
		const roots = moduleRoots(['modules/a/a.info.yml', 'modules/b/b.info.yml']);
		expect(roots.map((r) => r.root)).toEqual(['modules/a', 'modules/b']);
	});

	it('falls back to the repository name when nothing declares itself', () => {
		expect(mountPlan([], 'My-Repo.git').get('')).toBe('modules/custom/my_repo_git');
	});

	it('reduces a repository name to something Drupal would accept', () => {
		expect(safeName('owner/My Module!')).toBe('my_module');
		expect(safeName('group/sub/thing')).toBe('thing');
		expect(safeName('---')).toBe('custom');
	});

	it('routes each path to the longest root that claims it', () => {
		const plan = new Map([
			['', 'modules/custom/outer'],
			['modules/inner', 'modules/custom/inner']
		]);
		expect(mountFor(plan, 'src/A.php')).toBe('modules/custom/outer/src/A.php');
		expect(mountFor(plan, 'modules/inner/x.php')).toBe('modules/custom/inner/x.php');
		// the root path itself names a directory, not a file
		expect(mountFor(plan, 'modules/inner')).toBeNull();
	});

	it('claims nothing when a path sits outside every module', () => {
		expect(mountFor(new Map([['modules/a', 'modules/custom/a']]), 'docs/x.php')).toBeNull();
	});
});

describe('selecting what may be mounted', () => {
	it('refuses a file over the record cap rather than truncating it', () => {
		const huge: WorkingFile = {
			path: 'big.php',
			bytes: new Uint8Array(2_200_000),
			mode: '100644'
		};
		const chosen = selectFiles([file('x.info.yml', 'type: module\n'), huge], 'x');
		expect(chosen.files.some((f) => f.path.endsWith('big.php'))).toBe(false);
		expect(chosen.skipped.find((s) => s.path === 'big.php')?.why).toMatch(/record cap/);
	});

	it('says why each drop happened, so a thin install is explainable', () => {
		const chosen = selectFiles(
			[
				file('x.info.yml', 'type: module\n'),
				file('README.md', '#'),
				file('tests/T.php', '<?php'),
				file('.github/workflows/ci.yml', 'on: push')
			],
			'x'
		);
		const why = new Map(chosen.skipped.map((s) => [s.path, s.why]));
		expect(why.get('README.md')).toMatch(/extension/);
		expect(why.get('tests/T.php')).toMatch(/mountable tree/);
		expect(why.get('.github/workflows/ci.yml')).toMatch(/mountable tree/);
	});

	it('reports an empty selection rather than mounting a repository with no module', () => {
		const chosen = selectFiles([file('README.md', '#')], 'x');
		expect(chosen.files).toEqual([]);
		expect(chosen.roots).toEqual([]);
	});
});

describe('the plan', () => {
	it('separates added, modified, removed and unchanged', () => {
		const stored = new Map([
			['a.php', 'one'],
			['b.php', 'two'],
			['gone.php', 'three']
		]);
		const plan = planSync(stored, [
			sel('a.php', 'one'),
			sel('b.php', 'CHANGED'),
			sel('c.php', 'new')
		]);
		expect(plan.counts).toEqual({ added: 1, modified: 1, removed: 1, unchanged: 1 });
		expect(plan.deletes).toEqual(['gone.php']);
		expect(plan.writes.map((w) => w.path)).toEqual(['b.php', 'c.php']);
	});

	it('charges rows for writes and deletes and nothing for the rest', () => {
		const stored = new Map([['a.php', 'one']]);
		expect(planSync(stored, [sel('a.php', 'one')]).rowsWritten).toBe(0);
		expect(planSync(stored, [sel('a.php', 'two')]).rowsWritten).toBe(1);
		expect(planSync(stored, []).rowsWritten).toBe(1);
	});

	it('installs everything from nothing on a first pull', () => {
		const plan = planSync(new Map(), [sel('a.php', 'x'), sel('b.php', 'y')]);
		expect(plan.counts.added).toBe(2);
		expect(plan.deletes).toEqual([]);
	});

	it('removes everything when the incoming tree is empty', () => {
		const plan = planSync(new Map([['a.php', 'x']]), []);
		expect(plan.counts.removed).toBe(1);
		expect(plan.changes[0]?.kind).toBe('removed');
	});

	it('is ordered by path, so two runs of the same plan read the same', () => {
		const plan = planSync(new Map(), [sel('z.php', '1'), sel('a.php', '2'), sel('m.php', '3')]);
		expect(plan.changes.map((c) => c.path)).toEqual(['a.php', 'm.php', 'z.php']);
	});
});

describe('line counts a reviewer reads', () => {
	it('counts nothing for an identical file', () => {
		expect(lineDelta('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
	});

	it('counts one added line', () => {
		expect(lineDelta('a\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 });
	});

	it('counts one removed line', () => {
		expect(lineDelta('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
	});

	it('counts a replacement as one of each', () => {
		expect(lineDelta('a\nb\nc', 'a\nX\nc')).toEqual({ added: 1, removed: 1 });
	});

	it('is not fooled by a reorder, which moves no lines', () => {
		expect(lineDelta('a\nb\nc', 'c\nb\na')).toEqual({ added: 0, removed: 0 });
	});

	it('handles the empty file in both directions', () => {
		expect(lineDelta('', 'a\nb')).toEqual({ added: 2, removed: 0 });
		expect(lineDelta('a\nb', '')).toEqual({ added: 0, removed: 2 });
	});
});

describe('conflicts', () => {
	it('names a path another remote already owns', () => {
		const owners = new Map([['modules/custom/x/x.module', 'github:other/repo@main']]);
		const found = detectConflicts(
			[sel('modules/custom/x/x.module', 'y')],
			owners,
			'github:me/x@main'
		);
		expect(found).toEqual([
			{
				path: 'modules/custom/x/x.module',
				owner: 'github:other/repo@main',
				claimant: 'github:me/x@main'
			}
		]);
	});

	it('does not call a remote overwriting its own file a conflict', () => {
		const owners = new Map([['a.php', 'me']]);
		expect(detectConflicts([sel('a.php', 'x')], owners, 'me')).toEqual([]);
	});

	it('catches a composer-installed package being taken over', () => {
		const owners = new Map([['modules/contrib/token/token.module', 'drupal/token']]);
		const found = detectConflicts(
			[sel('modules/contrib/token/token.module', 'x')],
			owners,
			'github:me/token@main'
		);
		expect(found[0]?.owner).toBe('drupal/token');
	});
});

describe('polling cadence', () => {
	it('floors an interval at the minimum and keeps zero as off', () => {
		expect(clampInterval(1)).toBe(MIN_POLL_MINUTES);
		expect(clampInterval(0)).toBe(0);
		expect(clampInterval(-5)).toBe(0);
		expect(clampInterval(Number.NaN)).toBe(0);
		expect(clampInterval(90)).toBe(90);
	});

	it('defaults to an hour, which is 12 polls a day per remote', () => {
		expect(DEFAULT_POLL_MINUTES).toBe(60);
	});

	const state = (id: string, over: Partial<Parameters<typeof duePolls>[0][number]> = {}) => ({
		id,
		intervalMinutes: 60,
		lastCheckedMs: 0,
		backoffUntilMs: 0,
		...over
	});

	it('picks only what is due', () => {
		const now = 10 * 60 * 60_000;
		const due = duePolls(
			[state('a'), state('b', { lastCheckedMs: now - 60_000 }), state('c')],
			now
		);
		expect(due).toEqual(['a', 'c']);
	});

	it('never polls a remote whose interval is off', () => {
		expect(duePolls([state('a', { intervalMinutes: 0 })], 1e12)).toEqual([]);
	});

	it('honours a backoff window', () => {
		const now = 1e12;
		expect(duePolls([state('a', { backoffUntilMs: now + 1000 })], now)).toEqual([]);
		expect(duePolls([state('a', { backoffUntilMs: now - 1000 })], now)).toEqual(['a']);
	});

	it('takes the oldest first and caps the batch, so one remote cannot starve the rest', () => {
		const now = 1e12;
		const due = duePolls(
			[
				state('new', { lastCheckedMs: 100 }),
				state('old', { lastCheckedMs: 1 }),
				state('mid', { lastCheckedMs: 50 })
			],
			now,
			2
		);
		expect(due).toEqual(['old', 'mid']);
	});
});

describe('backoff', () => {
	it('doubles per attempt', () => {
		expect(backoffMs(1)).toBe(60_000);
		expect(backoffMs(2)).toBe(120_000);
		expect(backoffMs(4)).toBe(480_000);
	});

	it('prefers Retry-After when the provider sends one', () => {
		// GitLab rate-limits the archive endpoint at 5/minute and does say how long to wait
		expect(backoffMs(1, 30)).toBe(30_000);
		expect(backoffMs(9, 12)).toBe(12_000);
	});

	it('caps at an hour either way', () => {
		expect(backoffMs(40)).toBe(3_600_000);
		expect(backoffMs(1, 99_999)).toBe(3_600_000);
	});

	it('ignores a Retry-After that says nothing', () => {
		expect(backoffMs(1, 0)).toBe(60_000);
		expect(backoffMs(1, null)).toBe(60_000);
	});
});
