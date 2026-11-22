import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readZipPackage, ZIP_LIMITS, ZipRefused, type ZipRule } from '../../../src/wordpress/zip';
import { buildZip, cleanPluginZip, type BuiltEntry } from '../../fixtures/wordpress/zip-builder';

const SLUG = 'fixture-plugin';
const main = (extra: BuiltEntry[]) => cleanPluginZip(SLUG, extra);

/** the rule a read refuses with, or undefined when it passes */
function refusal(archive: Uint8Array, limits = ZIP_LIMITS): ZipRule | undefined {
	try {
		readZipPackage(archive, SLUG, limits);
		return undefined;
	} catch (e) {
		if (e instanceof ZipRefused) return e.rule;
		throw e;
	}
}

describe('a plugin archive that follows the rules', () => {
	it('yields its files relative to the folder, directories dropped', () => {
		const pkg = readZipPackage(cleanPluginZip(SLUG), SLUG);
		expect(pkg.folder).toBe(SLUG);
		expect(pkg.files.map((f) => f.path).sort()).toEqual([`${SLUG}.php`, 'js/app.js']);
		expect(new TextDecoder().decode(pkg.files.find((f) => f.path === 'js/app.js')!.bytes)).toBe(
			'console.log(1);'
		);
		expect(pkg.totalBytes).toBe(pkg.files.reduce((n, f) => n + f.bytes.length, 0));
	});

	it('reads stored and deflated entries alike', () => {
		const pkg = readZipPackage(
			main([{ name: `${SLUG}/readme.txt`, data: 'stored bytes', method: 0 }]),
			SLUG
		);
		expect(
			new TextDecoder().decode(pkg.files.find((f) => f.path === 'readme.txt')!.bytes)
		).toBe('stored bytes');
	});

	it('leaves out hidden and vendored paths and says why', () => {
		const pkg = readZipPackage(
			main([
				{ name: `${SLUG}/.git/config`, data: 'x' },
				{ name: `${SLUG}/node_modules/a/index.js`, data: 'x' },
				{ name: `${SLUG}/.DS_Store`, data: 'x' }
			]),
			SLUG
		);
		expect(pkg.files.map((f) => f.path).sort()).toEqual([`${SLUG}.php`, 'js/app.js']);
		expect(pkg.skipped.map((s) => s.path).sort()).toEqual([
			'.DS_Store',
			'.git/config',
			'node_modules/a/index.js'
		]);
	});
});

describe('every rule has a hostile archive', () => {
	const cases: [ZipRule, Uint8Array, string][] = [
		['path-traversal', main([{ name: `${SLUG}/../evil.php`, data: 'x' }]), 'a .. segment'],
		['path-traversal', main([{ name: `${SLUG}/a/../../x.php`, data: 'x' }]), 'a nested climb'],
		['absolute-path', main([{ name: '/etc/cron.d/x', data: 'x' }]), 'a leading slash'],
		['drive-letter', main([{ name: 'C:/windows/x.php', data: 'x' }]), 'a drive letter'],
		['backslash', main([{ name: `${SLUG}\\..\\x.php`, data: 'x' }]), 'a backslash'],
		['invalid-name', main([{ name: `${SLUG}/a\u0000.php`, data: 'x' }]), 'a NUL in the name'],
		[
			'symlink',
			main([{ name: `${SLUG}/link.php`, data: '/etc/passwd', unixMode: 0o120777 }]),
			'a unix symlink'
		],
		[
			'device-entry',
			main([{ name: `${SLUG}/dev`, data: '', unixMode: 0o020666 }]),
			'a character device'
		],
		[
			'device-entry',
			main([{ name: `${SLUG}/pipe`, data: '', unixMode: 0o010644 }]),
			'a named pipe'
		],
		[
			'duplicate-name',
			main([{ name: `${SLUG}/js/app.js`, data: 'second' }]),
			'the same name twice'
		],
		[
			'case-collision',
			main([{ name: `${SLUG}/JS/App.js`, data: 'x' }]),
			'names that differ only in case'
		],
		['encrypted', main([{ name: `${SLUG}/s.php`, data: 'x', flags: 1 }]), 'an encrypted entry'],
		[
			'layout',
			buildZip([
				{ name: `${SLUG}/${SLUG}.php`, data: 'x' },
				{ name: 'other/other.php', data: 'x' }
			]),
			'two top-level folders'
		],
		[
			'layout',
			buildZip([{ name: `wrong-folder/${SLUG}.php`, data: 'x' }]),
			'a folder that is not the slug'
		],
		['layout', buildZip([{ name: 'notes.txt', data: 'x' }]), 'a file beside the folder'],
		['layout', buildZip([]), 'an empty archive'],
		[
			'php-outside-folder',
			main([{ name: 'shell.php', data: '<?php system($_GET[0]);' }]),
			'a PHP file beside the folder'
		],
		[
			'php-outside-folder',
			main([{ name: 'index.phtml', data: 'x' }]),
			'a phtml file beside the folder'
		],
		['not-a-zip', new Uint8Array(64), 'bytes that are not an archive'],
		['not-a-zip', cleanPluginZip(SLUG).subarray(0, 40), 'a truncated archive']
	];

	for (const [rule, archive, what] of cases) {
		it(`refuses ${what} as ${rule}`, () => {
			expect(refusal(archive)).toBe(rule);
		});
	}

	it('names the offending entry in the refusal', () => {
		try {
			readZipPackage(main([{ name: `${SLUG}/../evil.php`, data: 'x' }]), SLUG);
			expect.unreachable();
		} catch (e) {
			expect((e as ZipRefused).entry).toBe(`${SLUG}/../evil.php`);
			expect((e as Error).message).toContain('path-traversal');
		}
	});

	it('refuses a method it does not read', () => {
		const zip = cleanPluginZip(SLUG);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		// the first central entry's method field, found by its signature
		for (let i = 0; i < zip.length - 4; i++) {
			if (view.getUint32(i, true) === 0x02014b50) {
				view.setUint16(i + 10, 12, true);
				break;
			}
		}
		expect(refusal(zip)).toBe('unsupported-compression');
	});
});

describe('size rules', () => {
	const small: typeof ZIP_LIMITS = { ...ZIP_LIMITS, entries: 3 };

	it('caps the entry count, and passes the same archive under the cap', () => {
		const many = main([
			{ name: `${SLUG}/a.js`, data: 'a' },
			{ name: `${SLUG}/b.js`, data: 'b' }
		]);
		expect(refusal(many, small)).toBe('too-many-entries');
		expect(refusal(many)).toBeUndefined();
	});

	it('caps the whole archive in compressed bytes', () => {
		const zip = cleanPluginZip(SLUG);
		expect(refusal(zip, { ...ZIP_LIMITS, archiveBytes: zip.length - 1 })).toBe(
			'archive-too-large'
		);
		expect(refusal(zip, { ...ZIP_LIMITS, archiveBytes: zip.length })).toBeUndefined();
	});

	it('caps one expanded file, and passes the same file under the cap', () => {
		const zip = main([{ name: `${SLUG}/big.js`, data: 'x'.repeat(5000) }]);
		expect(refusal(zip, { ...ZIP_LIMITS, entryBytes: 4999 })).toBe('entry-too-large');
		expect(refusal(zip, { ...ZIP_LIMITS, entryBytes: 5000 })).toBeUndefined();
	});

	it('caps the expanded total', () => {
		const zip = main([
			{ name: `${SLUG}/a.js`, data: 'a'.repeat(3000) },
			{ name: `${SLUG}/b.js`, data: 'b'.repeat(3000) }
		]);
		expect(refusal(zip, { ...ZIP_LIMITS, expandedBytes: 5999 })).toBe('expanded-too-large');
		expect(refusal(zip, { ...ZIP_LIMITS, expandedBytes: 7000 })).toBeUndefined();
	});

	it('refuses a bomb: a megabyte of zeros that deflates to a kilobyte', () => {
		const bomb = main([{ name: `${SLUG}/zeros.bin`, data: new Uint8Array(1_000_000) }]);
		expect(bomb.length).toBeLessThan(5000);
		expect(refusal(bomb)).toBe('ratio');
	});

	it('does not hold a small repetitive file to the per-file ratio', () => {
		const zip = main([{ name: `${SLUG}/data.json`, data: '0'.repeat(30_000) }]);
		expect(refusal(zip, { ...ZIP_LIMITS, ratio: 1e9 })).toBeUndefined();
		expect(refusal(zip)).toBeUndefined();
	});

	it('refuses a header that understates the data, without expanding it', () => {
		const real = new Uint8Array(200_000).fill(7);
		const zip = main([
			{
				name: `${SLUG}/lie.js`,
				data: real,
				declaredExpanded: 100,
				rawCompressed: deflateSync(real)
			}
		]);
		expect(refusal(zip)).toBe('size-mismatch');
	});

	it('refuses a header that overstates the data', () => {
		const zip = main([{ name: `${SLUG}/lie.js`, data: 'short', declaredExpanded: 50 }]);
		expect(refusal(zip)).toBe('size-mismatch');
	});

	it('refuses a stored entry whose two sizes disagree', () => {
		const zip = main([
			{ name: `${SLUG}/s.js`, data: 'abcdef', method: 0, declaredExpanded: 3 }
		]);
		expect(refusal(zip)).toBe('size-mismatch');
	});

	it('refuses two entries that share bytes', () => {
		const zip = cleanPluginZip(SLUG);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		const offsets: number[] = [];
		for (let i = 0; i < zip.length - 4; i++) {
			if (view.getUint32(i, true) === 0x02014b50) offsets.push(i);
		}
		// the last central entry now points at the second one's local header
		const second = view.getUint32(offsets[1]! + 42, true);
		view.setUint32(offsets[2]! + 42, second, true);
		expect(refusal(zip)).toBe('overlap');
	});
});
