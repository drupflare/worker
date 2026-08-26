import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eGate, ENDPOINT, SITE } from './helpers/endpoint';

/** the git tier through a running worker; the `node` forge specs never reach the Durable Object */

const FORGE = process.env.CFW_E2E_FORGE ?? 'gitea';
const BASE = process.env.CFW_E2E_FORGE_URL ?? 'http://127.0.0.1:3300';
const CONTAINER = process.env.CFW_E2E_FORGE_CONTAINER ?? `drupflare-worker-${FORGE}-1`;
const USER = 'drupflare';
const PASSWORD = 'drupflare-test-pw-1';

const RUN = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const REPO = `e2e-module-${RUN}`;
const MACHINE = `e2e_module_${RUN.replace(/[^a-z0-9]/gi, '')}`.toLowerCase();

let token = '';
let root = '';
let skip = false;
let noRig = false;
let remoteId = '';

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

function write(repo: string, path: string, body: string): void {
	const full = join(repo, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

/** the worker's own git route, which is what this spec exists to exercise */
async function route(params: Record<string, string>): Promise<Record<string, any>> {
	const url = new URL(`${ENDPOINT}/git`);
	url.searchParams.set('site', SITE);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	return (await res.json()) as Record<string, any>;
}

async function forgeReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${BASE}/api/healthz`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}

beforeAll(async () => {
	skip = await e2eGate();
	if (skip) return;
	noRig = !(await forgeReachable());
	if (noRig && process.env.CI) {
		throw new Error(
			`e2e: no ${FORGE} at ${BASE} (required in CI). ` +
				`Start it with \`docker compose -f docker/compose.yml up -d ${FORGE}\`.`
		);
	}
	if (noRig) return;

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
		'write:repository,write:user',
		'-t',
		`e2e-git-${RUN}`,
		'--raw'
	);

	const made = await fetch(`${BASE}/api/v1/user/repos`, {
		method: 'POST',
		headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ name: REPO, private: true, auto_init: false })
	});
	if (!made.ok && made.status !== 409) {
		throw new Error(`could not create ${REPO}: ${made.status} ${await made.text()}`);
	}

	root = mkdtempSync(join(tmpdir(), 'cfw-e2e-git-'));
	const dir = join(root, REPO);
	mkdirSync(dir, { recursive: true });
	git(dir, 'init', '-q', '-b', 'main');
	write(
		dir,
		`${MACHINE}.info.yml`,
		`name: E2E Module\ntype: module\ncore_version_requirement: ^11\n`
	);
	write(dir, `${MACHINE}.module`, `<?php\n\nfunction ${MACHINE}_help() { return "v1"; }\n`);
	// dropped by the mount filter, which is half of what this asserts
	write(dir, 'tests/src/Ignored.php', '<?php\n// never mounted\n');
	write(dir, 'node_modules/junk.js', 'nope\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'the module');
	git(
		dir,
		'remote',
		'add',
		'origin',
		`${BASE.replace('://', `://${USER}:${encodeURIComponent(PASSWORD)}@`)}/${USER}/${REPO}.git`
	);
	git(dir, 'push', '-q', '-u', 'origin', 'main');
}, 180_000);

afterAll(async () => {
	if (root !== '') rmSync(root, { recursive: true, force: true });
	if (skip || noRig || token === '') return;
	if (remoteId !== '') await route({ action: 'remove', id: remoteId }).catch(() => null);
	await fetch(`${BASE}/api/v1/repos/${USER}/${REPO}`, {
		method: 'DELETE',
		headers: { authorization: `token ${token}` }
	}).catch(() => null);
});

describe('the git route against a real forge', () => {
	it('adds a private remote, resolving its default branch from the advertisement', async (ctx) => {
		if (skip || noRig) return ctx.skip();
		const added = await route({
			action: 'add',
			provider: 'gitea',
			repo: `${BASE}/${USER}/${REPO}`,
			token
		});
		expect(added.ok, JSON.stringify(added)).toBe(true);
		// the branch was never passed in; it came out of the ref advertisement
		expect(added.branch ?? added.remote?.branch).toBe('main');
		remoteId = String(added.id ?? added.remote?.id ?? '');
		expect(remoteId).not.toBe('');
	});

	it('lists the remote it just stored', async (ctx) => {
		if (skip || noRig || remoteId === '') return ctx.skip();
		const listed = await route({ action: 'list' });
		expect(listed.ok).toBe(true);
		const mine = (listed.remotes as any[]).find((r) => String(r.id) === remoteId);
		expect(mine, `${remoteId} is not in the list`).toBeTruthy();
		// the token must never come back out of the route
		expect(JSON.stringify(listed)).not.toContain(token);
	});

	it('pulls the commit and mounts only what Drupal can use', async (ctx) => {
		if (skip || noRig || remoteId === '') return ctx.skip();
		const pulled = await route({ action: 'pull', id: remoteId });
		expect(pulled.applied, JSON.stringify(pulled).slice(0, 400)).toBe(true);

		// the module was identified by its info file, not by the repository name
		const modules = (pulled.modules ?? []) as { name: string; type: string }[];
		expect(modules.map((m) => m.name)).toContain(MACHINE);
		expect(modules.find((m) => m.name === MACHINE)?.type).toBe('module');

		// and the mount filter dropped the two files that must never reach the site
		const paths = ((pulled.changes ?? []) as any[]).map((c) =>
			typeof c === 'string' ? c : String(c.path ?? '')
		);
		expect(paths.length, 'a pull that applied reported no changes').toBeGreaterThan(0);
		expect(paths.some((p) => p.endsWith(`${MACHINE}.info.yml`))).toBe(true);
		expect(paths.some((p) => p.includes('node_modules/'))).toBe(false);
		expect(paths.some((p) => p.includes('tests/'))).toBe(false);
		expect(
			Number(pulled.skipped),
			'nothing was skipped, so the filter did not run'
		).toBeGreaterThan(0);
	});

	it('writes the result back to the forge as a commit status', async (ctx) => {
		if (skip || noRig || remoteId === '') return ctx.skip();
		// from the push rather than from the API: the commits endpoint is indexed asynchronously
		const sha = git(join(root, REPO), 'rev-parse', 'HEAD');
		expect(sha).toMatch(/^[0-9a-f]{40}$/);

		const statuses = await fetch(`${BASE}/api/v1/repos/${USER}/${REPO}/statuses/${sha}`, {
			headers: { authorization: `token ${token}` }
		});
		const list = (await statuses.json()) as any[];
		// best-effort tolerates a provider refusing; this forge accepts statuses and the token has
		// the scope, so one must exist
		const ours = list.filter((s) => s.context === 'drupflare');
		expect(
			ours.length,
			`no drupflare status on ${sha}: ${JSON.stringify(list).slice(0, 200)}`
		).toBeGreaterThan(0);
		expect(ours[0].status).toBe('success');
		expect(String(ours[0].target_url ?? '')).not.toBe('');
	});

	it('reports status for the remote without leaking the credential', async (ctx) => {
		if (skip || noRig || remoteId === '') return ctx.skip();
		const status = await route({ action: 'status', id: remoteId });
		expect(status.ok ?? true).not.toBe(false);
		expect(JSON.stringify(status)).not.toContain(token);
		expect(JSON.stringify(status)).not.toContain(PASSWORD);
	});
});
