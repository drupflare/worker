import { describe, expect, it } from 'vitest';
import {
	bumpComment,
	decide,
	isLegacyProposalBranch,
	matchesProposal,
	proposalBody,
	proposalBranch,
	proposalTitle,
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

function pr(number: number, headRefName: string, state: ProposalPr['state'] = 'OPEN'): ProposalPr {
	return { number, headRefName, state };
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

	it('leaves another variant, another version and every other lane open', () => {
		const open = [
			pr(8, 'interp/control84-php8.4-1'),
			pr(9, 'interp/control85-php8.4-1'),
			pr(3, 'renovate/typescript-7.x')
		];
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
});
