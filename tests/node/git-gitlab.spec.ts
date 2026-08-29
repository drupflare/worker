import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	authHeaders,
	cloneUrl,
	createHookRequest,
	defaultBranchRequest,
	projectPath,
	pullsRequest,
	readHookEvent,
	smartAuth,
	statusRequest,
	verifyHook,
	type Remote
} from '../../src/ops/git-provider';
import { branchNames, discoverRefs, fetchCommit, refSha } from '../../src/ops/git-smart';

/** a real GitLab, whose `/api/v4` shares nothing with the Gitea family; `heavy` compose profile */

const BASE = process.env.CFW_E2E_GITLAB ?? 'http://127.0.0.1:3500';
const CONTAINER = process.env.CFW_E2E_GITLAB_CONTAINER ?? 'drupflare-worker-gitlab-1';
const USER = process.env.CFW_E2E_GITLAB_USER ?? 'root';

let token = '';
let root = '';
let skip = false;

const RUN = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PROJECT = `module-${RUN}`;

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'drupflare',
			GIT_AUTHOR_EMAIL: 'dev@example.invalid',
			GIT_COMMITTER_NAME: 'drupflare',
			GIT_COMMITTER_EMAIL: 'dev@example.invalid',
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_SYSTEM: '/dev/null'
		}
	}).trim();

/** the only way to mint a token without a browser session */
const rails = (ruby: string): string =>
	execFileSync('docker', ['exec', CONTAINER, 'gitlab-rails', 'runner', ruby], {
		encoding: 'utf8'
	}).trim();

function write(repo: string, path: string, body: string): void {
	const full = join(repo, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

function remote(over: Partial<Remote> = {}): Remote {
	return {
		id: `gitlab:${USER}/${PROJECT}@main`,
		provider: 'gitlab',
		repo: `${USER}/${PROJECT}`,
		host: BASE,
		branch: 'main',
		...over
	};
}

function smart(r: Remote) {
	const auth = smartAuth(r, { token });
	return { url: cloneUrl(r), username: auth.username, token: auth.token };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}/api/v4${path}`, {
		...init,
		headers: {
			'private-token': token,
			'content-type': 'application/json',
			...(init.headers ?? {})
		}
	});
}

beforeAll(async () => {
	try {
		const up = await fetch(`${BASE}/users/sign_in`, { signal: AbortSignal.timeout(4000) });
		skip = !up.ok;
	} catch {
		skip = true;
	}
	if (skip) {
		// CFW_RIG rather than CI; see the note in git-forge.spec.ts. GitLab is behind
		// `--profile heavy` and wants ~4 GB, so the gate could not start it even if it wanted to
		if (process.env.CFW_RIG) {
			throw new Error(
				`e2e: no GitLab at ${BASE} (CFW_RIG is set, so one was expected). Start it with ` +
					'`docker compose -f docker/compose.yml --profile heavy up -d gitlab`.'
			);
		}
		return;
	}

	// an APPLICATION setting rather than an omnibus one, so the compose file cannot set it; without
	// it GitLab refuses to deliver a hook to a private address and the delivery just never arrives
	rails(
		'ApplicationSetting.current.update!(allow_local_requests_from_web_hooks_and_services: true)'
	);

	// the seeded admin, because it is the one user GitLab provisions with a personal namespace and a
	// project cannot be created without one
	token = rails(
		`u = User.find_by_username('${USER}'); ` +
			`puts u.personal_access_tokens.create!(scopes: ['api','read_repository','write_repository'], ` +
			`name: 'e2e-${RUN}', expires_at: 90.days.from_now).token`
	);

	// a private project, which is the case a token has to carry
	const made = await api('/projects', {
		method: 'POST',
		body: JSON.stringify({
			name: PROJECT,
			path: PROJECT,
			visibility: 'private',
			initialize_with_readme: false,
			default_branch: 'main'
		})
	});
	if (!made.ok) throw new Error(`could not create ${PROJECT}: ${await made.text()}`);

	root = mkdtempSync(join(tmpdir(), 'cfw-gitlab-'));
	const dir = join(root, PROJECT);
	mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', 'main');
	write(dir, 'gl_module.info.yml', 'name: GL\ntype: module\ncore_version_requirement: ^11\n');
	write(dir, 'gl_module.module', '<?php\n\nfunction gl_module_help() { return "v1"; }\n');
	write(dir, 'src/Gl.php', '<?php\n\nnamespace Drupal\\gl_module;\n\nclass Gl {}\n');
	write(dir, 'tests/src/GlTest.php', '<?php\n// never mounted\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'first');
	git(
		dir,
		'remote',
		'add',
		'origin',
		`${BASE.replace('://', `://oauth2:${token}@`)}/${USER}/${PROJECT}.git`
	);
	git(dir, 'push', '-q', '-u', 'origin', 'main');

	git(dir, 'checkout', '-q', '-b', 'feature/two');
	write(dir, 'src/Proposed.php', '<?php\n// under review\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'proposed');
	git(dir, 'push', '-q', 'origin', 'feature/two');

	// GitLab indexes a pushed branch asynchronously, so the first POST answers
	// `source_branch does not exist` on a branch git has already accepted
	let mr: Response | null = null;
	for (let i = 0; i < 30; i++) {
		mr = await api(`/projects/${projectPath(`${USER}/${PROJECT}`)}/merge_requests`, {
			method: 'POST',
			body: JSON.stringify({
				source_branch: 'feature/two',
				target_branch: 'main',
				title: 'proposed'
			})
		});
		if (mr.ok) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	if (mr === null || !mr.ok) {
		throw new Error(`could not open the merge request: ${mr === null ? '?' : await mr.text()}`);
	}
}, 300_000);

afterAll(async () => {
	if (root !== '') rmSync(root, { recursive: true, force: true });
	if (skip || token === '') return;
	await api(`/projects/${projectPath(`${USER}/${PROJECT}`)}`, { method: 'DELETE' }).catch(
		() => null
	);
});

describe('a private GitLab project over real smart HTTP', () => {
	it('refuses ref discovery with no credential', async (ctx) => {
		if (skip) return ctx.skip();
		await expect(
			discoverRefs({ url: cloneUrl(remote()), username: '', token: '' })
		).rejects.toThrow();
	});

	it('discovers refs with the token, whose Basic username is oauth2 and not the email', async (ctx) => {
		if (skip) return ctx.skip();
		// GitLab is the one provider whose git username is a fixed literal
		expect(smartAuth(remote(), { token }).username).toBe('oauth2');
		const ad = await discoverRefs(smart(remote()));
		expect(branchNames(ad)).toContain('main');
		expect(branchNames(ad)).toContain('feature/two');
	});

	it('fetches the working tree and mounts only what Drupal can use', async (ctx) => {
		if (skip) return ctx.skip();
		const ad = await discoverRefs(smart(remote()));
		const files = await fetchCommit(smart(remote()), refSha(ad, 'main') as string);
		const names = files.map((f) => f.path).sort();
		expect(names).toContain('gl_module.info.yml');
		expect(names).toContain('src/Gl.php');
	});
});

describe('the GitLab API against a real server', () => {
	it('reads the default branch through the URL-encoded project path', async (ctx) => {
		if (skip) return ctx.skip();
		const ref = defaultBranchRequest(remote());
		// the encoded path is the thing most likely to be wrong, so assert the URL as well
		expect(ref.url).toContain(encodeURIComponent(`${USER}/${PROJECT}`));
		const res = await fetch(ref.url, { headers: authHeaders(remote(), { token }) });
		expect(res.status).toBe(200);
		expect(ref.pick(await res.json())).toBe('main');
	});

	it('writes a commit status in GitLab own state vocabulary', async (ctx) => {
		if (skip) return ctx.skip();
		const ad = await discoverRefs(smart(remote()));
		const sha = refSha(ad, 'main') as string;
		const post = statusRequest(
			remote(),
			sha,
			'running',
			'drupflare is building this commit',
			`${BASE}/build/1`
		);
		// `running` is GitLab-only; GitHub and Gitea both collapse it to `pending`
		expect(post?.body.state).toBe('running');
		const res = await fetch(post!.url, {
			method: 'POST',
			headers: { ...authHeaders(remote(), { token }), 'content-type': 'application/json' },
			body: JSON.stringify(post!.body)
		});
		expect(res.status, await res.clone().text()).toBe(201);
		expect(((await res.json()) as { status?: string }).status).toBe('running');
	});

	it('lists an open merge request and its head is fetchable', async (ctx) => {
		if (skip) return ctx.skip();
		const req = pullsRequest(remote());
		// GitLab indexes a new merge request asynchronously, so the first read can come back empty
		let open = [] as ReturnType<typeof req.pick>;
		for (let i = 0; i < 20 && open.length === 0; i++) {
			const res = await fetch(req.url, { headers: authHeaders(remote(), { token }) });
			open = req.pick(await res.json());
			if (open.length === 0) await new Promise((r) => setTimeout(r, 1000));
		}
		expect(open).toHaveLength(1);
		expect(open[0]?.branch).toBe('feature/two');
		expect(open[0]?.target).toBe('main');
		expect(open[0]?.sha).toBeTruthy();

		const files = await fetchCommit(smart(remote()), open[0]?.sha as string);
		expect(files.map((f) => f.path)).toContain('src/Proposed.php');
	});
});

describe('a webhook delivery, signed by the server rather than by the test', () => {
	it('registers a hook and verifies the proof GitLab actually sends', async (ctx) => {
		if (skip) return ctx.skip();
		const secret = `s${Math.random().toString(36).slice(2, 12)}`;
		let server: Server | null = null;
		const delivery = await new Promise<{ headers: Headers; body: string } | null>((resolve) => {
			const deadline = setTimeout(() => resolve(null), 45_000);
			server = createServer((req, res) => {
				let body = '';
				req.on('data', (c) => {
					body += String(c);
				});
				req.on('end', () => {
					res.writeHead(204).end();
					const headers = new Headers();
					for (const [k, v] of Object.entries(req.headers)) {
						if (typeof v === 'string') headers.set(k, v);
					}
					// a push to `main` also updates the open merge request, and THAT hook can
					// arrive first; taking the first delivery read as a push that was not one
					if (headers.get('x-gitlab-event') !== 'Push Hook') return;
					clearTimeout(deadline);
					resolve({ headers, body });
				});
			});
			server.listen(0, '0.0.0.0', async () => {
				const port = (server!.address() as { port: number }).port;
				const hook = createHookRequest(
					remote(),
					`http://host.docker.internal:${port}/githook`,
					secret
				);
				// a rejected registration must not surface later as a delivery timeout
				expect(hook!.body).not.toHaveProperty('signing_token');
				const made = await fetch(hook!.url, {
					method: 'POST',
					headers: {
						...authHeaders(remote(), { token }),
						'content-type': 'application/json'
					},
					body: JSON.stringify(hook!.body)
				});
				expect(made.status, await made.clone().text()).toBe(201);
				const repo = join(root, PROJECT);
				git(repo, 'checkout', '-q', 'main');
				write(
					repo,
					'gl_module.module',
					'<?php\n\nfunction gl_module_help() { return "v2"; }\n'
				);
				git(repo, 'add', '-A');
				git(repo, 'commit', '-q', '-m', 'v2');
				git(repo, 'push', '-q', 'origin', 'main');
			});
		});
		if (server !== null) (server as Server).close();
		expect(delivery, 'GitLab never delivered the hook').not.toBeNull();

		const verdict = await verifyHook('gitlab', delivery!.headers, delivery!.body, secret);
		expect(verdict.ok, verdict.reason).toBe(true);
		// a plaintext token is what every install below 19.0 sends, and the verdict must SAY so
		expect(['shared-secret', 'hmac-sha256']).toContain(verdict.proof);

		const wrong = await verifyHook('gitlab', delivery!.headers, delivery!.body, 'not-it');
		expect(wrong.ok).toBe(false);

		const event = readHookEvent('gitlab', delivery!.headers, JSON.parse(delivery!.body));
		expect(event.kind).toBe('push');
		if (event.kind === 'push') {
			expect(event.branch).toBe('main');
			expect(event.deleted).toBe(false);
			expect(event.after).toBeTruthy();
		}
	}, 90_000);
});
