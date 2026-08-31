import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const PACKER = join(ROOT, 'scripts/pack-drupal.ts');

/** every fixture file as [path, contents, mtime in whole seconds] */
const FIXTURE: [string, string, number][] = [
	['index.php', "<?php\nrequire 'core/includes/bootstrap.inc';\n", 1700000001],
	['composer.lock', '{"packages":[]}\n', 1700000002],
	['tests/fixture.yml', 'name: fixture\n', 1700000003],
	[
		'core/core.services.yml',
		'services:\n  renderer:\n    class: Drupal\\Core\\Render\\Renderer\n',
		1700000010
	],
	['core/includes/bootstrap.inc', '<?php\nfunction drupal_bootstrap() {}\n', 1700000011],
	['core/includes/install.inc', '<?php\nfunction install_drupal() {}\n', 1700000012],
	[
		'core/lib/Drupal/Core/Render/Renderer.php',
		'<?php\nnamespace Drupal\\Core\\Render;\nclass Renderer {}\n',
		1700000020
	],
	[
		'core/lib/Drupal/Core/Http/RequestException.php',
		'<?php\nnamespace Drupal\\Core\\Http;\nclass RequestException extends \\Exception {}\n',
		1700000021
	],
	[
		'core/modules/system/system.info.yml',
		'name: System\ntype: module\ncore_version_requirement: ^11\n',
		1700000030
	],
	[
		'core/modules/system/system.module',
		'<?php\nfunction system_theme() { return []; }\n',
		1700000031
	],
	[
		'core/modules/system/src/SystemManager.php',
		'<?php\nnamespace Drupal\\system;\nclass SystemManager {}\n',
		1700000032
	],
	[
		'core/modules/system/src/Exception/SystemException.php',
		'<?php\nnamespace Drupal\\system\\Exception;\nclass SystemException extends \\RuntimeException {}\n',
		1700000033
	],
	['core/modules/system/templates/page.html.twig', '<div>{{ page.content }}</div>\n', 1700000034],
	['core/modules/system/css/system.css', '.system { color: red; }\n', 1700000035],
	[
		'core/modules/system/tests/src/Kernel/SystemTest.php',
		'<?php\nclass SystemTest {}\n',
		1700000036
	],
	['core/themes/claro/claro.info.yml', 'name: Claro\ntype: theme\n', 1700000040],
	['core/themes/claro/images/hamburger.svg', '<svg viewBox="0 0 16 16"></svg>\n', 1700000041],
	[
		'vendor/symfony/http-kernel/HttpKernel.php',
		'<?php\nnamespace Symfony\\Component\\HttpKernel;\nclass HttpKernel {}\n',
		1700000050
	],
	[
		'vendor/symfony/http-kernel/Exception/NotFoundHttpException.php',
		'<?php\nnamespace Symfony\\Component\\HttpKernel\\Exception;\nclass NotFoundHttpException extends \\Exception {}\n',
		1700000051
	],
	['vendor/symfony/http-kernel/composer.json', '{"name":"symfony/http-kernel"}\n', 1700000052],
	['vendor/symfony/http-kernel/README.md', '# HttpKernel\n', 1700000053],
	[
		'vendor/symfony/polyfill-mbstring/bootstrap.php',
		'<?php\nfunction mb_strlen($s) { return strlen($s); }\n',
		1700000060
	],
	[
		'vendor/symfony/polyfill-mbstring/Mbstring.php',
		'<?php\nnamespace Symfony\\Polyfill\\Mbstring;\nclass Mbstring {}\n',
		1700000061
	],
	[
		'vendor/doctrine/lexer/src/Lexer.php',
		'<?php\nnamespace Doctrine\\Common\\Lexer;\nclass Lexer {}\n',
		1700000070
	],
	['vendor/doctrine/lexer/Tests/LexerTest.php', '<?php\nclass LexerTest {}\n', 1700000071],
	['sites/default/settings.php', '<?php\n$databases = [];\n', 1700000080],
	['sites/default/files/.sqlite', 'SQLite format 3\0', 1700000081],
	['sites/default/files/php/twig/abc/page.html.twig', '<div>compiled</div>\n', 1700000082]
];

/**
 * A trace-shaped list, keyed `path`.
 *
 * Two entries earn their place beyond the completion rules: an absolute path, which the packer
 * drops because a profile records the host's own prepend files, and a path that does not exist,
 * which is what `missing` counts.
 */
const PROFILE = [
	{ path: 'core/includes/bootstrap.inc' },
	{ path: 'core/lib/Drupal/Core/Render/Renderer.php' },
	{ path: 'core/modules/system/system.module' },
	{ path: 'vendor/symfony/http-kernel/HttpKernel.php' },
	{ path: 'vendor/nonexistent/gone/Missing.php' },
	{ path: '/usr/local/lib/php/prepend.php' }
];

/** a pack-index-shaped list, keyed `p`, which is what `assets:core` feeds the packer */
const INDEX_LIST = [
	{ p: 'core/modules/system/system.module', o: 0, l: 1, m: 1 },
	{ p: 'core/themes/claro/claro.info.yml', o: 1, l: 1, m: 1 },
	{ p: 'vendor/doctrine/lexer/src/Lexer.php', o: 2, l: 1, m: 1 },
	{ p: 'sites/default/files/.sqlite', o: 3, l: 1, m: 1 },
	{ p: 'vendor/nonexistent/gone/Missing.php', o: 4, l: 1, m: 1 },
	{ p: '/usr/local/lib/php/prepend.php', o: 5, l: 1, m: 1 }
];

type IndexEntry = { p: string; o: number; l: number; m: number };
type Pack = { index: IndexEntry[]; bin: Buffer; gz: Buffer; json: Buffer; summary: Summary };
type Summary = {
	files: number;
	missing: number;
	rawBytes: number;
	rawMb: number;
	gzipBytes: number;
	gzipMb: number;
	indexBytes: number;
};

const BODIES = new Map(FIXTURE.map(([p, body]) => [p, Buffer.from(body, 'utf8')]));
const MTIMES = new Map(FIXTURE.map(([p, , m]) => [p, m * 1000]));

let dir = '';

async function buildTree(): Promise<void> {
	for (const [rel, body, mtime] of FIXTURE) {
		const abs = join(dir, 'tree', rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, body);
		// whole seconds so mtimeMs has no sub-millisecond tail to round; the packer floors it
		await utimes(abs, mtime, mtime);
	}
	await writeFile(join(dir, 'profile.json'), JSON.stringify(PROFILE));
	await writeFile(join(dir, 'index.json'), JSON.stringify(INDEX_LIST));
}

/**
 * Runs the packer in one mode and reads back all three artifacts.
 *
 * The out-dir is absolute: a relative one resolves under the repo's own `assets/`,
 * which the rest of the suite reads.
 */
async function pack(
	name: string,
	listFile: string,
	env: Record<string, string>,
	root = join(dir, 'tree')
): Promise<Pack & { stderr: string }> {
	const out = join(dir, `out-${name}`);
	const childEnv = { ...process.env };
	for (const k of ['PACK_INDEX', 'FULL', 'TRACE', 'COMPLETE_CORE']) delete childEnv[k];
	const r = spawnSync('node', [PACKER, root, join(dir, listFile), out], {
		cwd: ROOT,
		encoding: 'utf8',
		env: { ...childEnv, ...env },
		timeout: 120_000
	});
	if (r.status !== 0) throw new Error(`pack ${name} exited ${r.status}: ${r.stderr}`);
	// workers-types shadows the node Buffer globals, so readFile lands as a bare Uint8Array
	const json = Buffer.from(await readFile(join(out, 'core.json')));
	return {
		index: JSON.parse(json.toString('utf8')) as IndexEntry[],
		bin: existsSync(join(out, 'core.bin'))
			? Buffer.from(await readFile(join(out, 'core.bin')))
			: Buffer.alloc(0),
		gz: Buffer.from(await readFile(join(out, 'core.bin.gz'))),
		json,
		summary: JSON.parse(r.stdout) as Summary,
		stderr: r.stderr.trim()
	};
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const packs: Record<string, Pack & { stderr: string }> = {};

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'cfw-pack-drupal-'));
	await buildTree();
	packs.default = await pack('default', 'profile.json', {});
	packs.index = await pack('index', 'index.json', { PACK_INDEX: '1' });
	packs.full = await pack('full', 'profile.json', { FULL: '1' });
	packs.trace = await pack('trace', 'profile.json', { TRACE: '1' });
	packs.core = await pack('core', 'profile.json', { COMPLETE_CORE: '1' });
}, 120_000);

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

/** every invariant that holds in every mode, so a mode-specific test only carries its own claim */
function assertWellFormed(pack: Pack): void {
	let offset = 0;
	const parts: Buffer[] = [];
	for (const e of pack.index) {
		const body = BODIES.get(e.p);
		expect(body, `${e.p} is not a fixture file`).toBeDefined();
		expect(e.l).toBe(body!.length);
		// mtime is load-bearing: MTimeProtectedFastFileStorage hashes filemtime() into the
		// compiled-Twig directory name, so a packer reporting write-time recompiles every boot
		expect(e.m).toBe(MTIMES.get(e.p));
		expect(e.o).toBe(offset);
		offset += e.l;
		parts.push(body!);
	}
	expect(pack.bin).toEqual(Buffer.concat(parts));
	expect(pack.gz).toEqual(gzipSync(pack.bin, { level: 9 }));
	expect(pack.summary.files).toBe(pack.index.length);
	expect(pack.summary.rawBytes).toBe(pack.bin.length);
	expect(pack.summary.gzipBytes).toBe(pack.gz.length);
	expect(pack.summary.indexBytes).toBe(pack.json.length);
	expect(Object.keys(pack.index[0]!)).toEqual(['p', 'o', 'l', 'm']);
}

describe('the profiled default path', () => {
	it('packs the byte-identical set pack-drupal.mjs packed', () => {
		expect(sha(packs.default!.json)).toBe(
			'0729d0b3bac1f922ceb15150abc8873b95276198d218ed13b4935b5ddec4dbdb'
		);
		expect(packs.default!.summary).toEqual({
			files: 17,
			missing: 2,
			rawBytes: 897,
			rawMb: 0,
			gzipBytes: 394,
			gzipMb: 0,
			indexBytes: 1355
		});
		assertWellFormed(packs.default!);
	});

	it('names the profiled count, the unit count and the file count on stderr', () => {
		expect(packs.default!.stderr).toBe('profiled 5 -> 2 units -> 19 files');
	});

	it('expands every completion rule the comments claim it does', () => {
		const got = packs.default!.index.map((e) => e.p);
		expect(got).toEqual([
			// the blanket yml/twig sweep, which a profile structurally cannot see
			'core/core.services.yml',
			'core/includes/bootstrap.inc',
			// core/includes, conditionally loaded by module_load_include
			'core/includes/install.inc',
			// core/**/*Exception.php
			'core/lib/Drupal/Core/Http/RequestException.php',
			'core/lib/Drupal/Core/Render/Renderer.php',
			// core/**/Exception/*.php
			'core/modules/system/src/Exception/SystemException.php',
			'core/modules/system/system.info.yml',
			'core/modules/system/system.module',
			'core/modules/system/templates/page.html.twig',
			// *.info.yml, which ExtensionDiscovery needs without ever opening
			'core/themes/claro/claro.info.yml',
			// a root-level tests/ dir is filtered only under FULL=1, so this ships here
			'tests/fixture.yml',
			// vendor wholesale, the doctrine/lexer case: never traced, still packed
			'vendor/doctrine/lexer/src/Lexer.php',
			// package-level completion off one traced file
			'vendor/symfony/http-kernel/Exception/NotFoundHttpException.php',
			'vendor/symfony/http-kernel/HttpKernel.php',
			'vendor/symfony/http-kernel/composer.json',
			// the polyfills, which the profile never saw because the host had intl/mbstring
			'vendor/symfony/polyfill-mbstring/Mbstring.php',
			'vendor/symfony/polyfill-mbstring/bootstrap.php'
		]);
	});

	it('excludes sites/default/files, test dirs and the SKIP extensions', () => {
		const got = packs.default!.index.map((e) => e.p);
		// the database is mounted separately; packing it would duplicate 6.5 MB
		expect(got.some((p) => p.startsWith('sites/default/files/'))).toBe(false);
		expect(got).not.toContain('core/modules/system/tests/src/Kernel/SystemTest.php');
		expect(got).not.toContain('vendor/doctrine/lexer/Tests/LexerTest.php');
		expect(got).not.toContain('core/modules/system/css/system.css');
		expect(got).not.toContain('vendor/symfony/http-kernel/README.md');
		// .lock and .dist are SKIPped here and NOT under FULL=1
		expect(got).not.toContain('composer.lock');
	});

	it('counts an unreadable path as missing rather than failing', () => {
		// two of them: the nonexistent file in the list, and the Exception/ directory the
		// `**/*` completion glob yields alongside its files
		expect(packs.default!.summary.missing).toBe(2);
	});
});

describe('PACK_INDEX=1 takes the list verbatim', () => {
	it('packs the byte-identical set pack-drupal.mjs packed', () => {
		expect(sha(packs.index!.json)).toBe(
			'1471b703fb9dba2906248a713ef324eff50dab418e2b92e9842a6d98a361730e'
		);
		expect(packs.index!.summary).toEqual({
			files: 4,
			missing: 1,
			rawBytes: 139,
			rawMb: 0,
			gzipBytes: 138,
			gzipMb: 0,
			indexBytes: 292
		});
		assertWellFormed(packs.index!);
	});

	it('runs no completion rule and keeps the list order', () => {
		// the contrib count is reported even at zero, because a silent 0 and a rule that never ran
		// look identical from outside and one of them is a packing bug
		expect(packs.index!.stderr).toBe(
			'index-driven: 5 files + 0 contrib, no other completion rules'
		);
		expect(packs.index!.index.map((e) => e.p)).toEqual([
			'core/modules/system/system.module',
			'core/themes/claro/claro.info.yml',
			'vendor/doctrine/lexer/src/Lexer.php',
			// a pinned list overrides the sites/default/files exclusion, which only the
			// completion branch applies
			'sites/default/files/.sqlite'
		]);
	});

	it('reads `p` where a trace writes `path`, so either shape seeds a rebuild', () => {
		// the whole list is `p`-keyed; four of six survived, so the key was understood
		expect(packs.index!.summary.files + packs.index!.summary.missing).toBe(5);
	});
});

describe('FULL=1 packs the tree instead of the profile', () => {
	it('packs the byte-identical set pack-drupal.mjs packed', () => {
		// asserted as a set, not a digest: the file order comes from readdir, and ext4 seeds its
		// directory hash per-filesystem, so an ordered digest would pass here and fail on CI
		expect([...packs.full!.index].map((e) => e.p).sort()).toEqual([
			'composer.lock',
			'core/core.services.yml',
			'core/includes/bootstrap.inc',
			'core/includes/install.inc',
			'core/lib/Drupal/Core/Http/RequestException.php',
			'core/lib/Drupal/Core/Render/Renderer.php',
			'core/modules/system/src/Exception/SystemException.php',
			'core/modules/system/src/SystemManager.php',
			'core/modules/system/system.info.yml',
			'core/modules/system/system.module',
			'core/modules/system/templates/page.html.twig',
			'core/themes/claro/claro.info.yml',
			// .svg is NOT skipped: Claro inlines SVGs through Twig, and excluding them broke
			// every admin page with a LoaderError
			'core/themes/claro/images/hamburger.svg',
			'index.php',
			'sites/default/files/php/twig/abc/page.html.twig',
			'sites/default/settings.php',
			'vendor/doctrine/lexer/src/Lexer.php',
			'vendor/symfony/http-kernel/Exception/NotFoundHttpException.php',
			'vendor/symfony/http-kernel/HttpKernel.php',
			'vendor/symfony/http-kernel/composer.json',
			'vendor/symfony/polyfill-mbstring/Mbstring.php',
			'vendor/symfony/polyfill-mbstring/bootstrap.php'
		]);
		expect(packs.full!.summary.files).toBe(22);
		expect(packs.full!.summary.rawBytes).toBe(1073);
		assertWellFormed(packs.full!);
	});

	it('drops a root-level tests/ dir the profiled branch keeps', () => {
		expect(packs.full!.index.map((e) => e.p)).not.toContain('tests/fixture.yml');
	});

	it('keeps sites/default/files but still misses the dotfile database', () => {
		const got = packs.full!.index.map((e) => e.p);
		// the exclusion lives in the completion branch only, so compiled Twig ships here
		expect(got).toContain('sites/default/files/php/twig/abc/page.html.twig');
		// `.sqlite` is absent for a different reason: glob does not match dotfiles, and `.sql`
		// is the SKIP entry rather than `.sqlite`
		expect(got).not.toContain('sites/default/files/.sqlite');
	});

	it('prints no completion summary, because it ran no completion rules', () => {
		expect(packs.full!.stderr).toBe('');
	});
});

describe('TRACE=1 drops the blanket yml/twig sweep', () => {
	it('packs the byte-identical set pack-drupal.mjs packed', () => {
		expect(sha(packs.trace!.json)).toBe(
			'2de541fcf590e6c338a377cba0d37d68027cabfaf4d49fc7d7898f4cc8886df5'
		);
		expect(packs.trace!.summary.files).toBe(14);
		expect(packs.trace!.stderr).toBe('profiled 5 -> 2 units -> 16 files');
		assertWellFormed(packs.trace!);
	});

	it('loses exactly the files the sweep contributed, and keeps *.info.yml', () => {
		const got = packs.trace!.index.map((e) => e.p);
		expect(got).not.toContain('core/core.services.yml');
		expect(got).not.toContain('core/modules/system/templates/page.html.twig');
		expect(got).not.toContain('tests/fixture.yml');
		// its own glob, not the sweep, so a trace does not cost extension discovery
		expect(got).toContain('core/modules/system/system.info.yml');
		expect(got).toContain('core/themes/claro/claro.info.yml');
	});
});

describe('COMPLETE_CORE=1 widens completion to core', () => {
	it('packs the byte-identical set pack-drupal.mjs packed', () => {
		expect(sha(packs.core!.json)).toBe(
			'30edc435da326a3b2b3659366c1c8b893130e9b314579a95ebac0608fbcf4e52'
		);
		expect(packs.core!.summary.files).toBe(18);
		expect(packs.core!.stderr).toBe('profiled 5 -> 4 units -> 29 files');
		assertWellFormed(packs.core!);
	});

	it('adds the traced core module as a unit, which the default path leaves out', () => {
		expect(packs.core!.index.map((e) => e.p)).toContain(
			'core/modules/system/src/SystemManager.php'
		);
		expect(packs.default!.index.map((e) => e.p)).not.toContain(
			'core/modules/system/src/SystemManager.php'
		);
	});
});

describe('the core.bin threshold', () => {
	it('writes core.bin below 24 MiB and DELETES a stale one above it', async () => {
		const big = join(dir, 'big');
		await mkdir(join(big, 'core/includes'), { recursive: true });
		// one byte over, so the comparison is the boundary rather than a round number
		await writeFile(join(big, 'core/includes/big.inc'), Buffer.alloc(24 * 1024 * 1024 + 1));
		await utimes(join(big, 'core/includes/big.inc'), 1700000090, 1700000090);
		await writeFile(join(dir, 'big.json'), JSON.stringify([{ p: 'core/includes/big.inc' }]));

		const out = join(dir, 'out-big');
		await mkdir(out, { recursive: true });
		// a leftover from a smaller pack; the point is that it does not survive
		await writeFile(join(out, 'core.bin'), 'stale');

		const r = spawnSync('node', [PACKER, big, join(dir, 'big.json'), out], {
			cwd: ROOT,
			encoding: 'utf8',
			env: { ...process.env, PACK_INDEX: '1' },
			timeout: 120_000
		});
		expect(r.status).toBe(0);
		expect(existsSync(join(out, 'core.bin'))).toBe(false);
		expect(existsSync(join(out, 'core.bin.gz'))).toBe(true);
		expect((JSON.parse(r.stdout) as Summary).rawBytes).toBe(24 * 1024 * 1024 + 1);
	}, 120_000);
});

describe('the packer refuses a run it cannot complete', () => {
	it('exits non-zero with a usage line when the drupal root is missing', () => {
		const r = spawnSync('node', [PACKER], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('usage: pack-drupal.ts <drupal-root> [includes.json] [out-dir]');
	});
});
