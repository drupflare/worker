import { describe, expect, it } from 'vitest';
import {
	autoclosedTitle,
	blockedComment,
	BOT_LOGIN,
	branchIsPristine,
	bumpComment,
	decide,
	isLegacyProposalBranch,
	isProposalBot,
	matchesProposal,
	plan,
	proposalBody,
	proposalBranch,
	proposalTitle,
	reusable,
	staleBranches,
	supersede,
	type ProposalPr
} from '../../scripts/interp-proposal.ts';

/**
 * The reconciler that keeps one pull request per interpreter proposal line.
 *
 * The state this replaces is the fixture: three open pull requests on 2026-08-16, artifacts
 * 9255839106, 9255713894 and 9259605002, all proposing `control85 php8.5`, none closing any other.
 * Two defects produced it -- the branch carried the artifact id, so a newer build never matched an
 * existing branch; and the "already pinned" guard compared against a file that does not exist on
 * master, so it could never fire.
 *
 * Node lane: the module reads `node:child_process` at import.
 */

const V = 'control85';
const P = '8.5';
const CANONICAL = 'interp/control85-php8.5';

function pr(
	number: number,
	headRefName: string,
	state: ProposalPr['state'] = 'OPEN',
	author = BOT_LOGIN
): ProposalPr {
	return { number, headRefName, state, title: 'chore(interp): control85 php8.5', author };
}

/** the three that were open, newest first, as `gh pr list` returned them */
function theBrokenCase(): ProposalPr[] {
	return [
		pr(6, 'interp/control85-php8.5-9259605002'),
		pr(5, 'interp/control85-php8.5-9255713894'),
		pr(4, 'interp/control85-php8.5-9255839106'),
		pr(3, 'renovate/typescript-7.x')
	];
}

describe('the proposal line is the branch', () => {
	it('names one branch per variant and version', () => {
		expect(proposalBranch(V, P)).toBe(CANONICAL);
		expect(proposalBranch('control84', '8.4')).toBe('interp/control84-php8.4');
	});

	it('claims the artifact-suffixed branches the old scheme created', () => {
		expect(isLegacyProposalBranch('interp/control85-php8.5-9259605002', V, P)).toBe(true);
		expect(matchesProposal('interp/control85-php8.5-9259605002', V, P)).toBe(true);
		expect(matchesProposal(CANONICAL, V, P)).toBe(true);
	});

	it('claims nothing belonging to another variant, version or lane', () => {
		for (const branch of [
			'interp/control84-php8.4-9259605002',
			'interp/control85-php8.4',
			'interp/control8-php5.6',
			'renovate/typescript-7.x',
			'master'
		]) {
			expect(matchesProposal(branch, V, P)).toBe(false);
		}
	});

	it('does not treat a hand-named branch on the line as bot-created', () => {
		// the digits are what make a sweep safe, so a worded suffix is left alone
		expect(isLegacyProposalBranch('interp/control85-php8.5-rebase', V, P)).toBe(false);
		expect(matchesProposal('interp/control85-php8.5-rebase', V, P)).toBe(false);
	});

	it('escapes a variant carrying regex punctuation', () => {
		expect(isLegacyProposalBranch('interp/rc.1-php8.5-42', 'rc.1', P)).toBe(true);
		expect(isLegacyProposalBranch('interp/rcx1-php8.5-42', 'rc.1', P)).toBe(false);
	});
});

describe('the decision', () => {
	const base = { artifactId: '9259605002', newPin: '{"artifactId":"9259605002"}' };

	it('does nothing when the base branch already carries the pin', () => {
		const d = decide({ ...base, basePin: base.newPin, branchPin: null, canonicalPr: null });
		expect(d).toMatchObject({ push: false, pr: 'none' });
		expect(d.why).toContain('9259605002');
	});

	it('proposes even though the base has no pin file at all', () => {
		// the guard this replaces compared `git status` against a file untracked on master, so it
		// could never fire and every run proposed
		const d = decide({ ...base, basePin: null, branchPin: null, canonicalPr: null });
		expect(d).toMatchObject({ push: true, pr: 'create' });
	});

	it('force-pushes and bumps an open proposal when the artifact moves', () => {
		const d = decide({
			...base,
			basePin: null,
			branchPin: '{"artifactId":"9255713894"}',
			canonicalPr: pr(7, CANONICAL)
		});
		expect(d).toMatchObject({ push: true, pr: 'update' });
	});

	it('does nothing when the open proposal already carries the pin', () => {
		const d = decide({
			...base,
			basePin: null,
			branchPin: base.newPin,
			canonicalPr: pr(7, CANONICAL)
		});
		expect(d).toMatchObject({ push: false, pr: 'none' });
	});

	it('reopens rather than duplicating when the proposal was closed', () => {
		const d = decide({
			...base,
			basePin: null,
			branchPin: '{"artifactId":"9255713894"}',
			canonicalPr: pr(7, CANONICAL, 'CLOSED')
		});
		expect(d).toMatchObject({ push: true, pr: 'reopen' });
	});

	it('reopens without pushing when the branch already carries the pin', () => {
		const d = decide({
			...base,
			basePin: null,
			branchPin: base.newPin,
			canonicalPr: pr(7, CANONICAL, 'CLOSED')
		});
		expect(d).toMatchObject({ push: false, pr: 'reopen' });
	});

	it('opens a new proposal after the previous one merged', () => {
		const d = decide({
			...base,
			basePin: '{"artifactId":"9255713894"}',
			branchPin: '{"artifactId":"9255713894"}',
			canonicalPr: pr(7, CANONICAL, 'MERGED')
		});
		expect(d).toMatchObject({ push: true, pr: 'create' });
	});

	it('refuses to reset a branch carrying work it did not write', () => {
		// resetting the ref to base is an unconditional force; a human who fixed something on the
		// branch would otherwise lose it to the next phasm build
		const d = decide({
			...base,
			basePin: null,
			branchPin: '{"artifactId":"9255713894"}',
			canonicalPr: pr(7, CANONICAL),
			branchIsPristine: false
		});
		expect(d).toMatchObject({ push: false, pr: 'blocked' });
		expect(d.why).toContain('work this workflow did not write');
	});

	it('still adopts a branch that does not exist, whatever the authorship flag says', () => {
		const d = decide({
			...base,
			basePin: null,
			branchPin: null,
			canonicalPr: null,
			branchIsPristine: false
		});
		expect(d).toMatchObject({ push: true, pr: 'create' });
	});

	it('replaces a proposal a person authored rather than reopening it', () => {
		// #7 was opened by a maintainer PAT before the reconciler moved onto GITHUB_TOKEN; reopening
		// it on the next phasm build would keep an automated pin attributed to a human forever
		const d = decide({
			...base,
			basePin: null,
			branchPin: base.newPin,
			canonicalPr: pr(7, CANONICAL, 'CLOSED', 'gmitch215')
		});
		expect(d).toMatchObject({ pr: 'create' });
		expect(d.retire).toBeUndefined();
		expect(d.why).toContain('gmitch215');
	});

	it('closes a person-authored proposal that is still open, then replaces it', () => {
		const d = decide({
			...base,
			basePin: null,
			branchPin: base.newPin,
			canonicalPr: pr(7, CANONICAL, 'OPEN', 'gmitch215')
		});
		expect(d).toMatchObject({ pr: 'create', retire: 7 });
	});

	it('reuses a proposal the bot authored', () => {
		expect(reusable(pr(7, CANONICAL))).toBe(true);
		expect(reusable(pr(7, CANONICAL, 'OPEN', 'gmitch215'))).toBe(false);
		expect(reusable(null)).toBe(true);
	});

	it('does not block when there is nothing to push', () => {
		const d = decide({
			...base,
			basePin: null,
			branchPin: base.newPin,
			canonicalPr: pr(7, CANONICAL),
			branchIsPristine: false
		});
		expect(d).toMatchObject({ push: false, pr: 'none' });
	});
});

describe('whether a branch is still only what the reconciler put there', () => {
	// identity cannot be the test: the commit is made through the contents API so GitHub signs it,
	// which attributes it to the token owner rather than to a bot address
	it('accepts a branch one commit ahead touching only the pin', () => {
		expect(branchIsPristine(1, ['interp.lock.json'])).toBe(true);
	});

	it('accepts a branch that only trails the base', () => {
		expect(branchIsPristine(0, [])).toBe(true);
	});

	it('rejects a second commit, however small', () => {
		expect(branchIsPristine(2, ['interp.lock.json'])).toBe(false);
	});

	it('rejects a commit that touched anything else', () => {
		expect(branchIsPristine(1, ['interp.lock.json', 'src/site-do.ts'])).toBe(false);
		expect(branchIsPristine(1, ['wrangler.jsonc'])).toBe(false);
	});
});

describe('recognising the bot that owns a proposal', () => {
	/**
	 * Every shape GitHub renders the same actor in. Comparing the raw string churned #16 -> #17 ->
	 * #18 on one unchanged branch, because `gh pr list --json author` says `app/github-actions` and
	 * the constant is the bare name.
	 */
	it('accepts the bare login, the app form and the bracket form', () => {
		expect(isProposalBot('github-actions')).toBe(true);
		expect(isProposalBot('app/github-actions')).toBe(true);
		expect(isProposalBot('github-actions[bot]')).toBe(true);
	});

	it('still refuses a person, which is the guard this protects', () => {
		expect(isProposalBot('gmitch215')).toBe(false);
		expect(isProposalBot('app/renovate')).toBe(false);
		expect(isProposalBot('')).toBe(false);
	});

	it('reuses a proposal the bot opened rather than replacing it', () => {
		expect(reusable(pr(18, CANONICAL, 'OPEN', 'app/github-actions'))).toBe(true);
		expect(reusable(pr(18, CANONICAL, 'OPEN', 'gmitch215'))).toBe(false);
		expect(reusable(null)).toBe(true);
	});
});

describe('superseding', () => {
	it('closes all three of the branches that accumulated overnight', () => {
		const closing = supersede(theBrokenCase(), V, P, CANONICAL);
		expect(closing.map((p) => p.number)).toEqual([6, 5, 4]);
	});

	it('never closes the branch it is keeping', () => {
		const open = [pr(7, CANONICAL), ...theBrokenCase()];
		const closing = supersede(open, V, P, CANONICAL);
		expect(closing.map((p) => p.number)).toEqual([6, 5, 4]);
	});

	/**
	 * THE #16 CASE, and it used to assert the opposite.
	 *
	 * This read "leaves another variant open", which sounds careful and was the defect: a proposal
	 * pinning `control85` sat against a repository shipping `long64`, nothing ever ran for control85
	 * again, so nothing ever closed it. The same orphaning happens on any future switch, to whichever
	 * arm was shipping before. One interpreter ships at a time, so one proposal stays open.
	 */
	it('closes a proposal for a variant this repository is not shipping', () => {
		// this file's canonical variant IS control85, so the orphan here is the other arm; live it
		// was the mirror image, a control85 proposal against a repository shipping long64
		const open = [pr(16, 'interp/long64-php8.5'), pr(8, 'interp/control84-php8.4-1')];
		expect(supersede(open, V, P, CANONICAL).map((p) => p.number)).toEqual([16, 8]);
	});

	it('never touches a lane that is not an interpreter proposal', () => {
		const open = [pr(3, 'renovate/typescript-7.x'), pr(11, 'renovate/all-minor-patch')];
		expect(supersede(open, V, P, CANONICAL)).toEqual([]);
	});
});

describe('the branch sweep', () => {
	const remote = [
		CANONICAL,
		'interp/control85-php8.5-9255713894',
		'interp/control85-php8.5-9259605002',
		'interp/control84-php8.4-1',
		'master'
	];

	it('deletes only artifact-suffixed branches with no pull request left', () => {
		const open = [pr(6, 'interp/control85-php8.5-9259605002')];
		expect(staleBranches(remote, V, P, open)).toEqual(['interp/control85-php8.5-9255713894']);
	});

	it('never sweeps the canonical branch, even with nothing open on it', () => {
		expect(staleBranches(remote, V, P, [])).not.toContain(CANONICAL);
	});
});

describe('the plan a dry run prints', () => {
	const base = 'deadbeefcafe1234567890abcdef1234567890ab';

	/** the state the repository was actually in: three legacy proposals, no canonical branch */
	it('collapses the three that accumulated into one signed proposal', () => {
		const steps = plan(
			{ push: true, pr: 'create', why: 'the proposal moves to 9259605002' },
			CANONICAL,
			base,
			null,
			supersede(theBrokenCase(), V, P, CANONICAL),
			[]
		);
		expect(steps[0]).toContain(`reset refs/heads/${CANONICAL} to deadbee`);
		expect(steps[1]).toContain('signed');
		expect(steps[2]).toContain('open a pull request');
		expect(steps.filter((s) => s.includes('rename autoclosed'))).toHaveLength(3);
		for (const n of [6, 5, 4]) {
			expect(steps.some((s) => s.includes(`#${n}`))).toBe(true);
		}
	});

	it('re-triggers the checks when it bumps an open proposal', () => {
		// the commit is written by a bot token, which emits no synchronize; without this the new
		// head sha would carry no Gate Suites, test or format at all and could never merge
		const steps = plan(
			{ push: true, pr: 'update', why: 'the proposal moves to 9259605002' },
			CANONICAL,
			base,
			pr(7, CANONICAL),
			[],
			[]
		);
		expect(steps.some((s) => s.includes('close and reopen #7'))).toBe(true);
	});

	it('does not close and reopen when it changed no bytes', () => {
		const steps = plan(
			{ push: false, pr: 'update', why: 'nothing moved' },
			CANONICAL,
			base,
			pr(7, CANONICAL),
			[],
			[]
		);
		expect(steps.some((s) => s.includes('close and reopen'))).toBe(false);
	});

	it('mutates nothing at all when the branch is blocked', () => {
		const steps = plan(
			{ push: false, pr: 'blocked', why: 'a human committed here' },
			CANONICAL,
			base,
			pr(7, CANONICAL),
			supersede(theBrokenCase(), V, P, CANONICAL),
			['interp/control85-php8.5-1']
		);
		expect(steps.join('\n')).not.toContain('reset refs/heads');
		expect(steps.join('\n')).not.toContain('autoclosed');
		expect(steps.join('\n')).not.toContain('delete');
		expect(steps.some((s) => s.includes('supersede nothing'))).toBe(true);
	});

	it('retires a person-authored proposal without deleting the branch under it', () => {
		const steps = plan(
			{ push: true, pr: 'create', retire: 7, why: '#7 was authored by gmitch215' },
			CANONICAL,
			base,
			pr(7, CANONICAL, 'OPEN', 'gmitch215'),
			[],
			[]
		);
		expect(steps.some((s) => s.includes('close #7, keeping its branch'))).toBe(true);
		expect(steps.join('\n')).not.toContain(`delete ${CANONICAL}`);
		expect(steps.indexOf(steps.find((s) => s.includes('close #7'))!)).toBeLessThan(
			steps.indexOf(steps.find((s) => s.includes('open a pull request'))!)
		);
	});

	it('says so plainly when there is nothing to clean up', () => {
		const steps = plan(
			{ push: true, pr: 'create', why: 'first proposal' },
			CANONICAL,
			base,
			null,
			[],
			[]
		);
		expect(steps.some((s) => s.includes('supersede nothing; none is open'))).toBe(true);
	});

	it('sweeps an orphan branch whose pull request a human closed', () => {
		const steps = plan(
			{ push: false, pr: 'none', why: 'already pinned' },
			CANONICAL,
			base,
			null,
			[],
			['interp/control85-php8.5-9255713894']
		);
		expect(steps.some((s) => s.includes('delete interp/control85-php8.5-9255713894'))).toBe(
			true
		);
	});
});

describe('what a reviewer reads', () => {
	const facts = {
		variant: V,
		phpVersion: P,
		artifactId: '9259605002',
		sourceRun: '31931684516',
		sourceCommit: 'fd780a8ce9206f4fcfff8d7604b612f67ab6da2e',
		fetchLog: '.interp/php8.5.wasm  raw=12218396  packed to 2659489 zstd bytes\n',
		incumbent: '2879099 gzipped bytes',
		proposed: '2898319 gzipped bytes',
		runId: '31932228595',
		superseded: [6, 5, 4]
	};

	it('states the artifact, both bundle figures and what it replaced', () => {
		const body = proposalBody(facts);
		expect(body).toContain('`9259605002`');
		expect(body).toContain('incumbent: 2879099 gzipped bytes');
		expect(body).toContain('proposed:  2898319 gzipped bytes');
		expect(body).toContain('Superseded: #6, #5, #4.');
		expect(body).toContain('single proposal line');
	});

	it('says a figure was not measured rather than printing an empty one', () => {
		const body = proposalBody({ ...facts, incumbent: '', proposed: '', sourceRun: '' });
		expect(body).toContain('incumbent: not measured');
		expect(body).toContain('| phasm run | `n/a` |');
		expect(body).not.toContain('Superseded: .');
	});

	it('drops the supersession line when nothing was replaced', () => {
		expect(proposalBody({ ...facts, superseded: [] })).not.toContain('Superseded');
	});

	it('warns that the branch history is gone when it force-pushes', () => {
		expect(bumpComment(facts)).toContain('9259605002');
		expect(bumpComment(facts)).toContain('everything earlier on this branch is gone');
	});

	it('titles every proposal the same, so the bump is visible as an edit', () => {
		expect(proposalTitle(V, P)).toBe('chore(interp): control85 php8.5');
	});

	it('marks a superseded proposal autoclosed, the way renovate does', () => {
		expect(autoclosedTitle(proposalTitle(V, P))).toBe(
			'chore(interp): control85 php8.5 - autoclosed'
		);
	});

	it('does not stack the suffix when a title already carries it', () => {
		const once = autoclosedTitle(proposalTitle(V, P));
		expect(autoclosedTitle(once)).toBe(once);
	});

	it('explains a block without implying anything was changed', () => {
		const comment = blockedComment(facts);
		expect(comment).toContain('9259605002');
		expect(comment).toContain('nothing was changed');
	});

	it('says why the checks are held, and that bot authorship is the reason', () => {
		const held = proposalBody({ ...facts, checksHeld: true });
		expect(held).toContain('action_required');
		expect(held).toContain('github-actions[bot]');
		expect(held).toContain('intended');
		expect(proposalBody(facts)).not.toContain('action_required');
	});
});
