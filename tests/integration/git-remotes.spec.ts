import { afterEach, describe, expect, it } from 'vitest';
import { KV_OVERRIDABLE } from '../../src/ops/plan';
import { fakeCommit, gitFetch, type FakeRepo } from '../helpers/fake-git';
import { freshSite, inObject } from '../helpers/serve-do';

/**
 * The git tier's wiring: where a token is stored, who may reach it, and what a delivery must carry.
 *
 * The provider layer is covered by `unit/ops/git-provider.spec.ts`, which is where the endpoints and
 * signature verification live. This is the half that touches the object.
 */

const call = (site: DurableObjectStub, path: string, init?: RequestInit) =>
	site.fetch(new Request(`https://do.local${path}`, init));

describe('the owner gate', () => {
	// the lane runs with PW_DIAGNOSTICS on, which opens every `/__` route by design, so the owner
	// half is only observable with it off
	it('refuses /__git with neither the owner token nor diagnostics', async () => {
		const site = freshSite();
		const status = await inObject(site, async (obj) => {
			const env = obj.env as Record<string, unknown>;
			const had = env.PW_DIAGNOSTICS;
			env.PW_DIAGNOSTICS = undefined;
			try {
				const res = await obj.fetch(new Request('https://do.local/__git?action=list'));
				return res.status;
			} finally {
				env.PW_DIAGNOSTICS = had;
			}
		});
		expect(status).toBe(401);
	});

	it('answers an empty list once the owner token is presented', async () => {
		const site = freshSite();
		const token = await inObject(site, async (obj) => {
			obj.ensureServeTables();
			obj.metaSet('owner_token', 'tok-1');
			return 'tok-1';
		});
		const res = await call(site, '/__git?action=list', {
			headers: { authorization: `Bearer ${token}` }
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, remotes: [] });
	});
});

describe('remote storage', () => {
	it('keeps the token out of the listed remote', async () => {
		const site = freshSite();
		const listed = await inObject(site, async (obj) => {
			obj.ensureServeTables();
			obj.metaSet(
				'git_remotes',
				JSON.stringify([
					{ id: 'github:o/r@main', provider: 'github', repo: 'o/r', branch: 'main' }
				])
			);
			obj.metaSet('git_token_github:o/r@main', 'ghp_secret');
			obj.metaSet('git_head_github:o/r@main', 'abc123');
			const res = await obj.handleGit(new URL('https://do.local/__git?action=list'));
			return (await res.json()) as { remotes: Record<string, unknown>[] };
		});
		const row = listed.remotes[0] as Record<string, unknown>;
		expect(row.repo).toBe('o/r');
		expect(row.head).toBe('abc123');
		// the page renders this object; a token in it would be readable from the admin surface
		expect(JSON.stringify(listed)).not.toContain('ghp_secret');
	});

	it('forgets every secret when a remote is removed', async () => {
		const site = freshSite();
		const left = await inObject(site, async (obj) => {
			obj.ensureServeTables();
			const id = 'github:o/r@main';
			obj.metaSet(
				'git_remotes',
				JSON.stringify([{ id, provider: 'github', repo: 'o/r', branch: 'main' }])
			);
			obj.metaSet(`git_token_${id}`, 'ghp_secret');
			obj.metaSet(`git_hooksecret_${id}`, 'hook_secret');
			await obj.handleGit(
				new URL(`https://do.local/__git?action=remove&id=${encodeURIComponent(id)}`)
			);
			return {
				remotes: obj.gitRemotes().length,
				token: obj.metaGet(`git_token_${id}`),
				hook: obj.metaGet(`git_hooksecret_${id}`)
			};
		});
		expect(left).toEqual({ remotes: 0, token: '', hook: '' });
	});

	it('refuses a repository string that names nothing', async () => {
		const site = freshSite();
		const out = await inObject(site, async (obj) => {
			obj.ensureServeTables();
			const res = await obj.handleGit(
				new URL('https://do.local/__git?action=add&provider=github&repo=&token=t')
			);
			return { status: res.status, body: await res.json() };
		});
		expect(out.status).toBe(400);
	});

	// Bitbucket has no PAT: the token is the password half of a Basic pair whose username is the
	// account email, so accepting one without the other would build an un-authenticatable remote
	it('refuses a Bitbucket remote with no account email', async () => {
		const site = freshSite();
		const out = await inObject(site, async (obj) => {
			obj.ensureServeTables();
			const res = await obj.handleGit(
				new URL('https://do.local/__git?action=add&provider=bitbucket&repo=ws/slug&token=t')
			);
			return (await res.json()) as { error?: string };
		});
		expect(String(out.error)).toContain('email');
	});

	it('refuses an unknown provider and an unknown action', async () => {
		const site = freshSite();
		const out = await inObject(site, async (obj) => {
			obj.ensureServeTables();
			const bad = await obj.handleGit(
				new URL('https://do.local/__git?action=add&provider=sourcehut&repo=a/b&token=t')
			);
			const nope = await obj.handleGit(new URL('https://do.local/__git?action=fly&id=x'));
			return { provider: bad.status, action: nope.status };
		});
		expect(out.provider).toBe(400);
		expect(out.action).toBe(404);
	});
});

describe('a delivery', () => {
	const deliver = (
		site: DurableObjectStub,
		id: string,
		body: string,
		headers: Record<string, string>
	) =>
		call(site, `/__githook?remote=${encodeURIComponent(id)}`, {
			method: 'POST',
			body,
			headers
		});

	async function withRemote(site: DurableObjectStub, secret: string): Promise<string> {
		const id = 'github:o/r@main';
		await inObject(site, async (obj) => {
			obj.ensureServeTables();
			obj.metaSet(
				'git_remotes',
				JSON.stringify([{ id, provider: 'github', repo: 'o/r', branch: 'main' }])
			);
			obj.metaSet(`git_hooksecret_${id}`, secret);
		});
		return id;
	}

	async function sign(secret: string, body: string): Promise<string> {
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
		return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
	}

	it('refuses a delivery for a remote nothing configured', async () => {
		const site = freshSite();
		const res = await deliver(site, 'github:nobody/x@main', '{}', {});
		expect(res.status).toBe(404);
	});

	// the route is PUBLIC because a provider sends no header this Worker controls, so the signature
	// is the whole of the authentication
	it('refuses an unsigned delivery', async () => {
		const site = freshSite();
		const id = await withRemote(site, 'hook-secret');
		const res = await deliver(site, id, '{"ref":"refs/heads/main"}', {});
		expect(res.status).toBe(401);
	});

	it('refuses a delivery signed with the wrong secret', async () => {
		const site = freshSite();
		const id = await withRemote(site, 'hook-secret');
		const body = '{"ref":"refs/heads/main","after":"abc"}';
		const res = await deliver(site, id, body, {
			'x-github-event': 'push',
			'x-hub-signature-256': await sign('not-the-secret', body)
		});
		expect(res.status).toBe(401);
	});

	it('accepts a correctly signed push and records the head', async () => {
		const site = freshSite();
		const id = await withRemote(site, 'hook-secret');
		const body = JSON.stringify({ ref: 'refs/heads/main', before: 'old', after: 'new-sha' });
		const res = await deliver(site, id, body, {
			'x-github-event': 'push',
			'x-hub-signature-256': await sign('hook-secret', body)
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, proof: 'hmac-sha256' });
		const stored = await inObject(site, async (obj) => obj.metaGet(`git_head_${id}`));
		expect(stored).toBe('new-sha');
	});

	// a push to another branch is a real, verified delivery that this site must not act on
	it('does not move the head for a push to a different branch', async () => {
		const site = freshSite();
		const id = await withRemote(site, 'hook-secret');
		await inObject(site, async (obj) => obj.metaSet(`git_head_${id}`, 'keep-me'));
		const body = JSON.stringify({ ref: 'refs/heads/topic', after: 'other-sha' });
		await deliver(site, id, body, {
			'x-github-event': 'push',
			'x-hub-signature-256': await sign('hook-secret', body)
		});
		const stored = await inObject(site, async (obj) => obj.metaGet(`git_head_${id}`));
		expect(stored).toBe('keep-me');
	});

	it('does not move the head for a branch delete', async () => {
		const site = freshSite();
		const id = await withRemote(site, 'hook-secret');
		await inObject(site, async (obj) => obj.metaSet(`git_head_${id}`, 'keep-me'));
		const body = JSON.stringify({ ref: 'refs/heads/main', after: 'x', deleted: true });
		await deliver(site, id, body, {
			'x-github-event': 'push',
			'x-hub-signature-256': await sign('hook-secret', body)
		});
		const stored = await inObject(site, async (obj) => obj.metaGet(`git_head_${id}`));
		expect(stored).toBe('keep-me');
	});
});

describe('the privilege boundary', () => {
	/**
	 * A KV writer must not be able to point a site at a repository they control, or read the token
	 * out of one. The remotes and their tokens live in `cfw_meta` for the same reason
	 * `CF_OAUTH_CLIENT_ID` does.
	 */
	it('puts nothing git-related on the KV allow-list', () => {
		const names = KV_OVERRIDABLE as readonly string[];
		for (const forbidden of ['GIT_TOKEN', 'GIT_REMOTE', 'GIT_PROVIDER', 'GIT_HOOK_SECRET']) {
			expect(
				names,
				`${forbidden} would let a KV writer redirect the source of truth`
			).not.toContain(forbidden);
		}
		expect(names.filter((n) => n.startsWith('GIT'))).toEqual([]);
	});
});

describe('a pull against a git server', () => {
	const MODULE = {
		'mymodule.info.yml': 'name: My Module\ntype: module\ncore_version_requirement: ^11\n',
		'mymodule.module': '<?php\n\nfunction mymodule_help() { return "v1"; }\n',
		'src/Thing.php': '<?php\n\nnamespace Drupal\\mymodule;\n\nclass Thing {}\n',
		'tests/src/ThingTest.php': '<?php\n// never mounted\n',
		'README.md': '# not mountable\n'
	};

	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	/** a remote already in the meta table, so the add path is not what is under test */
	async function connected(
		site: DurableObjectStub,
		id = 'generic:o/r@main',
		over: Record<string, unknown> = {}
	): Promise<void> {
		await inObject(site, async (obj) => {
			obj.ensureServeTables();
			obj.metaSet(
				'git_remotes',
				JSON.stringify([
					{
						id,
						provider: 'generic',
						repo: 'o/r',
						host: 'https://git.example.invalid',
						branch: 'main',
						...over
					}
				])
			);
		});
	}

	function serve(repo: FakeRepo, onCall?: Parameters<typeof gitFetch>[1]): void {
		globalThis.fetch = gitFetch(repo, onCall ?? {});
	}

	async function api(site: DurableObjectStub, params: Record<string, string>): Promise<any> {
		return inObject(site, async (obj) => {
			const url = new URL('https://do.local/__git');
			for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
			const res = await obj.handleGit(url, 'https://site.example');
			return { status: res.status, body: await res.json() };
		});
	}

	/** the four columns the SELECT names, so a reader is a string rather than `string | undefined` */
	type StoredFile = { path: string; package: string; version: string; source: string };

	function storedFiles(site: DurableObjectStub): Promise<StoredFile[]> {
		return inObject(site, async (obj) =>
			obj.sql
				.exec('SELECT path, package, version, source FROM cfw_module_file ORDER BY path')
				.toArray()
		) as Promise<StoredFile[]>;
	}

	it('installs a module, keeping only what a mounted tree can use', async () => {
		const site = freshSite();
		await connected(site);
		const head = await fakeCommit(MODULE);
		serve({ refs: { 'refs/heads/main': head.sha }, packs: { [head.sha]: head.pack } });

		const out = await api(site, { action: 'pull', id: 'generic:o/r@main' });
		expect(out.body.ok, out.body.error).toBe(true);
		expect(out.body.applied).toBe(true);
		expect(out.body.modules).toEqual([{ name: 'mymodule', type: 'module', root: '' }]);

		const files = await storedFiles(site);
		expect(files.map((f) => f.path)).toEqual([
			'modules/custom/mymodule/mymodule.info.yml',
			'modules/custom/mymodule/mymodule.module',
			'modules/custom/mymodule/src/Thing.php'
		]);
		expect(files[0]?.package).toBe('generic:o/r@main');
		expect(files[0]?.version).toBe(head.sha);
	});

	it('charges no rows for a second pull of the same commit', async () => {
		const site = freshSite();
		await connected(site);
		const head = await fakeCommit(MODULE);
		serve({ refs: { 'refs/heads/main': head.sha }, packs: { [head.sha]: head.pack } });

		await api(site, { action: 'pull', id: 'generic:o/r@main' });
		const again = await api(site, { action: 'pull', id: 'generic:o/r@main' });
		expect(again.body.rowsWritten).toBe(0);
		expect(again.body.counts.unchanged).toBe(3);
	});

	it('reports a diff without writing anything', async () => {
		const site = freshSite();
		await connected(site);
		const first = await fakeCommit(MODULE);
		serve({ refs: { 'refs/heads/main': first.sha }, packs: { [first.sha]: first.pack } });
		await api(site, { action: 'pull', id: 'generic:o/r@main' });

		const next = await fakeCommit({
			...MODULE,
			'mymodule.module': '<?php\n\nfunction mymodule_help() { return "v2"; }\n',
			'src/Extra.php': '<?php\n// added\n'
		});
		serve({
			refs: { 'refs/heads/main': next.sha },
			packs: { [next.sha]: next.pack, [first.sha]: first.pack }
		});

		const diff = await api(site, { action: 'diff', id: 'generic:o/r@main' });
		expect(diff.body.applied).toBe(false);
		expect(diff.body.counts).toEqual({ added: 1, modified: 1, removed: 0, unchanged: 2 });
		// the diff must not have touched storage
		expect((await storedFiles(site)).length).toBe(3);
	});

	it('deletes what a branch switch leaves behind and carries the token across', async () => {
		const site = freshSite();
		await connected(site);
		await inObject(site, async (obj) =>
			obj.metaSet('git_token_generic:o/r@main', 'secret-token')
		);
		const main = await fakeCommit({ ...MODULE, 'src/OnlyOnMain.php': '<?php\n' });
		const topic = await fakeCommit({ ...MODULE, 'src/OnlyOnTopic.php': '<?php\n' });
		serve({
			refs: { 'refs/heads/main': main.sha, 'refs/heads/topic': topic.sha },
			packs: { [main.sha]: main.pack, [topic.sha]: topic.pack }
		});

		await api(site, { action: 'pull', id: 'generic:o/r@main' });
		const switched = await api(site, {
			action: 'switch',
			id: 'generic:o/r@main',
			branch: 'topic'
		});
		expect(switched.body.ok, switched.body.error).toBe(true);
		expect(switched.body.id).toBe('generic:o/r@topic');

		const paths = (await storedFiles(site)).map((f) => f.path);
		expect(paths).toContain('modules/custom/mymodule/src/OnlyOnTopic.php');
		expect(paths, 'the old branch file survived the switch').not.toContain(
			'modules/custom/mymodule/src/OnlyOnMain.php'
		);
		const carried = await inObject(site, async (obj) => ({
			next: obj.metaGet('git_token_generic:o/r@topic'),
			old: obj.metaGet('git_token_generic:o/r@main'),
			owner: (
				obj.sql.exec('SELECT package FROM cfw_module_file LIMIT 1').toArray()[0] as {
					package: string;
				}
			).package
		}));
		expect(carried.next, 'the token was stranded under the old id').toBe('secret-token');
		expect(carried.old).toBe('');
		expect(carried.owner).toBe('generic:o/r@topic');
	});

	it('refuses to take a path another remote already owns', async () => {
		const site = freshSite();
		await connected(site);
		const head = await fakeCommit(MODULE);
		serve({ refs: { 'refs/heads/main': head.sha }, packs: { [head.sha]: head.pack } });
		await inObject(site, async (obj) => {
			obj.ensureServeTables();
			obj.sql.exec(
				`INSERT INTO cfw_module_file (path, package, version, source, installed_at)
				 VALUES (?, ?, ?, ?, ?)`,
				'modules/custom/mymodule/mymodule.module',
				'github:someone/else@main',
				'x',
				'<?php // theirs',
				1
			);
		});

		const out = await api(site, { action: 'pull', id: 'generic:o/r@main' });
		expect(out.body.ok).toBe(false);
		expect(out.body.applied).toBe(false);
		expect(out.body.conflicts[0].owner).toBe('github:someone/else@main');
		const kept = await inObject(site, async (obj) =>
			obj.metaGet('git_installedsha_generic:o/r@main')
		);
		expect(kept ?? '', 'a refused pull must not record itself as installed').toBe('');
	});

	it('rolls back to the previous files when the kernel refuses to boot', async () => {
		const site = freshSite();
		await connected(site);
		const good = await fakeCommit(MODULE);
		serve({ refs: { 'refs/heads/main': good.sha }, packs: { [good.sha]: good.pack } });
		await api(site, { action: 'pull', id: 'generic:o/r@main' });

		const bad = await fakeCommit({
			...MODULE,
			'src/Broken.php': '<?php\n\nclass Broken { syntax error',
			'mymodule.module': '<?php\n// changed too\n'
		});
		serve({
			refs: { 'refs/heads/main': bad.sha },
			packs: { [bad.sha]: bad.pack, [good.sha]: good.pack }
		});

		const out = await inObject(site, async (obj) => {
			// what a fatal looks like from here: the kernel boot reports an error
			obj.runJson = async () => ({ error: 'PHP Parse error: syntax error in Broken.php' });
			const url = new URL('https://do.local/__git?action=pull&id=generic:o/r@main');
			const res = await obj.handleGit(url, 'https://site.example');
			return res.json();
		});
		expect((out as any).rolledBack).toBe(true);
		expect(String((out as any).error)).toContain('rolled back');

		const files = await storedFiles(site);
		expect(
			files.map((f) => f.path),
			'the broken file survived the rollback'
		).not.toContain('modules/custom/mymodule/src/Broken.php');
		expect(files.find((f) => f.path.endsWith('mymodule.module'))?.source).toContain('v1');
		const installed = await inObject(site, async (obj) =>
			obj.metaGet('git_installedsha_generic:o/r@main')
		);
		expect(installed).toBe(good.sha);
	});

	it('previews a request head and returns to the branch on demand', async () => {
		const site = freshSite();
		await connected(site);
		const main = await fakeCommit(MODULE);
		const pr = await fakeCommit({ ...MODULE, 'src/Proposed.php': '<?php\n// in review\n' });
		serve({
			refs: { 'refs/heads/main': main.sha, 'refs/pull/9/head': pr.sha },
			packs: { [main.sha]: main.pack, [pr.sha]: pr.pack }
		});

		await api(site, { action: 'pull', id: 'generic:o/r@main' });
		const listed = await api(site, { action: 'prs', id: 'generic:o/r@main' });
		expect(listed.body.pulls.map((p: any) => p.id)).toEqual(['9']);

		const previewed = await api(site, { action: 'preview', id: 'generic:o/r@main', pr: '9' });
		expect(previewed.body.applied, previewed.body.error).toBe(true);
		expect((await storedFiles(site)).map((f) => f.path)).toContain(
			'modules/custom/mymodule/src/Proposed.php'
		);

		const back = await api(site, { action: 'unpreview', id: 'generic:o/r@main' });
		expect(back.body.applied).toBe(true);
		expect((await storedFiles(site)).map((f) => f.path)).not.toContain(
			'modules/custom/mymodule/src/Proposed.php'
		);
	});

	it('holds a preview against a push to the branch', async () => {
		const site = freshSite();
		await connected(site);
		const main = await fakeCommit(MODULE);
		const pr = await fakeCommit({ ...MODULE, 'src/Proposed.php': '<?php\n' });
		serve({
			refs: { 'refs/heads/main': main.sha, 'refs/pull/9/head': pr.sha },
			packs: { [main.sha]: main.pack, [pr.sha]: pr.pack }
		});
		await api(site, { action: 'preview', id: 'generic:o/r@main', pr: '9' });

		await inObject(site, async (obj) => {
			obj.metaSet('git_interval_generic:o/r@main', '5');
			obj.metaSet('git_checked_generic:o/r@main', '0');
		});
		const polled = await inObject(site, async (obj) => obj.gitPoll());
		expect(polled[0]?.changed, 'the poll replaced what somebody was reviewing').toBe(false);
		expect((await storedFiles(site)).map((f) => f.path)).toContain(
			'modules/custom/mymodule/src/Proposed.php'
		);
	});

	it('removes the installed files when the remote is removed', async () => {
		const site = freshSite();
		await connected(site);
		const head = await fakeCommit(MODULE);
		serve({ refs: { 'refs/heads/main': head.sha }, packs: { [head.sha]: head.pack } });
		await api(site, { action: 'pull', id: 'generic:o/r@main' });
		expect((await storedFiles(site)).length).toBe(3);

		const gone = await api(site, { action: 'remove', id: 'generic:o/r@main' });
		expect(gone.body.message).toContain('3 file');
		expect(await storedFiles(site)).toEqual([]);
	});

	it('backs off after a refusal and stops polling until the window passes', async () => {
		const site = freshSite();
		await connected(site);
		// `preconnect` carried over rather than cast away: workers-types puts it on `typeof fetch`,
		// so a bare function is not one
		globalThis.fetch = Object.assign(async () => new Response('nope', { status: 429 }), {
			preconnect: realFetch.preconnect
		});
		await inObject(site, async (obj) => {
			obj.metaSet('git_interval_generic:o/r@main', '5');
			obj.metaSet('git_checked_generic:o/r@main', '0');
		});

		const polled = await inObject(site, async (obj) => obj.gitPoll());
		expect(String(polled[0]?.error)).toContain('429');
		const until = await inObject(site, async (obj) =>
			Number(obj.metaGet('git_backoff_generic:o/r@main'))
		);
		expect(until).toBeGreaterThan(Date.now());
		const again = await inObject(site, async (obj) => obj.gitPoll());
		expect(again, 'a backed-off remote was polled anyway').toEqual([]);
	});

	it('polls, sees a moved head, and installs it', async () => {
		const site = freshSite();
		await connected(site);
		const first = await fakeCommit(MODULE);
		serve({ refs: { 'refs/heads/main': first.sha }, packs: { [first.sha]: first.pack } });
		await api(site, { action: 'pull', id: 'generic:o/r@main' });

		const next = await fakeCommit({ ...MODULE, 'src/New.php': '<?php\n' });
		serve({ refs: { 'refs/heads/main': next.sha }, packs: { [next.sha]: next.pack } });
		await inObject(site, async (obj) => {
			obj.metaSet('git_interval_generic:o/r@main', '5');
			obj.metaSet('git_checked_generic:o/r@main', '0');
		});

		const polled = await inObject(site, async (obj) => obj.gitPoll());
		expect(polled[0]?.changed).toBe(true);
		expect((await storedFiles(site)).map((f) => f.path)).toContain(
			'modules/custom/mymodule/src/New.php'
		);
	});

	it('connects a public remote with no token at all', async () => {
		const site = freshSite();
		const head = await fakeCommit(MODULE);
		serve({ refs: { 'refs/heads/main': head.sha }, packs: { [head.sha]: head.pack } });
		const added = await api(site, {
			action: 'add',
			provider: 'generic',
			repo: 'https://git.example.invalid/o/r'
		});
		expect(added.body.ok, added.body.error).toBe(true);
		expect(added.body.branch, 'the symref capability names the default branch').toBe('main');
		expect(added.body.head).toBe(head.sha);
	});

	it('still requires a token where the API is the only way in', async () => {
		const site = freshSite();
		const out = await api(site, { action: 'add', provider: 'github', repo: 'o/r' });
		expect(out.status).toBe(400);
		expect(String(out.body.error)).toContain('token');
	});

	it('installs every extension a monorepo declares, at its own path', async () => {
		const site = freshSite();
		await connected(site);
		const head = await fakeCommit({
			'modules/alpha/alpha.info.yml': 'name: Alpha\ntype: module\n',
			'modules/alpha/alpha.module': '<?php\n',
			'themes/gamma/gamma.info.yml': 'name: Gamma\ntype: theme\n',
			'themes/gamma/gamma.theme': '<?php\n'
		});
		serve({ refs: { 'refs/heads/main': head.sha }, packs: { [head.sha]: head.pack } });

		const out = await api(site, { action: 'pull', id: 'generic:o/r@main' });
		expect(out.body.applied, out.body.error).toBe(true);
		expect((await storedFiles(site)).map((f) => f.path)).toEqual([
			'modules/custom/alpha/alpha.info.yml',
			'modules/custom/alpha/alpha.module',
			'themes/custom/gamma/gamma.info.yml',
			'themes/custom/gamma/gamma.theme'
		]);
	});

	it('mints a hook secret a plain remote can be configured with by hand', async () => {
		const site = freshSite();
		await connected(site);
		const out = await api(site, { action: 'hooksecret', id: 'generic:o/r@main' });
		expect(out.body.secret).toMatch(/^[0-9a-f]{48}$/);
		expect(out.body.deliverTo).toBe(
			'https://site.example/githook?remote=generic%3Ao%2Fr%40main'
		);
	});

	it('refuses to register a webhook where there is no API to register it through', async () => {
		const site = freshSite();
		await connected(site);
		const out = await api(site, { action: 'hook', id: 'generic:o/r@main' });
		expect(out.status).toBe(400);
		expect(String(out.body.error)).toContain('no API');
	});

	it('sets and clamps the poll interval', async () => {
		const site = freshSite();
		await connected(site);
		expect(
			(await api(site, { action: 'interval', id: 'generic:o/r@main', minutes: '1' })).body
				.intervalMinutes
		).toBe(5);
		expect(
			(await api(site, { action: 'interval', id: 'generic:o/r@main', minutes: '0' })).body
				.message
		).toBe('polling off');
	});
});
