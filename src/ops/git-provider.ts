/**
 * Git hosting providers, reduced to the six operations a site needs.
 *
 * **THE WRITE-BACK IS A COMMIT STATUS, NOT A CHECK RUN.** Measured 2026-08-24 with a
 * repository-scoped fine-grained PAT: `POST /repos/{o}/{r}/check-runs` answers 403
 * `Resource not accessible by personal access token`, while `POST /repos/{o}/{r}/statuses/{sha}`
 * answers 201. Checks are GitHub-App-only, GitLab and Bitbucket have no equivalent at all, and
 * registering an App is the same ask as registering an OAuth app. A status is a state, a context, a
 * description and a target URL on all three.
 */

// #region providers

export type ProviderId = 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'generic';

export const PROVIDERS: readonly ProviderId[] = [
	'github',
	'gitlab',
	'bitbucket',
	'gitea',
	'generic'
];

/** providers with an API beyond the git protocol itself */
export const API_PROVIDERS: readonly ProviderId[] = ['github', 'gitlab', 'bitbucket', 'gitea'];

export function hasApi(provider: ProviderId): boolean {
	return (API_PROVIDERS as readonly string[]).includes(provider);
}

/** one configured remote */
export interface Remote {
	id: string;
	provider: ProviderId;
	/** `owner/repo`, `group/subgroup/project`, or `workspace/slug` */
	repo: string;
	branch: string;
	/** the API host, so a self-hosted GitLab or Gitea works */
	host?: string;
	/** Bitbucket's REST API authenticates as Basic with the Atlassian account email as the username */
	email?: string;
	/** Bitbucket's GIT endpoint wants the Bitbucket username instead, and it is case sensitive */
	username?: string;
	/** an explicit clone URL, for a host whose git origin is not derivable from its API base */
	clone?: string;
	/** a pull/merge request head this remote is previewing instead of its branch */
	previewOf?: string;
}

/** what the operator pasted, kept apart from the remote so a log line can carry the remote */
export interface Credential {
	token: string;
	email?: string;
	username?: string;
}

const DEFAULT_HOST: Record<ProviderId, string> = {
	github: 'https://api.github.com',
	gitlab: 'https://gitlab.com',
	bitbucket: 'https://api.bitbucket.org',
	gitea: '',
	generic: ''
};

export function apiBase(remote: Remote): string {
	return (remote.host ?? DEFAULT_HOST[remote.provider]).replace(/\/+$/, '');
}

/** where the git protocol itself lives, which is not always derivable from the API base */
export function cloneUrl(remote: Remote): string {
	if (remote.clone !== undefined && remote.clone !== '') return remote.clone;
	const repo = remote.repo.replace(/^\/+|\/+$/g, '');
	if (remote.provider === 'github') {
		const host = remote.host ? remote.host.replace(/\/api\/v3\/?$/, '') : 'https://github.com';
		return `${host.replace(/\/+$/, '')}/${repo}.git`;
	}
	if (remote.provider === 'bitbucket') return `https://bitbucket.org/${repo}.git`;
	const base = apiBase(remote) || 'https://gitlab.com';
	return `${base}/${repo}.git`;
}

/** Bitbucket differs from {@link authHeaders}: the API takes the email, git the username */
export function smartAuth(remote: Remote, cred: Credential): { username: string; token: string } {
	const token = cred.token;
	if (remote.provider === 'gitlab') return { username: cred.email || 'oauth2', token };
	if (remote.provider === 'bitbucket') {
		return { username: cred.username || remote.username || '', token };
	}
	return { username: cred.email || 'x-access-token', token };
}

/** GitLab addresses a project by URL-encoded path, `/` as `%2F` */
export function projectPath(repo: string): string {
	return encodeURIComponent(repo.replace(/^\/+|\/+$/g, ''));
}

/**
 * The auth headers one provider wants.
 *
 * Bitbucket has no PAT: an Atlassian API token is Basic with the account email as the username, so
 * its settings row needs a field the other two do not.
 */
export function authHeaders(remote: Remote, cred: Credential): Record<string, string> {
	if (cred.token === '') return {};
	if (remote.provider === 'github') {
		return {
			authorization: `Bearer ${cred.token}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28'
		};
	}
	if (remote.provider === 'gitlab') {
		return { 'private-token': cred.token };
	}
	// Gitea's own scheme; it also accepts Basic, but `token` avoids needing a username
	if (remote.provider === 'gitea') {
		return { authorization: `token ${cred.token}`, accept: 'application/json' };
	}
	if (remote.provider === 'generic') {
		const user = cred.email || 'git';
		return { authorization: `Basic ${btoa(`${user}:${cred.token}`)}` };
	}
	const user = cred.email ?? remote.email ?? '';
	return { authorization: `Basic ${btoa(`${user}:${cred.token}`)}` };
}

// #endregion

// #region reading repository state

export interface RepoRef {
	url: string;
	/** where the head sha lives in the JSON the URL returns */
	pick: (body: unknown) => string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * The repository's own default branch, for the setup form.
 *
 * Only reached when a remote advertises no `symref=HEAD:` capability; the ref advertisement answers
 * this for free on every host that does, which is why there is no API call for a branch head.
 */
export function defaultBranchRequest(remote: Remote): RepoRef {
	const base = apiBase(remote);
	if (remote.provider === 'github') {
		return { url: `${base}/repos/${remote.repo}`, pick: (b) => str(obj(b).default_branch) };
	}
	if (remote.provider === 'gitea') {
		return {
			url: `${base}/api/v1/repos/${remote.repo}`,
			pick: (b) => str(obj(b).default_branch)
		};
	}
	if (remote.provider === 'gitlab') {
		return {
			url: `${base}/api/v4/projects/${projectPath(remote.repo)}`,
			pick: (b) => str(obj(b).default_branch)
		};
	}
	return {
		url: `${base}/2.0/repositories/${remote.repo}`,
		pick: (b) => str(obj(obj(b).mainbranch).name)
	};
}

// #endregion

// #region pull and merge requests

export interface PullRequest {
	id: string;
	title: string;
	/** the source branch, which is what a preview checks out */
	branch: string;
	target: string;
	sha: string | null;
	author: string;
	url: string;
	draft: boolean;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Open pull or merge requests.
 *
 * `generic` has no API, and does not need one: `requestRefs()` reads `refs/pull/N/head` and
 * `refs/merge-requests/N/head` straight out of the ref advertisement.
 */
export function pullsRequest(remote: Remote): { url: string; pick: (b: unknown) => PullRequest[] } {
	const base = apiBase(remote);
	if (remote.provider === 'gitlab') {
		return {
			url: `${base}/api/v4/projects/${projectPath(remote.repo)}/merge_requests?state=opened&per_page=50`,
			pick: (body) =>
				list(body).map((raw) => {
					const mr = obj(raw);
					return {
						id: String(mr.iid ?? mr.id ?? ''),
						title: str(mr.title) ?? '',
						branch: str(mr.source_branch) ?? '',
						target: str(mr.target_branch) ?? '',
						sha: str(mr.sha),
						author: str(obj(mr.author).username) ?? '',
						url: str(mr.web_url) ?? '',
						draft: mr.draft === true || mr.work_in_progress === true
					};
				})
		};
	}
	if (remote.provider === 'bitbucket') {
		return {
			url: `${base}/2.0/repositories/${remote.repo}/pullrequests?state=OPEN&pagelen=50`,
			pick: (body) =>
				list(obj(body).values).map((raw) => {
					const pr = obj(raw);
					return {
						id: String(pr.id ?? ''),
						title: str(pr.title) ?? '',
						branch: str(obj(obj(pr.source).branch).name) ?? '',
						target: str(obj(obj(pr.destination).branch).name) ?? '',
						sha: str(obj(obj(pr.source).commit).hash),
						author: str(obj(pr.author).display_name) ?? '',
						url: str(obj(obj(pr.links).html).href) ?? '',
						draft: false
					};
				})
		};
	}
	// GitHub and Gitea answer the same shape; only the path differs
	const path =
		remote.provider === 'gitea'
			? `${base}/api/v1/repos/${remote.repo}/pulls?state=open&limit=50`
			: `${base}/repos/${remote.repo}/pulls?state=open&per_page=50`;
	return {
		url: path,
		pick: (body) =>
			list(body).map((raw) => {
				const pr = obj(raw);
				return {
					id: String(pr.number ?? pr.id ?? ''),
					title: str(pr.title) ?? '',
					branch: str(obj(pr.head).ref) ?? '',
					target: str(obj(pr.base).ref) ?? '',
					sha: str(obj(pr.head).sha) ?? str(obj(pr.head).sha),
					author: str(obj(pr.user).login) ?? '',
					url: str(pr.html_url) ?? '',
					draft: pr.draft === true
				};
			})
	};
}

// #endregion

// #region the write-back

/** the vocabulary every provider shares, before each one's own spelling */
export type BuildState = 'pending' | 'running' | 'success' | 'failed';

/** Gitea reuses GitHub's vocabulary but spells a failure `failure` and an error `error` */
const GITEA_STATE: Record<BuildState, string> = {
	pending: 'pending',
	running: 'pending',
	success: 'success',
	failed: 'failure'
};

const GITHUB_STATE: Record<BuildState, string> = {
	pending: 'pending',
	running: 'pending',
	success: 'success',
	failed: 'failure'
};
const GITLAB_STATE: Record<BuildState, string> = {
	pending: 'pending',
	running: 'running',
	success: 'success',
	failed: 'failed'
};
const BITBUCKET_STATE: Record<BuildState, string> = {
	pending: 'INPROGRESS',
	running: 'INPROGRESS',
	success: 'SUCCESSFUL',
	failed: 'FAILED'
};

export interface StatusPost {
	url: string;
	body: Record<string, unknown>;
}

/**
 * One commit status, in the provider's own spelling.
 *
 * GitLab caps `description` and `target_url` at 255 characters and rejects a longer one, so both are
 * clipped here rather than at the call site.
 */
export function statusRequest(
	remote: Remote,
	sha: string,
	state: BuildState,
	description: string,
	targetUrl: string,
	context = 'drupflare'
): StatusPost | null {
	// a plain git remote has nowhere to put one; the caller reports that rather than guessing a URL
	if (remote.provider === 'generic') return null;
	const base = apiBase(remote);
	const desc = description.slice(0, 255);
	const target = targetUrl.slice(0, 255);
	if (remote.provider === 'gitea') {
		return {
			url: `${base}/api/v1/repos/${remote.repo}/statuses/${sha}`,
			body: {
				state: GITEA_STATE[state],
				context,
				description: desc,
				target_url: target
			}
		};
	}
	if (remote.provider === 'github') {
		return {
			url: `${base}/repos/${remote.repo}/statuses/${sha}`,
			body: {
				state: GITHUB_STATE[state],
				description: desc,
				target_url: target,
				context
			}
		};
	}
	if (remote.provider === 'gitlab') {
		return {
			url: `${base}/api/v4/projects/${projectPath(remote.repo)}/statuses/${sha}`,
			body: {
				state: GITLAB_STATE[state],
				name: context,
				description: desc,
				target_url: target,
				ref: remote.branch
			}
		};
	}
	return {
		url: `${base}/2.0/repositories/${remote.repo}/commit/${sha}/statuses/build`,
		body: {
			key: context,
			state: BITBUCKET_STATE[state],
			name: context,
			description: desc,
			url: target
		}
	};
}

// #endregion

// #region webhooks

export interface HookPost {
	url: string;
	body: Record<string, unknown>;
}

export function createHookRequest(
	remote: Remote,
	deliverTo: string,
	secret: string
): HookPost | null {
	if (remote.provider === 'generic') return null;
	const base = apiBase(remote);
	if (remote.provider === 'gitea') {
		return {
			url: `${base}/api/v1/repos/${remote.repo}/hooks`,
			// `type: 'gitea'` still signs with X-Hub-Signature-256, which is why it verifies as GitHub does
			body: {
				type: 'gitea',
				active: true,
				events: ['push', 'pull_request'],
				config: { url: deliverTo, content_type: 'json', secret }
			}
		};
	}
	if (remote.provider === 'github') {
		return {
			url: `${base}/repos/${remote.repo}/hooks`,
			// `name` must be the literal "web"; `events` defaults to ["push"] if omitted
			body: {
				name: 'web',
				active: true,
				events: ['push', 'pull_request'],
				config: { url: deliverTo, content_type: 'json', secret }
			}
		};
	}
	if (remote.provider === 'gitlab') {
		return {
			url: `${base}/api/v4/projects/${projectPath(remote.repo)}/hooks`,
			// no `signing_token`: GitLab validates it and rejects the whole request
			body: {
				url: deliverTo,
				token: secret,
				push_events: true,
				merge_requests_events: true,
				enable_ssl_verification: true
			}
		};
	}
	return {
		url: `${base}/2.0/repositories/${remote.repo}/hooks`,
		body: {
			url: deliverTo,
			description: 'drupflare',
			active: true,
			events: ['repo:push', 'pullrequest:created', 'pullrequest:updated'],
			secret
		}
	};
}

const encoder = new TextEncoder();

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
	return diff === 0;
}

const HEX = (bytes: ArrayBuffer): string =>
	[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(
	secret: string,
	message: string,
	hash: 'SHA-256' | 'SHA-1'
): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash },
		false,
		['sign']
	);
	return crypto.subtle.sign('HMAC', key, encoder.encode(message));
}

/** how a delivery was authenticated, so a site can tell a signature from a shared secret */
export type HookProof = 'hmac-sha256' | 'hmac-sha1' | 'shared-secret' | 'none';

export interface HookVerdict {
	ok: boolean;
	proof: HookProof;
	reason?: string;
}

/**
 * Verifies one delivery.
 *
 * **GitLab cannot be HMAC-verified on most installs.** `webhook-signature` needs 19.0 with the
 * `webhook_signing_token` flag; everything older sends the secret in `X-Gitlab-Token` as plaintext.
 * Both are accepted and the verdict records which one answered, because "verified" means different
 * things and a site should be able to see that.
 */
export async function verifyHook(
	provider: ProviderId,
	headers: Headers,
	body: string,
	secret: string
): Promise<HookVerdict> {
	if (secret === '') return { ok: false, proof: 'none', reason: 'no secret is configured' };

	// Gitea and Forgejo sign exactly as GitHub does, and a plain remote is only accepted if it can
	if (provider === 'github' || provider === 'gitea' || provider === 'generic') {
		const sent = headers.get('x-hub-signature-256');
		if (sent !== null) {
			const want = `sha256=${HEX(await hmac(secret, body, 'SHA-256'))}`;
			return timingSafeEqual(encoder.encode(sent), encoder.encode(want))
				? { ok: true, proof: 'hmac-sha256' }
				: { ok: false, proof: 'hmac-sha256', reason: 'signature did not match' };
		}
		return { ok: false, proof: 'none', reason: 'no X-Hub-Signature-256 on the delivery' };
	}

	if (provider === 'bitbucket') {
		const sent = headers.get('x-hub-signature');
		if (sent === null) return { ok: false, proof: 'none', reason: 'no X-Hub-Signature' };
		// the docs say sha256 today and that it may change, so the method is read rather than assumed
		const [method = '', value = ''] = sent.split('=');
		const hash = method === 'sha1' ? 'SHA-1' : 'SHA-256';
		const want = HEX(await hmac(secret, body, hash));
		return timingSafeEqual(encoder.encode(value), encoder.encode(want))
			? { ok: true, proof: method === 'sha1' ? 'hmac-sha1' : 'hmac-sha256' }
			: { ok: false, proof: 'hmac-sha256', reason: 'signature did not match' };
	}

	const signature = headers.get('webhook-signature');
	const id = headers.get('webhook-id');
	const timestamp = headers.get('webhook-timestamp');
	if (signature !== null && id !== null && timestamp !== null) {
		// Standard Webhooks: the key is the base64 body of a `whsec_`-prefixed token
		const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
		const digest = await hmac(atob(raw), `${id}.${timestamp}.${body}`, 'SHA-256');
		const want = `v1,${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
		const offered = signature.split(' ');
		for (const one of offered) {
			if (timingSafeEqual(encoder.encode(one), encoder.encode(want))) {
				return { ok: true, proof: 'hmac-sha256' };
			}
		}
		return { ok: false, proof: 'hmac-sha256', reason: 'no signature in the list matched' };
	}

	const token = headers.get('x-gitlab-token');
	if (token === null) return { ok: false, proof: 'none', reason: 'no X-Gitlab-Token' };
	return timingSafeEqual(encoder.encode(token), encoder.encode(secret))
		? { ok: true, proof: 'shared-secret' }
		: { ok: false, proof: 'shared-secret', reason: 'token did not match' };
}

// #endregion

// #region reading a delivery

export interface PushEvent {
	kind: 'push';
	branch: string;
	before: string | null;
	after: string | null;
	deleted: boolean;
}

export interface PullEvent {
	kind: 'pull';
	branch: string;
	sha: string | null;
	action: string;
}

export type HookEvent = PushEvent | PullEvent | { kind: 'other'; action: string };

const bare = (ref: string): string => ref.replace(/^refs\/heads\//, '');

/**
 * Reads the branch and shas out of one delivery.
 *
 * Bitbucket differs in shape rather than in naming: it batches every changed ref into
 * `push.changes[]`, and `new` is null on a branch delete.
 */
export function readHookEvent(provider: ProviderId, headers: Headers, payload: unknown): HookEvent {
	const body = obj(payload);

	if (provider === 'bitbucket') {
		const key = headers.get('x-event-key') ?? '';
		if (key === 'repo:push') {
			const changes = Array.isArray(obj(body.push).changes)
				? (obj(body.push).changes as unknown[])
				: [];
			const first = obj(changes[0]);
			const next = first.new === null ? null : obj(first.new);
			return {
				kind: 'push',
				branch: str(next?.name) ?? str(obj(obj(first.old).target).hash) ?? '',
				before: str(obj(obj(first.old).target).hash),
				after: next === null ? null : str(obj(next.target).hash),
				deleted: next === null
			};
		}
		if (key.startsWith('pullrequest:')) {
			const pr = obj(body.pullrequest);
			return {
				kind: 'pull',
				branch: str(obj(obj(pr.source).branch).name) ?? '',
				sha: str(obj(obj(pr.source).commit).hash),
				action: key.slice('pullrequest:'.length)
			};
		}
		return { kind: 'other', action: key };
	}

	if (provider === 'gitlab') {
		const event = headers.get('x-gitlab-event') ?? '';
		if (event === 'Push Hook') {
			const after = str(body.after);
			return {
				kind: 'push',
				branch: bare(str(body.ref) ?? ''),
				before: str(body.before),
				after: str(body.checkout_sha) ?? after,
				// GitLab reports a delete as an all-zero `after`
				deleted: after === null || /^0+$/.test(after)
			};
		}
		if (event === 'Merge Request Hook') {
			const at = obj(body.object_attributes);
			return {
				kind: 'pull',
				branch: str(at.source_branch) ?? '',
				sha: str(obj(at.last_commit).id),
				action: str(at.action) ?? 'update'
			};
		}
		return { kind: 'other', action: event };
	}

	// GitHub, Gitea and a plain remote all send GitHub's payload shape; only the header name differs
	const event =
		headers.get('x-github-event') ??
		headers.get('x-gitea-event') ??
		(body.ref !== undefined && body.after !== undefined ? 'push' : '');
	if (event === 'push') {
		return {
			kind: 'push',
			branch: bare(str(body.ref) ?? ''),
			before: str(body.before),
			after: str(body.after),
			deleted: body.deleted === true
		};
	}
	if (event === 'pull_request') {
		const pr = obj(body.pull_request);
		return {
			kind: 'pull',
			branch: str(obj(pr.head).ref) ?? '',
			sha: str(obj(pr.head).sha),
			action: str(body.action) ?? 'synchronize'
		};
	}
	return { kind: 'other', action: event };
}

// #endregion

/** a remote id that is safe in a URL and in a storage key */
export function remoteId(provider: ProviderId, repo: string, branch: string): string {
	return `${provider}:${repo}@${branch}`.replace(/[^A-Za-z0-9:@/._-]/g, '-');
}

/**
 * Parses what an operator pastes into the one field the form offers.
 *
 * A browse URL, a clone URL and `owner/repo` all name the same thing, and requiring one of them is
 * the kind of ceremony that makes a setup page feel hostile.
 */
export function parseRemote(
	input: string,
	provider: ProviderId
): { repo: string; host?: string } | null {
	const trimmed = input
		.trim()
		.replace(/\.git$/, '')
		.replace(/\/+$/, '');
	if (trimmed === '') return null;

	// `owner/repo` names nothing without a host on a provider that has no default one
	if (/^[\w.-]+(\/[\w.-]+)+$/.test(trimmed) && !trimmed.includes('://')) {
		return DEFAULT_HOST[provider] === '' ? null : { repo: trimmed };
	}

	let url: URL;
	try {
		url = new URL(trimmed.replace(/^git@([^:]+):/, 'https://$1/'));
	} catch {
		return null;
	}
	const repo = url.pathname.replace(/^\/+/, '');
	if (repo === '') return null;

	const origin = `${url.protocol}//${url.host}`;
	if (provider === 'gitea' || provider === 'generic') return { repo, host: origin };
	if (provider === 'gitlab' && url.host !== 'gitlab.com') return { repo, host: origin };
	// GitHub Enterprise puts its API under /api/v3 while the git origin stays at the root
	if (provider === 'github' && url.host !== 'github.com') {
		return { repo, host: `${origin}/api/v3` };
	}
	return { repo };
}
