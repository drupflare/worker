import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	BOX_ASSETS_MANIFEST,
	BOX_ENTRYPOINTS,
	BOX_VARS_FILE,
	BOX_WITHHELD,
	boxAssetFiles,
	boxAssetManifest,
	boxBundleName,
	boxProblems,
	boxVars,
	entryOf,
	importsOf,
	packBox,
	readBoxModules,
	sumsLine
} from '../../scripts/build-box-bundle';
import { PAYLOAD_ASSETS, readJsonc } from '../../scripts/release-payload';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/build-box-bundle.ts');
const enc = (text: string) => new TextEncoder().encode(text);

const ENTRY =
	'import a from"./aaa-php.wasm";import b from"./bbb-composer.lock";export default{a,b}';

/** a dry-run output directory shaped like wrangler's: modules, a source map and a readme */
function dryRun(overrides: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), 'box-bundle-'));
	const files: Record<string, string> = {
		'site.js': ENTRY,
		'site.js.map': '{}',
		'README.md': 'built by wrangler',
		'aaa-php.wasm': 'wasm',
		'bbb-composer.lock': '{}',
		...overrides
	};
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	return dir;
}

function list(archive: string): string[] {
	return execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
}

// reads the tar headers itself: bsdtar on macOS hides AppleDouble members from its own listing
function memberNames(archive: string): string[] {
	const tar = gunzipSync(readFileSync(archive));
	const names: string[] = [];
	for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
		names.push(
			tar
				.subarray(at, at + 100)
				.toString('latin1')
				.replace(/\0.*$/s, '')
		);
		const size = parseInt(tar.subarray(at + 124, at + 136).toString('latin1'), 8);
		at += 512 + Math.ceil(size / 512) * 512;
	}
	return names;
}

const SHIPPED = [
	'assets/robots.txt',
	'assets/driver.json',
	'assets/prefill.json',
	'assets/core/css/a.css',
	'assets/core/js/b.js',
	'assets/modules/m/m.js',
	'assets/drupal-pf/core.pf.json',
	'assets/drupal-pf/core.pf.bin',
	'assets/drupal-sql/manifest.json',
	'assets/drupal-sql/0001.json'
];

/** what the plan withholds from the edge, which a box has no use for either, and the boot image */
const WITHHELD = [
	'assets/drupal/site.sqlite',
	'assets/drupal-pf/other.bin',
	'assets/notes.txt',
	'assets/bootimage/claimed/a.bin'
];

const CANONICAL_VARS = { CMS: 'drupal', LAZY_MOUNT: '1', ASSET_AGGREGATES: 1, FLAG: true };

/** a checkout holding the real ignore file and a small asset tree, some of it withheld */
function checkout(extra: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), 'box-root-'));
	writeFileSync(
		join(root, 'wrangler.jsonc'),
		`{ "main": "src/site.ts",\n// a comment\n"vars": ${JSON.stringify(CANONICAL_VARS)} }`
	);
	writeFileSync(
		join(root, 'wrangler.managed.jsonc'),
		`{ "vars": ${JSON.stringify({ ...CANONICAL_VARS, CACHE_API: 'off', FILE_STORE: 'r2' })} }`
	);
	const put = (path: string, body: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), body);
	};
	put('assets/.assetsignore', readFileSync(join(ROOT, 'assets/.assetsignore'), 'utf8'));
	for (const path of SHIPPED) put(path, `body of ${path}`);
	for (const path of WITHHELD) put(path, `withheld ${path}`);
	for (const [path, body] of Object.entries(extra)) put(path, body);
	return root;
}

describe('the box bundle name', () => {
	it('carries the version without a v, beside the payload and the managed bundle', () => {
		expect(boxBundleName('1.1.0')).toBe('drupflare-box-bundle-1.1.0.tar.gz');
	});

	it('is a name the dashboard accepts as an archive', () => {
		expect(boxBundleName('1.1.0')).toMatch(/\.(tar\.gz|tgz)$/);
	});
});

describe('reading what wrangler wrote', () => {
	it('keeps the modules and drops the source map and the readme', () => {
		const modules = readBoxModules(dryRun());
		expect([...modules.keys()].sort()).toEqual([
			'aaa-php.wasm',
			'bbb-composer.lock',
			'site.js'
		]);
	});

	it('refuses a nested folder, which the box would silently skip', () => {
		const dir = dryRun();
		mkdirSync(join(dir, 'chunks'));
		expect(() => readBoxModules(dir)).toThrow('chunks/ is nested');
	});

	it('refuses an ending the box does not load, naming the file', () => {
		const dir = dryRun({ 'ccc-data.zst': 'z' });
		expect(() => readBoxModules(dir)).toThrow(
			'ccc-data.zst has an ending the box does not load'
		);
	});
});

describe('the imports a script names', () => {
	it('reads the from and bare import forms and ignores bare packages and dynamic ones', () => {
		expect(
			importsOf(
				'import a from"./x.wasm";import"./y.js";import z from"node:fs";import("./w.js")'
			)
		).toEqual(['./x.wasm', './y.js']);
	});

	it('reads single quotes and spaces', () => {
		expect(importsOf("import a from './x.wasm'")).toEqual(['./x.wasm']);
	});
});

describe('what makes a bundle a box can run', () => {
	const modules = () => readBoxModules(dryRun());

	it('finds no problem with a complete output', () => {
		expect(boxProblems(modules(), 'site.js')).toEqual([]);
	});

	it('refuses a missing entry', () => {
		const held = modules();
		held.delete('site.js');
		expect(boxProblems(held, 'site.js')).toContain(
			'site.js is not among the modules wrangler wrote'
		);
	});

	it('refuses an entry the box could not infer, since the add names no entry', () => {
		const held = modules();
		held.set('server.js', held.get('site.js')!);
		held.delete('site.js');
		expect(boxProblems(held, 'server.js').join('\n')).toContain('not a name the box infers');
		expect(BOX_ENTRYPOINTS).toContain('site.js');
	});

	it('refuses an import with no module behind it', () => {
		const held = modules();
		held.delete('bbb-composer.lock');
		expect(boxProblems(held, 'site.js')).toEqual([
			'site.js imports ./bbb-composer.lock and the bundle has no such module'
		]);
	});

	it('refuses an import that climbs out or reaches into a folder', () => {
		const held = modules();
		held.set('site.js', enc('import a from"./sub/a.wasm";import b from"../b.wasm"'));
		expect(boxProblems(held, 'site.js')).toHaveLength(2);
	});
});

describe('the entry name', () => {
	it('is the file wrangler writes for the config main', () => {
		expect(entryOf('src/site.ts')).toBe('site.js');
		expect(entryOf('src/index.mts')).toBe('index.js');
	});
});

describe('the archive', () => {
	it('holds the modules at its root and nothing else', () => {
		const dir = dryRun();
		const archive = join(dir, 'box.tar.gz');
		packBox(dir, ['site.js', 'bbb-composer.lock', 'aaa-php.wasm'], archive);
		expect(list(archive)).toEqual(['aaa-php.wasm', 'bbb-composer.lock', 'site.js']);
	});

	it.runIf(process.platform === 'darwin')(
		'writes no AppleDouble member for a file with an extended attribute',
		() => {
			const dir = dryRun();
			execFileSync('xattr', ['-w', 'com.drupflare.test', '1', join(dir, 'site.js')]);
			const archive = join(dir, 'box.tar.gz');
			packBox(dir, ['site.js', 'bbb-composer.lock', 'aaa-php.wasm'], archive);
			expect(
				memberNames(archive).filter((name) => name.split('/').pop()!.startsWith('._'))
			).toEqual([]);
		}
	);

	it('returns the digest of the bytes it wrote', () => {
		const dir = dryRun();
		const archive = join(dir, 'box.tar.gz');
		const digest = packBox(dir, ['site.js'], archive);
		expect(digest).toBe(createHash('sha256').update(readFileSync(archive)).digest('hex'));
	});

	it('carries the assets and their manifest beside the modules, files only', () => {
		const dir = dryRun();
		const root = checkout();
		const manifest = boxAssetManifest(root, '1.1.0', boxAssetFiles(root));
		const archive = join(dir, 'box.tar.gz');
		packBox(dir, ['site.js', 'bbb-composer.lock', 'aaa-php.wasm'], archive, { root, manifest });
		expect(list(archive)).toEqual(
			['aaa-php.wasm', 'bbb-composer.lock', 'site.js', BOX_ASSETS_MANIFEST, ...SHIPPED].sort()
		);
	});

	it('holds the same bytes the manifest names, so a box that checks it passes', () => {
		const dir = dryRun();
		const root = checkout();
		const manifest = boxAssetManifest(root, '1.1.0', boxAssetFiles(root));
		const archive = join(dir, 'box.tar.gz');
		packBox(dir, ['site.js', 'bbb-composer.lock', 'aaa-php.wasm'], archive, { root, manifest });
		const out = mkdtempSync(join(tmpdir(), 'box-unpacked-'));
		execFileSync('tar', ['-xzf', archive, '-C', out]);
		const held = JSON.parse(readFileSync(join(out, BOX_ASSETS_MANIFEST), 'utf8')) as {
			files: { path: string; bytes: number; sha256: string }[];
		};
		expect(held.files).toHaveLength(SHIPPED.length);
		for (const file of held.files) {
			const bytes = readFileSync(join(out, file.path));
			expect(bytes.length).toBe(file.bytes);
			expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
		}
	});

	it('names the manifest with an ending the box loads no module from', () => {
		expect(BOX_ASSETS_MANIFEST).not.toMatch(/\.(js|mjs|wasm|json|txt|bin|lock)$/);
	});

	it('leaves no staging folder behind', () => {
		const dir = dryRun();
		const root = checkout();
		const manifest = boxAssetManifest(root, '1.1.0', boxAssetFiles(root));
		const staged = () => readdirSync(tmpdir()).filter((name) => name.startsWith('box-pack-'));
		const before = staged();
		packBox(dir, ['site.js', 'bbb-composer.lock', 'aaa-php.wasm'], join(dir, 'x.tgz'), {
			root,
			manifest
		});
		expect(staged()).toEqual(before);
	});

	it('writes a checksum line sha256sum reads back', () => {
		expect(sumsLine('ab'.repeat(32), 'x.tar.gz')).toBe(`${'ab'.repeat(32)}  x.tar.gz\n`);
	});
});

describe('the assets the box serves', () => {
	it('are the files the plan ships, and none the ignore file withholds', () => {
		const files = boxAssetFiles(checkout());
		expect(files).toEqual([...SHIPPED].sort());
		for (const path of WITHHELD) expect(files).not.toContain(path);
	});

	it('leave out the boot image, which the payload plan still ships to the edge', () => {
		const root = checkout();
		expect(boxAssetFiles(root).some((path) => path.startsWith('assets/bootimage'))).toBe(false);
		expect(BOX_WITHHELD).toEqual(['assets/bootimage']);
		expect(PAYLOAD_ASSETS.map((entry) => entry.path)).toContain('assets/bootimage');
	});

	it('refuse a tree missing a path the plan requires, naming it and what builds it', () => {
		const root = checkout();
		rmSync(join(root, 'assets/driver.json'));
		expect(() => boxAssetFiles(root)).toThrow('assets/driver.json <- bun run assets:driver');
	});

	it('refuse a plan that disagrees with the ignore file', () => {
		const root = checkout();
		writeFileSync(join(root, 'assets/.assetsignore'), '/*\n!/robots.txt\n');
		expect(() => boxAssetFiles(root)).toThrow('disagree');
	});

	it('are listed with the size and sha-256 of each file, in the payload manifest shape', () => {
		const root = checkout();
		const manifest = boxAssetManifest(root, '1.1.0', boxAssetFiles(root));
		expect(manifest).toMatchObject({
			name: 'drupflare-box-bundle',
			version: 1,
			release: '1.1.0',
			totals: { files: SHIPPED.length }
		});
		const body = 'body of assets/driver.json';
		expect(manifest.files.find((file) => file.path === 'assets/driver.json')).toEqual({
			path: 'assets/driver.json',
			bytes: body.length,
			sha256: createHash('sha256').update(body).digest('hex')
		});
		expect(manifest.totals.bytes).toBe(manifest.files.reduce((n, f) => n + f.bytes, 0));
	});

	it('refuse a path a tar list cannot carry', () => {
		const root = checkout({ 'assets/core/odd\\name.css': 'x' });
		expect(() => boxAssetManifest(root, '1.1.0', boxAssetFiles(root))).toThrow('tar list');
	});
});

describe('the vars a box binds', () => {
	it('are the canonical config vars, comments in the file allowed', () => {
		expect(boxVars(checkout(), 'wrangler.jsonc')).toEqual(CANONICAL_VARS);
	});

	it('refuse a value a box could not bind', () => {
		const root = checkout();
		writeFileSync(join(root, 'wrangler.jsonc'), '{ "vars": { "A": { "b": 1 } } }');
		expect(() => boxVars(root, 'wrangler.jsonc')).toThrow('var A is not a string');
	});

	it('refuse a config with no vars, or vars that are not an object', () => {
		const root = checkout();
		writeFileSync(join(root, 'wrangler.jsonc'), '{ "vars": [1] }');
		expect(() => boxVars(root, 'wrangler.jsonc')).toThrow('no vars block');
	});

	it('hold every var in the real config and no name only the managed config sets', () => {
		const real = boxVars(ROOT, 'wrangler.jsonc');
		const managed = Object.keys(boxVars(ROOT, 'wrangler.managed.jsonc'));
		const onlyManaged = managed.filter((name) => !(name in real));
		expect(onlyManaged.length).toBeGreaterThan(0);
		expect(Object.keys(real).length).toBeGreaterThan(0);
		expect(readJsonc(join(ROOT, 'wrangler.jsonc'))['vars']).toEqual(real);
		for (const name of onlyManaged) expect(real).not.toHaveProperty(name);
	});

	it('are written with an ending the box loads no module from', () => {
		expect(BOX_VARS_FILE).not.toMatch(/\.(js|mjs|wasm|json|txt|bin|lock)$/);
	});

	it('ride in the archive when there are no assets too', () => {
		const dir = dryRun();
		const archive = join(dir, 'box.tar.gz');
		packBox(dir, ['site.js'], archive, undefined, { A: 'b' });
		expect(list(archive)).toEqual([BOX_VARS_FILE, 'site.js']);
	});
});

describe('the command', () => {
	function run(dir: string, extra: string[] = [], root = checkout()) {
		const out = mkdtempSync(join(tmpdir(), 'box-out-'));
		const args = [
			SCRIPT,
			`--root=${root}`,
			`--outdir=${dir}`,
			`--out=${out}`,
			'--version=9.9.9',
			...extra
		];
		const result = execFileSync('bun', args, { cwd: ROOT, encoding: 'utf8' });
		return { out, result };
	}

	it('packs the output, appends the sums line below the existing ones and names the entry', () => {
		const dir = dryRun();
		const sums = join(mkdtempSync(join(tmpdir(), 'box-sums-')), 'SHA256SUMS');
		writeFileSync(sums, `${'0'.repeat(64)}  drupflare-worker-9.9.9.tar.gz\n`);
		const { out, result } = run(dir, [`--sums=${sums}`]);
		const archive = join(out, 'drupflare-box-bundle-9.9.9.tar.gz');
		const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
		expect(result).toContain('3 modules, entry site.js');
		expect(result).toContain(`${SHIPPED.length} asset files`);
		expect(readFileSync(sums, 'utf8').split('\n')).toEqual([
			`${'0'.repeat(64)}  drupflare-worker-9.9.9.tar.gz`,
			`${digest}  drupflare-box-bundle-9.9.9.tar.gz`,
			''
		]);
		expect(list(archive)).toEqual(
			[
				'aaa-php.wasm',
				'bbb-composer.lock',
				'site.js',
				BOX_ASSETS_MANIFEST,
				BOX_VARS_FILE,
				...SHIPPED
			].sort()
		);
		expect(result).toContain('4 vars');
	});

	it('writes the canonical vars into the archive and none of the managed-only ones', () => {
		const { out } = run(dryRun());
		const unpacked = mkdtempSync(join(tmpdir(), 'box-unpacked-'));
		execFileSync('tar', [
			'-xzf',
			join(out, 'drupflare-box-bundle-9.9.9.tar.gz'),
			'-C',
			unpacked
		]);
		const held = JSON.parse(readFileSync(join(unpacked, BOX_VARS_FILE), 'utf8'));
		expect(held).toEqual(CANONICAL_VARS);
		expect(held).not.toHaveProperty('CACHE_API');
		expect(held).not.toHaveProperty('FILE_STORE');
	});

	it('writes no archive when the config has no vars block', () => {
		const root = checkout();
		writeFileSync(join(root, 'wrangler.jsonc'), '{ "main": "src/site.ts" }');
		refused(dryRun(), root, /no vars block/);
	});

	function refused(dir: string, root: string, pattern: RegExp) {
		const sums = join(mkdtempSync(join(tmpdir(), 'box-sums-')), 'SHA256SUMS');
		writeFileSync(sums, '');
		const out = mkdtempSync(join(tmpdir(), 'box-out-'));
		expect(() =>
			execFileSync(
				'bun',
				[
					SCRIPT,
					`--root=${root}`,
					`--outdir=${dir}`,
					`--out=${out}`,
					'--version=9.9.9',
					`--sums=${sums}`
				],
				{ cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }
			)
		).toThrow(pattern);
		expect(readFileSync(sums, 'utf8')).toBe('');
		expect(() => readFileSync(join(out, 'drupflare-box-bundle-9.9.9.tar.gz'))).toThrow();
	}

	it('writes no archive and no sums line for a bundle a box could not run', () => {
		refused(
			dryRun({ 'site.js': 'import a from"./gone.wasm"' }),
			checkout(),
			/imports \.\/gone\.wasm/
		);
	});

	it('writes no archive and no sums line when the asset tree is incomplete', () => {
		const root = checkout();
		rmSync(join(root, 'assets/drupal-pf/core.pf.bin'));
		refused(dryRun(), root, /assets\/drupal-pf\/core\.pf\.bin/);
	});

	it('names a missing flag', () => {
		expect(() =>
			execFileSync('bun', [SCRIPT, '--out=/tmp/x', '--version=1'], {
				cwd: ROOT,
				encoding: 'utf8',
				stdio: 'pipe'
			})
		).toThrow('--outdir= is required');
	});
});
