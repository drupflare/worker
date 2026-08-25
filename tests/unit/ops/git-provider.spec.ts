import { describe, expect, it } from 'vitest';
import {
	API_PROVIDERS,
	apiBase,
	authHeaders,
	cloneUrl,
	createHookRequest,
	defaultBranchRequest,
	hasApi,
	parseRemote,
	PROVIDERS,
	pullsRequest,
	readHookEvent,
	remoteId,
	smartAuth,
	statusRequest,
	verifyHook,
	type ProviderId,
	type Remote
} from '../../../src/ops/git-provider';

/**
 * The provider layer, which is URL and payload construction plus signature verification.
 *
 * The endpoints come from the provider docs and from calls measured against the live APIs, so what
 * is covered here is that this code emits what was measured, not that the measurement was right.
 */

const SELF_HOSTED: Partial<Record<ProviderId, string>> = {
	gitea: 'https://git.example.com',
	generic: 'https://git.example.com'
};

const remote = (provider: ProviderId, over: Partial<Remote> = {}): Remote => ({
	id: 'r',
	provider,
	repo: provider === 'gitlab' ? 'group/sub/project' : 'owner/repo',
	branch: 'main',
	...(SELF_HOSTED[provider] ? { host: SELF_HOSTED[provider] } : {}),
	...over
});

describe('addressing a repository', () => {
	it('defaults each provider to its own API host', () => {
		expect(apiBase(remote('github'))).toBe('https://api.github.com');
		expect(apiBase(remote('gitlab'))).toBe('https://gitlab.com');
		expect(apiBase(remote('bitbucket'))).toBe('https://api.bitbucket.org');
	});

	it('lets a self-hosted GitLab override the host, trailing slash and all', () => {
		expect(apiBase(remote('gitlab', { host: 'https://git.example.com/' }))).toBe(
			'https://git.example.com'
		);
	});

	// a subgroup path is the case a naive join breaks: GitLab wants it URL-encoded whole
	it('encodes a GitLab subgroup path rather than joining it', () => {
		for (const url of [
			defaultBranchRequest(remote('gitlab')).url,
			pullsRequest(remote('gitlab')).url
		]) {
			expect(url).toContain('/projects/group%2Fsub%2Fproject');
			expect(url).not.toContain('/group/sub/project');
		}
	});

	it('reads the default branch out of each provider own shape', () => {
		expect(defaultBranchRequest(remote('github')).pick({ default_branch: 'trunk' })).toBe(
			'trunk'
		);
		expect(defaultBranchRequest(remote('gitlab')).pick({ default_branch: 'trunk' })).toBe(
			'trunk'
		);
		expect(defaultBranchRequest(remote('gitea')).pick({ default_branch: 'trunk' })).toBe(
			'trunk'
		);
		expect(
			defaultBranchRequest(remote('bitbucket')).pick({ mainbranch: { name: 'trunk' } })
		).toBe('trunk');
	});

	it('returns null rather than a wrong branch when the field is missing', () => {
		for (const p of PROVIDERS) expect(defaultBranchRequest(remote(p)).pick({})).toBeNull();
		expect(defaultBranchRequest(remote('github')).pick(null)).toBeNull();
	});

	it('separates the providers that have an API from the one that does not', () => {
		expect([...API_PROVIDERS]).toEqual(['github', 'gitlab', 'bitbucket', 'gitea']);
		expect(hasApi('generic')).toBe(false);
		for (const p of API_PROVIDERS) expect(hasApi(p)).toBe(true);
	});
});

describe('the git transport, which is where the content actually comes from', () => {
	it('derives a clone URL that is not the API host', () => {
		expect(cloneUrl(remote('github'))).toBe('https://github.com/owner/repo.git');
		expect(cloneUrl(remote('bitbucket'))).toBe('https://bitbucket.org/owner/repo.git');
		expect(cloneUrl(remote('gitlab'))).toBe('https://gitlab.com/group/sub/project.git');
		expect(cloneUrl(remote('gitea'))).toBe('https://git.example.com/owner/repo.git');
	});

	// GitHub Enterprise puts the API at /api/v3 while git stays at the root
	it('strips the Enterprise API suffix off the git origin', () => {
		expect(cloneUrl(remote('github', { host: 'https://ghe.example.com/api/v3' }))).toBe(
			'https://ghe.example.com/owner/repo.git'
		);
	});

	it('lets an explicit clone URL win over any derivation', () => {
		expect(cloneUrl(remote('github', { clone: 'https://mirror.invalid/x.git' }))).toBe(
			'https://mirror.invalid/x.git'
		);
	});

	it('picks the Basic username each host expects, which is not the API scheme', () => {
		expect(smartAuth(remote('github'), { token: 't' })).toEqual({
			username: 'x-access-token',
			token: 't'
		});
		expect(smartAuth(remote('gitlab'), { token: 't' }).username).toBe('oauth2');
		expect(smartAuth(remote('bitbucket'), { token: 't', email: 'a@b.test' }).username).toBe(
			'a@b.test'
		);
	});
});

describe('authentication', () => {
	it('sends GitHub a bearer plus the pinned API version', () => {
		const h = authHeaders(remote('github'), { token: 't' });
		expect(h.authorization).toBe('Bearer t');
		expect(h['x-github-api-version']).toBe('2022-11-28');
	});

	it('sends GitLab its own header rather than a bearer', () => {
		expect(authHeaders(remote('gitlab'), { token: 't' })).toEqual({ 'private-token': 't' });
	});

	// Bitbucket has no PAT: an Atlassian API token is Basic with the account email as the username
	it('sends Bitbucket Basic with the email as the username', () => {
		const h = authHeaders(remote('bitbucket'), { token: 'tok', email: 'a@b.test' });
		expect(h.authorization).toBe(`Basic ${btoa('a@b.test:tok')}`);
	});
});

describe('open requests', () => {
	it('reads GitHub and Gitea, which answer the same shape at different paths', () => {
		const body = [
			{
				number: 12,
				title: 'Add a form',
				head: { ref: 'feat/form', sha: 'aaa' },
				base: { ref: 'main' },
				user: { login: 'someone' },
				html_url: 'https://example.invalid/12',
				draft: true
			}
		];
		for (const p of ['github', 'gitea'] as const) {
			const req = pullsRequest(remote(p));
			expect(req.url).toContain('/pulls?state=open');
			expect(req.pick(body)[0]).toEqual({
				id: '12',
				title: 'Add a form',
				branch: 'feat/form',
				target: 'main',
				sha: 'aaa',
				author: 'someone',
				url: 'https://example.invalid/12',
				draft: true
			});
		}
	});

	it('reads a GitLab merge request by iid, not by id', () => {
		const req = pullsRequest(remote('gitlab'));
		expect(req.url).toContain('/merge_requests?state=opened');
		const one = req.pick([
			{
				id: 99999,
				iid: 4,
				title: 'MR',
				source_branch: 'topic',
				target_branch: 'main',
				sha: 'bbb',
				author: { username: 'dev' },
				web_url: 'https://gitlab.invalid/4',
				work_in_progress: true
			}
		])[0];
		expect(one?.id, 'the iid is what a human sees and what the API takes back').toBe('4');
		expect(one?.draft).toBe(true);
	});

	it('reads a Bitbucket pull request out of its values array', () => {
		const one = pullsRequest(remote('bitbucket')).pick({
			values: [
				{
					id: 7,
					title: 'PR',
					source: { branch: { name: 'topic' }, commit: { hash: 'ccc' } },
					destination: { branch: { name: 'main' } },
					author: { display_name: 'Dev Eloper' },
					links: { html: { href: 'https://bitbucket.invalid/7' } }
				}
			]
		})[0];
		expect(one?.id).toBe('7');
		expect(one?.sha).toBe('ccc');
		expect(one?.author).toBe('Dev Eloper');
	});

	it('answers an empty list rather than throwing on a body it did not expect', () => {
		for (const p of API_PROVIDERS) expect(pullsRequest(remote(p)).pick(null)).toEqual([]);
	});
});

describe('commit status write-back', () => {
	const status = (...a: Parameters<typeof statusRequest>) => {
		const post = statusRequest(...a);
		if (post === null) throw new Error('that provider has no status endpoint');
		return post;
	};

	it('spells one state three ways', () => {
		expect(status(remote('github'), 'sha', 'failed', 'd', 'u').body.state).toBe('failure');
		expect(status(remote('gitlab'), 'sha', 'failed', 'd', 'u').body.state).toBe('failed');
		expect(status(remote('bitbucket'), 'sha', 'failed', 'd', 'u').body.state).toBe('FAILED');
	});

	// GitHub has no running state, so it has to collapse onto pending rather than be dropped
	it('collapses running onto pending where the provider has no such state', () => {
		expect(status(remote('github'), 'sha', 'running', 'd', 'u').body.state).toBe('pending');
		expect(status(remote('gitlab'), 'sha', 'running', 'd', 'u').body.state).toBe('running');
	});

	it('clips description and target to GitLab 255-character cap', () => {
		const long = 'x'.repeat(400);
		const body = status(remote('gitlab'), 'sha', 'success', long, long).body;
		expect(String(body.description)).toHaveLength(255);
		expect(String(body.target_url)).toHaveLength(255);
	});

	it('names the context in the field each provider keys on', () => {
		expect(status(remote('github'), 's', 'success', '', '', 'ctx').body.context).toBe('ctx');
		expect(status(remote('gitlab'), 's', 'success', '', '', 'ctx').body.name).toBe('ctx');
		// a POST with an existing key overwrites that status, so the key IS the identity
		expect(status(remote('bitbucket'), 's', 'success', '', '', 'ctx').body.key).toBe('ctx');
	});

	it('posts to the sha, on every provider that has an endpoint', () => {
		for (const p of API_PROVIDERS) {
			expect(status(remote(p), 'deadbeef', 'success', '', '').url).toContain('deadbeef');
		}
	});

	it('spells Gitea like GitHub, on its own path', () => {
		const post = status(remote('gitea'), 'sha', 'failed', 'd', 'u');
		expect(post.url).toBe('https://git.example.com/api/v1/repos/owner/repo/statuses/sha');
		expect(post.body.state).toBe('failure');
	});

	// a plain remote has nowhere to put a status, and guessing a URL would post to a stranger
	it('refuses rather than inventing an endpoint for a plain remote', () => {
		expect(statusRequest(remote('generic'), 'sha', 'success', '', '')).toBeNull();
	});
});

describe('creating a webhook', () => {
	const hook = (...a: Parameters<typeof createHookRequest>) => {
		const post = createHookRequest(...a);
		if (post === null) throw new Error('that provider has no hook endpoint');
		return post;
	};

	// `name` must be the literal "web" or GitHub refuses the body
	it('sends GitHub the literal web name and the secret in config', () => {
		const { body } = hook(remote('github'), 'https://s.test/h', 'sec');
		expect(body.name).toBe('web');
		expect((body.config as Record<string, unknown>).secret).toBe('sec');
	});

	// token is what every install before 19.0 sends back; signing_token is the 19.0 HMAC one
	it('sends GitLab both the shared token and the signing token', () => {
		const { body } = hook(remote('gitlab'), 'https://s.test/h', 'sec');
		expect(body.token).toBe('sec');
		expect(body.signing_token).toBe('sec');
	});

	it('subscribes Bitbucket to push and pull-request events by key', () => {
		const { body } = hook(remote('bitbucket'), 'https://s.test/h', 'sec');
		expect(body.events).toContain('repo:push');
		expect(body.secret).toBe('sec');
	});

	it('sends Gitea its own type with GitHub-shaped config', () => {
		const { url, body } = hook(remote('gitea'), 'https://s.test/h', 'sec');
		expect(url).toBe('https://git.example.com/api/v1/repos/owner/repo/hooks');
		expect(body.type).toBe('gitea');
		expect((body.config as Record<string, unknown>).secret).toBe('sec');
	});

	it('refuses for a plain remote, which the operator registers by hand', () => {
		expect(createHookRequest(remote('generic'), 'https://s.test/h', 'sec')).toBeNull();
	});
});

describe('verifying a delivery', () => {
	const hex = (buf: ArrayBuffer) =>
		[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

	async function sign(secret: string, body: string, hash: 'SHA-256' | 'SHA-1' = 'SHA-256') {
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash },
			false,
			['sign']
		);
		return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
	}

	it('accepts a correct GitHub signature and names the proof', async () => {
		const body = '{"ref":"refs/heads/main"}';
		const h = new Headers({ 'x-hub-signature-256': `sha256=${await sign('sec', body)}` });
		expect(await verifyHook('github', h, body, 'sec')).toEqual({
			ok: true,
			proof: 'hmac-sha256'
		});
	});

	it('refuses a GitHub signature computed over a different body', async () => {
		const h = new Headers({ 'x-hub-signature-256': `sha256=${await sign('sec', 'other')}` });
		const out = await verifyHook('github', h, '{"ref":"refs/heads/main"}', 'sec');
		expect(out.ok).toBe(false);
	});

	it('refuses a GitHub delivery that carries no signature at all', async () => {
		expect(await verifyHook('github', new Headers(), 'x', 'sec')).toMatchObject({ ok: false });
	});

	// the docs say sha256 today and that it may change, so the method is read off the header
	it('reads the Bitbucket hash method rather than assuming it', async () => {
		const body = '{"push":{}}';
		const sha1 = new Headers({ 'x-hub-signature': `sha1=${await sign('sec', body, 'SHA-1')}` });
		expect(await verifyHook('bitbucket', sha1, body, 'sec')).toEqual({
			ok: true,
			proof: 'hmac-sha1'
		});
	});

	// most GitLab installs cannot be HMAC-verified at all; the verdict has to say which it was
	it('accepts a GitLab shared secret and records it as weaker than a signature', async () => {
		const h = new Headers({ 'x-gitlab-token': 'sec' });
		expect(await verifyHook('gitlab', h, '{}', 'sec')).toEqual({
			ok: true,
			proof: 'shared-secret'
		});
	});

	it('refuses a GitLab token that does not match', async () => {
		const h = new Headers({ 'x-gitlab-token': 'wrong' });
		expect(await verifyHook('gitlab', h, '{}', 'sec')).toMatchObject({ ok: false });
	});

	it('prefers the 19.0 standard-webhooks signature when the delivery carries one', async () => {
		const secret = 'whsec_' + btoa('key-bytes');
		const body = '{"object_kind":"push"}';
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode('key-bytes'),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const digest = await crypto.subtle.sign(
			'HMAC',
			key,
			new TextEncoder().encode(`id-1.1700000000.${body}`)
		);
		const value = `v1,${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
		const h = new Headers({
			'webhook-id': 'id-1',
			'webhook-timestamp': '1700000000',
			// the header is a space-separated LIST, so a match against any entry counts
			'webhook-signature': `v1,other ${value}`
		});
		expect(await verifyHook('gitlab', h, body, secret)).toEqual({
			ok: true,
			proof: 'hmac-sha256'
		});
	});

	it('refuses everything when no secret is configured', async () => {
		const h = new Headers({ 'x-hub-signature-256': 'sha256=whatever' });
		expect(await verifyHook('github', h, 'x', '')).toMatchObject({ ok: false, proof: 'none' });
	});
});

describe('reading a delivery', () => {
	it('reads a GitHub push', () => {
		const out = readHookEvent('github', new Headers({ 'x-github-event': 'push' }), {
			ref: 'refs/heads/main',
			before: 'a',
			after: 'b',
			deleted: false
		});
		expect(out).toEqual({
			kind: 'push',
			branch: 'main',
			before: 'a',
			after: 'b',
			deleted: false
		});
	});

	it('reads a GitLab push and prefers checkout_sha', () => {
		const out = readHookEvent('gitlab', new Headers({ 'x-gitlab-event': 'Push Hook' }), {
			ref: 'refs/heads/trunk',
			before: 'a',
			after: 'b',
			checkout_sha: 'c'
		});
		expect(out).toMatchObject({ branch: 'trunk', after: 'c' });
	});

	// GitLab reports a delete as an all-zero `after`, which is not a sha to fetch
	it('calls an all-zero GitLab after a delete', () => {
		const out = readHookEvent('gitlab', new Headers({ 'x-gitlab-event': 'Push Hook' }), {
			ref: 'refs/heads/gone',
			after: '0000000000000000000000000000000000000000'
		});
		expect(out).toMatchObject({ deleted: true });
	});

	// Bitbucket batches refs into push.changes[] and sends `new: null` on a delete
	it('reads a Bitbucket push out of its changes array', () => {
		const out = readHookEvent('bitbucket', new Headers({ 'x-event-key': 'repo:push' }), {
			push: {
				changes: [
					{ old: { target: { hash: 'a' } }, new: { name: 'main', target: { hash: 'b' } } }
				]
			}
		});
		expect(out).toEqual({
			kind: 'push',
			branch: 'main',
			before: 'a',
			after: 'b',
			deleted: false
		});
	});

	it('calls a null Bitbucket new a delete', () => {
		const out = readHookEvent('bitbucket', new Headers({ 'x-event-key': 'repo:push' }), {
			push: { changes: [{ old: { target: { hash: 'a' } }, new: null }] }
		});
		expect(out).toMatchObject({ kind: 'push', deleted: true, after: null });
	});

	it('reads a pull request on all three', () => {
		expect(
			readHookEvent('github', new Headers({ 'x-github-event': 'pull_request' }), {
				action: 'opened',
				pull_request: { head: { ref: 'topic', sha: 's' } }
			})
		).toEqual({ kind: 'pull', branch: 'topic', sha: 's', action: 'opened' });

		expect(
			readHookEvent('gitlab', new Headers({ 'x-gitlab-event': 'Merge Request Hook' }), {
				object_attributes: {
					action: 'open',
					source_branch: 'topic',
					last_commit: { id: 's' }
				}
			})
		).toEqual({ kind: 'pull', branch: 'topic', sha: 's', action: 'open' });

		expect(
			readHookEvent('bitbucket', new Headers({ 'x-event-key': 'pullrequest:created' }), {
				pullrequest: { source: { branch: { name: 'topic' }, commit: { hash: 's' } } }
			})
		).toEqual({ kind: 'pull', branch: 'topic', sha: 's', action: 'created' });
	});

	it('calls anything else other rather than guessing', () => {
		expect(readHookEvent('github', new Headers({ 'x-github-event': 'ping' }), {})).toEqual({
			kind: 'other',
			action: 'ping'
		});
	});
});

describe('what an operator pastes', () => {
	it('takes owner/repo as it stands', () => {
		expect(parseRemote('owner/repo', 'github')).toEqual({ repo: 'owner/repo' });
	});

	it('takes a browse URL, a clone URL and an SSH remote', () => {
		expect(parseRemote('https://github.com/owner/repo', 'github')).toEqual({
			repo: 'owner/repo'
		});
		expect(parseRemote('https://github.com/owner/repo.git', 'github')).toEqual({
			repo: 'owner/repo'
		});
		expect(parseRemote('git@github.com:owner/repo.git', 'github')).toEqual({
			repo: 'owner/repo'
		});
	});

	it('takes a GitLab subgroup path', () => {
		expect(parseRemote('https://gitlab.com/group/sub/project', 'gitlab')).toEqual({
			repo: 'group/sub/project'
		});
	});

	// the one case where the host is not derivable from the provider
	it('keeps the host for a self-hosted GitLab and drops it for gitlab.com', () => {
		expect(parseRemote('https://git.example.com/g/p', 'gitlab')).toEqual({
			repo: 'g/p',
			host: 'https://git.example.com'
		});
		expect(parseRemote('https://gitlab.com/g/p', 'gitlab')).toEqual({ repo: 'g/p' });
	});

	it('refuses what is not a repository at all', () => {
		expect(parseRemote('', 'github')).toBeNull();
		expect(parseRemote('   ', 'github')).toBeNull();
		expect(parseRemote('https://github.com/', 'github')).toBeNull();
	});
});

describe('remote ids', () => {
	it('is stable and safe for a URL and a storage key', () => {
		expect(remoteId('github', 'owner/repo', 'main')).toBe('github:owner/repo@main');
	});

	it('strips anything that would need escaping', () => {
		expect(remoteId('gitlab', 'g/p', 'feat #1')).toBe('gitlab:g/p@feat--1');
	});
});

describe('Gitea, Forgejo and a plain remote', () => {
	const hex = (buf: ArrayBuffer) =>
		[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

	async function githubStyle(secret: string, body: string): Promise<string> {
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))}`;
	}

	it('sends Gitea its own token scheme rather than a bearer', () => {
		expect(authHeaders(remote('gitea'), { token: 't' }).authorization).toBe('token t');
	});

	it('sends a plain remote Basic, defaulting the username to git', () => {
		expect(authHeaders(remote('generic'), { token: 't' }).authorization).toBe(
			`Basic ${btoa('git:t')}`
		);
	});

	it('sends nothing at all when there is no token, which is what a public repo wants', () => {
		for (const p of PROVIDERS) expect(authHeaders(remote(p), { token: '' })).toEqual({});
	});

	it('verifies a Gitea delivery with GitHub signing, because that is what Gitea sends', async () => {
		const body = '{"ref":"refs/heads/main","after":"abc"}';
		const headers = new Headers({
			'x-gitea-event': 'push',
			'x-hub-signature-256': await githubStyle('sec', body)
		});
		expect(await verifyHook('gitea', headers, body, 'sec')).toEqual({
			ok: true,
			proof: 'hmac-sha256'
		});
	});

	it('refuses a plain delivery that carries no signature, which is all it has to go on', async () => {
		const verdict = await verifyHook('generic', new Headers(), '{}', 'sec');
		expect(verdict.ok).toBe(false);
		expect(verdict.proof).toBe('none');
	});

	it('accepts a plain delivery that does sign, so a self-hosted hook still works', async () => {
		const body = '{"ref":"refs/heads/main","after":"abc"}';
		const headers = new Headers({ 'x-hub-signature-256': await githubStyle('sec', body) });
		expect((await verifyHook('generic', headers, body, 'sec')).ok).toBe(true);
	});

	it('reads a Gitea push off its own event header', () => {
		const event = readHookEvent('gitea', new Headers({ 'x-gitea-event': 'push' }), {
			ref: 'refs/heads/main',
			before: 'old',
			after: 'new'
		});
		expect(event).toEqual({
			kind: 'push',
			branch: 'main',
			before: 'old',
			after: 'new',
			deleted: false
		});
	});

	it('infers a push from the payload when a plain remote sends no event header', () => {
		const event = readHookEvent('generic', new Headers(), {
			ref: 'refs/heads/trunk',
			before: 'a',
			after: 'b'
		});
		expect(event.kind).toBe('push');
		expect((event as { branch: string }).branch).toBe('trunk');
	});

	it('keeps the host for Gitea and a plain remote, which have no default one', () => {
		expect(parseRemote('https://git.example.com/o/r.git', 'gitea')).toEqual({
			repo: 'o/r',
			host: 'https://git.example.com'
		});
		expect(parseRemote('https://code.internal:8443/team/site', 'generic')).toEqual({
			repo: 'team/site',
			host: 'https://code.internal:8443'
		});
	});

	it('refuses owner/repo where there is no host to attach it to', () => {
		expect(parseRemote('owner/repo', 'gitea')).toBeNull();
		expect(parseRemote('owner/repo', 'generic')).toBeNull();
		expect(parseRemote('owner/repo', 'github')).toEqual({ repo: 'owner/repo' });
	});

	it('keeps a GitHub Enterprise host and points it at the v3 API', () => {
		expect(parseRemote('https://ghe.corp.example/o/r', 'github')).toEqual({
			repo: 'o/r',
			host: 'https://ghe.corp.example/api/v3'
		});
	});
});
