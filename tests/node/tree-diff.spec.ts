import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The fleet-patch planner, tested against its own failure modes.
 *
 * `scripts/tree-diff.mjs` decides what a security patch moves to every site, so a wrong answer is
 * either a rollout that ships nothing or one that ships the whole 12,894-file tree. Three of these
 * assertions are regressions for defects that shipped: a skip entry that could never fire, an exit
 * code that was the same on both branches, and a removal that no step in the plan executed.
 *
 * It runs the real CLI in a child process rather than importing it, because the script is a
 * top-level program with no exports and two of the three defects are only observable from outside
 * it -- an exit code is not a return value.
 */

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/tree-diff.mjs');
const exec = promisify(execFile);

type Run = { status: number; stdout: string; stderr: string };

/** runs the CLI and reports the exit code instead of throwing, because two tests assert on it */
async function cli(...args: string[]): Promise<Run> {
	try {
		const { stdout, stderr } = await exec('node', [SCRIPT, ...args], { cwd: ROOT });
		return { status: 0, stdout, stderr };
	} catch (e) {
		const err = e as { code?: number | string; stdout?: string; stderr?: string };
		return {
			status: typeof err.code === 'number' ? err.code : 1,
			stdout: err.stdout ?? '',
			stderr: err.stderr ?? ''
		};
	}
}

type Manifest = { generatedFor: string; fileCount: number; files: Record<string, string> };
type Plan = {
	from: string;
	to: string;
	fileCount: number;
	changed: string[];
	added: string[];
	removed: string[];
	objectsToUpload: number;
	objectsToDelete: number;
	manifestEntries: number;
	fractionOfTree: number;
	rollout: {
		note: string;
		sites: Record<string, unknown>;
		steps: string[];
		constraint: string;
	};
};

let dir = '';
let fleet: Server;
let fleetOrigin = '';

/** writes a tree of literal file bodies; every parent directory is created on the way */
async function tree(name: string, files: Record<string, string>): Promise<string> {
	const root = join(dir, name);
	for (const [rel, body] of Object.entries(files)) {
		const full = join(root, rel);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, body);
	}
	return root;
}

const drupalPhp = (version: string): string =>
	`<?php\nclass Drupal {\n\tconst VERSION = '${version}';\n}\n`;

const BASE: Record<string, string> = {
	'core/lib/Drupal.php': drupalPhp('11.4.5'),
	'core/modules/system/system.info.yml': 'name: System\n',
	'core/modules/system/system.module': '<?php\nfunction system_theme() {}\n',
	'core/modules/system/templates/page.html.twig': '<div>{{ page }}</div>\n',
	'core/themes/claro/claro.info.yml': 'name: Claro\n',
	'core/themes/claro/images/hamburger.svg': '<svg></svg>\n',
	// a directory merely NAMED files, which the skip must not reach
	'core/modules/file/files/sample.php': '<?php\nfunction file_sample() {}\n',
	// sibling of the skipped directory; excluding its parent would take this too
	'sites/default/settings.php': '<?php\n// settings\n',
	// runtime state, not shipped: the compiled-twig names here have NO hash suffix, which is the
	// only reason the real tree never exposed the skip that could not fire
	'sites/default/files/php/twig/abc/page.html.twig': '<?php\n// compiled\n',
	'sites/default/files/php/twig/abc/state.json': '{"compiled":true}\n',
	// wrong extension: shipped by the pack, not by this diff
	'core/misc/drupal.js': 'window.Drupal = {};\n',
	'core/modules/system/css/system.css': '.system {}\n',
	// skipped by name
	'core/modules/system/tests/src/SystemTest.php': '<?php\nclass SystemTest {}\n',
	'.git/config': '[core]\n',
	'node_modules/pkg/index.php': '<?php\n'
};

/** exactly what BASE ships, sorted the way the manifest sorts it */
const BASE_SHIPPED = [
	'core/lib/Drupal.php',
	'core/modules/file/files/sample.php',
	'core/modules/system/system.info.yml',
	'core/modules/system/system.module',
	'core/modules/system/templates/page.html.twig',
	'core/themes/claro/claro.info.yml',
	'core/themes/claro/images/hamburger.svg',
	'sites/default/settings.php'
];

/** BASE with one file changed, one added, one deleted, and the core version bumped */
const PATCHED: Record<string, string> = (() => {
	const next = { ...BASE };
	next['core/lib/Drupal.php'] = drupalPhp('11.4.6');
	next['core/modules/system/system.module'] = '<?php\nfunction system_theme() { return []; }\n';
	next['core/modules/system/src/Patched.php'] = '<?php\nclass Patched {}\n';
	delete next['core/themes/claro/claro.info.yml'];
	return next;
})();

/** BASE plus one file and nothing else, so a plan with no removals is distinguishable */
const ADDITIVE: Record<string, string> = {
	...BASE,
	'core/modules/system/src/Added.php': '<?php\nclass Added {}\n'
};

let base = '';
let patched = '';
let additive = '';
let baseManifest = '';

async function manifestOf(treeDir: string, out: string): Promise<Manifest> {
	const r = await cli('manifest', treeDir, `--out=${out}`);
	expect(r.status, r.stderr).toBe(0);
	return JSON.parse(await readFile(out, 'utf8')) as Manifest;
}

async function planOf(treeDir: string, against: string, ...extra: string[]): Promise<Run & Plan> {
	const r = await cli('plan', treeDir, `--against=${against}`, ...extra);
	return { ...r, ...(JSON.parse(r.stdout) as Plan) };
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'cfw-tree-diff-'));
	base = await tree('base', BASE);
	patched = await tree('patched', PATCHED);
	additive = await tree('additive', ADDITIVE);
	baseManifest = join(dir, 'base.json');
	await manifestOf(base, baseManifest);

	fleet = createServer((req, res) => {
		if (req.url === '/boom') {
			res.writeHead(500).end('no');
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({ sites: 3, rollout: 1, byPackGeneration: { g1: 2, g2: 1 }, stale: 1 })
		);
	});
	await new Promise<void>((done) => fleet.listen(0, '127.0.0.1', done));
	fleetOrigin = `http://127.0.0.1:${(fleet.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
	await new Promise<void>((done) => fleet.close(() => done()));
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the manifest hashes what ships and nothing else', () => {
	it('skips sites/default/files, which is a PATH and never a single directory name', async () => {
		// the defect: `SKIP_DIRS.has(entry.name)` compares a multi-segment constant against one
		// segment, so the entry could not fire and the twig cache was planned as shipped code
		const m = await manifestOf(base, join(dir, 'skip.json'));
		const leaked = Object.keys(m.files).filter((p) => p.startsWith('sites/default/files/'));
		expect(leaked).toEqual([]);
	});

	it('does not over-skip: settings.php and a directory named files both survive', async () => {
		const m = await manifestOf(base, join(dir, 'keep.json'));
		expect(Object.keys(m.files)).toContain('sites/default/settings.php');
		expect(Object.keys(m.files)).toContain('core/modules/file/files/sample.php');
	});

	it('lists exactly the shipped extensions, sorted, with tests and VCS metadata gone', async () => {
		const m = await manifestOf(base, join(dir, 'exact.json'));
		expect(Object.keys(m.files)).toEqual(BASE_SHIPPED);
		expect(m.fileCount).toBe(BASE_SHIPPED.length);
	});

	it('is deterministic: the same tree twice produces byte-identical JSON', async () => {
		const a = join(dir, 'det-a.json');
		const b = join(dir, 'det-b.json');
		await manifestOf(base, a);
		await manifestOf(base, b);
		expect(await readFile(a, 'utf8')).toBe(await readFile(b, 'utf8'));
	});

	it('emits a 32-hex digest per file, distinct per content', async () => {
		const m = await manifestOf(base, join(dir, 'hash.json'));
		const hashes = Object.values(m.files);
		for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{32}$/);
		expect(new Set(hashes).size).toBe(hashes.length);
	});

	it('reads the core version out of Drupal.php, and says unknown without it', async () => {
		const m = await manifestOf(base, join(dir, 'ver.json'));
		expect(m.generatedFor).toBe('11.4.5');
		const bare = await tree('bare', { 'core/modules/system/system.module': '<?php\n' });
		const none = await manifestOf(bare, join(dir, 'bare.json'));
		expect(none.generatedFor).toBe('unknown');
	});
});

describe('the plan classifies a patch against the prior manifest', () => {
	it('reports nothing to move when the tree is unchanged', async () => {
		const p = await planOf(base, baseManifest);
		expect([p.changed, p.added, p.removed]).toEqual([[], [], []]);
		expect(p.objectsToUpload).toBe(0);
		expect(p.fractionOfTree).toBe(0);
		expect(p.from).toBe('11.4.5');
		expect(p.to).toBe('11.4.5');
	});

	it('separates changed from added from removed', async () => {
		const p = await planOf(patched, baseManifest);
		expect(p.changed).toEqual(['core/lib/Drupal.php', 'core/modules/system/system.module']);
		expect(p.added).toEqual(['core/modules/system/src/Patched.php']);
		expect(p.removed).toEqual(['core/themes/claro/claro.info.yml']);
		expect(p.from).toBe('11.4.5');
		expect(p.to).toBe('11.4.6');
	});

	it('counts only the bodies that move, against the size of the new tree', async () => {
		const p = await planOf(patched, baseManifest);
		// 2 changed + 1 added, over a tree that is still 8 files after the deletion
		expect(p.objectsToUpload).toBe(3);
		expect(p.fileCount).toBe(8);
		expect(p.fractionOfTree).toBe(0.375);
	});
});

describe('a rollout can DELETE a file, which is the case an upload count cannot express', () => {
	it('exits 3 when the plan removes a file', async () => {
		// the defect: `process.exit(removed.length > 0 ? 0 : 0)` is 0 on both branches, so the one
		// class of change a delta upload silently drops had no signal at all
		const p = await planOf(patched, baseManifest);
		expect(p.status).toBe(3);
	});

	it('exits 0 on a plan that only adds, so the code means removals and not merely work', async () => {
		const p = await planOf(additive, baseManifest);
		expect(p.added).toEqual(['core/modules/system/src/Added.php']);
		expect(p.removed).toEqual([]);
		expect(p.status).toBe(0);
	});

	it('names the deletion in the plan the operator executes', async () => {
		const p = await planOf(patched, baseManifest);
		// a removal moves no bytes, so it can never appear in objectsToUpload; it has to be its own
		// count and its own step or the file stays on every site forever
		expect(p.objectsToDelete).toBe(1);
		expect(p.objectsToUpload).not.toBe(p.changed.length + p.added.length + p.removed.length);
		expect(p.manifestEntries).toBe(p.fileCount);
		const steps = p.rollout.steps.join(' ');
		expect(steps).toMatch(/manifest of ALL/);
		expect(steps).toMatch(/omitting the plan's removed paths/);
	});

	it('says nothing about deletion when there is none to do', async () => {
		const p = await planOf(base, baseManifest);
		expect(p.objectsToDelete).toBe(0);
	});
});

describe('the fleet is read, never assumed', () => {
	it('names no sites without --fleet', async () => {
		const p = await planOf(base, baseManifest);
		expect(p.rollout.sites.source).toBe(null);
		expect(String(p.rollout.sites.note)).toContain('GET /fleet');
	});

	it('reports the inventory when the endpoint answers', async () => {
		const p = await planOf(base, baseManifest, `--fleet=${fleetOrigin}/fleet`);
		expect(p.rollout.sites).toMatchObject({
			source: `${fleetOrigin}/fleet`,
			total: 3,
			onTarget: 1,
			byPackGeneration: { g1: 2, g2: 1 },
			stale: 1
		});
	});

	it('still emits a plan when the endpoint errors, and says so on stderr', async () => {
		const p = await planOf(base, baseManifest, `--fleet=${fleetOrigin}/boom`);
		expect(p.stderr).toContain('fleet read failed: HTTP 500');
		expect(p.rollout.sites.source).toBe(null);
		expect(p.status).toBe(0);
	});

	it('still emits a plan when the endpoint is unreachable', async () => {
		const p = await planOf(base, baseManifest, '--fleet=http://127.0.0.1:1/fleet');
		expect(p.stderr).toContain('fleet read failed');
		expect(p.rollout.sites.source).toBe(null);
	});
});

describe('the CLI refuses what it cannot answer', () => {
	it('exits 2 with no arguments, naming itself correctly', async () => {
		const r = await cli();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('tree-diff.mjs');
		expect(r.stderr).not.toContain('security-update.mjs');
	});

	it('exits 2 on a tree that does not exist', async () => {
		const r = await cli('manifest', join(dir, 'nope'));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('no such tree');
	});

	it('exits 2 when plan has no --against', async () => {
		const r = await cli('plan', base);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('--against');
	});

	it('exits 2 on an unknown command', async () => {
		const r = await cli('audit', base);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('unknown command: audit');
	});
});
