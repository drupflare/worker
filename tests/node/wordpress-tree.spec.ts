import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	countFiles,
	LOCK_PATH,
	MANIFEST_NAME,
	parseLock,
	planExtract,
	treeManifest,
	verifyDigest,
	type WordpressLock
} from '../../scripts/fetch-wordpress-tree';

/**
 * `wordpress-src/` is the WordPress tree the WordPress artifact is built from, pinned the way
 * `drupal-src/` is.
 *
 * Node lane and hermetic: nothing here touches the network. The download is the one step that
 * cannot be checked offline, so the digest check and the replace guard are the pure functions
 * tested below.
 */

const ROOT = join(import.meta.dirname, '../..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
	scripts: Record<string, string>;
};
const GITIGNORE = readFileSync(join(ROOT, '.gitignore'), 'utf8');

const SHA = 'db96f5eaa77a8d3e8eec8923a518fa2326f0d46a';
const DIGEST = '050814351b0dd7c57a6753e1f02d56774349cfcaa55dc5164583f67b316d705c';

const temps: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function lock(over: Partial<WordpressLock> = {}): WordpressLock {
	return {
		tag: '7.1.4',
		sha: SHA,
		tarball: `https://codeload.github.com/WordPress/WordPress/tar.gz/${SHA}`,
		sha256: DIGEST,
		...over
	};
}

describe('the lock names one WordPress release by tag, commit and tarball digest', () => {
	it('parses the shipped lock', () => {
		const shipped = parseLock(JSON.parse(readFileSync(join(ROOT, LOCK_PATH), 'utf8')));
		expect(shipped.tag).toBe('7.1.4');
		expect(shipped.sha).toBe(SHA);
		expect(shipped.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses a commit that is not a full 40-character SHA', () => {
		expect(() => parseLock(lock({ sha: SHA.slice(0, 12) }))).toThrow(/sha/);
	});

	it('refuses a tag that is not a plain version', () => {
		expect(() => parseLock(lock({ tag: 'v7.1.4' }))).toThrow(/tag/);
	});

	it('refuses a tarball that is not fetched over https', () => {
		expect(() => parseLock(lock({ tarball: `http://example.invalid/${SHA}` }))).toThrow(
			/tarball/
		);
	});

	it('accepts an empty digest, which means the tarball is not pinned yet', () => {
		expect(parseLock(lock({ sha256: '' })).sha256).toBe('');
	});

	it('refuses a digest that is not 64 hex characters', () => {
		expect(() => parseLock(lock({ sha256: DIGEST.slice(0, 63) }))).toThrow(/sha256/);
	});
});

describe('the tarball is unpacked only when its digest is the one the lock records', () => {
	it('passes when the bytes hash to the recorded digest', () => {
		expect(() => verifyDigest(lock(), DIGEST)).not.toThrow();
	});

	it('refuses a tarball whose digest differs, and names both', () => {
		const other = 'f'.repeat(64);
		expect(() => verifyDigest(lock(), other)).toThrow(other);
		expect(() => verifyDigest(lock(), other)).toThrow(DIGEST);
	});

	it('refuses an unpinned lock and prints the digest it would need to record', () => {
		// the first run after a bump has nothing to compare with; it must say what to record and
		// must not write the lock itself
		const unpinned = lock({ sha256: '' });
		expect(() => verifyDigest(unpinned, DIGEST)).toThrow(DIGEST);
		expect(() => verifyDigest(unpinned, DIGEST)).toThrow(LOCK_PATH);
	});
});

describe('an existing tree is replaced only with --force', () => {
	it('extracts into an empty checkout', () => {
		expect(planExtract(false, undefined, SHA, false)).toBe('extract');
	});

	it('leaves a tree that already holds the pinned commit alone', () => {
		expect(planExtract(true, SHA, SHA, false)).toBe('already-present');
	});

	it('refuses to replace a tree at a different commit without --force', () => {
		expect(() => planExtract(true, 'a'.repeat(40), SHA, false)).toThrow(/--force/);
	});

	it('replaces a tree at a different commit with --force', () => {
		expect(planExtract(true, 'a'.repeat(40), SHA, true)).toBe('extract');
	});

	it('refuses a directory it cannot identify, unless --force', () => {
		// a tree with no manifest was not written by this script and may be anything
		expect(() => planExtract(true, undefined, SHA, false)).toThrow(/--force/);
		expect(planExtract(true, undefined, SHA, true)).toBe('extract');
	});
});

describe('the manifest records what was fetched', () => {
	it('names the tag, commit, tarball, digest and file count, and nothing else', () => {
		const m = treeManifest(lock(), 5008);
		expect(Object.keys(m).sort()).toEqual(['files', 'sha', 'sha256', 'tag', 'tarball']);
		expect(m).toEqual({
			tag: '7.1.4',
			sha: SHA,
			tarball: lock().tarball,
			sha256: DIGEST,
			files: 5008
		});
	});

	it('counts regular files at every depth', () => {
		const dir = tempDir('cfw-wp-count-');
		mkdirSync(join(dir, 'wp-content/themes/a'), { recursive: true });
		writeFileSync(join(dir, 'index.php'), '<?php');
		writeFileSync(join(dir, 'wp-content/themes/a/style.css'), 'a{}');
		writeFileSync(join(dir, 'wp-content/themes/a/functions.php'), '<?php');
		expect(countFiles(dir)).toBe(3);
	});
});

describe('the fetch is wired like the Drupal one', () => {
	it('is a package.json script', () => {
		expect(PKG.scripts['fetch:wordpress']).toBe('bun scripts/fetch-wordpress-tree.ts');
	});

	it('gitignores the tree beside drupal-src', () => {
		expect(GITIGNORE.split('\n')).toContain('wordpress-src');
	});

	it('writes its manifest under the name the tree expects', () => {
		expect(MANIFEST_NAME).toBe('.fetched.json');
	});
});

describe('the packed tree is every PHP file plus the non-PHP files PHP reads', () => {
	it('keeps PHP and the data PHP opens, and leaves the browser-only files out', async () => {
		const { isPackedFile } = await import('../../scripts/pack-wordpress');
		const kept = [
			'wp-settings.php',
			'wp-includes/version.php',
			'wp-includes/theme.json',
			'wp-includes/blocks/paragraph/block.json',
			'wp-includes/blocks/paragraph/style.min.css',
			'wp-includes/css/wp-block-template-skip-link.min.css',
			'wp-includes/js/wp-emoji-loader.min.js',
			'wp-content/themes/twentytwentyfive/theme.json',
			'wp-content/themes/twentytwentyfive/style.css',
			'wp-content/themes/twentytwentyfive/style.min.css',
			'wp-content/themes/twentytwentyfive/templates/index.html',
			'wp-admin/css/view-transitions.min.css'
		];
		const left = [
			'wp-includes/js/dist/block-editor.js',
			'wp-includes/js/dist/vips/worker.js',
			'wp-includes/js/jquery/jquery.js',
			'wp-includes/js/tinymce/tinymce.json',
			'wp-admin/css/common.css',
			'wp-admin/images/wordpress-logo.svg',
			'wp-content/themes/twentytwentyfive/assets/fonts/literata/a.woff2',
			'wp-content/themes/twentytwentyfive/assets/css/editor.css',
			'wp-content/themes/twentytwentyfive/assets/images/a.webp',
			'license.txt',
			'readme.html'
		];
		for (const rel of kept) expect(isPackedFile(rel), rel).toBe(true);
		for (const rel of left) expect(isPackedFile(rel), rel).toBe(false);
	});

	it('lists a tree sorted, without the fetch manifest, and nothing outside the rule', async () => {
		const { listPackedFiles } = await import('../../scripts/pack-wordpress');
		const dir = mkdtempSync(join(tmpdir(), 'wp-pack-list-'));
		temps.push(dir);
		for (const rel of [
			'wp-load.php',
			'wp-includes/b.php',
			'wp-includes/a.php',
			'wp-includes/js/x.js',
			'wp-includes/theme.json',
			'.fetched.json'
		]) {
			mkdirSync(join(dir, rel, '..'), { recursive: true });
			writeFileSync(join(dir, rel), 'x');
		}
		expect(listPackedFiles(dir).map((e) => e.p)).toEqual([
			'wp-includes/a.php',
			'wp-includes/b.php',
			'wp-includes/theme.json',
			'wp-load.php'
		]);
	});

	it('is a control: a rule that took every file would pack the scripts and the fonts', async () => {
		const { isPackedFile } = await import('../../scripts/pack-wordpress');
		const everything = (rel: string) => rel.length > 0;
		expect(everything('wp-includes/js/jquery/jquery.js')).toBe(true);
		expect(isPackedFile('wp-includes/js/jquery/jquery.js')).toBe(false);
	});
});

describe('what the request fragment relies on in the pinned tree', () => {
	const read = (path: string) => readFileSync(path, 'utf8');
	const cron = (): string | undefined => {
		try {
			return read('wordpress-src/wp-cron.php');
		} catch {
			return undefined;
		}
	};

	// the fragment turns each die() of wp-cron.php into a stop and each __DIR__ into the mount root;
	// a release that adds an ending or another __DIR__ must fail here, not at run time
	it('finds exactly the three die() calls and the one __DIR__ the cron fragment rewrites', (ctx) => {
		const text = cron();
		if (text === undefined) return ctx.skip();
		expect(text.split('die();').length - 1).toBe(3);
		expect(text.split('__DIR__').length - 1).toBe(1);
		expect(/\bexit\b/.test(text.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
	});

	it('keeps the test switch out of the shipping config and the KV allow-list', async () => {
		const { KV_OVERRIDABLE } = await import('../../src/ops/plan');
		expect(read('wrangler.jsonc')).not.toContain('WORDPRESS_PAGE_CACHE');
		expect(read('package.json')).not.toContain('WORDPRESS_PAGE_CACHE');
		expect(KV_OVERRIDABLE as readonly string[]).not.toContain('WORDPRESS_PAGE_CACHE');
	});
});
