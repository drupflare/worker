/**
 * Reconciles `interp.lock.json` into exactly ONE pull request per proposal line.
 *
 * ```sh
 * bun scripts/interp-proposal.ts --variant=control85 --php=8.5
 * bun scripts/interp-proposal.ts --variant=control85 --php=8.5 --dry-run
 * ```
 *
 * The branch used to carry the artifact id -- `interp/control85-php8.5-9255839106` -- and the
 * workflow bailed whenever that branch already existed. A newer phasm build therefore never matched
 * an existing branch, so it opened another pull request and nothing ever closed the older one: three
 * arrived overnight on 2026-08-16, all proposing the same one-line change to a file that does not
 * exist on master.
 *
 * The branch is now the proposal LINE, `interp/<variant>-php<version>`, rebuilt from the base on
 * every run. A newer artifact force-pushes onto it and bumps the open pull request; a build that
 * arrives after someone closed it reopens rather than duplicating; and every branch left over from
 * the artifact-suffixed scheme is closed and deleted.
 *
 * Recovery is the same code path rather than a mode, which is why a `workflow_dispatch` with no
 * artifact id collapses whatever is open today.
 *
 * @see .github/workflows/interpreter.yml which drives this
 * @see scripts/fetch-interpreter.ts which writes the pin this proposes
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/** where the pin lands; `scripts/fetch-interpreter.ts --pin` is what writes it */
export const PIN_PATH = 'interp.lock.json';

/** the state GitHub reports for a pull request, in the spelling `gh pr list --json state` uses */
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

export type ProposalPr = { number: number; state: PrState; headRefName: string };

/** what to do with the branch and with the pull request on it */
export type Decision = {
	push: boolean;
	pr: 'none' | 'create' | 'update' | 'reopen';
	why: string;
};

export type DecisionInput = {
	/** `interp.lock.json` as the base branch carries it, or null when the base has no pin */
	basePin: string | null;
	/** the same file as the proposal branch carries it, or null when the branch does not exist */
	branchPin: string | null;
	/** what this run fetched */
	newPin: string;
	artifactId: string;
	/** the newest pull request whose head is the proposal branch, in any state */
	canonicalPr: ProposalPr | null;
};

/** the one branch every proposal for a variant and version lands on */
export function proposalBranch(variant: string, phpVersion: string): string {
	return `interp/${variant}-php${phpVersion}`;
}

/**
 * Whether a branch is the artifact-suffixed form this scheme replaced.
 *
 * The digits are load-bearing: they are what makes such a branch provably bot-created, so sweeping
 * one that has no pull request left cannot take a branch somebody is working on.
 */
export function isLegacyProposalBranch(
	branch: string,
	variant: string,
	phpVersion: string
): boolean {
	return new RegExp(`^${escapeRegExp(proposalBranch(variant, phpVersion))}-[0-9]+$`).test(branch);
}

/** whether a branch proposes this variant and version at all, under either naming */
export function matchesProposal(branch: string, variant: string, phpVersion: string): boolean {
	return (
		branch === proposalBranch(variant, phpVersion) ||
		isLegacyProposalBranch(branch, variant, phpVersion)
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Picks the action from what the base, the branch and the pull request already carry.
 *
 * The base is checked FIRST and by content. `git status --porcelain -- interp.lock.json` used to
 * stand in for "is this already pinned", which can never be empty while the file is untracked on
 * master -- so the old workflow proposed a pin it already had, every time.
 */
export function decide(input: DecisionInput): Decision {
	const { basePin, branchPin, newPin, artifactId, canonicalPr } = input;

	if (basePin !== null && basePin === newPin) {
		return { push: false, pr: 'none', why: `the base branch already pins ${artifactId}` };
	}

	const push = branchPin !== newPin;
	if (!push && canonicalPr?.state === 'OPEN') {
		return { push: false, pr: 'none', why: `the open proposal already pins ${artifactId}` };
	}

	const pr =
		canonicalPr === null || canonicalPr.state === 'MERGED'
			? 'create'
			: canonicalPr.state === 'CLOSED'
				? 'reopen'
				: 'update';

	return {
		push,
		pr,
		why: push
			? `the proposal moves to ${artifactId}`
			: `the branch pins ${artifactId} and no open proposal names it`
	};
}

/** every open pull request this run replaces; the kept branch is never among them */
export function supersede(
	open: readonly ProposalPr[],
	variant: string,
	phpVersion: string,
	keep: string | null
): ProposalPr[] {
	return open.filter(
		(pr) => matchesProposal(pr.headRefName, variant, phpVersion) && pr.headRefName !== keep
	);
}

/**
 * Artifact-suffixed branches with no open pull request left to close them.
 *
 * `gh pr close --delete-branch` covers the ones still open; this covers the ones whose pull request
 * a human closed by hand, which is the state the repository would otherwise accumulate forever.
 */
export function staleBranches(
	branches: readonly string[],
	variant: string,
	phpVersion: string,
	open: readonly ProposalPr[]
): string[] {
	const claimed = new Set(open.map((pr) => pr.headRefName));
	return branches.filter(
		(branch) => isLegacyProposalBranch(branch, variant, phpVersion) && !claimed.has(branch)
	);
}

export function proposalTitle(variant: string, phpVersion: string): string {
	return `chore(interp): ${variant} php${phpVersion}`;
}

export type ProposalFacts = {
	variant: string;
	phpVersion: string;
	artifactId: string;
	sourceRun?: string;
	sourceCommit?: string;
	fetchLog?: string;
	incumbent?: string;
	proposed?: string;
	runId?: string;
	superseded?: number[];
};

export function proposalBody(facts: ProposalFacts): string {
	const lines = [
		'Fetched from `drupflare/phasm` and verified. Nothing here deploys.',
		'',
		'| field | value |',
		'| --- | --- |',
		`| variant | \`${facts.variant}\` |`,
		`| php | \`${facts.phpVersion}\` |`,
		`| artifact | \`${facts.artifactId}\` |`,
		`| phasm run | \`${facts.sourceRun || 'n/a'}\` |`,
		`| phasm commit | \`${facts.sourceCommit || 'n/a'}\` |`,
		''
	];

	if (facts.fetchLog || facts.incumbent || facts.proposed) {
		lines.push('```txt');
		if (facts.fetchLog) lines.push(facts.fetchLog.replace(/\n+$/, ''));
		lines.push(`incumbent: ${facts.incumbent || 'not measured'}`);
		lines.push(`proposed:  ${facts.proposed || 'not measured'}`);
		lines.push('```', '');
	}

	lines.push(
		`This branch is the single proposal line for \`${facts.variant} php${facts.phpVersion}\`; ` +
			'a newer phasm build force-pushes onto it rather than opening another pull request.'
	);
	if (facts.superseded?.length) {
		lines.push('', `Superseded: ${facts.superseded.map((n) => `#${n}`).join(', ')}.`);
	}
	lines.push(
		'',
		`The payload carrying these bytes is attached to run ${facts.runId || 'n/a'}.`,
		'The rollback unit is a Worker version, so ship this on its own.'
	);
	return lines.join('\n') + '\n';
}

/** what an existing proposal is told when a newer artifact lands on it */
export function bumpComment(facts: ProposalFacts): string {
	return (
		`Force-pushed to phasm artifact \`${facts.artifactId}\` ` +
		`(run \`${facts.sourceRun || 'n/a'}\`). The body above describes the current bytes; ` +
		'everything earlier on this branch is gone.\n'
	);
}

/** what a superseded proposal is told before it is closed */
export function supersededComment(facts: ProposalFacts, keep: string): string {
	return (
		`Superseded by \`${keep}\`, which now pins phasm artifact \`${facts.artifactId}\`. ` +
		'One branch carries every proposal for this variant and version, so this one is closed ' +
		'and deleted rather than left to be reviewed against bytes nothing would ship.\n'
	);
}

function run(cmd: string, args: string[]): string {
	return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
}

/** the same call, answering null rather than throwing; an absent branch is an answer here */
function tryRun(cmd: string, args: string[]): string | null {
	try {
		return execFileSync(cmd, args, {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 1 << 26
		});
	} catch {
		return null;
	}
}

/** `git show <ref>:interp.lock.json`, or null when the ref or the file is absent */
export function pinAt(ref: string): string | null {
	return tryRun('git', ['show', `${ref}:${PIN_PATH}`]);
}

function exportEnv(values: Record<string, string>): void {
	const file = process.env.GITHUB_ENV;
	if (!file) return;
	appendFileSync(
		file,
		Object.entries(values)
			.map(([key, value]) => `${key}=${value}`)
			.join('\n') + '\n'
	);
}

if (import.meta.main) {
	const arg = (name: string, fallback = ''): string =>
		process.argv.find((a: string) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
		fallback;
	const dryRun = process.argv.includes('--dry-run');

	const variant = arg('variant', process.env.VARIANT ?? '');
	const phpVersion = arg('php', process.env.PHP_VERSION ?? '');
	const base = arg('base', process.env.GITHUB_REF_NAME || 'master');
	if (!variant || !phpVersion) {
		console.error('usage: bun scripts/interp-proposal.ts --variant=<rc> --php=<major.minor>');
		process.exit(2);
	}
	if (!existsSync(PIN_PATH)) {
		console.error(`${PIN_PATH} is not present; run fetch-interpreter.ts --pin first`);
		process.exit(2);
	}

	const newPin = readFileSync(PIN_PATH, 'utf8');
	const artifactId = String(JSON.parse(newPin).artifactId);
	const branch = proposalBranch(variant, phpVersion);

	const remoteSha = tryRun('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`])
		?.split(/\s/)[0]
		?.trim();
	if (remoteSha) run('git', ['fetch', '--depth=1', 'origin', `refs/heads/${branch}`]);
	const branchPin = remoteSha ? pinAt('FETCH_HEAD') : null;

	const openPrs = JSON.parse(
		run('gh', [
			'pr',
			'list',
			'--state',
			'open',
			'--limit',
			'100',
			'--json',
			'number,state,headRefName'
		])
	) as ProposalPr[];
	const history = JSON.parse(
		run('gh', [
			'pr',
			'list',
			'--head',
			branch,
			'--state',
			'all',
			'--limit',
			'10',
			'--json',
			'number,state,headRefName'
		])
	) as ProposalPr[];
	const canonicalPr = history[0] ?? null;

	const decision = decide({ basePin: pinAt('HEAD'), branchPin, newPin, artifactId, canonicalPr });
	const replaced = supersede(openPrs, variant, phpVersion, branch);
	const facts: ProposalFacts = {
		variant,
		phpVersion,
		artifactId,
		sourceRun: arg('source-run', process.env.SOURCE_RUN ?? ''),
		sourceCommit: arg('source-commit', process.env.SOURCE_COMMIT ?? ''),
		fetchLog: (() => {
			const path = arg('fetch-log');
			return path && existsSync(path) ? readFileSync(path, 'utf8') : undefined;
		})(),
		incumbent: arg('incumbent', process.env.INCUMBENT ?? ''),
		proposed: arg('proposed', process.env.BUNDLE ?? ''),
		runId: process.env.GITHUB_RUN_ID,
		superseded: replaced.map((pr) => pr.number)
	};

	console.log(`branch:  ${branch}`);
	console.log(`action:  push=${decision.push} pr=${decision.pr} (${decision.why})`);
	console.log(`replace: ${replaced.map((pr) => `#${pr.number}`).join(', ') || 'nothing open'}`);

	if (dryRun) {
		console.log('\n--- body ---\n' + proposalBody(facts));
		process.exit(0);
	}

	if (decision.push) {
		run('git', ['config', 'user.name', 'github-actions[bot]']);
		run('git', [
			'config',
			'user.email',
			'41898282+github-actions[bot]@users.noreply.github.com'
		]);
		run('git', ['checkout', '-B', branch]);
		run('git', ['add', PIN_PATH]);
		run('git', [
			'commit',
			'-m',
			`chore(interp): pin ${variant} php${phpVersion} artifact ${artifactId}`
		]);
		// rebuilt from the base every run, so the lease is what stops a concurrent push being lost
		const lease = remoteSha ? [`--force-with-lease=refs/heads/${branch}:${remoteSha}`] : [];
		run('git', ['push', ...lease, 'origin', `HEAD:refs/heads/${branch}`]);
	}

	const bodyFile = '/tmp/interp-proposal.md';
	writeFileSync(bodyFile, proposalBody(facts));

	let open: number | null = canonicalPr?.state === 'OPEN' ? canonicalPr.number : null;
	if (decision.pr === 'create') {
		run('gh', [
			'pr',
			'create',
			'--base',
			base,
			'--head',
			branch,
			'--title',
			proposalTitle(variant, phpVersion),
			'--body-file',
			bodyFile
		]);
		const created = Number(
			run('gh', ['pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number'])
		);
		open = Number.isFinite(created) ? created : null;
	} else if (decision.pr === 'reopen' || decision.pr === 'update') {
		const target = String(canonicalPr?.number);
		if (decision.pr === 'reopen') run('gh', ['pr', 'reopen', target]);
		run('gh', ['pr', 'edit', target, '--body-file', bodyFile]);
		if (decision.push) run('gh', ['pr', 'comment', target, '--body', bumpComment(facts)]);
		open = canonicalPr?.number ?? null;
	}

	for (const pr of replaced) {
		run('gh', ['pr', 'comment', String(pr.number), '--body', supersededComment(facts, branch)]);
		run('gh', ['pr', 'close', String(pr.number), '--delete-branch']);
		console.log(`closed #${pr.number} (${pr.headRefName}) and deleted its branch`);
	}

	const orphans = staleBranches(
		(tryRun('git', ['ls-remote', '--heads', 'origin', 'interp/*']) ?? '')
			.split('\n')
			.filter(Boolean)
			.map((line) => line.split('refs/heads/')[1]?.trim() ?? ''),
		variant,
		phpVersion,
		openPrs
	);
	for (const orphan of orphans) {
		run('git', ['push', 'origin', '--delete', orphan]);
		console.log(`deleted ${orphan}, which had no open pull request`);
	}

	exportEnv({
		PROPOSAL_BRANCH: branch,
		PROPOSAL_PR: open ? `#${open}` : 'none',
		PROPOSAL_ACTION: `${decision.pr}${decision.push ? ' (force-pushed)' : ''}`,
		PROPOSAL_WHY: decision.why,
		PROPOSAL_SUPERSEDED: replaced.map((pr) => `#${pr.number}`).join(' ') || 'none'
	});
}
