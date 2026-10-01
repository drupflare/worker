import { describe, expect, it } from 'vitest';
import { columnText, firstRow } from '../../../src/util/sql';

describe('firstRow', () => {
	it('is undefined for an empty cursor', () => {
		expect(firstRow({ toArray: () => [] })).toBeUndefined();
	});

	it('returns the first row of several', () => {
		const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
		expect(firstRow({ toArray: () => rows })).toBe(rows[0]);
	});

	it('returns a falsy first row as it is', () => {
		expect(firstRow({ toArray: () => [0, 1] })).toBe(0);
	});

	it('reads the cursor once', () => {
		let calls = 0;
		firstRow({
			toArray: () => {
				calls += 1;
				return [{ a: 1 }];
			}
		});
		expect(calls).toBe(1);
	});
});

describe('columnText', () => {
	it('passes a string through', () => {
		expect(columnText('abc')).toBe('abc');
	});

	it('decodes bytes as UTF-8', () => {
		expect(columnText(new TextEncoder().encode('héllo'))).toBe('héllo');
	});

	it('is empty for anything else', () => {
		for (const v of [null, undefined, 7, {}, [1, 2], new ArrayBuffer(2)]) {
			expect(columnText(v)).toBe('');
		}
	});
});
