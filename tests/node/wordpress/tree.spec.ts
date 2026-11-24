import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
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
} from '../../../scripts/fetch/wordpress-tree';

/**
 * `wordpress-src/` is the WordPress tree the WordPress artifact is built from, pinned the way
 * `drupal-src/` is.
 *
 * Node lane and hermetic: nothing here touches the network. The download is the one step that
 * cannot be checked offline, so the digest check and the replace guard are the pure functions
 * tested below.
 */

const ROOT = join(import.meta.dirname, '../../..');
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
		expect(PKG.scripts['fetch:wordpress']).toBe('bun scripts/fetch/wordpress-tree.ts');
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
		const { isPackedFile } = await import('../../../scripts/pack/wordpress');
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
		const { listPackedFiles } = await import('../../../scripts/pack/wordpress');
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
		const { isPackedFile } = await import('../../../scripts/pack/wordpress');
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

	// the request fragment points the one is_uploaded_file() call at a function that accepts the
	// uploads it parsed; a release with a second call or none must fail here, not on an upload
	it('finds exactly one is_uploaded_file() call in the upload handler', (ctx) => {
		let text: string;
		try {
			text = read('wordpress-src/wp-admin/includes/file.php');
		} catch {
			return ctx.skip();
		}
		expect(text.split('is_uploaded_file(').length - 1).toBe(1);
	});

	// the fragment turns the exit that ends a plugin's settings page into a stop; a release that
	// changes that ending must fail here, not when someone opens a plugin's settings
	it('finds exactly one exit after the footer of a plugin page in admin.php', (ctx) => {
		let text: string;
		try {
			text = read('wordpress-src/wp-admin/admin.php');
		} catch {
			return ctx.skip();
		}
		const needle =
			"require_once ABSPATH . 'wp-admin/admin-footer.php';\n\n\texit;\n} elseif ( isset( $_GET['import'] ) ) {";
		expect(text.split(needle).length - 1).toBe(1);
	});

	it('keeps the test switch out of the shipping config and the KV allow-list', async () => {
		const { KV_OVERRIDABLE } = await import('../../../src/ops/plan');
		expect(read('wrangler.jsonc')).not.toContain('WORDPRESS_PAGE_CACHE');
		expect(read('package.json')).not.toContain('WORDPRESS_PAGE_CACHE');
		expect(KV_OVERRIDABLE as readonly string[]).not.toContain('WORDPRESS_PAGE_CACHE');
	});
});

describe('the browser files a WordPress site publishes', () => {
	const set = (...rels: string[]) => new Set(rels);

	it('publishes the minified file and drops the plain one beside it', async () => {
		const { isPublishedFile } = await import('../../../scripts/pack/wordpress');
		const files = set(
			'wp-includes/js/dist/a11y.js',
			'wp-includes/js/dist/a11y.min.js',
			'wp-admin/css/common.css',
			'wp-admin/css/common.min.css',
			'wp-includes/js/only-plain.js'
		);
		expect(isPublishedFile('wp-includes/js/dist/a11y.min.js', files)).toBe(true);
		expect(isPublishedFile('wp-includes/js/dist/a11y.js', files)).toBe(false);
		expect(isPublishedFile('wp-admin/css/common.css', files)).toBe(false);
		expect(isPublishedFile('wp-includes/js/only-plain.js', files)).toBe(true);
	});

	it('keeps a plain file that core PHP names outright, which a browser fetched and got a 404 for', async () => {
		const { isPublishedFile, namedAssets } = await import('../../../scripts/pack/wordpress');
		const root = tempDir('cfw-wp-named-');
		mkdirSync(join(root, 'wp-includes'), { recursive: true });
		writeFileSync(
			join(root, 'wp-includes/script-loader.php'),
			"$scripts->add( 'wp-tooltip', '/wp-includes/js/wp-tooltip.js', array() );"
		);
		const named = namedAssets(root, ['wp-includes/script-loader.php']);
		expect([...named]).toEqual(['wp-includes/js/wp-tooltip.js']);
		const files = set('wp-includes/js/wp-tooltip.js', 'wp-includes/js/wp-tooltip.min.js');
		expect(isPublishedFile('wp-includes/js/wp-tooltip.js', files, undefined, named)).toBe(true);
		expect(isPublishedFile('wp-includes/js/wp-tooltip.js', files)).toBe(false);
	});

	it('leaves out PHP, right-to-left sheets, source files and every theme but the published ones', async () => {
		const { isPublishedFile } = await import('../../../scripts/pack/wordpress');
		const none = set();
		for (const rel of [
			'wp-includes/version.php',
			'wp-admin/css/common-rtl.min.css',
			'wp-includes/js/tinymce/license.txt',
			'wp-admin/css/colors/_admin.scss',
			'wp-content/themes/twentytwentyfour/assets/fonts/a.woff2',
			'wp-content/uploads/2026/01/a.png',
			'wp-content/themes/twentytwentyfive/theme.json',
			'readme.html'
		]) {
			expect(isPublishedFile(rel, none), rel).toBe(false);
		}
		expect(
			isPublishedFile('wp-content/themes/twentytwentyfive/assets/fonts/a.woff2', none)
		).toBe(true);
		expect(
			isPublishedFile('wp-content/themes/twentytwentyfour/assets/fonts/a.woff2', none, 'all')
		).toBe(true);
	});

	it('names no path in two header rules, because the platform joins the headers of every match', async () => {
		const { headersFor } = await import('../../../scripts/pack/wordpress');
		const text = headersFor([
			'wp-includes/js/a.min.js',
			'wp-includes/css/a.min.css',
			'wp-includes/images/a.png',
			'wp-admin/js/b.min.js',
			'wp-content/themes/twentytwentyfive/assets/fonts/a.woff2'
		]);
		const patterns = text.split('\n').filter((l) => l.startsWith('/'));
		expect(new Set(patterns).size).toBe(patterns.length);
		expect(text).toContain(
			'/wp-includes/*.js\n  Cache-Control: public, max-age=31536000, immutable'
		);
		expect(text).toContain('/wp-includes/*.png\n  Cache-Control: public, max-age=31536000\n');
		expect(text).not.toContain(
			'/wp-includes/*.png\n  Cache-Control: public, max-age=31536000, immutable'
		);
	});

	it('writes the directory, copies the pack, prunes a stale file and refuses a foreign one', async () => {
		const { writeSite } = await import('../../../scripts/pack/wordpress');
		const root = tempDir('cfw-wp-site-src-');
		const out = tempDir('cfw-wp-site-out-');
		const pack = tempDir('cfw-wp-site-pack-');
		for (const rel of [
			'wp-includes/css/a.min.css',
			'wp-includes/css/a.css',
			'wp-includes/x.php'
		]) {
			mkdirSync(join(root, rel, '..'), { recursive: true });
			writeFileSync(join(root, rel), 'body{}');
		}
		mkdirSync(join(pack, 'sql'), { recursive: true });
		writeFileSync(join(pack, 'driver.json'), '{}');
		writeFileSync(join(pack, 'sql/0000.json'), '[]');

		mkdirSync(join(out, 'wp-includes/old'), { recursive: true });
		writeFileSync(join(out, 'wp-includes/old/stale.css'), 'x');
		const written = writeSite(root, out, pack);

		expect(written.files.map((f) => f.path)).toEqual(['wp-includes/css/a.min.css']);
		expect(existsSync(join(out, 'wp-includes/old'))).toBe(false);
		expect(existsSync(join(out, 'wordpress/sql/0000.json'))).toBe(true);
		expect(readFileSync(join(out, '_headers'), 'utf8')).toContain('/wp-includes/*.css');
		expect(existsSync(join(out, 'robots.txt'))).toBe(false);

		writeFileSync(join(out, 'robots.txt'), 'User-agent: *');
		expect(() => writeSite(root, out, pack)).toThrow(/robots\.txt/);
	});

	it('fits the platform limits for the shipped tree, and a file over the per-file limit fails', async () => {
		const { assetFit, listPublishedFiles } = await import('../../../scripts/pack/wordpress');
		const over = assetFit([{ path: 'a.js', bytes: 26 * 1024 * 1024 }]);
		expect(over.problems.join(' ')).toContain('a.js');
		if (!existsSync(join(ROOT, 'wordpress-src/wp-includes'))) return;
		const list = listPublishedFiles(join(ROOT, 'wordpress-src'));
		const fit = assetFit(
			list.map((p) => ({
				path: p,
				bytes: readFileSync(join(ROOT, 'wordpress-src', p)).length
			}))
		);
		expect(fit.problems).toEqual([]);
	});

	it('never lists the Drupal crawler file or a favicon, so WordPress answers both itself', async () => {
		const { listPublishedFiles } = await import('../../../scripts/pack/wordpress');
		if (!existsSync(join(ROOT, 'wordpress-src/wp-includes'))) return;
		const list = listPublishedFiles(join(ROOT, 'wordpress-src'));
		expect(list).not.toContain('robots.txt');
		expect(
			list.filter((p) => /(^|\/)(robots\.txt|favicon\.ico|apple-touch-icon.*)$/.test(p))
		).toEqual([]);
	});

	it('is current: every file the tree publishes is in assets/wordpress-site, byte for byte', async () => {
		const { digest, listPublishedFiles, SITE_DIR } =
			await import('../../../scripts/pack/wordpress');
		const src = join(ROOT, 'wordpress-src');
		const site = join(ROOT, SITE_DIR);
		if (!existsSync(join(src, 'wp-includes')) || !existsSync(site)) return;
		const stale: string[] = [];
		for (const rel of listPublishedFiles(src)) {
			const copy = join(site, rel);
			if (!existsSync(copy) || digest(copy) !== digest(join(src, rel))) {
				stale.push(rel);
			}
		}
		expect(stale).toEqual([]);
		// and nothing extra sits beside them
		const wanted = new Set(listPublishedFiles(src));
		const extra: string[] = [];
		const walkSite = (dir: string, base: string): void => {
			for (const e of readdirSync(join(site, dir), { withFileTypes: true })) {
				const rel = dir === '' ? e.name : `${dir}/${e.name}`;
				if (e.isDirectory()) walkSite(rel, base);
				else if (/^wp-(includes|admin|content)\//.test(rel) && !wanted.has(rel))
					extra.push(rel);
			}
		};
		walkSite('', site);
		expect(extra).toEqual([]);
	});

	it('is not served by the Drupal asset directory', () => {
		const ignore = readFileSync(join(ROOT, 'assets/.assetsignore'), 'utf8');
		const rules = ignore.split('\n').filter((l) => l.startsWith('!'));
		expect(rules.filter((l) => /wordpress-site|\/wp-/.test(l))).toEqual([]);
		expect(readFileSync(join(ROOT, 'assets/_headers'), 'utf8')).not.toContain('/wp-');
	});
});
