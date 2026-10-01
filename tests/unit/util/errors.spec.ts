import { describe, expect, it } from 'vitest';
import { errorMessage, isMissingTable } from '../../../src/util/errors';

const legacy = (e: any): string => String(e?.message ?? e);

describe('errorMessage', () => {
	const cases: Array<[string, unknown]> = [
		['an Error', new Error('boom')],
		['an Error with an empty message', new Error('')],
		['a TypeError', new TypeError('bad type')],
		['a string', 'plain text'],
		['an empty string', ''],
		['null', null],
		['undefined', undefined],
		['a number', 42],
		['zero', 0],
		['an object with a string message', { message: 'from an object' }],
		['an object with a numeric message', { message: 7 }],
		['an object with a null message', { message: null }],
		['an object with an undefined message', { message: undefined }],
		['an object with no message', { code: 'E_NOPE' }],
		['an array', [1, 2]],
		['a symbol', Symbol('s')]
	];

	for (const [name, value] of cases) {
		it(`matches String(e?.message ?? e) for ${name}`, () => {
			expect(errorMessage(value)).toBe(legacy(value));
		});
	}

	it('keeps an empty message empty rather than falling back to the value', () => {
		expect(errorMessage(new Error(''))).toBe('');
	});

	it('names null and undefined', () => {
		expect(errorMessage(null)).toBe('null');
		expect(errorMessage(undefined)).toBe('undefined');
	});

	it('reads message through a getter', () => {
		const e = {
			get message() {
				return 'lazy';
			}
		};
		expect(errorMessage(e)).toBe('lazy');
	});
});

describe('isMissingTable', () => {
	it('recognises the message SQLite gives for an absent table', () => {
		expect(
			isMissingTable(new Error('SQLITE_ERROR: no such table: cfw_meta: SQLITE_ERROR'))
		).toBe(true);
		expect(isMissingTable('No such table: x')).toBe(true);
	});

	it('refuses any other fault', () => {
		expect(isMissingTable(new Error('disk I/O error'))).toBe(false);
		expect(isMissingTable(new Error('no such column: v'))).toBe(false);
		expect(isMissingTable(undefined)).toBe(false);
	});
});
