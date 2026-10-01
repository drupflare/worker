import { describe, expect, it } from 'vitest';
import { leverInt } from '../../../src/util/lever';

describe('leverInt', () => {
	it('floors a non-negative number', () => {
		expect(leverInt(7)).toBe(7);
		expect(leverInt(7.9)).toBe(7);
		expect(leverInt('12')).toBe(12);
		expect(leverInt('3.5')).toBe(3);
	});

	it('honours zero', () => {
		expect(leverInt(0)).toBe(0);
		expect(leverInt('0')).toBe(0);
	});

	it('is null when absent, empty, negative or not finite', () => {
		for (const v of [undefined, null, '', -1, '-5', 'abc', NaN, Infinity, {}]) {
			expect(leverInt(v)).toBeUndefined();
		}
	});
});
