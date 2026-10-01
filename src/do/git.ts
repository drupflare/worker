import {
	authHeaders,
	type BuildState,
	createHookRequest,
	defaultBranchRequest,
	hasApi,
	parseRemote,
	type ProviderId,
	PROVIDERS,
	type Remote,
	remoteId
} from '../ops/git-provider';
import { type Advertisement, branchNames, discoverRefs, refSha } from '../ops/git-smart';
import { clampInterval, DEFAULT_POLL_MINUTES, duePolls } from '../ops/git-sync';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { jsonError } from '../util/reply';

export { gitApply, gitRestore, gitSync, gitVerifyBoot } from './git-delivery';

/**
 * Polls whatever is due, and pulls when a head moved.
 *
 * Driven from the alarm, capped at three remotes per firing: a poll is a DO request, and polling
 * every remote every firing would spend the regeneration meter on remotes that never change.
 */
export async function gitPoll(
	site: SitePhpDurableObject,
	limit = 3
): Promise<Record<string, unknown>[]> {
	const remotes = site.gitRemotes();
	if (remotes.length === 0) return [];
	const due = duePolls(site.gitPollStates(remotes), site.nowMs(), limit);
	const out: Record<string, unknown>[] = [];
	for (const id of due) {
		const remote = remotes.find((r) => r.id === id);
		if (remote === undefined) continue;
		try {
			const ad = await site.gitRefs(remote);
			const sha = refSha(ad, remote.branch);
			site.metaSet(`git_checked_${id}`, String(site.nowMs()));
			const before = site.metaGet(`git_head_${id}`) || null;
			site.metaSet(`git_head_${id}`, sha ?? '');
			if (sha === undefined || sha === before || site.metaGet(`git_previewof_${id}`)) {
				out.push({ id, changed: false, head: sha });
				continue;
			}
			const result = await site.gitSync(remote, sha, { apply: true });
			out.push({ id, changed: true, head: sha, ...result });
		} catch (e) {
			site.metaSet(`git_lasterror_${id}`, errorMessage(e).slice(0, 300));
			out.push({ id, error: errorMessage(e) });
		}
	}
	return out;
}

/** one remote with its stored state (head, install, backoff, hook) for the list reply */
export function gitRow(site: SitePhpDurableObject, remote: Remote): Record<string, unknown> {
	const id = remote.id;
	let counts: unknown = null;
	try {
		counts = JSON.parse(site.metaGet(`git_lastplan_${id}`) || 'null');
	} catch {
		counts = null;
	}
	return {
		...remote,
		head: site.metaGet(`git_head_${id}`) || null,
		installed: site.metaGet(`git_installedsha_${id}`) || null,
		checkedAt: Number(site.metaGet(`git_checked_${id}`) || '0') || null,
		pulledAt: Number(site.metaGet(`git_pulled_${id}`) || '0') || null,
		intervalMinutes: clampInterval(
			Number(site.metaGet(`git_interval_${id}`, String(DEFAULT_POLL_MINUTES)) ?? 0)
		),
		backoffUntil: Number(site.metaGet(`git_backoff_${id}`) || '0') || null,
		previewOf: site.metaGet(`git_previewof_${id}`) || null,
		lastError: site.metaGet(`git_lasterror_${id}`) || null,
		lastPlan: counts,
		proof: site.metaGet(`git_proof_${id}`) || null,
		hookInstalled: site.metaGet(`git_hooksecret_${id}`) !== '',
		files: site.gitStoredFiles(id).size
	};
}

/** the commit a diff or pull targets: the query's `sha`, else the remote branch head */
async function requestedSha(site: SitePhpDurableObject, url: URL, remote: Remote): Promise<string> {
	return url.searchParams.get('sha') || refSha(await site.gitRefs(remote), remote.branch) || '';
}

/** dispatches `/git?action=` (list, add, remove, check, switch, preview, pull, hook, ...) */
export async function handleGit(
	site: SitePhpDurableObject,
	url: URL,
	deliverBase = ''
): Promise<Response> {
	const action = url.searchParams.get('action') ?? 'list';
	const remotes = site.gitRemotes();
	const now = site.nowMs();

	if (action === 'list') {
		return Response.json({ ok: true, remotes: remotes.map((r) => gitRow(site, r)) });
	}

	if (action === 'add') {
		const provider = String(url.searchParams.get('provider') ?? '') as ProviderId;
		if (!(PROVIDERS as readonly string[]).includes(provider)) {
			return jsonError('unknown provider', 400);
		}
		const parsed = parseRemote(url.searchParams.get('repo') ?? '', provider);
		if (parsed === undefined) {
			return jsonError(
				hasApi(provider)
					? 'that is not a repository'
					: 'a plain remote needs a full clone URL',
				400
			);
		}
		const token = url.searchParams.get('token') ?? '';
		// a public remote over smart HTTP needs no credential at all
		if (token === '' && hasApi(provider)) {
			return jsonError('an access token is required', 400);
		}
		const email = url.searchParams.get('email') ?? '';
		const username = url.searchParams.get('username') ?? '';
		// Bitbucket's API takes the email and git takes the username, so one cannot serve both
		if (provider === 'bitbucket' && (email === '' || username === '')) {
			return jsonError(
				'Bitbucket needs your Atlassian account email for the API and your Bitbucket username for git',
				400
			);
		}

		// the token has to be stored before the first call, because every call authenticates
		const draft: Remote = {
			id: 'pending',
			provider,
			repo: parsed.repo,
			branch: url.searchParams.get('branch') || '',
			...(parsed.host ? { host: parsed.host } : {}),
			...(email ? { email } : {}),
			...(username ? { username } : {})
		};
		site.metaSet('git_token_pending', token);
		site.metaSet('git_email_pending', email);
		site.metaSet('git_username_pending', username);

		// the advertisement carries the default branch and proves the remote is reachable, which a
		// plain remote's missing provider API could not answer
		let ad: Advertisement;
		try {
			ad = await discoverRefs(site.gitSmart(draft));
		} catch (e) {
			return jsonError(errorMessage(e), 400);
		}
		let branch = draft.branch || ad.defaultBranch || '';
		if (branch === '' && hasApi(provider)) {
			const ref = defaultBranchRequest(draft);
			const got = await site.gitGet(draft, ref.url);
			branch = (got.ok ? ref.pick(got.body) : undefined) ?? 'main';
		}
		if (branch === '') branch = 'main';

		const remote: Remote = {
			...draft,
			branch,
			id: remoteId(provider, parsed.repo, branch)
		};
		const sha = refSha(ad, branch);
		if (sha === undefined) {
			return jsonError(`the remote has no branch ${branch}`, 400);
		}
		site.metaSet(`git_token_${remote.id}`, token);
		site.metaSet(`git_email_${remote.id}`, email);
		site.metaSet(`git_username_${remote.id}`, username);
		site.metaSet(`git_head_${remote.id}`, sha);
		site.metaSet(`git_checked_${remote.id}`, String(now));
		site.metaSet(
			`git_interval_${remote.id}`,
			String(clampInterval(Number(url.searchParams.get('interval') ?? DEFAULT_POLL_MINUTES)))
		);
		site.gitSaveRemotes([...remotes.filter((r) => r.id !== remote.id), remote]);
		return Response.json({
			ok: true,
			repo: remote.repo,
			branch,
			head: sha,
			id: remote.id,
			branches: branchNames(ad)
		});
	}

	const id = url.searchParams.get('id') ?? '';
	const remote = remotes.find((r) => r.id === id);
	if (remote === undefined) {
		return jsonError('unknown remote', 404);
	}
	const others = remotes.filter((r) => r.id !== id);

	try {
		switch (action) {
			case 'remove': {
				site.gitSaveRemotes(others);
				site.ensureServeTables();
				const removed = site.gitStoredFiles(id).size;
				site.sql.exec('DELETE FROM cfw_module_file WHERE package = ?', id);
				for (const key of [
					'token',
					'email',
					'head',
					'checked',
					'proof',
					'hooksecret',
					'interval',
					'backoff',
					'attempts',
					'installedsha',
					'previewof',
					'lasterror',
					'lastplan',
					'pulled'
				]) {
					site.metaSet(`git_${key}_${id}`, '');
				}
				site.php = undefined;
				return Response.json({
					ok: true,
					message: `removed ${remote.repo} and ${removed} file(s)`
				});
			}

			case 'check': {
				const ad = await site.gitRefs(remote);
				const sha = refSha(ad, remote.branch);
				const before = site.metaGet(`git_head_${id}`) || null;
				site.metaSet(`git_head_${id}`, sha ?? '');
				site.metaSet(`git_checked_${id}`, String(now));
				return Response.json({
					ok: true,
					head: sha,
					changed: sha !== before,
					installed: site.metaGet(`git_installedsha_${id}`) || null,
					message:
						sha === before
							? `unchanged at ${String(sha).slice(0, 12)}`
							: `now ${String(sha).slice(0, 12)}`
				});
			}

			case 'branches': {
				const ad = await site.gitRefs(remote);
				return Response.json({
					ok: true,
					branches: branchNames(ad),
					current: remote.branch,
					default: ad.defaultBranch
				});
			}

			case 'switch': {
				const branch = url.searchParams.get('branch') ?? '';
				if (branch === '') {
					return jsonError('no branch named', 400);
				}
				const ad = await site.gitRefs(remote);
				const sha = refSha(ad, branch);
				if (sha === undefined) {
					return jsonError(`the remote has no branch ${branch}`, 400);
				}
				// the id encodes the branch, so a switch carries every key across rather than
				// stranding the token and the installed files under the old one
				const next: Remote = {
					...remote,
					branch,
					id: remoteId(remote.provider, remote.repo, branch)
				};
				if (next.id !== id) {
					for (const key of [
						'token',
						'email',
						'proof',
						'hooksecret',
						'interval',
						'installedsha',
						'lasterror'
					]) {
						site.metaSet(
							`git_${key}_${next.id}`,
							site.metaGet(`git_${key}_${id}`) ?? ''
						);
						site.metaSet(`git_${key}_${id}`, '');
					}
					site.sql.exec(
						'UPDATE cfw_module_file SET package = ? WHERE package = ?',
						next.id,
						id
					);
				}
				site.metaSet(`git_head_${next.id}`, sha);
				site.metaSet(`git_checked_${next.id}`, String(now));
				site.metaSet(`git_previewof_${next.id}`, '');
				site.gitSaveRemotes([...others, next]);
				const result = await site.gitSync(next, sha, { apply: true });
				return Response.json({ ...result, branch, id: next.id });
			}

			case 'prs': {
				const pulls = await site.gitPulls(remote);
				return Response.json({
					ok: true,
					pulls,
					previewOf: site.metaGet(`git_previewof_${id}`) || null
				});
			}

			case 'preview': {
				const pr = url.searchParams.get('pr') ?? '';
				const pulls = await site.gitPulls(remote);
				const found = pulls.find((p) => p.id === pr);
				if (found === undefined || found.sha === null) {
					return jsonError(`no open request ${pr}`, 404);
				}
				const result = await site.gitSync(remote, found.sha, {
					apply: true,
					previewOf: pr
				});
				return Response.json({ ...result, previewOf: pr, title: found.title });
			}

			case 'unpreview': {
				const ad = await site.gitRefs(remote);
				const sha = refSha(ad, remote.branch);
				if (sha === undefined) {
					return jsonError(`the remote has no branch ${remote.branch}`, 400);
				}
				const result = await site.gitSync(remote, sha, {
					apply: true
				});
				return Response.json({ ...result, previewOf: null, branch: remote.branch });
			}

			// releases the preview pin without reaching the remote (`unpreview` needs a ref
			// advertisement, so it cannot heal a dead remote); the next successful poll converges
			case 'unpin': {
				const was = site.metaGet(`git_previewof_${remote.id}`) || undefined;
				site.metaSet(`git_previewof_${remote.id}`, '');
				return Response.json({
					ok: true,
					previewOf: null,
					was: was ?? null,
					synced: false,
					note:
						was === undefined
							? 'no preview was pinned'
							: 'pin released; the next poll pulls the branch head'
				});
			}

			case 'diff': {
				const sha = await requestedSha(site, url, remote);
				if (sha === '') {
					return jsonError('nothing to compare', 400);
				}
				return Response.json(await site.gitSync(remote, sha, { apply: false }));
			}

			case 'pull': {
				const sha = await requestedSha(site, url, remote);
				if (sha === '') {
					return jsonError('nothing to pull', 400);
				}
				site.metaSet(`git_head_${id}`, sha);
				const result = await site.gitSync(remote, sha, { apply: true });
				// the write-back is best-effort: a site that pulled must not report a failure
				// because the provider refused a status it was never required to accept
				if (hasApi(remote.provider) && site.gitCredential(id).token !== '') {
					await site
						.gitWriteStatus(
							remote,
							sha,
							result['applied'] === true ? 'success' : 'failed',
							String(result['error'] ?? 'installed on drupflare'),
							deliverBase
						)
						.catch(() => false);
				}
				return Response.json(result);
			}

			case 'interval': {
				const minutes = clampInterval(Number(url.searchParams.get('minutes') ?? '0'));
				site.metaSet(`git_interval_${id}`, String(minutes));
				return Response.json({
					ok: true,
					intervalMinutes: minutes,
					message: minutes === 0 ? 'polling off' : `every ${minutes} minutes`
				});
			}

			case 'hook': {
				if (!hasApi(remote.provider)) {
					return jsonError('a plain remote has no API to register a hook through', 400);
				}
				const secret = [...crypto.getRandomValues(new Uint8Array(24))]
					.map((b) => b.toString(16).padStart(2, '0'))
					.join('');
				const deliverTo = `${deliverBase}/githook?remote=${encodeURIComponent(id)}`;
				const post = createHookRequest(remote, deliverTo, secret);
				if (post === undefined) {
					return jsonError('not supported here', 400);
				}
				const res = await fetch(post.url, {
					method: 'POST',
					headers: {
						...authHeaders(remote, site.gitCredential(id)),
						'content-type': 'application/json'
					},
					body: JSON.stringify(post.body)
				});
				if (!res.ok) {
					return jsonError(`the provider answered ${res.status} creating the hook`, 400, {
						deliverTo
					});
				}
				site.metaSet(`git_hooksecret_${id}`, secret);
				return Response.json({ ok: true, deliverTo, message: 'webhook registered' });
			}

			case 'hooksecret': {
				// the manual path: an operator pasting the URL and secret into the provider by hand
				const secret =
					url.searchParams.get('secret') ||
					[...crypto.getRandomValues(new Uint8Array(24))]
						.map((b) => b.toString(16).padStart(2, '0'))
						.join('');
				site.metaSet(`git_hooksecret_${id}`, secret);
				return Response.json({
					ok: true,
					secret,
					deliverTo: `${deliverBase}/githook?remote=${encodeURIComponent(id)}`
				});
			}

			case 'status': {
				const sha = url.searchParams.get('sha') || site.metaGet(`git_head_${id}`) || '';
				if (sha === '') {
					return jsonError('no sha to write against', 400);
				}
				const state = (url.searchParams.get('state') ?? 'success') as BuildState;
				const wrote = await site.gitWriteStatus(
					remote,
					sha,
					state,
					url.searchParams.get('description') ?? 'drupflare',
					url.searchParams.get('target') ?? deliverBase
				);
				return Response.json({
					ok: wrote,
					message: wrote
						? 'status written'
						: hasApi(remote.provider)
							? 'the provider refused'
							: 'a plain remote has nowhere to put a status'
				});
			}

			default:
				return jsonError(`unknown action ${action}`, 404);
		}
	} catch (e) {
		site.metaSet(`git_lasterror_${id}`, errorMessage(e).slice(0, 300));
		return jsonError(errorMessage(e), 400);
	}
}
