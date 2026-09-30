import { describe, expect, it } from 'vitest';
import { chunkStack, flatFields, isLengthError } from '../../../src/ops/error-probe';
import type { SitePhpDurableObject } from '../../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../../helpers/serve-do';

describe('the RangeError probe', () => {
	it('recognises a length error and nothing else', () => {
		expect(isLengthError(new RangeError('Invalid array buffer length'))).toBe(true);
		expect(isLengthError(new Error('Invalid array buffer length'))).toBe(true);
		expect(isLengthError(new Error('boom'))).toBe(false);
	});

	it('splits a long stack into pieces and flattens them to fields', () => {
		const pieces = chunkStack('x'.repeat(1000), 400);
		expect(pieces.map((p) => p.length)).toEqual([400, 400, 200]);
		const fields = flatFields({
			at: 1,
			where: 'fetch',
			method: 'GET',
			path: '/a',
			message: 'm',
			stack: pieces,
			linear: 5,
			isolate: 6,
			reused: 0,
			bootMs: null,
			grow: [{ size: 1 }],
			sub: []
		});
		expect(fields['stack2']).toBe('x'.repeat(200));
		expect(fields['grow']).toBe('[{"size":1}]');
	});

	it('keeps the report on the object, with the last growth attempts, and ignores other errors', async () => {
		const seen = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as SitePhpDurableObject;
			(globalThis as { __cfwGrow?: unknown[] }).__cfwGrow = [{ size: 7, ok: 0 }];
			site.noteRangeError(new Error('unrelated'), 'fetch');
			site.noteRangeError(
				new RangeError('Invalid array buffer length'),
				'fetch',
				new Request('https://do.local/__serve?path=%2Fnode%2F1', { method: 'POST' })
			);
			delete (globalThis as { __cfwGrow?: unknown }).__cfwGrow;
			return site.rangeErrors;
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			where: 'fetch',
			method: 'POST',
			path: '/node/1',
			message: 'Invalid array buffer length',
			grow: [{ size: 7, ok: 0 }]
		});
		expect(seen[0]!.stack.join('')).toContain('Invalid array buffer length');
	});
});

describe('the demand record', () => {
	it('names the page that raised linear memory, keeps the highest per path, and caps the table', async () => {
		const seen = await inObject(freshSite(), async (handle: ServeDo) => {
			const site = handle as unknown as Pick<
				SitePhpDurableObject,
				'noteDemand' | 'demandLog' | 'demandByPath'
			> & { heapNow: () => number };
			let linear = 0;
			site.heapNow = () => linear;
			const at = (path: string) =>
				new Request(`https://do.local/__serve?path=${encodeURIComponent(path)}`);
			site.noteDemand(at('/cold'), 0, 0);
			linear = 100;
			site.noteDemand(at('/a'), 90, 0);
			linear = 150;
			site.noteDemand(at('/admin/reports/status?x=1'), 100, 0);
			linear = 120;
			site.noteDemand(at('/admin/reports/status'), 150, 0);
			for (let i = 0; i < 60; i++) site.noteDemand(at(`/scan/${i}`), 120, 0);
			return { log: site.demandLog, byPath: site.demandByPath };
		});
		expect(seen.byPath['/admin/reports/status']).toBe(150);
		expect(seen.byPath['/a']).toBe(100);
		expect(seen.byPath['/cold']).toBeUndefined();
		expect(Object.keys(seen.byPath).length).toBeLessThanOrEqual(40);
		expect(seen.log).toHaveLength(60);
	});
});
