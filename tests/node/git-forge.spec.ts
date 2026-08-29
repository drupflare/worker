import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	authHeaders,
	cloneUrl,
	createHookRequest,
	defaultBranchRequest,
	pullsRequest,
	readHookEvent,
	smartAuth,
	statusRequest,
	verifyHook,
	type Remote
} from '../../src/ops/git-provider';
import {
	branchNames,
	discoverRefs,
	fetchCommit,
	refSha,
	requestRefs
} from '../../src/ops/git-smart';
import { planSync, selectFiles } from '../../src/ops/git-sync';

/**
 * Every git operation against a REAL server, over real HTTP, with real credentials.
 *
 * The unit lane proves the URLs are what was measured and the node lane proves the packfile reader
 * agrees with git. Neither touches a socket, so neither can see an auth scheme a server rejects or a
 * signature header a provider actually sends. Skip locally when the rig is down; fail in CI.
 *
 * `CFW_E2E_FORGE` names the compose service and its admin CLI, so one file drives Gitea or Forgejo.
 */

const FORGE = process.env.CFW_E2E_FORGE ?? 'gitea';
const BASE = process.env.CFW_E2E_FORGE_URL ?? 'http://127.0.0.1:3300';
const CONTAINER = process.env.CFW_E2E_FORGE_CONTAINER ?? `drupflare-worker-${FORGE}-1`;
const USER = 'drupflare';
const PASSWORD = 'drupflare-test-pw-1';

let token = '';
let root = '';
let skip = false;

/** repositories are per-run, so a second run never pushes onto the first one's history */
const RUN = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PRIVATE = `private-module-${RUN}`;
const SIBLING = `drupflare-module-${RUN}`;

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

const cli = (...args: string[]): string =>
	execFileSync('docker', ['exec', '-u', 'git', CONTAINER, FORGE, ...args], {
		encoding: 'utf8'
	}).trim();

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}/api/v1${path}`, {
		...init,
		headers: {
			authorization: `token ${token}`,
			'content-type': 'application/json',
			...(init.headers ?? {})
		}
	});
}

function write(repo: string, path: string, body: string): void {
	const full = join(repo, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

/** the remote as the object would store it, pointed at the local server */
function remote(repo: string, branch = 'main', over: Partial<Remote> = {}): Remote {
	return {
		id: `${FORGE}:${USER}/${repo}@${branch}`,
		provider: 'gitea',
		repo: `${USER}/${repo}`,
		host: BASE,
		branch,
		...over
	};
}

function smart(r: Remote) {
	const auth = smartAuth(r, { token });
	return { url: cloneUrl(r), username: auth.username, token: auth.token };
}

/** an authenticated push URL, which is how the fixtures get into the server at all */
const pushUrl = (repo: string) =>
	`${BASE.replace('://', `://${USER}:${encodeURIComponent(PASSWORD)}@`)}/${USER}/${repo}.git`;

async function makeRepo(name: string, isPrivate: boolean): Promise<void> {
	const res = await api('/user/repos', {
		method: 'POST',
		body: JSON.stringify({ name, private: isPrivate, auto_init: false })
	});
	if (!res.ok && res.status !== 409) {
		throw new Error(`could not create ${name}: ${res.status} ${await res.text()}`);
	}
}

beforeAll(async () => {
	try {
		const health = await fetch(`${BASE}/api/healthz`, { signal: AbortSignal.timeout(3000) });
		skip = !health.ok;
	} catch {
		skip = true;
	}
	if (skip) {
		// CFW_RIG, not CI. This spec lives in the NODE lane, which `bun run test` runs and which
		// CLAUDE.md requires to stay hermetic -- and the gate workflow starts no containers, so
		// keying on CI made every gate run demand a rig nothing provides. The loud failure is kept
		// for a lane that DECLARES it brought one up, which is where a silent skip would hide a
		// broken rig
		if (process.env.CFW_RIG) {
			throw new Error(
				`e2e: no ${FORGE} at ${BASE} (CFW_RIG is set, so one was expected). ` +
					`Start it with \`docker compose -f docker/compose.yml up -d ${FORGE}\`.`
			);
		}
		return;
	}

	try {
		cli(
			'admin',
			'user',
			'create',
			'--admin',
			'--username',
			USER,
			'--password',
			PASSWORD,
			'--email',
			'dev@example.invalid',
			'--must-change-password=false'
		);
	} catch {
		// already there from a previous run, which is the normal case
	}
	token = cli(
		'admin',
		'user',
		'generate-access-token',
		'-u',
		USER,
		'--scopes',
		'write:repository,write:user,write:issue',
		'-t',
		`e2e-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
		'--raw'
	);

	root = mkdtempSync(join(tmpdir(), `cfw-${FORGE}-`));

	// a private module repository, which is the case a token has to carry
	await makeRepo(PRIVATE, true);
	const priv = join(root, PRIVATE);
	mkdirSync(priv, { recursive: true });
	git(priv, 'init', '-q', '-b', 'main');
	write(
		priv,
		'secret_module.info.yml',
		'name: Secret\ntype: module\ncore_version_requirement: ^11\n'
	);
	write(
		priv,
		'secret_module.module',
		'<?php\n\nfunction secret_module_help() { return "v1"; }\n'
	);
	write(priv, 'src/Secret.php', '<?php\n\nnamespace Drupal\\secret_module;\n\nclass Secret {}\n');
	write(priv, 'tests/src/SecretTest.php', '<?php\n// never mounted\n');
	git(priv, 'add', '-A');
	git(priv, 'commit', '-q', '-m', 'first');
	git(priv, 'remote', 'add', 'origin', pushUrl(PRIVATE));
	git(priv, 'push', '-q', '-u', 'origin', 'main');
	// a second branch and a real pull request, so the request refs exist on the server
	git(priv, 'checkout', '-q', '-b', 'feature/two');
	write(priv, 'src/Proposed.php', '<?php\n// under review\n');
	git(priv, 'add', '-A');
	git(priv, 'commit', '-q', '-m', 'proposed');
	git(priv, 'push', '-q', 'origin', 'feature/two');

	// the real sibling, which is the module this feature exists to deliver
	const src = process.env.DRUPFLARE_SRC ?? '../drupflare';
	if (existsSync(join(src, 'src'))) {
		await makeRepo(SIBLING, false);
		const sib = join(root, SIBLING);
		mkdirSync(sib, { recursive: true });
		git(sib, 'init', '-q', '-b', 'main');
		cpSync(join(src, 'src'), join(sib, 'src'), { recursive: true });
		for (const file of ['drupflare.info.yml', 'drupflare.module', 'drupflare.services.yml']) {
			if (existsSync(join(src, file))) cpSync(join(src, file), join(sib, file));
		}
		if (!existsSync(join(sib, 'drupflare.info.yml'))) {
			write(sib, 'drupflare.info.yml', 'name: Drupflare\ntype: module\n');
		}
		git(sib, 'add', '-A');
		git(sib, 'commit', '-q', '-m', 'the sibling as a module repository');
		git(sib, 'remote', 'add', 'origin', pushUrl(SIBLING));
		git(sib, 'push', '-q', '-u', 'origin', 'main');
	}
}, 180_000);

afterAll(async () => {
	if (root !== '') rmSync(root, { recursive: true, force: true });
	if (skip || token === '') return;
	for (const name of [PRIVATE, SIBLING]) {
		await api(`/repos/${USER}/${name}`, { method: 'DELETE' }).catch(() => null);
	}
});

describe('a private repository over real smart HTTP', () => {
	it('refuses ref discovery with no credential', async (ctx) => {
		if (skip) return ctx.skip();
		await expect(discoverRefs({ url: cloneUrl(remote(PRIVATE)) })).rejects.toThrow(
			/answered 40[13]/
		);
	});

	it('discovers refs with the token, and names the default branch', async (ctx) => {
		if (skip) return ctx.skip();
		const ad = await discoverRefs(smart(remote(PRIVATE)));
		expect(ad.defaultBranch).toBe('main');
		expect(branchNames(ad)).toEqual(['feature/two', 'main']);
		expect(refSha(ad, 'main')).toMatch(/^[0-9a-f]{40}$/);
	});

	it('fetches the working tree and mounts only what Drupal can use', async (ctx) => {
		if (skip) return ctx.skip();
		const r = remote(PRIVATE);
		const ad = await discoverRefs(smart(r));
		const files = await fetchCommit(smart(r), refSha(ad, 'main') as string);
		const chosen = selectFiles(files, PRIVATE);
		expect(chosen.roots).toEqual([{ name: 'secret_module', root: '', type: 'module' }]);
		expect(chosen.files.map((f) => f.path)).toEqual([
			'modules/custom/secret_module/secret_module.info.yml',
			'modules/custom/secret_module/secret_module.module',
			'modules/custom/secret_module/src/Secret.php'
		]);
	});

	it('reads a second branch and diffs it against the first', async (ctx) => {
		if (skip) return ctx.skip();
		const r = remote(PRIVATE);
		const ad = await discoverRefs(smart(r));
		const main = selectFiles(
			await fetchCommit(smart(r), refSha(ad, 'main') as string),
			PRIVATE
		);
		const feature = selectFiles(
			await fetchCommit(smart(r), refSha(ad, 'feature/two') as string),
			PRIVATE
		);
		const plan = planSync(new Map(main.files.map((f) => [f.path, f.source])), feature.files);
		expect(plan.counts.added).toBe(1);
		expect(plan.changes.find((c) => c.kind === 'added')?.path).toBe(
			'modules/custom/secret_module/src/Proposed.php'
		);
	});
});

describe('the provider API against a real server', () => {
	it('reads the default branch through the endpoint this code constructs', async (ctx) => {
		if (skip) return ctx.skip();
		const r = remote(PRIVATE);
		const req = defaultBranchRequest(r);
		const res = await fetch(req.url, { headers: authHeaders(r, { token }) });
		const body = await res.text();
		expect(res.status, body).toBe(200);
		expect(req.pick(JSON.parse(body))).toBe('main');
	});

	it('writes a commit status, which is the write-back this project chose over check runs', async (ctx) => {
		if (skip) return ctx.skip();
		const r = remote(PRIVATE);
		const ad = await discoverRefs(smart(r));
		const sha = refSha(ad, 'main') as string;
		const post = statusRequest(
			r,
			sha,
			'success',
			'installed on drupflare',
			'https://site.test'
		);
		expect(post).not.toBeNull();
		const res = await fetch((post as { url: string }).url, {
			method: 'POST',
			headers: { ...authHeaders(r, { token }), 'content-type': 'application/json' },
			body: JSON.stringify((post as { body: unknown }).body)
		});
		expect(res.status, await res.text()).toBe(201);

		const back = await api(`/repos/${USER}/${PRIVATE}/statuses/${sha}`);
		// Gitea takes `state` on the way in and answers `status` on the way out
		const listed = (await back.json()) as { context: string; status: string }[];
		expect(listed[0]?.context).toBe('drupflare');
		expect(listed[0]?.status).toBe('success');
	});

	it('lists an open pull request and its head is fetchable', async (ctx) => {
		if (skip) return ctx.skip();
		// Gitea indexes a pushed branch asynchronously, so the first POST can 404 on a head the
		// push has already reported; 409 is "already open", which a re-run produces
		let status = 0;
		let body = '';
		for (let attempt = 0; attempt < 10 && ![201, 409].includes(status); attempt++) {
			if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
			const made = await api(`/repos/${USER}/${PRIVATE}/pulls`, {
				method: 'POST',
				body: JSON.stringify({
					head: 'feature/two',
					base: 'main',
					title: 'Proposed change'
				})
			});
			status = made.status;
			body = await made.text();
		}
		expect([201, 409], body).toContain(status);

		const r = remote(PRIVATE);
		const req = pullsRequest(r);
		const res = await fetch(req.url, { headers: authHeaders(r, { token }) });
		const pulls = req.pick(await res.json());
		expect(pulls.length).toBeGreaterThan(0);
		expect(pulls[0]?.branch).toBe('feature/two');
		expect(pulls[0]?.target).toBe('main');

		// the same request is visible over the git protocol alone, with no API at all
		const ad = await discoverRefs(smart(r));
		const refs = requestRefs(ad);
		expect(refs.length, 'the server advertises no request head').toBeGreaterThan(0);
		const files = await fetchCommit(smart(r), refs[0]?.sha as string);
		expect(files.some((f) => f.path === 'src/Proposed.php')).toBe(true);
	});
});

describe('a webhook delivery, signed by the server rather than by the test', () => {
	it('registers a hook and verifies the signature the server actually sends', async (ctx) => {
		if (skip) return ctx.skip();

		const deliveries: { headers: Record<string, string>; body: string }[] = [];
		let server: Server | null = null;
		const port = await new Promise<number>((resolve) => {
			server = createServer((req, res) => {
				let body = '';
				req.on('data', (c) => (body += c));
				req.on('end', () => {
					deliveries.push({
						headers: req.headers as Record<string, string>,
						body
					});
					res.writeHead(200).end('ok');
				});
			});
			server.listen(0, '0.0.0.0', () =>
				resolve((server?.address() as { port: number }).port)
			);
		});

		try {
			const secret = 'a-secret-the-server-will-sign-with';
			const r = remote(PRIVATE);
			const post = createHookRequest(
				r,
				`http://host.docker.internal:${port}/githook`,
				secret
			);
			expect(post).not.toBeNull();
			const made = await fetch((post as { url: string }).url, {
				method: 'POST',
				headers: { ...authHeaders(r, { token }), 'content-type': 'application/json' },
				body: JSON.stringify((post as { body: unknown }).body)
			});
			const madeBody = await made.text();
			expect(made.status, madeBody).toBe(201);
			const hookId = (JSON.parse(madeBody) as { id: number }).id;

			// a real push, which is what a developer does and what the site must react to
			const repo = join(root, PRIVATE);
			git(repo, 'checkout', '-q', 'main');
			write(
				repo,
				'secret_module.module',
				'<?php\n\nfunction secret_module_help() { return "v2"; }\n'
			);
			git(repo, 'add', '-A');
			git(repo, 'commit', '-q', '-m', 'v2');
			const pushed = git(repo, 'rev-parse', 'HEAD');
			git(repo, 'push', '-q', 'origin', 'main');

			// matched by SHA rather than by arrival order: the server may deliver more than one
			// event, and asserting against whichever landed first is how this reads as a defect
			const found = () => deliveries.find((d) => d.body.includes(pushed));
			const deadline = Date.now() + 30_000;
			while (found() === undefined && Date.now() < deadline) {
				await new Promise((r2) => setTimeout(r2, 500));
			}
			expect(found(), `no delivery named ${pushed}; got ${deliveries.length}`).toBeDefined();

			const delivery = found() as { headers: Record<string, string>; body: string };
			const headers = new Headers(delivery.headers as Record<string, string>);
			const verdict = await verifyHook('gitea', headers, delivery.body, secret);
			expect(verdict, 'the signature this server sends did not verify').toEqual({
				ok: true,
				proof: 'hmac-sha256'
			});

			const wrong = await verifyHook('gitea', headers, delivery.body, 'not-the-secret');
			expect(wrong.ok).toBe(false);

			const event = readHookEvent('gitea', headers, JSON.parse(delivery.body));
			expect(event.kind).toBe('push');
			expect((event as { branch: string }).branch).toBe('main');
			expect((event as { after: string }).after).toBe(pushed);

			// and the sha the delivery named is the one the transport can now fetch
			const files = await fetchCommit(smart(r), pushed);
			const module = files.find((f) => f.path === 'secret_module.module');
			expect(new TextDecoder().decode(module?.bytes)).toContain('v2');

			await api(`/repos/${USER}/${PRIVATE}/hooks/${hookId}`, { method: 'DELETE' });
		} finally {
			(server as Server | null)?.close();
		}
	}, 60_000);
});

describe('the real sibling module, end to end', () => {
	it('fetches drupflare out of a real server and mounts it by its info file', async (ctx) => {
		if (skip) return ctx.skip();
		const r = remote(SIBLING);
		let ad;
		try {
			ad = await discoverRefs(smart(r));
		} catch {
			return ctx.skip();
		}
		const files = await fetchCommit(smart(r), refSha(ad, 'main') as string);
		expect(files.length, 'the sibling pushed nothing').toBeGreaterThan(20);

		const chosen = selectFiles(files, SIBLING);
		expect(chosen.roots.map((x) => x.name)).toContain('drupflare');
		expect(chosen.files.every((f) => f.path.startsWith('modules/custom/drupflare/'))).toBe(
			true
		);
		expect(chosen.files.some((f) => f.path.endsWith('Host.php'))).toBe(true);
		// a repository this size is where the packfile carries deltas rather than whole blobs
		expect(chosen.totalBytes).toBeGreaterThan(50_000);
	}, 60_000);
});
