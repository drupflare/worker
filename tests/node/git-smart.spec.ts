import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	branchNames,
	fetchCommit,
	packOffset,
	parseAdvertisement,
	parsePackfile,
	readWorkingTree,
	refSha,
	requestRefs,
	smartBase,
	uploadPackRequest,
	type WorkingFile
} from '../../src/ops/git-smart';
import { planSync, selectFiles } from '../../src/ops/git-sync';

/**
 * The smart-HTTP client against REAL `git upload-pack`.
 *
 * `--stateless-rpc` reads the same request body an HTTP POST carries and writes the same response, so
 * this drives the whole client -- advertisement, negotiation, packfile, deltas, trees -- with no
 * server and no network. A mock packfile would only prove the mock.
 */

let root = '';
const repos = new Map<string, string>();

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'drupflare',
			GIT_AUTHOR_EMAIL: 'test@example.invalid',
			GIT_COMMITTER_NAME: 'drupflare',
			GIT_COMMITTER_EMAIL: 'test@example.invalid',
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_SYSTEM: '/dev/null'
		}
	}).trim();

function write(repo: string, path: string, body: string | Uint8Array): void {
	const full = join(repo, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

function commit(repo: string, message: string): string {
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', message);
	return git(repo, 'rev-parse', 'HEAD');
}

/** the `GET /info/refs?service=git-upload-pack` body, minus the banner http-backend prepends */
function advertise(repo: string): Uint8Array {
	return new Uint8Array(
		execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', repo], {
			maxBuffer: 256 * 1024 * 1024
		})
	);
}

/** the `POST /git-upload-pack` exchange, byte for byte */
function uploadPack(repo: string, body: Uint8Array): Uint8Array {
	return new Uint8Array(
		execFileSync('git', ['upload-pack', '--stateless-rpc', repo], {
			input: Buffer.from(body),
			maxBuffer: 256 * 1024 * 1024
		})
	);
}

/** the two calls `fetchCommit()` makes, served by the local binary instead of by HTTPS */
function localFetch(repo: string): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes('/info/refs')) {
			return new Response(advertise(repo), { status: 200 });
		}
		const body = new Uint8Array(init?.body as ArrayBuffer);
		return new Response(uploadPack(repo, body), { status: 200 });
	}) as unknown as typeof fetch;
}

function tree(repo: string, sha: string): Promise<WorkingFile[]> {
	return fetchCommit({ url: `https://local.invalid/${repo}` }, sha, localFetch(repo));
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'cfw-git-'));

	// a module-shaped repository, with a second commit so the pack carries deltas
	const single = join(root, 'single');
	mkdirSync(single, { recursive: true });
	git(single, 'init', '-q', '-b', 'main');
	write(
		single,
		'mymodule.info.yml',
		'name: My Module\ntype: module\ncore_version_requirement: ^11\n'
	);
	write(single, 'mymodule.module', '<?php\n\nfunction mymodule_help() { return "v1"; }\n');
	write(
		single,
		'src/Controller/PageController.php',
		`<?php\n\nnamespace Drupal\\mymodule;\n\nclass PageController {\n${'  // padding to make the delta worth taking\n'.repeat(60)}}\n`
	);
	write(single, 'tests/src/Kernel/ThingTest.php', '<?php\n// must never be mounted\n');
	write(single, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
	write(single, 'vendor/autoload.php', '<?php\n// composer\n');
	write(single, '.gitignore', 'vendor\n');
	write(single, 'README.md', '# not a mountable extension\n');
	write(
		single,
		'logo.png',
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13])
	);
	const first = commit(single, 'first');
	write(single, 'mymodule.module', '<?php\n\nfunction mymodule_help() { return "v2"; }\n');
	write(
		single,
		'src/Controller/PageController.php',
		`<?php\n\nnamespace Drupal\\mymodule;\n\nclass PageController {\n${'  // padding to make the delta worth taking\n'.repeat(60)}  // one more line\n}\n`
	);
	write(
		single,
		'src/Form/SettingsForm.php',
		'<?php\n\nnamespace Drupal\\mymodule;\n\nclass SettingsForm {}\n'
	);
	const second = commit(single, 'second');
	// forked from the FIRST commit, so switching to it has to delete a file main added
	git(single, 'branch', 'feature/one', first);
	git(single, 'checkout', '-q', 'feature/one');
	write(single, 'mymodule.module', '<?php\n\nfunction mymodule_help() { return "feature"; }\n');
	const feature = commit(single, 'on the feature branch');
	git(single, 'checkout', '-q', 'main');
	git(single, 'tag', 'v1.0.0');
	// what a provider publishes for an open request; visible to any client with no API at all
	git(single, 'update-ref', 'refs/pull/7/head', feature);
	repos.set('single', single);
	repos.set('single:first', first);
	repos.set('single:second', second);
	repos.set('single:feature', feature);

	// several modules in one repository, which is what a real agency monorepo looks like
	const multi = join(root, 'multi');
	mkdirSync(multi, { recursive: true });
	git(multi, 'init', '-q', '-b', 'main');
	write(multi, 'modules/alpha/alpha.info.yml', 'name: Alpha\ntype: module\n');
	write(multi, 'modules/alpha/alpha.module', '<?php\n// alpha\n');
	write(multi, 'modules/beta/beta.info.yml', 'name: Beta\ntype: module\n');
	write(multi, 'modules/beta/src/Beta.php', '<?php\n// beta\n');
	write(multi, 'themes/gamma/gamma.info.yml', 'name: Gamma\ntype: theme\nbase theme: stable9\n');
	write(multi, 'themes/gamma/gamma.theme', '<?php\n// gamma\n');
	write(
		multi,
		'modules/alpha/modules/alpha_sub/alpha_sub.info.yml',
		'name: Alpha Sub\ntype: module\n'
	);
	repos.set('multi:head', commit(multi, 'three extensions'));
	repos.set('multi', multi);

	// the shapes that break a naive walker
	const odd = join(root, 'odd');
	mkdirSync(odd, { recursive: true });
	git(odd, 'init', '-q', '-b', 'main');
	write(odd, 'odd.info.yml', 'name: Odd\ntype: module\n');
	write(odd, 'src/Ünïcodé Ñame.php', '<?php\n// a path outside ascii\n');
	write(odd, 'src/big.php', `<?php\n${'// '.repeat(200_000)}\n`);
	write(odd, 'src/empty.php', '');
	write(odd, 'templates/thing.html.twig', '<div>{{ thing }}</div>\n');
	write(odd, 'css/style.css', 'body { color: #333; }\n');
	write(odd, 'js/app.js', 'export const a = 1;\n');
	execFileSync('ln', ['-s', 'big.php', join(odd, 'src/link.php')]);
	repos.set('odd:head', commit(odd, 'awkward shapes'));
	repos.set('odd', odd);
});

afterAll(() => {
	if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('the ref advertisement', () => {
	it('reads every ref a real server advertises', () => {
		const ad = parseAdvertisement(advertise(repos.get('single') as string));
		expect(ad.refs.get('refs/heads/main')).toBe(repos.get('single:second'));
		expect(ad.refs.get('refs/heads/feature/one')).toBe(repos.get('single:feature'));
		expect(ad.refs.has('refs/tags/v1.0.0')).toBe(true);
		expect(ad.capabilities.length, 'no capability line was parsed').toBeGreaterThan(0);
	});

	it('names the default branch from the symref capability', () => {
		const ad = parseAdvertisement(advertise(repos.get('single') as string));
		expect(ad.defaultBranch).toBe('main');
	});

	it('resolves a branch, a tag and a bare sha through one accessor', () => {
		const ad = parseAdvertisement(advertise(repos.get('single') as string));
		expect(refSha(ad, 'main')).toBe(repos.get('single:second'));
		expect(refSha(ad, 'refs/heads/main')).toBe(repos.get('single:second'));
		expect(refSha(ad, repos.get('single:first') as string)).toBe(repos.get('single:first'));
		expect(refSha(ad, 'no-such-branch')).toBeNull();
	});

	it('lists branches without the refs prefix and leaves tags out', () => {
		const ad = parseAdvertisement(advertise(repos.get('single') as string));
		expect(branchNames(ad)).toEqual(['feature/one', 'main']);
	});

	it('finds an open request head with no provider API at all', () => {
		const ad = parseAdvertisement(advertise(repos.get('single') as string));
		expect(requestRefs(ad)).toEqual([
			{ id: '7', ref: 'refs/pull/7/head', sha: repos.get('single:feature') }
		]);
	});

	it('normalises a clone URL exactly once', () => {
		expect(smartBase('https://host/o/r')).toBe('https://host/o/r.git');
		expect(smartBase('https://host/o/r.git')).toBe('https://host/o/r.git');
		expect(smartBase('https://host/o/r/  ')).toBe('https://host/o/r.git');
	});
});

describe('the packfile', () => {
	it('parses a real shallow fetch and finds the commit it asked for', async () => {
		const repo = repos.get('single') as string;
		const sha = repos.get('single:second') as string;
		const body = uploadPack(repo, uploadPackRequest(sha, 1));
		const pack = await parsePackfile(body, packOffset(body));
		expect(pack.objects.has(sha), 'the requested commit is not in the pack').toBe(true);
		expect(pack.count).toBe(pack.objects.size);
	});

	it('resolves deltas across a two-commit fetch', async () => {
		// depth 2 forces git to delta the second revision of the padded controller against the first
		const repo = repos.get('single') as string;
		const sha = repos.get('single:second') as string;
		const body = uploadPack(repo, uploadPackRequest(sha, 2));
		const pack = await parsePackfile(body, packOffset(body));
		const files = readWorkingTree(pack, sha);
		const module = files.find((f) => f.path === 'mymodule.module');
		expect(new TextDecoder().decode(module?.bytes)).toContain('v2');
		// the older commit's tree is present too, which is where the delta bases live
		expect(pack.objects.has(repos.get('single:first') as string)).toBe(true);
	});

	it('reproduces the working tree byte for byte against git itself', async () => {
		const repo = repos.get('single') as string;
		const sha = repos.get('single:second') as string;
		const files = await tree(repo, sha);
		const listed = git(repo, 'ls-tree', '-r', '--name-only', sha).split('\n').sort();
		expect(files.map((f) => f.path)).toEqual(listed);
		for (const file of files) {
			const expected = execFileSync('git', ['-C', repo, 'show', `${sha}:${file.path}`], {
				maxBuffer: 64 * 1024 * 1024
			});
			expect(Buffer.from(file.bytes).equals(expected), `${file.path} differs`).toBe(true);
		}
	});

	it('carries a binary blob through unchanged', async () => {
		const files = await tree(
			repos.get('single') as string,
			repos.get('single:second') as string
		);
		const png = files.find((f) => f.path === 'logo.png');
		expect([...(png?.bytes.slice(0, 4) ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it('handles a non-ascii path, an empty file and a large one', async () => {
		const repo = repos.get('odd') as string;
		const files = await tree(repo, repos.get('odd:head') as string);
		const paths = files.map((f) => f.path);
		expect(paths).toContain('src/Ünïcodé Ñame.php');
		expect(files.find((f) => f.path === 'src/empty.php')?.bytes.length).toBe(0);
		expect(files.find((f) => f.path === 'src/big.php')?.bytes.length).toBeGreaterThan(500_000);
	});

	it('skips a symlink rather than writing its target as a file', async () => {
		const files = await tree(repos.get('odd') as string, repos.get('odd:head') as string);
		expect(files.some((f) => f.path === 'src/link.php')).toBe(false);
	});

	it('refuses a body that is not a packfile', async () => {
		await expect(parsePackfile(new TextEncoder().encode('NOPE....'))).rejects.toThrow(
			/packfile/
		);
		expect(() => packOffset(new TextEncoder().encode('0008NAK\n'))).toThrow(/no packfile/);
	});
});

describe('what a repository turns into', () => {
	it('drops tests, vendor, node_modules, dotfiles and unmountable extensions', async () => {
		const files = await tree(
			repos.get('single') as string,
			repos.get('single:second') as string
		);
		const chosen = selectFiles(files, 'mymodule');
		const paths = chosen.files.map((f) => f.path);
		expect(paths).toContain('modules/custom/mymodule/mymodule.module');
		expect(paths).toContain('modules/custom/mymodule/src/Form/SettingsForm.php');
		expect(paths.some((p) => p.includes('tests/'))).toBe(false);
		expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
		expect(paths.some((p) => p.includes('vendor/'))).toBe(false);
		expect(paths.some((p) => p.endsWith('README.md'))).toBe(false);
		expect(paths.some((p) => p.endsWith('logo.png'))).toBe(false);
		expect(chosen.skipped.length, 'nothing was reported as dropped').toBeGreaterThan(4);
	});

	it('mounts every extension in a monorepo at its own path and by its own type', async () => {
		const files = await tree(repos.get('multi') as string, repos.get('multi:head') as string);
		const chosen = selectFiles(files, 'multi');
		expect(chosen.roots.map((r) => `${r.type}:${r.name}`).sort()).toEqual([
			'module:alpha',
			'module:beta',
			'theme:gamma'
		]);
		const paths = chosen.files.map((f) => f.path);
		expect(paths).toContain('modules/custom/alpha/alpha.module');
		expect(paths).toContain('modules/custom/beta/src/Beta.php');
		expect(paths).toContain('themes/custom/gamma/gamma.theme');
		// the submodule travels inside its parent rather than being mounted twice
		expect(paths).toContain('modules/custom/alpha/modules/alpha_sub/alpha_sub.info.yml');
		expect(paths.some((p) => p.startsWith('modules/custom/alpha_sub/'))).toBe(false);
	});

	it('keeps twig, css and js, which a theme needs and PHP-only filtering would lose', async () => {
		const files = await tree(repos.get('odd') as string, repos.get('odd:head') as string);
		const paths = selectFiles(files, 'odd').files.map((f) => f.path);
		expect(paths).toContain('modules/custom/odd/templates/thing.html.twig');
		expect(paths).toContain('modules/custom/odd/css/style.css');
		expect(paths).toContain('modules/custom/odd/js/app.js');
	});
});

describe('the diff between two commits', () => {
	it('reports added, modified and unchanged against what is installed', async () => {
		const repo = repos.get('single') as string;
		const before = selectFiles(
			await tree(repo, repos.get('single:first') as string),
			'mymodule'
		);
		const after = selectFiles(
			await tree(repo, repos.get('single:second') as string),
			'mymodule'
		);
		const stored = new Map(before.files.map((f) => [f.path, f.source]));

		const plan = planSync(stored, after.files);
		expect(plan.counts.added).toBe(1);
		expect(plan.counts.modified).toBe(2);
		expect(plan.counts.removed).toBe(0);
		const added = plan.changes.find((c) => c.path.endsWith('SettingsForm.php'));
		expect(added?.kind).toBe('added');
		const edited = plan.changes.find((c) => c.path.endsWith('PageController.php'));
		expect(edited?.added, 'the one added line was not counted').toBe(1);
		expect(edited?.removed).toBe(0);
	});

	it('deletes what a branch switch leaves behind', async () => {
		const repo = repos.get('single') as string;
		const main = selectFiles(
			await tree(repo, repos.get('single:second') as string),
			'mymodule'
		);
		const feature = selectFiles(
			await tree(repo, repos.get('single:feature') as string),
			'mymodule'
		);
		const stored = new Map(main.files.map((f) => [f.path, f.source]));

		const plan = planSync(stored, feature.files);
		// the feature branch forked before SettingsForm existed, so switching must remove it
		expect(plan.deletes).toEqual(['modules/custom/mymodule/src/Form/SettingsForm.php']);
		expect(plan.counts.removed).toBe(1);
	});

	it('plans nothing at all when the same commit is pulled twice', async () => {
		const repo = repos.get('single') as string;
		const chosen = selectFiles(
			await tree(repo, repos.get('single:second') as string),
			'mymodule'
		);
		const stored = new Map(chosen.files.map((f) => [f.path, f.source]));
		const plan = planSync(stored, chosen.files);
		expect(plan.rowsWritten, 'a repeat pull must charge no rows').toBe(0);
		expect(plan.counts.unchanged).toBe(chosen.files.length);
	});
});

describe('the real sibling modules, which are what this feature exists to deliver', () => {
	const SIBLINGS: [string, string][] = [
		['drupflare', process.env.DRUPFLARE_SRC ?? '../drupflare'],
		['rom', process.env.ROM_SRC ?? '../rom']
	];

	for (const [name, path] of SIBLINGS) {
		it(`round-trips ${name} through a real fetch`, async (ctx) => {
			if (!existsSync(join(path, 'src'))) return ctx.skip();
			const repo = join(root, `sib-${name}`);
			mkdirSync(repo, { recursive: true });
			git(repo, 'init', '-q', '-b', 'main');
			for (const part of ['src', 'tests']) {
				if (existsSync(join(path, part))) {
					cpSync(join(path, part), join(repo, part), { recursive: true });
				}
			}
			for (const file of [
				'drupflare.info.yml',
				'drupflare.module',
				'cfw_do_sqlite.info.yml'
			]) {
				if (existsSync(join(path, file))) cpSync(join(path, file), join(repo, file));
			}
			// the mount name comes from the info file, so give a repo without one what it declares
			if (!existsSync(join(repo, `${name}.info.yml`))) {
				write(
					repo,
					`${name === 'rom' ? 'cfw_do_sqlite' : name}.info.yml`,
					`name: ${name}\ntype: module\n`
				);
			}
			const sha = commit(repo, `${name} as a module repository`);

			const files = await tree(repo, sha);
			expect(files.length, 'the sibling produced no files').toBeGreaterThan(5);
			const chosen = selectFiles(files, name);
			expect(chosen.roots.length, 'no module was discovered').toBeGreaterThan(0);
			// rom is checked out as `rom` and provides `cfw_do_sqlite`; the info file is the authority
			const expected = name === 'rom' ? 'cfw_do_sqlite' : 'drupflare';
			expect(chosen.roots.map((r) => r.name)).toContain(expected);
			expect(
				chosen.files.every((f) => f.path.startsWith(`modules/custom/${expected}/`))
			).toBe(true);
			expect(chosen.files.some((f) => f.path.endsWith('.php'))).toBe(true);
			// the sibling's own test tree is not part of a mounted module
			expect(chosen.files.some((f) => f.path.includes('/tests/'))).toBe(false);
		});
	}
});
