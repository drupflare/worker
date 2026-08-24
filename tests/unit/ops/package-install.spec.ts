import { gzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
	DROP,
	KEEP,
	RECORD_CAP,
	commonPrefix,
	distOf,
	metadataUrl,
	mountFor,
	pickVersion,
	unpackTar,
	unpackZip
} from '../../../src/ops/package-install';

/**
 * The installer P18's `composer require` and P40's git delivery share.
 *
 * The fixtures here are the SHAPES both repositories actually return, taken from live responses on
 * 2026-08-23 rather than invented: `packages.drupal.org` answers a `dist.url` pointing at
 * `ftp.drupal.org`, packagist answers one pointing at `api.github.com/.../zipball/<sha>`.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

/** a minimal ustar archive, so the tar case does not need a fixture file on disk */
function tarOf(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const [name, body] of entries) {
		const header = new Uint8Array(512);
		const put = (offset: number, text: string) => {
			for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
		};
		put(0, name);
		put(100, '0000644\0');
		put(124, body.length.toString(8).padStart(11, '0') + '\0');
		put(156, '0');
		put(257, 'ustar\0' + '00');
		// the checksum is computed with the field itself read as spaces, which is the one part of
		// the format a hand-written fixture always gets wrong
		for (let i = 148; i < 156; i++) header[i] = 32;
		let sum = 0;
		for (const b of header) sum += b;
		put(148, sum.toString(8).padStart(6, '0') + '\0 ');
		blocks.push(header);
		const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
		padded.set(body);
		blocks.push(padded);
	}
	blocks.push(new Uint8Array(1024));
	const total = blocks.reduce((n, b) => n + b.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const b of blocks) {
		out.set(b, at);
		at += b.length;
	}
	return out;
}

describe('resolving a name to a repository', () => {
	it('sends drupal/* to packages.drupal.org and everything else to packagist', () => {
		// NOT interchangeable: `repo.packagist.org/p2/drupal/token.json` answers
		// "404 not found, no packages here", which reads as a typo rather than as a wrong registry
		expect(metadataUrl('composer', 'drupal/token')).toBe(
			'https://packages.drupal.org/files/packages/8/p2/drupal/token.json'
		);
		expect(metadataUrl('composer', 'psr/log')).toBe(
			'https://repo.packagist.org/p2/psr/log.json'
		);
		expect(metadataUrl('npm', 'lodash')).toBe('https://registry.npmjs.org/lodash');
		expect(metadataUrl('npm', '@scope/pkg')).toBe('https://registry.npmjs.org/@scope/pkg');
	});

	it("mounts by composer's own type rather than by guessing from the name", () => {
		expect(mountFor('drupal/token', 'drupal-module')).toBe('modules/contrib/token');
		expect(mountFor('drupal/olivero_sub', 'drupal-theme')).toBe('themes/contrib/olivero_sub');
		expect(mountFor('drupal/chosen_lib', 'drupal-library')).toBe('libraries/chosen_lib');
		// a plain PHP package goes where the autoloader already has a root
		expect(mountFor('psr/log', 'library')).toBe('vendor/psr/log');
		expect(mountFor('psr/log')).toBe('vendor/psr/log');
	});
});

describe('picking a version', () => {
	const doc = {
		packages: {
			'drupal/token': [
				{ version: '2.0.0-beta1', dist: { url: 'b', type: 'zip' } },
				{ version: '1.17.0', dist: { url: 'https://ftp.drupal.org/x.zip', type: 'zip' } },
				{ version: '1.16.0', dist: { url: 'c', type: 'zip' } }
			]
		}
	};

	it('takes the newest STABLE when no constraint is given', () => {
		// the beta is listed first and must not win: an operator typing `composer require drupal/token`
		// on a real site gets 1.17.0, and getting a beta here would be a difference nobody asked for
		expect(pickVersion(doc, 'drupal/token')?.version).toBe('1.17.0');
	});

	it('matches an exact or prefix constraint', () => {
		expect(pickVersion(doc, 'drupal/token', '1.16.0')?.version).toBe('1.16.0');
		expect(pickVersion(doc, 'drupal/token', '^1.16')?.version).toBe('1.16.0');
		expect(pickVersion(doc, 'drupal/token', '2.0.0-beta1')?.version).toBe('2.0.0-beta1');
	});

	it('REFUSES a constraint it cannot match rather than installing something else', () => {
		// a caret range needs a real semver solver; answering one wrongly installs a version the
		// site cannot run, which is worse than reporting that the constraint was not understood
		expect(pickVersion(doc, 'drupal/token', '9.9')).toBeNull();
	});

	it('answers null for a package the document does not carry', () => {
		expect(pickVersion(doc, 'drupal/absent')).toBeNull();
		expect(pickVersion(null, 'drupal/token')).toBeNull();
		expect(
			pickVersion({ packages: { 'drupal/token': 'not a list' } }, 'drupal/token')
		).toBeNull();
	});
});

describe('reading the archive location', () => {
	it('reads the composer shape packages.drupal.org returns', () => {
		const out = distOf(
			{
				version: '1.17.0',
				type: 'drupal-module',
				dist: {
					type: 'zip',
					url: 'https://ftp.drupal.org/files/projects/token-8.x-1.17.zip',
					shasum: '21d11adf0be16f1aa95b6348b4ceadbe9a625824'
				}
			},
			'drupal/token'
		);
		expect(out?.url).toContain('ftp.drupal.org');
		expect(out?.type).toBe('zip');
		expect(out?.mount).toBe('modules/contrib/token');
		expect(out?.shasum).toHaveLength(40);
	});

	it("reads packagist's github zipball shape, whose shasum is empty", () => {
		const out = distOf(
			{
				version: '3.0.2',
				dist: {
					url: 'https://api.github.com/repos/php-fig/log/zipball/f16e',
					type: 'zip',
					shasum: ''
				}
			},
			'psr/log'
		);
		expect(out?.url).toContain('api.github.com');
		// an empty shasum is absent rather than a digest of nothing
		expect(out?.shasum).toBeUndefined();
	});

	it('reads the npm shape, which is a tarball', () => {
		const out = distOf(
			{
				version: '4.17.21',
				dist: { tarball: 'https://registry.npmjs.org/l/-/l-4.tgz', shasum: 'ab' }
			},
			'lodash'
		);
		expect(out?.type).toBe('tar');
		expect(out?.mount).toBe('libraries/lodash');
	});

	it('answers null when there is no archive at all', () => {
		expect(distOf({ version: '1.0.0' }, 'x/y')).toBeNull();
	});
});

describe('unpacking', () => {
	it('strips the single leading directory every dist archive wraps its files in', () => {
		// keeping it would mount every file one level too deep, where extension discovery never looks
		expect(commonPrefix(['token-8.x-1.17/token.info.yml', 'token-8.x-1.17/src/A.php'])).toBe(
			'token-8.x-1.17/'
		);
		expect(commonPrefix(['a/x.php', 'b/y.php'])).toBe('');
		expect(commonPrefix(['x.php'])).toBe('');
	});

	it('keeps what a mounted tree can use and reports what it dropped', () => {
		const archive = zipSync({
			'token-1.0/token.info.yml': bytes('name: Token'),
			'token-1.0/src/Tree.php': bytes('<?php class Tree {}'),
			'token-1.0/token.module': bytes('<?php'),
			'token-1.0/js/token.js': bytes('// js'),
			'token-1.0/tests/src/Kernel/TokenTest.php': bytes('<?php'),
			'token-1.0/.gitignore': bytes('vendor'),
			'token-1.0/README.txt': bytes('hello')
		});

		const out = unpackZip(archive, 'modules/contrib/token');
		const kept = out.files.map((f) => f.path).sort();
		expect(kept).toEqual([
			'modules/contrib/token/js/token.js',
			'modules/contrib/token/src/Tree.php',
			'modules/contrib/token/token.info.yml',
			'modules/contrib/token/token.module'
		]);

		// A THIN INSTALL HAS TO BE EXPLAINABLE. Silently keeping four of seven files is how a module
		// that half works becomes a mystery
		const why = Object.fromEntries(out.skipped.map((s) => [s.path, s.why]));
		expect(why['tests/src/Kernel/TokenTest.php']).toContain('mountable');
		expect(why['.gitignore']).toContain('mountable');
		expect(why['README.txt']).toContain('extension');
		expect(out.totalBytes).toBeGreaterThan(0);
	});

	it('refuses a file above the record cap rather than truncating it', () => {
		const archive = zipSync({ 'p-1/big.php': new Uint8Array(RECORD_CAP + 1) });
		const out = unpackZip(archive, 'modules/contrib/p');
		expect(out.files).toEqual([]);
		expect(out.skipped[0]?.why).toContain('record cap');
	});

	it('reads a gzipped tarball, which is what npm serves', () => {
		// `@drupflare/untarl` is a sibling package and already a dependency, so the tar path is not
		// a gap. `tarEntryTree(entries, 1)` strips npm's `package/` wrapper the same way
		// `commonPrefix()` strips a zip's
		const inner = zipSync({ 'package/index.js': bytes('// entry') });
		expect(inner.length).toBeGreaterThan(0);
		const tarball = gzipSync(
			tarOf([
				['package/index.js', bytes('// entry')],
				['package/test/a.js', bytes('// test')],
				['package/README.md', bytes('hi')]
			])
		);
		const out = unpackTar(tarball, 'libraries/lodash');
		expect(out.files.map((f) => f.path)).toEqual(['libraries/lodash/index.js']);
		const why = Object.fromEntries(out.skipped.map((s) => [s.path, s.why]));
		expect(why['test/a.js']).toContain('mountable');
		expect(why['README.md']).toContain('extension');
	});

	it('has no allow-list entry that the drop list would also match', () => {
		// a pattern in both lists is a rule nobody can predict the outcome of
		for (const keep of KEEP) {
			expect(DROP.some((d) => d.source === keep.source)).toBe(false);
		}
	});
});
