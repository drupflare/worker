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
 * **EVERYTHING HERE RUNS AS `GITHUB_TOKEN`, and that is the requirement rather than a default.** A
 * proposal must be attributed to `github-actions[bot]`, never to a maintainer. Running the pull
 * request half under a user PAT was tried and produced exactly that: the commit came back correctly
 * as `github-actions[bot]`, and the pull request came back authored by a person. The cost is that
 * GitHub holds every workflow run on a bot-authored pull request at `action_required` until someone
 * approves it from the Actions tab; that is accepted, because the alternative attributes automated
 * work to whoever owns the token.
 *
 * `PHASM_TOKEN` is not used here at all. It reaches the other repository's artifacts API, which is
 * the one thing `GITHUB_TOKEN` cannot do, and `scripts/fetch-interpreter.ts` is where it belongs.
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

export type ProposalPr = {
	number: number;
	state: PrState;
	headRefName: string;
	title: string;
	/** the login `gh pr list --json author` reports, e.g. `github-actions` or a person */
	author: string;
};

/** what to do with the branch and with the pull request on it */
export type Decision = {
	push: boolean;
	pr: 'none' | 'create' | 'update' | 'reopen' | 'blocked';
	/** an open proposal to close first, because a person authored it and cannot be reused */
	retire?: number;
	why: string;
};

/** what `gh pr list --json author` reports for a pull request this workflow opened */
export const BOT_LOGIN = 'github-actions';

/**
 * Whether an existing proposal can carry the next pin, or must be retired and replaced.
 *
 * A proposal authored by a person is never reused. One was opened by a maintainer PAT before the
 * reconciler moved fully onto `GITHUB_TOKEN`, and reopening it on the next phasm build would keep
 * an automated pin attributed to a human indefinitely -- the exact thing the bot attribution exists
 * to prevent.
 */
export function reusable(pr: ProposalPr | null): boolean {
	return pr === null || pr.author === BOT_LOGIN;
}

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
	/** false when the branch holds work this workflow did not write; see {@link branchIsPristine} */
	branchIsPristine?: boolean;
};

/**
 * Whether a proposal branch still holds only what this workflow put there.
 *
 * Identity is a fragile test here, because how the commit is written decides what it is attributed
 * to: `git commit` in Actions gives `github-actions[bot]` and `verified: false`, the contents API
 * under a bot token gives `github-actions[bot]` and a GitHub signature, and the same call under a
 * user PAT gives that user. Only one of those is what this workflow currently does, and it has
 * already changed once.
 *
 * The structural test survives all three: a pristine proposal is at most one commit ahead of its
 * base and touches nothing but the pin.
 *
 * @param aheadBy - `ahead_by` from a `base...branch` comparison; 0 when the branch only trails
 * @param files - the paths that comparison reports as changed
 */
export function branchIsPristine(aheadBy: number, files: readonly string[]): boolean {
	return aheadBy <= 1 && files.every((path) => path === PIN_PATH);
}

/** what a superseded proposal is renamed to, following renovate; appending twice is not a rename */
export function autoclosedTitle(title: string): string {
	return title.endsWith(' - autoclosed') ? title : `${title} - autoclosed`;
}

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

	const reuse = reusable(canonicalPr);
	const push = branchPin !== newPin;
	if (!push && canonicalPr?.state === 'OPEN' && reuse) {
		return { push: false, pr: 'none', why: `the open proposal already pins ${artifactId}` };
	}

	// resetting the ref to base is an unconditional force, so a human who committed onto the
	// proposal branch gets told rather than overwritten
	if (push && branchPin !== null && input.branchIsPristine === false) {
		return {
			push: false,
			pr: 'blocked',
			why: 'the branch carries work this workflow did not write, so it is left alone'
		};
	}

	const pr =
		canonicalPr === null || canonicalPr.state === 'MERGED' || !reuse
			? 'create'
			: canonicalPr.state === 'CLOSED'
				? 'reopen'
				: 'update';

	return {
		push,
		pr,
		...(reuse || canonicalPr?.state !== 'OPEN' ? {} : { retire: canonicalPr.number }),
		why: !reuse
			? `#${canonicalPr!.number} was authored by ${canonicalPr!.author}, so it is replaced`
			: push
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

/**
 * Every mutation a run would make, in order, as one readable list.
 *
 * `--dry-run` prints this so the reconciliation of an existing mess can be checked BEFORE it runs.
 * The three pull requests that accumulated on 2026-08-16 are exactly the case it was written for.
 */
export function plan(
	decision: Decision,
	branch: string,
	baseSha: string,
	canonicalPr: ProposalPr | null,
	replaced: readonly ProposalPr[],
	orphans: readonly string[]
): string[] {
	const steps: string[] = [];
	if (decision.pr === 'blocked') {
		steps.push(`leave ${branch} untouched: ${decision.why}`);
		if (canonicalPr?.state === 'OPEN')
			steps.push(`edit the status comment on #${canonicalPr.number}`);
		steps.push('supersede nothing, because the open proposals are the only record');
		return steps;
	}
	if (decision.push) {
		steps.push(`reset refs/heads/${branch} to ${baseSha.slice(0, 7)} (create if absent)`);
		steps.push(`commit ${PIN_PATH} onto ${branch} over the contents API, signed`);
	} else {
		steps.push(`leave refs/heads/${branch} as it is: ${decision.why}`);
	}
	if (decision.retire !== undefined) {
		steps.push(`close #${decision.retire}, keeping its branch: ${decision.why}`);
	}
	if (decision.pr === 'create') steps.push(`open a pull request from ${branch}`);
	if (decision.pr === 'update') steps.push(`edit #${canonicalPr?.number} and its status comment`);
	if (decision.pr === 'reopen') steps.push(`reopen and edit #${canonicalPr?.number}`);
	if (decision.pr === 'update' && decision.push) {
		steps.push(`close and reopen #${canonicalPr?.number} so the new sha gets its own checks`);
	}
	for (const pr of replaced) {
		steps.push(`comment, rename autoclosed, close #${pr.number} and delete ${pr.headRefName}`);
	}
	for (const orphan of orphans) steps.push(`delete ${orphan}, which has no open pull request`);
	if (replaced.length === 0 && orphans.length === 0)
		steps.push('supersede nothing; none is open');
	return steps;
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
	/** true when a bot opened the proposal, which is always, and which holds the required checks */
	checksHeld?: boolean;
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
	if (facts.checksHeld) {
		lines.push(
			'',
			'> Opened by `github-actions[bot]`, so GitHub holds every workflow run on it at ' +
				'`action_required` until it is approved from the Actions tab. That is deliberate: ' +
				'a maintainer token would start the checks unattended and would also author this ' +
				'pull request, which is not what an automated pin should look like.'
		);
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

/** what a superseded proposal is told before it is renamed and closed */
export function supersededComment(facts: ProposalFacts, keep: string): string {
	return (
		`Superseded by \`${keep}\`, which now pins phasm artifact \`${facts.artifactId}\`. ` +
		'One branch carries every proposal for this variant and version, so this one is closed ' +
		'and deleted rather than left to be reviewed against bytes nothing would ship.\n'
	);
}

/** what an open proposal is told when a human has committed onto its branch */
export function blockedComment(facts: ProposalFacts): string {
	return (
		`phasm artifact \`${facts.artifactId}\` is newer than the pin on this branch, and this ` +
		'branch carries a commit this workflow did not write. Force-pushing would destroy it, so ' +
		'nothing was changed. Merge or close this proposal, or drop the extra commit, and the next ' +
		'phasm build will take the branch again.\n'
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

const REPO = process.env.GITHUB_REPOSITORY ?? 'drupflare/worker';

function ghApi<T>(method: string, path: string, body?: unknown): T {
	const args = ['api', '--method', method, path];
	if (body) args.push('--input', '-');
	const out = execFileSync('gh', args, {
		encoding: 'utf8',
		input: body ? JSON.stringify(body) : undefined,
		maxBuffer: 1 << 26
	});
	return out.trim() ? (JSON.parse(out) as T) : ({} as T);
}

function tryGhApi<T>(method: string, path: string): T | null {
	try {
		const out = execFileSync('gh', ['api', '--method', method, path], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 1 << 26
		});
		return out.trim() ? (JSON.parse(out) as T) : ({} as T);
	} catch {
		return null;
	}
}

/**
 * A comment that REPLACES the last one this workflow left, rather than stacking beneath it.
 *
 * One status comment per proposal, always describing the current bytes. `--edit-last` targets the
 * authenticated user's own newest comment, so a bump overwrites a bump and a supersession overwrites
 * whatever the bumps left.
 */
function stickyComment(number: number, body: string): void {
	run('gh', ['pr', 'comment', String(number), '--body', body, '--edit-last', '--create-if-none']);
}

/** `git show <ref>:interp.lock.json`, or null when the ref or the file is absent */
export function pinAt(ref: string): string | null {
	return tryRun('git', ['show', `${ref}:${PIN_PATH}`]);
}

/** the pin a ref carries and the blob sha it is stored under, read over the API */
function pinOnRef(ref: string): { text: string; sha: string } | null {
	const got = tryGhApi<{ content?: string; sha?: string }>(
		'GET',
		`/repos/${REPO}/contents/${PIN_PATH}?ref=${encodeURIComponent(ref)}`
	);
	if (!got?.content || !got.sha) return null;
	return { text: Buffer.from(got.content, 'base64').toString('utf8'), sha: got.sha };
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

	const baseSha = run('git', ['rev-parse', 'HEAD']).trim();
	const branchRef = tryGhApi<{ object: { sha: string } }>(
		'GET',
		`/repos/${REPO}/git/ref/heads/${branch}`
	);
	const branchPin = branchRef ? (pinOnRef(branch)?.text ?? null) : null;
	const comparison = branchRef
		? ghApi<{ ahead_by: number; files?: { filename: string }[] }>(
				'GET',
				`/repos/${REPO}/compare/${baseSha}...${branch}`
			)
		: null;
	const pristine = comparison
		? branchIsPristine(
				comparison.ahead_by,
				(comparison.files ?? []).map((f) => f.filename)
			)
		: true;

	const fields = 'number,state,headRefName,title,author';
	// `author` arrives as an object; flattening it here keeps every pure function taking a login
	const list = (args: string[]): ProposalPr[] =>
		(
			JSON.parse(run('gh', ['pr', 'list', ...args, '--json', fields])) as (Omit<
				ProposalPr,
				'author'
			> & { author?: { login?: string } })[]
		).map((pr) => ({ ...pr, author: pr.author?.login ?? '' }));

	const openPrs = list(['--state', 'open', '--limit', '200']);
	const canonicalPr = list(['--head', branch, '--state', 'all', '--limit', '10'])[0] ?? null;

	const decision = decide({
		basePin: pinAt('HEAD'),
		branchPin,
		newPin,
		artifactId,
		canonicalPr,
		branchIsPristine: pristine
	});
	const replaced = supersede(openPrs, variant, phpVersion, branch);
	const orphanBranches = staleBranches(
		(
			tryGhApi<{ ref: string }[]>('GET', `/repos/${REPO}/git/matching-refs/heads/interp/`) ??
			[]
		).map((r) => r.ref.replace('refs/heads/', '')),
		variant,
		phpVersion,
		openPrs
	);
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
		superseded: replaced.map((pr) => pr.number),
		checksHeld: Boolean(process.env.GITHUB_ACTIONS)
	};

	console.log(`branch:  ${branch}`);
	console.log(`action:  push=${decision.push} pr=${decision.pr} (${decision.why})`);
	console.log(`replace: ${replaced.map((pr) => `#${pr.number}`).join(', ') || 'nothing open'}`);

	if (dryRun) {
		console.log('\n--- plan ---');
		for (const step of plan(decision, branch, baseSha, canonicalPr, replaced, orphanBranches))
			console.log(`  ${step}`);
		console.log('\n--- body ---\n' + proposalBody(facts));
		process.exit(0);
	}

	if (decision.pr === 'blocked') {
		if (canonicalPr?.state === 'OPEN') stickyComment(canonicalPr.number, blockedComment(facts));
		// nothing is superseded either: the open proposals are the only record of what was wanted
		exportEnv({
			PROPOSAL_BRANCH: branch,
			PROPOSAL_PR: canonicalPr ? `#${canonicalPr.number}` : 'none',
			PROPOSAL_ACTION: 'blocked',
			PROPOSAL_WHY: decision.why,
			PROPOSAL_SUPERSEDED: 'none'
		});
		console.error(`::warning::${branch} was left alone: ${decision.why}`);
		process.exit(0);
	}

	if (decision.push) {
		// the ref is reset to the base first, so the branch is always exactly base + one commit and
		// a proposal that sat through three master merges is never behind
		if (branchRef) {
			ghApi('PATCH', `/repos/${REPO}/git/refs/heads/${branch}`, {
				sha: baseSha,
				force: true
			});
		} else {
			ghApi('POST', `/repos/${REPO}/git/refs`, {
				ref: `refs/heads/${branch}`,
				sha: baseSha
			});
		}
		// the CONTENTS API rather than `git commit`, and no author or committer field: GitHub
		// attributes it to whoever the token is and signs it only when the payload names nobody
		ghApi('PUT', `/repos/${REPO}/contents/${PIN_PATH}`, {
			branch,
			message: `chore(interp): pin ${variant} php${phpVersion} artifact ${artifactId}`,
			content: Buffer.from(newPin, 'utf8').toString('base64'),
			...(pinOnRef(baseSha) ? { sha: pinOnRef(baseSha)!.sha } : {})
		});
	}

	const bodyFile = '/tmp/interp-proposal.md';
	writeFileSync(bodyFile, proposalBody(facts));

	// the branch is kept: it carries the commit this run just wrote, and the replacement opens on it
	if (decision.retire !== undefined) {
		stickyComment(decision.retire, supersededComment(facts, branch));
		run('gh', [
			'pr',
			'edit',
			String(decision.retire),
			'--title',
			autoclosedTitle(canonicalPr!.title)
		]);
		run('gh', ['pr', 'close', String(decision.retire)]);
		console.log(`autoclosed #${decision.retire}, which ${canonicalPr!.author} authored`);
	}

	let open: number | null =
		canonicalPr?.state === 'OPEN' && decision.retire === undefined ? canonicalPr.number : null;
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
		if (decision.push) {
			stickyComment(canonicalPr!.number, bumpComment(facts));
			// required checks are recorded per head sha, and a contents-API commit emits no
			// `synchronize`; a bot-opened pull request did get its runs created (held at
			// `action_required`), so reopening is the way to get runs onto the new sha to approve
			if (decision.pr === 'update') {
				run('gh', ['pr', 'close', target]);
				run('gh', ['pr', 'reopen', target]);
			}
		}
		open = canonicalPr?.number ?? null;
	}

	for (const pr of replaced) {
		stickyComment(pr.number, supersededComment(facts, branch));
		run('gh', ['pr', 'edit', String(pr.number), '--title', autoclosedTitle(pr.title)]);
		run('gh', ['pr', 'close', String(pr.number), '--delete-branch']);
		console.log(`autoclosed #${pr.number} (${pr.headRefName}) and deleted its branch`);
	}

	for (const orphan of orphanBranches) {
		ghApi('DELETE', `/repos/${REPO}/git/refs/heads/${orphan}`);
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
