import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { glob, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const PACKER = join(ROOT, 'scripts/pack-static.ts');

/**
 * The static packer, against a synthetic Drupal tree.
 *
 * Two claims carry the whole thing and both are cheap to get wrong: WHICH files it copies -- a
 * `.pcss.css` source or a `demo_umami` photograph that ships is 3 MB of bytes no page fetches -- and
 * that a RE-RUN is a no-op. The second matters because the output is a served directory rather than
 * a single artifact: a copy that re-writes 4,028 files every build churns mtimes, and one that never
 * prunes serves a deleted file forever under a live URL.
 */

/** every fixture file as [path under the drupal root, contents, mtime in whole seconds] */
const FIXTURE: [string, string, number][] = [
	['core/misc/drupal.js', 'window.Drupal = {};\n', 1700000001],
	['core/misc/favicon.ico', 'icon-bytes', 1700000002],
	[
		'core/themes/olivero/css/base/fonts.css',
		'@font-face { src: url(../../fonts/a.woff2); }\n',
		1700000003
	],
	['core/themes/olivero/css/base/fonts.pcss.css', '@font-face {}\n', 1700000004],
	['core/themes/olivero/fonts/a.woff2', 'woff2-bytes', 1700000005],
	['core/themes/olivero/images/logo.svg', '<svg></svg>\n', 1700000006],
	['core/themes/olivero/olivero.info.yml', 'name: Olivero\n', 1700000007],
	['core/modules/system/system.module', '<?php\n', 1700000008],
	['core/modules/system/css/system.css', '.system {}\n', 1700000009],
	['core/modules/system/tests/src/js/systemTest.js', 'test();\n', 1700000010],
	['core/assets/vendor/jquery/jquery.min.js', 'jQuery;\n', 1700000011],
	['core/assets/vendor/thing/node_modules/dep/dep.js', 'dep();\n', 1700000012],
	['core/profiles/demo_umami/themes/umami/images/food.jpg', 'jpeg-bytes', 1700000013],
	['themes/custom/mine/mine.css', '.mine {}\n', 1700000014],
	['index.php', '<?php\n', 1700000015]
];

/** what the packer must copy, relative to the out-dir, sorted */
const EXPECTED = [
	'assets/vendor/jquery/jquery.min.js',
	'misc/drupal.js',
	'misc/favicon.ico',
	'modules/system/css/system.css',
	'themes/olivero/css/base/fonts.css',
	'themes/olivero/fonts/a.woff2',
	'themes/olivero/images/logo.svg'
];

type Summary = {
	files: number;
	copied: number;
	unchanged: number;
	pruned: number;
	bytes: number;
	mb: number;
};

let dir = '';
let tree = '';
let out = '';

async function buildTree(): Promise<void> {
	for (const [rel, body, mtime] of FIXTURE) {
		const abs = join(tree, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, body);
		await utimes(abs, mtime, mtime);
	}
}

function pack(target = out, root = tree): { summary: Summary; status: number; stderr: string } {
	const r = spawnSync('bun', [PACKER, root, target], {
		cwd: ROOT,
		encoding: 'utf8',
		timeout: 120_000
	});
	return {
		summary: r.status === 0 ? (JSON.parse(r.stdout) as Summary) : ({} as Summary),
		status: r.status ?? -1,
		stderr: r.stderr.trim()
	};
}

/** every file under `root`, relative and sorted */
async function listing(root: string): Promise<string[]> {
	const found: string[] = [];
	for await (const p of glob('**/*', { cwd: root })) {
		if ((await stat(join(root, p))).isFile()) found.push(p);
	}
	return found.sort();
}

const made: string[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'cfw-pack-static-'));
	made.push(dir);
	tree = join(dir, 'tree');
	out = join(dir, 'out');
	await buildTree();
});

afterAll(async () => {
	for (const d of made) await rm(d, { recursive: true, force: true });
});

describe('which files reach the asset layer', () => {
	it('copies exactly the browser-fetchable set, flattened out of core/', async () => {
		const { status, summary } = pack();
		expect(status).toBe(0);
		expect(await listing(out)).toEqual(EXPECTED);
		expect(summary.files).toBe(EXPECTED.length);
		expect(summary.copied).toBe(EXPECTED.length);
		expect(summary.unchanged).toBe(0);
		expect(summary.pruned).toBe(0);
	});

	it('leaves out the four kinds of file that would ship bytes nothing fetches', async () => {
		pack();
		const got = await listing(out);
		// a PostCSS source Drupal already compiled into the sibling .css
		expect(got).not.toContain('themes/olivero/css/base/fonts.pcss.css');
		// the QA profile, 2.9 MB of photography an installed site never references
		expect(got).not.toContain('profiles/demo_umami/themes/umami/images/food.jpg');
		expect(got).not.toContain('modules/system/tests/src/js/systemTest.js');
		expect(got).not.toContain('assets/vendor/thing/node_modules/dep/dep.js');
	});

	it("takes nothing PHP opens, which is the packs' half of the split", async () => {
		pack();
		const got = await listing(out);
		expect(got.some((p) => p.endsWith('.php') || p.endsWith('.yml'))).toBe(false);
	});

	it('reads only core/, because only core/ answers at a /core/ URL', async () => {
		pack();
		// a contrib or custom theme asset is served at /modules/** or /themes/**, which this
		// directory cannot answer; shipping it under /core/ would be a URL that never resolves
		expect(await listing(out)).not.toContain('custom/mine/mine.css');
	});

	it('carries the source mtime, so a re-run has something to compare', async () => {
		pack();
		const copied = await stat(join(out, 'misc/drupal.js'));
		const source = await stat(join(tree, 'core/misc/drupal.js'));
		expect(Math.floor(copied.mtimeMs)).toBe(Math.floor(source.mtimeMs));
	});
});

describe('a re-run is a no-op, and a changed tree is not', () => {
	it('copies nothing the second time', () => {
		pack();
		const again = pack();
		expect(again.summary.copied).toBe(0);
		expect(again.summary.unchanged).toBe(EXPECTED.length);
		expect(again.summary.pruned).toBe(0);
	});

	it('re-copies a file whose bytes changed without changing length', async () => {
		pack();
		// the shape a patched core file has: same size, different content. Size alone would miss it
		await writeFile(join(tree, 'core/misc/drupal.js'), 'window.Drupal = [];\n');
		await utimes(join(tree, 'core/misc/drupal.js'), 1700000099, 1700000099);
		const again = pack();
		expect(again.summary.copied).toBe(1);
		expect(await readFile(join(out, 'misc/drupal.js'), 'utf8')).toBe('window.Drupal = [];\n');
	});

	it('prunes a file the source no longer has, and the directory it emptied', async () => {
		pack();
		await rm(join(tree, 'core/themes/olivero/images/logo.svg'));
		const again = pack();
		expect(again.summary.pruned).toBe(1);
		expect(existsSync(join(out, 'themes/olivero/images/logo.svg'))).toBe(false);
		// a stale asset under a live URL is worse than a missing one, and an empty skeleton is litter
		expect(existsSync(join(out, 'themes/olivero/images'))).toBe(false);
		expect(existsSync(join(out, 'themes/olivero/fonts/a.woff2'))).toBe(true);
	});
});

describe('the packer refuses a run it cannot complete', () => {
	it('exits non-zero with a usage line when the drupal root is missing', () => {
		const r = spawnSync('bun', [PACKER], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('usage: pack-static.ts <drupal-root> [out-dir]');
	});

	it('refuses a target holding a file it could not have written', async () => {
		// scripts/README.md's rule, and the reason pack-drupal.ts stopped opening with rm -rf: the
		// one unrecoverable artifact in this repo sits one argument away from a packer's output dir
		await mkdir(out, { recursive: true });
		await writeFile(join(out, 'site.sqlite'), 'SQLite format 3\0');
		const r = pack();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('pack-static.ts did not write');
		expect(existsSync(join(out, 'site.sqlite'))).toBe(true);
	});
});
