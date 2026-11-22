import { describe, expect, it } from 'vitest';
import {
	archiveUrl,
	compareVersions,
	phpSatisfies,
	readHeader,
	resolvePinned,
	type Registry
} from '../../../src/wordpress/registry';

const registry: Registry = {
	demo: {
		kind: 'plugin',
		licence: 'GPL-2.0-or-later',
		versions: {
			'1.9.0': { digest: `sha256:${'a'.repeat(64)}`, php: '7.4' },
			'1.10.0': { digest: `sha256:${'b'.repeat(64)}`, php: '8.1' }
		}
	},
	skin: {
		kind: 'theme',
		licence: 'GPL-2.0-or-later',
		versions: { '2.0': { digest: `sha256:${'c'.repeat(64)}`, php: '7.4' } }
	}
};

describe('version order', () => {
	it('compares numerically, so 1.10.0 is newer than 1.9.0', () => {
		expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
		expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
		expect(compareVersions('2.0', '2.0.0')).toBe(0);
	});
});

describe('resolving a pinned package', () => {
	it('takes the highest pinned version when none is asked for', () => {
		const pinned = resolvePinned('demo', undefined, registry);
		expect(pinned).toMatchObject({ version: '1.10.0', php: '8.1', kind: 'plugin' });
		expect(pinned).toHaveProperty('digest', `sha256:${'b'.repeat(64)}`);
	});

	it('takes a named version and builds its wordpress.org archive address', () => {
		const pinned = resolvePinned('demo', '1.9.0', registry);
		expect(pinned).toMatchObject({
			version: '1.9.0',
			url: 'https://downloads.wordpress.org/plugin/demo.1.9.0.zip'
		});
		expect(archiveUrl('theme', 'skin', '2.0')).toBe(
			'https://downloads.wordpress.org/theme/skin.2.0.zip'
		);
	});

	it('refuses a version that is not pinned and lists the ones that are', () => {
		const refused = resolvePinned('demo', '1.9.1', registry);
		expect(refused).toHaveProperty('error');
		expect((refused as { error: string }).error).toContain('1.9.0, 1.10.0');
	});

	it('refuses a slug that is not in the registry', () => {
		expect(resolvePinned('missing', undefined, registry)).toEqual({
			error: 'missing is not in the package registry'
		});
	});
});

describe('declared PHP', () => {
	it('is a minimum the interpreter must meet', () => {
		expect(phpSatisfies('5.2.4')).toBe(true);
		expect(phpSatisfies('8.5')).toBe(true);
		expect(phpSatisfies('8.6')).toBe(false);
		expect(phpSatisfies('9.0', '9.1')).toBe(true);
	});
});

describe('header lines', () => {
	const source = `<?php\n/**\n * Plugin Name:  Demo\n * Version:     1.2.3\n * Requires PHP: 7.4 */\n`;

	it('reads a header from a docblock line', () => {
		expect(readHeader(source, 'Plugin Name')).toBe('Demo');
		expect(readHeader(source, 'Version')).toBe('1.2.3');
	});

	it('drops a comment terminator on the same line', () => {
		expect(readHeader(source, 'Requires PHP')).toBe('7.4');
	});

	it('answers undefined for a header that is not there, and ignores text past 8 KiB', () => {
		expect(readHeader(source, 'License')).toBeUndefined();
		expect(readHeader(`${' '.repeat(9000)}\n * Version: 9`, 'Version')).toBeUndefined();
	});
});
