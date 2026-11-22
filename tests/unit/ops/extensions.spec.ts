import { describe, expect, it } from 'vitest';
import { extensionRows } from '../../../src/ops/extensions';

describe('the extension rows', () => {
	const reply = (extensions: unknown) => ({ ok: true, extensions });

	it('refuses a reply that is not the shape the script writes', () => {
		expect(extensionRows(undefined)).toBeUndefined();
		expect(extensionRows(null)).toBeUndefined();
		expect(extensionRows({ ok: true })).toBeUndefined();
		expect(extensionRows(reply('x'))).toBeUndefined();
		expect(extensionRows(reply([null]))).toBeUndefined();
		expect(
			extensionRows(reply([{ name: '', kind: 'module', version: null, enabled: true }]))
		).toBeUndefined();
		expect(
			extensionRows(reply([{ name: 'a', kind: 'plugin', version: null, enabled: true }]))
		).toBeUndefined();
		expect(
			extensionRows(reply([{ name: 'a', kind: 'module', version: null, enabled: 1 }]))
		).toBeUndefined();
	});

	it('refuses the whole reply when one row is wrong, and does not drop the row', () => {
		const good = { name: 'a', kind: 'module', version: '1.0.0', enabled: true };
		const bad = { name: 'b', kind: 'theme', version: '1.0.0', enabled: 'yes' };
		expect(extensionRows(reply([good, bad]))).toBeUndefined();
		expect(extensionRows(reply([good]))).toEqual([good]);
	});

	it('keeps a version string and turns a missing, empty or non-string one into null', () => {
		const row = (version: unknown) => ({ name: 'a', kind: 'module', version, enabled: false });
		const versions = [undefined, null, '', '  ', 7, '2.4.1'].map(
			(v) => extensionRows(reply([row(v)]))?.[0]?.version
		);
		expect(versions).toEqual([null, null, null, null, null, '2.4.1']);
	});

	it('sorts by name and then kind with a code-unit comparison, whatever order it arrives in', () => {
		const rows = [
			{ name: 'b', kind: 'module', version: null, enabled: true },
			{ name: 'a_x', kind: 'module', version: null, enabled: true },
			{ name: 'a', kind: 'theme', version: null, enabled: true },
			{ name: 'a', kind: 'module', version: null, enabled: false },
			{ name: 'B', kind: 'module', version: null, enabled: true }
		];
		expect(extensionRows(reply(rows))?.map((r) => `${r.name}:${r.kind}`)).toEqual([
			'B:module',
			'a:module',
			'a:theme',
			'a_x:module',
			'b:module'
		]);
	});

	it('accepts an empty list, which a site with no discovery result would report', () => {
		expect(extensionRows(reply([]))).toEqual([]);
	});
});
